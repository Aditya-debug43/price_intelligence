/**
 * Builds the evaluation set (fixtures/matching/eval-v1/eval-set.json) from the pooled samples and the labels a person wrote for them.
 *
 *   npx tsx scripts/match-eval-build.ts --pools-dir <dir with pool-*.json and labels-*.json> --auto-data dataset-adi.json --grocery-data dataset-Aditya.json --out fixtures/matching/eval-v1/eval-set.json
 *
 * The set is at PRODUCT-PAIR level (your product, a competitor's product) and records which part is for tuning ("dev") and which is never to be
 * tuned on ("heldout": the grocery website foodstore2go.com and the non-lighting automotive category). It also lists the products with no genuine
 * counterpart, found by an independent keyword search of the competitors' catalogues, not by looking at what any matcher said.
 */
import fs from 'node:fs';
import path from 'node:path';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const dir = arg('pools-dir')!, autoData = arg('auto-data')!, grocData = arg('grocery-data')!, out = arg('out')!;
if (!dir || !autoData || !grocData || !out) { console.error('usage: see header'); process.exit(1); }

interface Row { productId: string; siteId: string; role: string; site: string; title: string; variantTitle: string | null; variantId: string }
const load = (f: string) => (JSON.parse(fs.readFileSync(f, 'utf8')).rows ?? []) as Row[];
const products = new Map<string, { id: string; site: string; role: string; title: string; variants: string[] }>();
for (const r of [...load(autoData), ...load(grocData)]) {
  const p = products.get(r.productId) ?? { id: r.productId, site: r.site, role: r.role, title: r.title, variants: [] as string[] };
  products.set(r.productId, p);
}

const POOLS: Record<string, { file: string; labelsFile: string; domain: 'automotive' | 'grocery'; split: (n: number, lightingPairs: number[]) => 'dev' | 'heldout'; stratum: string }> = {
  'auto-dev': { file: 'pool-auto-dev.json', labelsFile: 'labels-auto-dev.json', domain: 'automotive', split: () => 'dev', stratum: 'independent pool (TF-IDF, rare tokens, random)' },
  'auto-dev2': { file: 'pool-auto-dev2.json', labelsFile: 'labels-pools-2.json', domain: 'automotive', split: () => 'dev', stratum: 'enriched (found by two retrievers)' },
  'auto-heldoutcat': { file: 'pool-auto-heldoutcat.json', labelsFile: 'labels-pools-1.json', domain: 'automotive', split: (n, l) => (l.includes(n) ? 'dev' : 'heldout'), stratum: 'independent pool, non-lighting category' },
  'groc-dev': { file: 'pool-groc-dev.json', labelsFile: 'labels-pools-1.json', domain: 'grocery', split: () => 'dev', stratum: 'independent pool' },
  'groc-dev2': { file: 'pool-groc-dev2.json', labelsFile: 'labels-pools-2.json', domain: 'grocery', split: () => 'dev', stratum: 'enriched (found by two retrievers)' },
  'groc-heldoutsite': { file: 'pool-groc-heldoutsite.json', labelsFile: 'labels-pools-1.json', domain: 'grocery', split: () => 'heldout', stratum: 'independent pool, held-out website' },
  'groc-heldoutsite2': { file: 'pool-groc-heldoutsite2.json', labelsFile: 'labels-pools-2.json', domain: 'grocery', split: () => 'heldout', stratum: 'enriched, held-out website' },
};
const parseLabels = (s: string) => Object.fromEntries(s.trim().split(/\s+/).map((x) => x.split(':') as [string, string]));
const pairs: Record<string, unknown>[] = [];
for (const [name, cfg] of Object.entries(POOLS)) {
  const pool = JSON.parse(fs.readFileSync(path.join(dir, cfg.file), 'utf8')).pairs as { n: number; sourceProductId: string; competitorProductId: string; via: string[] }[];
  const lf = JSON.parse(fs.readFileSync(path.join(dir, cfg.labelsFile), 'utf8'));
  const sec = lf.pools ? lf.pools[name] : lf;
  const labels = parseLabels(sec.labels);
  const lighting: number[] = sec.lightingSourcePairs ?? [];
  for (const q of pool) {
    const label = labels[String(q.n)];
    if (!label) throw new Error(`${name} #${q.n} has no label`);
    const s = products.get(q.sourceProductId)!, c = products.get(q.competitorProductId)!;
    pairs.push({ id: `${name}#${q.n}`, domain: cfg.domain, set: cfg.split(q.n, lighting), stratum: cfg.stratum, sourceProductId: q.sourceProductId, competitorProductId: q.competitorProductId, sourceTitle: s.title, competitorTitle: c.title, competitorSite: c.site, label, uncertain: (sec.uncertain ?? []).includes(q.n), via: q.via });
  }
}

// products with no genuine counterpart: your non-lighting automotive products whose KIND no competitor sells at all (independent keyword search)
const KINDS: [string, RegExp][] = [
  ['floor / cargo mat or liner', /floor ?mat|cargo (mat|liner)|\bliners?\b|seat ?back mat/i],
  ['bed or tailgate mat', /bed mat|tailgate mat|truck bed mat/i],
  ['running board / side step', /running boards?|side steps?|nerf bar/i],
  ['seat cover', /seat covers?/i],
  ['mud flap / splash guard', /mud ?flaps?|splash guards?/i],
];
const comp = [...products.values()].filter((p) => p.role === 'competitor');
const noCounterpart: { productId: string; title: string; kind: string }[] = [];
for (const [kind, re] of KINDS) {
  if (comp.some((c) => re.test(c.title))) continue;
  for (const p of products.values()) if (p.role === 'source' && re.test(p.title)) noCounterpart.push({ productId: p.id, title: p.title, kind });
}
const byKind = Object.fromEntries(KINDS.map(([k]) => [k, noCounterpart.filter((x) => x.kind === k).length]));
const count = (f: (p: Record<string, unknown>) => boolean) => pairs.filter(f).length;
const pos = (p: Record<string, unknown>) => ['E', 'V', 'S'].includes(p['label'] as string);
const summary = {
  pairs: pairs.length, dev: count((p) => p.set === 'dev'), heldout: count((p) => p.set === 'heldout'),
  positives: count(pos), positivesDev: count((p) => p.set === 'dev' && pos(p)), positivesHeldout: count((p) => p.set === 'heldout' && pos(p)),
  uncertain: count((p) => !!p.uncertain), byLabel: Object.fromEntries(['E', 'V', 'S', 'R', 'I', 'N'].map((l) => [l, count((p) => p.label === l)])), noCounterpartProducts: noCounterpart.length, noCounterpartByKind: byKind,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ version: 'eval-v1', labeller: 'assistant-1 (single reviewer; see review-sample for the independent audit)', summary, pairs, noCounterpart }, null, 1));
console.log(JSON.stringify(summary, null, 1));
