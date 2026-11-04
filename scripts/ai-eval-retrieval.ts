/**
 * OFFLINE measurement of candidate discovery: does the competitor product that a reviewer judged to be a match appear in the shortlist an AI model would be asked about?
 * Reads dataset and label files; never touches a database, the network or any production record.
 *
 *   npx tsx scripts/ai-eval-retrieval.ts --data export.json --labels eval-set.json [--labels fresh.json] --domain automotive|grocery [--decisions] [--max-variants 30]
 *
 * "Recall @K" = the share of reviewed pairs whose competitor PRODUCT is among the top K products of its website for at least one variant of the source product
 * (product-level, because the reviewed pairs are product pairs). Two rankings are compared on the same pairs:
 *   baseline  the rule engine's retrieval (token score, 25 per website + extras), products ranked by their best variant's score
 *   new       the multi-method fused retrieval of packages/core/src/ai/retrieval.ts
 * --decisions also measures the pairs a person accepted (variant level, in the dataset's own `decisions`): those are human labels.
 */
import fs from 'node:fs';
import {
  analyseCatalogue, buildCandidateIndex, buildRetrievalIndex, DEFAULT_CANDIDATE_OPTIONS, isPlaceholderBrand, placeholderBrandKeys, retrieveCandidates, retrieveShortlist, sizeHintOf, type DossierInput,
} from '@ci/core';

interface Row { variantId: string; productId: string; siteId: string; role: 'source' | 'competitor'; site?: string; title: string; variantTitle: string | null; brand: string | null; category: string | null; gtin: string | null; sku: string | null; mpn: string | null; model: string | null; qtyLabel: string | null; attrs: Record<string, unknown> | null; options?: Record<string, string> | null }
interface LabelPair { id: string; domain: string; set: string; sourceProductId: string; competitorProductId: string; competitorSite: string; label: string; uncertain?: boolean }

const arg = (name: string, d?: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; };
const all = (name: string) => process.argv.flatMap((a, i) => (a === `--${name}` ? [process.argv[i + 1]!] : []));
const dataPath = arg('data');
const domain = arg('domain');
if (!dataPath || !domain) { console.error('usage: tsx scripts/ai-eval-retrieval.ts --data export.json --labels labels.json [--labels more.json] --domain automotive|grocery [--decisions] [--max-variants 30]'); process.exit(1); }
const maxVariants = Number(arg('max-variants', '30'));
const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as { rows: Row[]; decisions?: { source: string; competitor: string; status: string }[] };
const rows = raw.rows;
const KS = [1, 2, 3, 4, 6, 10];
const tags = (a: Record<string, unknown> | null | undefined) => (Array.isArray(a?.['tags']) ? (a!['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : []);
const placeholders = placeholderBrandKeys(rows.map((r) => ({ siteId: r.siteId, brand: r.brand, title: r.title })));
const inputs: (DossierInput & { role: 'source' | 'competitor' })[] = rows.map((r) => ({
  variantId: r.variantId, productId: r.productId, siteId: r.siteId, role: r.role, title: r.title, variantTitle: r.variantTitle, brand: isPlaceholderBrand(placeholders, r.siteId, r.brand) ? null : r.brand, category: r.category, gtin: r.gtin, sku: r.sku,
  mpn: r.mpn, model: r.model, sizeHints: [r.qtyLabel, sizeHintOf(r.attrs)], context: tags(r.attrs).join(' ') || null, options: r.options ?? {}, tags: tags(r.attrs),
}));
const sourceIds = new Set(inputs.filter((i) => i.role === 'source').map((i) => i.variantId));
const variantsOf = new Map<string, string[]>();
for (const r of rows) if (r.role === 'source') (variantsOf.get(r.productId) ?? variantsOf.set(r.productId, []).get(r.productId)!).push(r.variantId);
const rowOf = new Map(rows.map((r) => [r.variantId, r]));
const siteName = new Map(rows.map((r) => [r.siteId, r.site ?? r.siteId.slice(0, 6)]));

const t0 = Date.now();
const corpus = analyseCatalogue(inputs);
const compDossiers = inputs.filter((i) => i.role === 'competitor').map((c) => corpus.byVariant.get(c.variantId)!);
const baseIndex = buildCandidateIndex(compDossiers, corpus, DEFAULT_CANDIDATE_OPTIONS);
const t1 = Date.now();
const newIndex = buildRetrievalIndex(compDossiers, corpus);
const t2 = Date.now();
console.log(`${domain}: ${rows.length} variants; corpus ${t1 - t0} ms; new index ${t2 - t1} ms`);

/** The rank (1 = best) of each competitor product within its website, for one source variant. */
function baselineRanks(sv: string): Map<string, number> {
  const best = new Map<string, { score: number; site: string }>();
  for (const r of retrieveCandidates(corpus.byVariant.get(sv)!, baseIndex, corpus, DEFAULT_CANDIDATE_OPTIONS)) {
    const cur = best.get(r.competitor.productId);
    if (!cur || r.score > cur.score) best.set(r.competitor.productId, { score: r.score, site: r.competitor.siteId });
  }
  return rankWithinSites(best);
}
const extraOpts = arg('opts') ? (JSON.parse(arg('opts')!) as Record<string, unknown>) : {};
function newRanks(sv: string, opts: { perSiteProducts: number }): { ranks: Map<string, number>; size: number } {
  const sl = retrieveShortlist(newIndex, corpus.byVariant.get(sv)!, { ...opts, ...extraOpts });
  const ranks = new Map<string, number>();
  for (const c of sl) ranks.set(c.productId, c.siteRank);
  return { ranks, size: sl.length };
}
function rankWithinSites(best: Map<string, { score: number; site: string }>): Map<string, number> {
  const bySite = new Map<string, [string, number][]>();
  for (const [p, v] of best) (bySite.get(v.site) ?? bySite.set(v.site, []).get(v.site)!).push([p, v.score]);
  const out = new Map<string, number>();
  for (const list of bySite.values()) list.sort((a, b) => b[1] - a[1]).forEach(([p], i) => out.set(p, i + 1));
  return out;
}

interface Result { label: string; site: string; base: number; fresh: number; sp?: string; cp?: string }
const results: Result[] = [];
const sizes = { base: [] as number[], fresh: [] as number[] };
let tNew = 0;
let nVariants = 0;
function evalPair(sp: string, cp: string, label: string, site: string) {
  let base = Infinity;
  let fresh = Infinity;
  const vs = (variantsOf.get(sp) ?? []).slice(0, maxVariants);
  for (const sv of vs) {
    const b = baselineRanks(sv).get(cp);
    if (b !== undefined) base = Math.min(base, b);
    const s = Date.now();
    const n = newRanks(sv, { perSiteProducts: 10 });
    tNew += Date.now() - s;
    nVariants++;
    const f = n.ranks.get(cp);
    if (f !== undefined) fresh = Math.min(fresh, f);
  }
  results.push({ label, site, base, fresh, sp, cp });
}

const labelFiles = all('labels');
const pairs: LabelPair[] = labelFiles.flatMap((f) => (JSON.parse(fs.readFileSync(f, 'utf8')) as { pairs: LabelPair[] }).pairs).filter((p) => p.domain === domain && variantsOf.has(p.sourceProductId));
const seen = new Set<string>();
for (const p of pairs.filter((x) => ['E', 'V', 'S'].includes(x.label))) {
  const key = `${p.sourceProductId}|${p.competitorProductId}`;
  if (seen.has(key)) continue;
  seen.add(key);
  evalPair(p.sourceProductId, p.competitorProductId, `assistant-labelled ${p.label}${p.uncertain ? ' (uncertain)' : ''}`, p.competitorSite);
}
const assistantResults = results.slice();

const decisionResults: Result[] = [];
if (process.argv.includes('--decisions') && raw.decisions?.length) {
  const accepted = raw.decisions.filter((d) => d.status === 'accepted' && sourceIds.has(d.source));
  const sample = accepted.filter((_, i) => i % Math.max(1, Math.floor(accepted.length / 300)) === 0).slice(0, 300);
  for (const d of sample) {
    const s = rowOf.get(d.source)!;
    const c = rowOf.get(d.competitor);
    if (!c) continue;
    const base = baselineRanks(d.source).get(c.productId) ?? Infinity;
    const n = newRanks(d.source, { perSiteProducts: 10 });
    nVariants++;
    decisionResults.push({ label: 'accepted by the owner', site: siteName.get(c.siteId)!, base, fresh: n.ranks.get(c.productId) ?? Infinity });
    void s;
  }
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
function table(name: string, rs: Result[]) {
  if (!rs.length) return;
  console.log(`\n${name}: ${rs.length} reviewed pairs`);
  console.log(`  ${'K products/site'.padEnd(18)} ${KS.map((k) => `@${k}`.padStart(8)).join('')}`);
  console.log(`  ${'baseline'.padEnd(18)} ${KS.map((k) => pct(rs.filter((r) => r.base <= k).length, rs.length).padStart(8)).join('')}   (any rank: ${pct(rs.filter((r) => Number.isFinite(r.base)).length, rs.length)})`);
  console.log(`  ${'new retrieval'.padEnd(18)} ${KS.map((k) => pct(rs.filter((r) => r.fresh <= k).length, rs.length).padStart(8)).join('')}   (any rank: ${pct(rs.filter((r) => Number.isFinite(r.fresh)).length, rs.length)})`);
  for (const site of [...new Set(rs.map((r) => r.site))].sort()) {
    const g = rs.filter((r) => r.site === site);
    console.log(`  ${site.padEnd(18)} n=${String(g.length).padStart(3)} | baseline ${[1, 3, 6].map((k) => `@${k} ${pct(g.filter((r) => r.base <= k).length, g.length)}`).join(' ')} | new ${[1, 3, 6].map((k) => `@${k} ${pct(g.filter((r) => r.fresh <= k).length, g.length)}`).join(' ')}`);
  }
}
table(`ASSISTANT-LABELLED genuine pairs (E/V/S) — ${domain}`, assistantResults);
// source-level: for a product of yours and a competitor website with at least one genuine counterpart, is ANY genuine counterpart in the top K? (one of many equally valid alternatives is enough)
{
  const groups = new Map<string, Result>();
  for (const r of assistantResults) {
    const k = `${r.sp}|${r.site}`;
    const g = groups.get(k);
    if (!g) groups.set(k, { ...r });
    else { g.base = Math.min(g.base, r.base); g.fresh = Math.min(g.fresh, r.fresh); }
  }
  const gs = [...groups.values()];
  console.log(`
SOURCE-LEVEL hit rate (${gs.length} product × website groups with a genuine counterpart; one genuine counterpart in the top K is a hit)`);
  console.log(`  ${'K products/site'.padEnd(18)} ${KS.map((k) => `@${k}`.padStart(8)).join('')}`);
  console.log(`  ${'baseline'.padEnd(18)} ${KS.map((k) => pct(gs.filter((r) => r.base <= k).length, gs.length).padStart(8)).join('')}`);
  console.log(`  ${'new retrieval'.padEnd(18)} ${KS.map((k) => pct(gs.filter((r) => r.fresh <= k).length, gs.length).padStart(8)).join('')}`);
}
for (const lab of ['exact', 'variant', 'substitute']) void lab;
table(`PERSON-ACCEPTED pairs (the owner's own decisions) — ${domain}`, decisionResults);
console.log(`\nnew retrieval: ${nVariants} source variants shortlisted in ${tNew} ms (${(tNew / Math.max(1, nVariants)).toFixed(1)} ms each)`);
void sizes;

if (process.argv.includes('--debug')) {
  const titleOf = (productId: string) => rows.find((r) => r.productId === productId)?.title.slice(0, 90) ?? '?';
  for (const r of assistantResults.filter((x) => x.fresh > 4)) {
    console.log(`\n[new rank ${Number.isFinite(r.fresh) ? r.fresh : "none"} | baseline ${Number.isFinite(r.base) ? "@" + r.base : "none"}] ${r.label} (${r.site}) new rank ${Number.isFinite(r.fresh) ? r.fresh : 'none'}\n   YOURS : ${titleOf(r.sp!)}\n   THEIRS: ${titleOf(r.cp!)}`);
    const vs = variantsOf.get(r.sp!) ?? [];
    const cpVariants = rows.filter((x) => x.productId === r.cp);
    const dS = corpus.byVariant.get(vs[0]!)!;
    console.log(`   source dossier: codes [${dS.codes.join(' ')}] subject [${dS.subject.join(' ')}] words ${dS.words.slice(0, 12).join(' ')} | candidate variant codes [${corpus.byVariant.get(cpVariants[0]!.variantId)!.codes.join(' ')}] words ${corpus.byVariant.get(cpVariants[0]!.variantId)!.words.slice(0, 12).join(' ')}`);
  }
}
