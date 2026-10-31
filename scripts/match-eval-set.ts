/**
 * PRODUCT-LEVEL EVALUATION of matching engine v2 against the labelled evaluation set (fixtures/matching/eval-v1/eval-set.json).
 * Reads exported datasets and the evaluation set; touches no database. Measures, separately for "dev" (what may be tuned on) and "heldout":
 *   - candidate recall @k per website: is the labelled counterpart among the top-k products RETRIEVED for the source product (before any decision)
 *   - accuracy of the strong tier and of strong + medium, per relationship, with Wilson bounds
 *   - false suggestions for products that have no genuine counterpart
 *   - the review workload, as variant pairs and as product pairs, per 100 source products and per website
 *
 *   npx tsx scripts/match-eval-set.ts --auto-data dataset-adi.json --grocery-data dataset-Aditya.json [--set dev|heldout|all] [--k 10] [--out report.json]
 *
 * Do not tune on --set heldout. Every run states which engine version produced the numbers.
 */
import fs from 'node:fs';
import { DEFAULT_CANDIDATE_OPTIONS, ENGINE_VERSION, buildCandidateIndex, evaluate, retrieveCandidates, runEngine, wilsonLower, type EngineResult, type LabelledPair, type Prediction } from '@ci/core';
import type { MatchRelationship } from '@ci/shared';
import { loadDataset } from './lib/eval-data.ts';

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const k = Number(arg('k', '10'));
const which = (arg('set', 'all') ?? 'all') as 'dev' | 'heldout' | 'all';
const evalSet = JSON.parse(fs.readFileSync(arg('eval-set', 'fixtures/matching/eval-v1/eval-set.json')!, 'utf8')) as {
  pairs: { id: string; domain: 'automotive' | 'grocery'; set: 'dev' | 'heldout'; sourceProductId: string; competitorProductId: string; competitorSite: string; label: string; uncertain: boolean; sourceTitle: string; competitorTitle: string }[];
  noCounterpart: { productId: string; title: string; kind: string }[];
};
const LABEL: Record<string, MatchRelationship> = { E: 'exact', V: 'variant', S: 'substitute', R: 'related', I: 'insufficient', N: 'non_match' };
const REL_ORDER: Record<string, number> = { exact: 0, variant: 1, substitute: 2, related: 3, insufficient: 4, non_match: 5 };
const TIER_ORDER: Record<string, number> = { strong: 0, medium: 1, insufficient: 2 };
const pct = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : `${(100 * x).toFixed(1)}%`);

const report: Record<string, unknown> = { engineVersion: ENGINE_VERSION, set: which, k };
const domains = [['automotive', arg('auto-data')], ['grocery', arg('grocery-data')]] as const;
const allPreds: Prediction[] = [];
const allLabelled: (LabelledPair & { domain: string; uncertain: boolean; id: string })[] = [];
const recallHits: { domain: string; set: string; site: string; hit: boolean }[] = [];
const noCpResults: { domain: string; productId: string; strong: boolean; any: boolean }[] = [];
const workload: Record<string, unknown> = {};

for (const [domain, path] of domains) {
  if (!path) continue;
  const ds = loadDataset(path);
  const t0 = Date.now();
  const res: EngineResult = runEngine(ds.sources, ds.competitors);
  const ms = Date.now() - t0;

  // best suggestion per PRODUCT pair
  const best = new Map<string, { relationship: MatchRelationship; tier: Prediction['tier']; rank: number }>();
  for (const s of res.suggestions) {
    const key = `${ds.productOf.get(s.sourceVariantId)}|${ds.productOf.get(s.competitorVariantId)}`;
    const cur = best.get(key);
    const better = !cur || REL_ORDER[s.relationship]! < REL_ORDER[cur.relationship]! || (s.relationship === cur.relationship && (TIER_ORDER[s.tier]! < TIER_ORDER[cur.tier]! || (s.tier === cur.tier && s.rank > cur.rank)));
    if (better) best.set(key, { relationship: s.relationship, tier: s.tier, rank: s.rank });
  }

  // workload: what a person would be asked to look at (exact/variant/substitute, strong or medium)
  const actionable = res.suggestions.filter((s) => (s.relationship === 'exact' || s.relationship === 'variant' || s.relationship === 'substitute') && s.tier !== 'insufficient');
  const productPairs = new Map<string, { site: string; tier: string }>();
  for (const s of actionable) {
    const key = `${ds.productOf.get(s.sourceVariantId)}|${ds.productOf.get(s.competitorVariantId)}`;
    const cur = productPairs.get(key);
    if (!cur || (cur.tier === 'medium' && s.tier === 'strong')) productPairs.set(key, { site: ds.siteOf.get(ds.productOf.get(s.competitorVariantId)!)!, tier: s.tier });
  }
  const nSrcProducts = ds.sourceProducts.size;
  const perSite: Record<string, unknown> = {};
  for (const site of new Set([...productPairs.values()].map((v) => v.site))) {
    const list = [...productPairs.values()].filter((v) => v.site === site);
    perSite[site] = { productPairs: list.length, strong: list.filter((v) => v.tier === 'strong').length, per100SourceProducts: +((100 * list.length) / nSrcProducts).toFixed(1) };
  }
  workload[domain] = {
    sourceProducts: nSrcProducts, sourceVariants: ds.sources.length, variantPairs: actionable.length, productPairs: productPairs.size,
    strongProductPairs: [...productPairs.values()].filter((v) => v.tier === 'strong').length,
    variantPairsPer100SourceProducts: +((100 * actionable.length) / nSrcProducts).toFixed(1), productPairsPer100SourceProducts: +((100 * productPairs.size) / nSrcProducts).toFixed(1),
    strongProductPairsPer100SourceProducts: +((100 * [...productPairs.values()].filter((v) => v.tier === 'strong').length) / nSrcProducts).toFixed(1),
    perWebsite: perSite, runMs: ms, heapMb: Math.round(process.memoryUsage().heapUsed / 1048576), rssMb: Math.round(process.memoryUsage().rss / 1048576), suggestions: res.stats.suggestions, byTier: res.stats.byTier, byRelationship: res.stats.byRelationship,
  };

  // labelled pairs of this domain
  const mine = evalSet.pairs.filter((p) => p.domain === domain && (which === 'all' || p.set === which));
  for (const p of mine) {
    const lab = LABEL[p.label]!;
    allLabelled.push({ source: p.sourceProductId, competitor: p.competitorProductId, label: lab, set: p.set, domain, uncertain: p.uncertain, id: p.id });
    const b = best.get(`${p.sourceProductId}|${p.competitorProductId}`);
    if (b) allPreds.push({ source: p.sourceProductId, competitor: p.competitorProductId, relationship: b.relationship, tier: b.tier });
  }

  // candidate recall: retrieval only, per source product (union over its variants), best score per competitor product, top k per website
  const index = buildCandidateIndex(ds.competitors.map((c) => res.corpus.byVariant.get(c.variantId)!), res.corpus);
  const variantsOfProduct = new Map<string, string[]>();
  for (const s of ds.sources) variantsOfProduct.set(s.productId, [...(variantsOfProduct.get(s.productId) ?? []), s.variantId]);
  const retrievedFor = new Map<string, Map<string, string[]>>();
  const retrieve = (productId: string) => {
    let m = retrievedFor.get(productId);
    if (m) return m;
    const score = new Map<string, { site: string; s: number }>();
    for (const vid of variantsOfProduct.get(productId) ?? []) for (const r of retrieveCandidates(res.corpus.byVariant.get(vid)!, index, res.corpus, DEFAULT_CANDIDATE_OPTIONS)) {
      const cp = r.competitor.productId;
      const cur = score.get(cp);
      if (!cur || r.score > cur.s) score.set(cp, { site: ds.siteOf.get(cp)!, s: r.score });
    }
    m = new Map();
    for (const [cp, v] of [...score.entries()].sort((a, b) => b[1].s - a[1].s)) m.set(v.site, [...(m.get(v.site) ?? []), cp]);
    retrievedFor.set(productId, m);
    return m;
  };
  for (const p of mine.filter((q) => ['E', 'V', 'S'].includes(q.label))) {
    recallHits.push({ domain, set: p.set, site: p.competitorSite, hit: (retrieve(p.sourceProductId).get(p.competitorSite) ?? []).slice(0, k).includes(p.competitorProductId) });
  }

  // products with no genuine counterpart
  if (domain === 'automotive') {
    const bySource = new Map<string, { strong: boolean; any: boolean }>();
    for (const s of actionable) {
      const sp = ds.productOf.get(s.sourceVariantId)!;
      const cur = bySource.get(sp) ?? { strong: false, any: false };
      cur.any = true;
      if (s.tier === 'strong') cur.strong = true;
      bySource.set(sp, cur);
    }
    for (const n of evalSet.noCounterpart) noCpResults.push({ domain, productId: n.productId, strong: bySource.get(n.productId)?.strong ?? false, any: bySource.get(n.productId)?.any ?? false });
  }
}
report['workload'] = workload;

// ── accuracy by split, domain and relationship
const slice = (f: (l: (typeof allLabelled)[number]) => boolean) => allLabelled.filter(f);
const accuracy = (label: string, ls: typeof allLabelled) => {
  const rep = evaluate(ls, allPreds.filter((p) => ls.some((l) => l.source === p.source && l.competitor === p.competitor)));
  const exactOnly = evaluate(ls.filter((l) => l.label === 'exact' || l.label === 'variant' || l.label === 'non_match' || l.label === 'related' || l.label === 'insufficient' || l.label === 'substitute'), []);
  void exactOnly;
  const certain = ls.filter((l) => !l.uncertain);
  const repCertain = evaluate(certain, allPreds.filter((p) => certain.some((l) => l.source === p.source && l.competitor === p.competitor)));
  const row = {
    pairs: rep.pairs, positives: rep.positives,
    strong: { predicted: rep.strong.predicted, correct: rep.strong.tp, precision: rep.strong.precision, precisionLower95: rep.strong.precisionLower, recall: rep.strong.recall },
    strongPlusMedium: { predicted: rep.review.predicted, correct: rep.review.tp, precision: rep.review.precision, recall: rep.review.recall, recallLower95: rep.review.positives ? wilsonLower(rep.review.tp, rep.review.positives) : null },
    certainOnly: { positives: repCertain.positives, strongPlusMediumRecall: repCertain.review.recall, strongPrecision: repCertain.strong.precision },
    strongErrors: rep.strongFalse.map((l) => allLabelled.find((x) => x.source === l.source && x.competitor === l.competitor)?.id),
    missed: rep.missed.map((l) => allLabelled.find((x) => x.source === l.source && x.competitor === l.competitor)?.id),
  };
  console.log(`\n${label}: ${row.pairs} pairs, ${row.positives} positives (exact/variant/substitute)`);
  console.log(`  strong tier        predicted ${row.strong.predicted}, correct ${row.strong.correct}  precision ${pct(row.strong.precision)} (lower 95% bound ${pct(row.strong.precisionLower95)})  recall ${pct(row.strong.recall)}`);
  console.log(`  strong + medium    predicted ${row.strongPlusMedium.predicted}, correct ${row.strongPlusMedium.correct}  precision ${pct(row.strongPlusMedium.precision)}  recall ${pct(row.strongPlusMedium.recall)} (lower 95% bound ${pct(row.strongPlusMedium.recallLower95)})`);
  console.log(`  without uncertain labels: ${row.certainOnly.positives} positives; recall ${pct(row.certainOnly.strongPlusMediumRecall)}; strong precision ${pct(row.certainOnly.strongPrecision)}`);
  if (row.strongErrors.length) console.log(`  strong-tier false suggestions: ${row.strongErrors.join(' ')}`);
  if (row.missed.length) console.log(`  missed positives: ${row.missed.join(' ')}`);
  return row;
};
report['accuracy'] = {
  dev: accuracy('DEV (all domains)', slice((l) => l.set === 'dev')),
  devAutomotive: accuracy('DEV automotive', slice((l) => l.set === 'dev' && l.domain === 'automotive')),
  devGrocery: accuracy('DEV grocery', slice((l) => l.set === 'dev' && l.domain === 'grocery')),
  heldout: accuracy(arg('heldout-name', 'HELD-OUT (website foodstore2go + non-lighting automotive category)')!, slice((l) => l.set === 'heldout')),
  heldoutGrocerySite: accuracy('HELD-OUT website (foodstore2go.com)', slice((l) => l.set === 'heldout' && l.domain === 'grocery')),
};

// ── candidate recall
const cr = (f: (x: (typeof recallHits)[number]) => boolean) => { const l = recallHits.filter(f); const h = l.filter((x) => x.hit).length; return { hits: h, total: l.length, recall: l.length ? h / l.length : null, lower95: l.length ? wilsonLower(h, l.length) : null }; };
report['candidateRecallAtK'] = { dev: cr((x) => x.set === 'dev'), heldout: cr((x) => x.set === 'heldout'), devAutomotive: cr((x) => x.set === 'dev' && x.domain === 'automotive'), devGrocery: cr((x) => x.set === 'dev' && x.domain === 'grocery') };
for (const [name, v] of Object.entries(report['candidateRecallAtK'] as Record<string, ReturnType<typeof cr>>)) console.log(`\ncandidate recall @${k} (${name}): ${v.hits}/${v.total} = ${pct(v.recall)} (lower 95% bound ${pct(v.lower95)})`);
const sites = [...new Set(recallHits.map((x) => `${x.set}|${x.domain}|${x.site}`))].sort();
const recallBySite: Record<string, ReturnType<typeof cr>> = {};
for (const key of sites) {
  const [s, d, site] = key.split('|');
  const v = cr((x) => x.set === s && x.domain === d && x.site === site);
  recallBySite[key] = v;
  console.log(`  per website — ${s} ${d} ${site}: ${v.hits}/${v.total} = ${pct(v.recall)} (lower 95% bound ${pct(v.lower95)})`);
}
report['candidateRecallAtKBySite'] = recallBySite;

// ── no genuine counterpart
const nc = noCpResults;
const ncAny = nc.filter((x) => x.any).length, ncStrong = nc.filter((x) => x.strong).length;
report['noCounterpart'] = { products: nc.length, withStrongOrMediumSuggestion: ncAny, withStrongSuggestion: ncStrong, rate: nc.length ? ncAny / nc.length : null, upperBound95: nc.length ? 1 - wilsonLower(nc.length - ncAny, nc.length) : null };
console.log(`\nproducts with no genuine counterpart (independent keyword search): ${nc.length}; given a strong/medium suggestion: ${ncAny} (${pct(nc.length ? ncAny / nc.length : null)}); strong: ${ncStrong}`);
console.log('\nWORKLOAD (exact/variant/substitute, strong+medium):');
for (const [d, w] of Object.entries(workload) as [string, Record<string, unknown>][]) console.log(`  ${d}: ${w.sourceProducts} source products; variant pairs ${w.variantPairs} (${w.variantPairsPer100SourceProducts}/100), product pairs ${w.productPairs} (${w.productPairsPer100SourceProducts}/100), strong product pairs ${w.strongProductPairs} (${w.strongProductPairsPer100SourceProducts}/100); run ${w.runMs} ms, heap ${w.heapMb} MB, rss ${w.rssMb} MB; per website ${JSON.stringify(w.perWebsite)}`);
// ── classification: what the engine called each labelled pair against its adjudicated label (strong and medium tiers; anything else counts as "none").
// This is the table that shows whether "same product", "other pack" and "substitute" are kept apart — the pair-level precision above counts all three as one.
{
  const COLS = ['exact', 'variant', 'substitute', 'related', 'none'] as const;
  const ROWS = ['exact', 'variant', 'substitute', 'related', 'insufficient', 'non_match'] as const;
  const predOf = new Map(allPreds.map((p) => [`${p.source}|${p.competitor}`, p]));
  const cell = (l: (typeof allLabelled)[number]): (typeof COLS)[number] => {
    const p = predOf.get(`${l.source}|${l.competitor}`);
    if (!p || p.tier === 'insufficient' || p.relationship === 'insufficient' || p.relationship === 'non_match') return 'none';
    return p.relationship as (typeof COLS)[number];
  };
  const matrix = (label: string, ls: typeof allLabelled) => {
    const m: Record<string, Record<string, number>> = {};
    for (const r of ROWS) m[r] = Object.fromEntries(COLS.map((c) => [c, 0]));
    for (const l of ls) m[l.label]![cell(l)]!++;
    console.log(`\nCLASSIFICATION ${label} — rows: adjudicated label; columns: what the engine proposed (strong or medium)`);
    console.log(`  ${''.padEnd(13)}${COLS.map((c) => c.padStart(11)).join('')}`);
    for (const r of ROWS) console.log(`  ${r.padEnd(13)}${COLS.map((c) => String(m[r]![c]).padStart(11)).join('')}`);
    const sum = (rows: readonly string[], cols: readonly string[]) => rows.reduce((s, r) => s + cols.reduce((t, c) => t + (m[r]?.[c] ?? 0), 0), 0);
    const proposedSame = sum(ROWS, ['exact', 'variant']);
    const sameRight = sum(['exact', 'variant'], ['exact', 'variant']);
    const proposedSub = sum(ROWS, ['substitute']);
    const subRight = sum(['substitute'], ['substitute']);
    console.log(`  proposed as the same product (exact or other pack): ${proposedSame}, of which the label agrees (exact or variant): ${sameRight}${proposedSame ? ` (${pct(sameRight / proposedSame)}, lower 95% bound ${pct(wilsonLower(sameRight, proposedSame))})` : ''}`);
    console.log(`  proposed as a substitute: ${proposedSub}, label substitute: ${subRight}${proposedSub ? ` (${pct(subRight / proposedSub)})` : ''}; label exact or other pack (labelled as a lesser relation): ${sum(['exact', 'variant'], ['substitute'])}`);
    console.log(`  proposed as same product but the label is substitute/related/not a match: ${sum(['substitute', 'related', 'non_match'], ['exact', 'variant'])}   (the costly error: a different product in a same-product comparison)`);
    console.log(`  proposed as a substitute but the label is related/not a match: ${sum(['related', 'non_match'], ['substitute'])}`);
    return { matrix: m, proposedSame, sameRight, proposedSubstitute: proposedSub, substituteRight: subRight };
  };
  report['classification'] = {
    all: matrix(`${which} (all domains)`, allLabelled.filter((l) => !l.uncertain || true)),
    certainOnly: matrix(`${which} (certain labels only)`, allLabelled.filter((l) => !l.uncertain)),
    automotive: matrix(`${which} automotive`, allLabelled.filter((l) => l.domain === 'automotive')),
    grocery: matrix(`${which} grocery`, allLabelled.filter((l) => l.domain === 'grocery')),
  };
}
if (arg('out')) fs.writeFileSync(arg('out')!, JSON.stringify(report, null, 1));
void allPreds;
