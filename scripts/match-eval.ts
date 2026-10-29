/**
 * OFFLINE EVALUATION of the matching engines. Reads a dataset file; never touches a database, the network or any production record.
 *
 *   npx tsx scripts/match-eval.ts --data export.json [--labels labels.json] [--engine v1|v2|both] [--out report.json] [--k 10]
 *
 * export.json   { rows: MatchableRow[], decisions?: Decision[] }  (or a bare array of rows) — produced by a read-only export of a workspace
 *               (scripts/match-export.ts, or the same query run with psql); `decisions` are the pairs a person accepted/rejected.
 * labels.json   { labels: { source, competitor, label, set: 'dev'|'heldout', labeller? }[], noCounterpart?: string[] }
 *
 * Reports (per engine): runtime and memory; suggestions by relationship and tier; review load per 100 of your products; coverage per website;
 * candidate recall at k against the labelled comparable pairs; precision/recall/F1 of the strong tier and of strong+medium, separately for the
 * development and the held-out labels; false suggestions for products with no genuine counterpart; and the grocery-style regression: the share of the
 * pairs a person accepted that the engine proposes again. Nothing is tuned here: this script only measures.
 */
import fs from 'node:fs';
import {
  analyseCatalogue, buildCandidateIndex, buildMatches, candidateRecall, collectKnownBrands, evaluate, evaluatePair, isPlaceholderBrand, placeholderBrandKeys, prepareVariant, prf, retrieveCandidates, runEngine, sizeHintOf, wilsonLower,
  DEFAULT_CANDIDATE_OPTIONS, ENGINE_VERSION, type DossierInput, type LabelledPair, type Prediction,
} from '@ci/core';
import { relationshipOfClass, type MatchRelationship } from '@ci/shared';

interface Row {
  variantId: string; productId: string; siteId: string; role: 'source' | 'competitor'; title: string; variantTitle: string | null; brand: string | null; category: string | null; gtin: string | null; sku: string | null;
  mpn: string | null; model: string | null; qtyLabel: string | null; attrs: Record<string, unknown> | null; options?: Record<string, string> | null; price?: number | null; currency?: string | null; site?: string;
}
interface Decision { source: string; competitor: string; status: 'accepted' | 'rejected'; matchClass?: string; relationship?: MatchRelationship }

const arg = (name: string, d?: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; };
const dataPath = arg('data');
if (!dataPath) { console.error('usage: tsx scripts/match-eval.ts --data export.json [--labels labels.json] [--engine v1|v2|both] [--out report.json] [--k 10]'); process.exit(1); }
const k = Number(arg('k', '10'));
const which = arg('engine', 'both')!;
const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const rows: Row[] = Array.isArray(raw) ? raw : raw.rows;
const decisions: Decision[] = (Array.isArray(raw) ? [] : raw.decisions) ?? [];
const labelFile = arg('labels') ? JSON.parse(fs.readFileSync(arg('labels')!, 'utf8')) : null;
const labels: (LabelledPair & { labeller?: string })[] = labelFile?.labels ?? [];
const noCounterpart: string[] = labelFile?.noCounterpart ?? [];

const tags = (a: Record<string, unknown> | null | undefined) => (Array.isArray(a?.['tags']) ? (a!['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : []);
const placeholders = placeholderBrandKeys(rows.map((r) => ({ siteId: r.siteId, brand: r.brand, title: r.title })));
const inputs: (DossierInput & { role: 'source' | 'competitor' })[] = rows.map((r) => ({
  variantId: r.variantId, productId: r.productId, siteId: r.siteId, role: r.role, title: r.title, variantTitle: r.variantTitle, brand: isPlaceholderBrand(placeholders, r.siteId, r.brand) ? null : r.brand, category: r.category, gtin: r.gtin, sku: r.sku,
  mpn: r.mpn, model: r.model, sizeHints: [r.qtyLabel, sizeHintOf(r.attrs)], context: tags(r.attrs).join(' ') || null, options: r.options ?? {}, tags: tags(r.attrs),
}));
const sources = inputs.filter((i) => i.role === 'source');
const competitors = inputs.filter((i) => i.role === 'competitor');
const siteName = new Map(rows.map((r) => [r.siteId, r.site ?? r.siteId.slice(0, 6)]));
const sourceProducts = new Set(sources.map((s) => s.productId)).size;
const report: Record<string, unknown> = { dataset: { path: dataPath, rows: rows.length, sourceVariants: sources.length, sourceProducts, competitorVariants: competitors.length, labels: labels.length, decisions: decisions.length }, engineVersion: ENGINE_VERSION };
console.log(`dataset: ${sources.length} source variants (${sourceProducts} products), ${competitors.length} competitor variants, ${labels.length} labelled pairs, ${decisions.length} human decisions`);

const wrap = (id: string, siteId: string) => `${id}|${siteId}`;
void wrap;

// ───────────────────────────── engine v2
let v2Pairs = new Map<string, { relationship: MatchRelationship; tier: Prediction['tier'] }>();
if (which === 'v2' || which === 'both') {
  global.gc?.();
  const rss0 = process.memoryUsage().rss;
  const t0 = Date.now();
  const r = runEngine(sources, competitors);
  const ms = Date.now() - t0;
  const mem = process.memoryUsage();
  v2Pairs = new Map(r.suggestions.map((s) => [`${s.sourceVariantId}|${s.competitorVariantId}`, { relationship: s.relationship, tier: s.tier }]));
  const actionable = r.suggestions.filter((s) => s.relationship === 'exact' || s.relationship === 'variant' || s.relationship === 'substitute');
  // pairs a person already decided are protected and are not work to do: the queue is what is left
  const decidedKeys = new Set(decisions.map((d) => d.source + '|' + d.competitor));
  const reviewLoad = actionable.filter((s) => (s.tier === 'strong' || s.tier === 'medium') && !decidedKeys.has(s.sourceVariantId + '|' + s.competitorVariantId));
  const perSite: Record<string, { suggestions: number; sourcesCovered: number }> = {};
  for (const c of new Set(competitors.map((x) => x.siteId))) {
    const forSite = actionable.filter((s) => s.competitorSiteId === c);
    perSite[siteName.get(c)!] = { suggestions: forSite.length, sourcesCovered: new Set(forSite.map((s) => s.sourceVariantId)).size };
  }
  const v2: Record<string, unknown> = {
    ms, rssMbBefore: Math.round(rss0 / 1048576), rssMbAfter: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576), corpus: r.corpus.stats,
    suggestions: r.stats.suggestions, byRelationship: r.stats.byRelationship, byTier: r.stats.byTier, candidatesLooked: r.stats.candidatesLooked, droppedAsNonMatch: r.stats.droppedAsNonMatch,
    topDropReasons: Object.entries(r.stats.droppedReasons).sort((a, b) => b[1] - a[1]).slice(0, 8),
    sourcesWithSuggestion: r.stats.sourcesWithSuggestion, sourcesWithoutSuggestion: r.stats.sources - r.stats.sourcesWithSuggestion,
    reviewQueue: reviewLoad.length, reviewPairsPer100SourceVariants: +((100 * reviewLoad.length) / Math.max(1, sources.length)).toFixed(1), reviewPairsPer100SourceProducts: +((100 * reviewLoad.length) / Math.max(1, sourceProducts)).toFixed(1),
    perWebsite: perSite,
  };
  report['v2'] = v2;
  console.log(`\nENGINE v2 (${ENGINE_VERSION}): ${ms} ms, heap ${v2['heapMb']} MB, rss ${v2['rssMbAfter']} MB`);
  console.log(`  suggestions ${r.stats.suggestions}  by relationship ${JSON.stringify(r.stats.byRelationship)}  by tier ${JSON.stringify(r.stats.byTier)}`);
  console.log(`  review queue (exact/variant/substitute, strong+medium, not already decided by a person): ${reviewLoad.length} = ${v2['reviewPairsPer100SourceProducts']} per 100 source products (${v2['reviewPairsPer100SourceVariants']} per 100 variants)`);
  console.log(`  source variants with no suggestion at all: ${v2['sourcesWithoutSuggestion']} of ${r.stats.sources}`);
  console.log(`  per website: ${JSON.stringify(perSite)}`);

  // candidate recall (retrieval alone, before any decision), measured on the labelled comparable pairs
  const corpus = r.corpus;
  const index = buildCandidateIndex(competitors.map((c) => corpus.byVariant.get(c.variantId)!), corpus);
  const retrieved = new Map<string, Map<string, string[]>>();
  const retrievalFor = (sourceId: string) => {
    let m = retrieved.get(sourceId);
    if (!m) {
      m = new Map();
      const hits = retrieveCandidates(corpus.byVariant.get(sourceId)!, index, corpus, DEFAULT_CANDIDATE_OPTIONS).sort((a, b) => b.score - a.score);
      for (const h of hits) m.set(h.competitor.siteId, [...(m.get(h.competitor.siteId) ?? []), h.competitor.variantId]);
      retrieved.set(sourceId, m);
    }
    return m;
  };
  const siteOf = new Map(rows.map((x) => [x.variantId, x.siteId]));
  const positives = labels.filter((l) => ['exact', 'variant', 'substitute'].includes(l.label));
  if (positives.length) {
    for (const set of ['dev', 'heldout'] as const) {
      const pos = positives.filter((l) => l.set === set).map((l) => ({ source: l.source, competitor: l.competitor, site: siteOf.get(l.competitor)! }));
      if (!pos.length) continue;
      const cr = candidateRecall(pos, retrievalFor, k);
      (report[`candidateRecall_${set}`] = cr);
      console.log(`  candidate recall @${k} per website (${set}): ${cr.hits}/${cr.total} = ${(100 * (cr.recall ?? 0)).toFixed(1)}%  (95% lower bound ${(100 * (cr.lower ?? 0)).toFixed(1)}%)`);
    }
  }

  // labelled accuracy, development and held-out kept apart
  for (const set of ['dev', 'heldout'] as const) {
    const L = labels.filter((l) => l.set === set);
    if (!L.length) continue;
    // a pair the engine never looked at is "not suggested"; one it looked at and dropped is a non-match; evaluate the pair directly when it was not retrieved
    const preds: Prediction[] = [];
    for (const l of L) {
      const hit = v2Pairs.get(`${l.source}|${l.competitor}`);
      if (hit) preds.push({ source: l.source, competitor: l.competitor, ...hit });
    }
    const rep = evaluate(L, preds);
    report[`labelled_${set}`] = { ...rep, strongFalse: rep.strongFalse.length, missed: rep.missed.length };
    console.log(`\n  LABELLED ${set.toUpperCase()}: ${rep.pairs} pairs, ${rep.positives} comparable`);
    console.log(`    strong tier        precision ${fmt(rep.strong.precision)} (lower bound ${fmt(rep.strong.precisionLower)})  recall ${fmt(rep.strong.recall)}  [${rep.strong.tp}/${rep.strong.predicted} suggested, ${rep.strong.positives} positives]`);
    console.log(`    strong + medium    precision ${fmt(rep.review.precision)}  recall ${fmt(rep.review.recall)}  F1 ${fmt(rep.review.f1)}  [${rep.review.tp}/${rep.review.predicted}]`);
    console.log(`    right kind as well precision ${fmt(rep.reviewExactKind.precision)}  recall ${fmt(rep.reviewExactKind.recall)}`);
    console.log(`    strong-tier errors ${rep.strongFalse.length}; missed ${rep.missed.length}`);
    const byL = labels.filter((l) => l.set === set && l.labeller);
    void byL;
  }

  // products with no genuine counterpart: how many got a suggestion that a person would be asked to confirm?
  if (noCounterpart.length) {
    const asked = noCounterpart.filter((id) => [...v2Pairs.entries()].some(([key, v]) => key.startsWith(`${id}|`) && ['exact', 'variant', 'substitute'].includes(v.relationship) && v.tier !== 'insufficient'));
    const strongAsked = noCounterpart.filter((id) => [...v2Pairs.entries()].some(([key, v]) => key.startsWith(`${id}|`) && ['exact', 'variant', 'substitute'].includes(v.relationship) && v.tier === 'strong'));
    report['noCounterpart'] = { products: noCounterpart.length, withSuggestion: asked.length, withStrongSuggestion: strongAsked.length, rate: asked.length / noCounterpart.length, upperBound95: 1 - wilsonLower(noCounterpart.length - asked.length, noCounterpart.length) };
    console.log(`\n  PRODUCTS WITH NO GENUINE COUNTERPART: ${noCounterpart.length}; engine suggested something to confirm for ${asked.length} (${((100 * asked.length) / noCounterpart.length).toFixed(1)}%), a strong suggestion for ${strongAsked.length}`);
  }

  // regression against what people already decided
  if (decisions.length) {
    const acc = decisions.filter((d) => d.status === 'accepted');
    const byKind: Record<string, { n: number; proposed: number; sameKind: number; anySuggestion: number }> = {};
    const titleOf = new Map(rows.map((r) => [r.variantId, r.title]));
    const lost: string[] = [];
    for (const d of acc) {
      const rel: MatchRelationship = d.relationship ?? relationshipOfClass((d.matchClass ?? 'identical') as never);
      const e = (byKind[rel] ??= { n: 0, proposed: 0, sameKind: 0, anySuggestion: 0 });
      e.n++;
      const hit = v2Pairs.get(`${d.source}|${d.competitor}`);
      if (hit) e.anySuggestion++;
      else if (lost.length < 12) lost.push(`${titleOf.get(d.source)} || ${titleOf.get(d.competitor)}`);
      if (hit && ['exact', 'variant', 'substitute'].includes(hit.relationship)) {
        e.proposed++;
        if (hit.relationship === rel) e.sameKind++;
      }
    }
    const rej = decisions.filter((d) => d.status === 'rejected').length;
    const total = acc.length;
    const prop = Object.values(byKind).reduce((a, x) => a + x.proposed, 0);
    const propAny = Object.values(byKind).reduce((a, x) => a + x.anySuggestion, 0);
    report['regression'] = { acceptedPairs: total, reproposed: prop, rate: prop / Math.max(1, total), lowerBound: wilsonLower(prop, total), reproposedInAnyRelationship: propAny, rateAny: propAny / Math.max(1, total), byKind, rejectedPairs: rej, notSuggestedAtAll: lost };
    console.log(`\n  REGRESSION on ${total} human-accepted pairs: the engine proposes ${prop} again (${((100 * prop) / Math.max(1, total)).toFixed(1)}%; 95% lower bound ${(100 * wilsonLower(prop, total)).toFixed(1)}%); by kind ${JSON.stringify(byKind)}`);
    console.log(`    ...counting a suggestion in ANY relationship (related / not enough information included): ${propAny}/${total} = ${((100 * propAny) / Math.max(1, total)).toFixed(1)}%`);
    if (lost.length) console.log(`    accepted pairs the engine does not suggest at all (first 12):\n      ${lost.join('\n      ')}`);
  }
}

// ───────────────────────────── the earlier engine
if (which === 'v1' || which === 'both') {
  const t0 = Date.now();
  const brands = collectKnownBrands(inputs);
  const prep = inputs.map((m) => ({ role: m.role, p: prepareVariant(m, brands) }));
  const cands = buildMatches(prep.filter((x) => x.role === 'source').map((x) => x.p), prep.filter((x) => x.role === 'competitor').map((x) => x.p)).filter((c) => c.matchClass !== 'not_comparable');
  const v1Pairs = new Map(cands.map((c) => [`${c.sourceVariantId}|${c.competitorVariantId}`, c]));
  const tally: Record<string, number> = {};
  for (const c of cands) tally[c.matchClass] = (tally[c.matchClass] ?? 0) + 1;
  report['v1'] = { ms: Date.now() - t0, suggestions: cands.length, byClass: tally };
  console.log(`\nENGINE v1 (earlier): ${Date.now() - t0} ms, ${cands.length} suggestions ${JSON.stringify(tally)}`);
  for (const set of ['dev', 'heldout'] as const) {
    const L = labels.filter((l) => l.set === set);
    if (!L.length) continue;
    const preds: Prediction[] = [];
    for (const l of L) {
      const c = v1Pairs.get(`${l.source}|${l.competitor}`);
      if (c) preds.push({ source: l.source, competitor: l.competitor, relationship: relationshipOfClass(c.matchClass), tier: c.confidence >= 0.85 ? 'strong' : 'medium' });
    }
    const rep = evaluate(L, preds);
    report[`labelled_v1_${set}`] = { strong: rep.strong, review: rep.review };
    console.log(`  LABELLED ${set.toUpperCase()} (v1): strong+medium precision ${fmt(rep.review.precision)} recall ${fmt(rep.review.recall)} [${rep.review.tp}/${rep.review.predicted}, ${rep.positives} comparable]`);
  }
  if (decisions.length) {
    const acc = decisions.filter((d) => d.status === 'accepted');
    const prop = acc.filter((d) => v1Pairs.has(`${d.source}|${d.competitor}`)).length;
    report['regression_v1'] = { acceptedPairs: acc.length, reproposed: prop, rate: prop / Math.max(1, acc.length) };
    console.log(`  REGRESSION (v1) on ${acc.length} human-accepted pairs: proposes ${prop} again (${((100 * prop) / Math.max(1, acc.length)).toFixed(1)}%)`);
  }
}

function fmt(x: number | null | undefined): string { return x === null || x === undefined ? 'n/a' : `${(100 * x).toFixed(1)}%`; }
void prf;
void evaluatePair;
void analyseCatalogue;
if (arg('out')) fs.writeFileSync(arg('out')!, JSON.stringify(report, null, 1));
