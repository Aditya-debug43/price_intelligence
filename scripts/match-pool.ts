/**
 * POOLED EVALUATION SAMPLE for the matching engines. Reads a dataset export (never a database) and writes the pairs a person should label.
 *
 *   npx tsx scripts/match-pool.ts --data export.json --sources 24 --seed 7 --filter "lighting|bulb|led" [--exclude-filter "mat|liner"] --out pool.json [--site-contains foodstore2go] [--exclude-site foodstore2go]
 *
 * Candidates come from retrievers that are NOT the matching engine, so a product the engine fails to find can still enter the sample:
 *   R1  title TF-IDF cosine (plain alphanumeric tokens), best per competitor website
 *   R2  rarest-token overlap (sum of IDF of shared tokens that are code-shaped or rare words), best per competitor website
 *   R3  a random product of each competitor website (a negative that nobody ranked)
 * The pool shows titles and variant summaries only — never an engine verdict — so labelling stays blind.
 * The unit is the PRODUCT pair (your product, a competitor's product); variants are summarised.
 */
import fs from 'node:fs';

interface Row { variantId: string; productId: string; siteId: string; role: 'source' | 'competitor'; site: string; title: string; variantTitle: string | null; brand: string | null; options: Record<string, string> | null }
const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const data = arg('data');
const out = arg('out');
if (!data || !out) { console.error('usage: tsx scripts/match-pool.ts --data export.json --out pool.json [--sources 24] [--seed 7] [--filter regex] [--exclude-filter regex] [--site-contains host] [--source-site host]'); process.exit(1); }
const nSources = Number(arg('sources', '24'));
let seed = Number(arg('seed', '7'));
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const filter = arg('filter') ? new RegExp(arg('filter')!, 'i') : null;
const exclude = arg('exclude-filter') ? new RegExp(arg('exclude-filter')!, 'i') : null;
const siteContains = arg('site-contains');
const sourceSite = arg('source-site');
const excludeSite = arg('exclude-site');
// enrich the sample with likely positives: keep only pairs that BOTH R1 and R2 retrieved; skip sources already pooled
const both = process.argv.includes('--both');
const skip = new Set<string>((arg('skip-pool') ?? '').split(',').filter(Boolean).flatMap((f) => (JSON.parse(fs.readFileSync(f, 'utf8')).pairs as { sourceProductId: string }[]).map((q) => q.sourceProductId)));

const rows = (JSON.parse(fs.readFileSync(data, 'utf8')).rows ?? JSON.parse(fs.readFileSync(data, 'utf8'))) as Row[];
interface Prod { id: string; site: string; siteId: string; role: string; title: string; brand: string | null; variants: string[]; n: number; tokens: string[] }
const byId = new Map<string, Prod>();
const tok = (s: string) => (s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[®™©]/g, ' ').match(/[a-z0-9]+(?:\/[a-z0-9]+)*/g) ?? []).flatMap((t) => t.split('/')).filter((t) => t.length > 1 && !/^(the|and|for|with|of|in|to|a|an|by|from|new|oz|pack|ct|pcs)$/.test(t));
for (const r of rows) {
  let p = byId.get(r.productId);
  if (!p) { p = { id: r.productId, site: r.site, siteId: r.siteId, role: r.role, title: r.title, brand: r.brand, variants: [], n: 0, tokens: tok(r.title) }; byId.set(r.productId, p); }
  p.n++;
  const v = [r.variantTitle && r.variantTitle.toLowerCase() !== 'default title' ? r.variantTitle : '', ...Object.values(r.options ?? {})].filter(Boolean).join(' / ');
  if (v && p.variants.length < 3 && !p.variants.includes(v)) p.variants.push(v);
}
const prods = [...byId.values()];
const df = new Map<string, number>();
for (const p of prods) for (const t of new Set(p.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
const N = prods.length;
const idf = (t: string) => Math.log(1 + N / (1 + (df.get(t) ?? 0)));
const vec = (p: Prod) => { const m = new Map<string, number>(); for (const t of new Set(p.tokens)) m.set(t, idf(t)); return { m, norm: Math.sqrt([...m.values()].reduce((a, b) => a + b * b, 0)) || 1 }; };
const vecs = new Map(prods.map((p) => [p.id, vec(p)]));
const cos = (a: Prod, b: Prod) => { const x = vecs.get(a.id)!, y = vecs.get(b.id)!; let d = 0; for (const [t, w] of x.m) { const o = y.m.get(t); if (o) d += w * o; } return d / (x.norm * y.norm); };
const isCode = (t: string) => /\d/.test(t) && /^[a-z]{0,4}\d{1,5}[a-z]{0,3}$/.test(t) && !/^(19|20)\d\d$/.test(t) && t.length >= 2;
const rare = (a: Prod, b: Prod) => { const sb = new Set(b.tokens); let s = 0; for (const t of new Set(a.tokens)) if (sb.has(t) && (isCode(t) || (df.get(t) ?? 0) <= 0.01 * N)) s += idf(t) * (isCode(t) ? 2 : 1); return s; };

const sources = prods.filter((p) => p.role === 'source' && !skip.has(p.id) && (!sourceSite || p.site.includes(sourceSite)) && (!filter || filter.test(p.title)) && (!exclude || !exclude.test(p.title)));
const chosen = [...sources].map((p) => [rnd(), p] as const).sort((a, b) => a[0] - b[0]).slice(0, nSources).map((x) => x[1]);
const compSites = [...new Set(prods.filter((p) => p.role === 'competitor' && (!siteContains || p.site.includes(siteContains)) && (!excludeSite || !p.site.includes(excludeSite))).map((p) => p.site))];
const pairs: { n: number; sourceProductId: string; competitorProductId: string; via: string[] }[] = [];
let n = 0;
for (const s of chosen) {
  for (const site of compSites) {
    const cands = prods.filter((p) => p.role === 'competitor' && p.site === site);
    const picks = new Map<string, Set<string>>();
    const add = (p: Prod | undefined, via: string) => { if (!p) return; const set = picks.get(p.id) ?? new Set<string>(); set.add(via); picks.set(p.id, set); };
    add([...cands].sort((a, b) => cos(s, b) - cos(s, a))[0], 'R1');
    add([...cands].map((c) => [rare(s, c), c] as const).sort((a, b) => b[0] - a[0]).find(([sc]) => sc > 0)?.[1], 'R2');
    add(cands[Math.floor(rnd() * cands.length)], 'R3');
    for (const [id, via] of picks) if (!both || (via.has('R1') && via.has('R2'))) pairs.push({ n: ++n, sourceProductId: s.id, competitorProductId: id, via: [...via] });
  }
}
fs.writeFileSync(out, JSON.stringify({ seed: arg('seed', '7'), pairs }, null, 1));
const show = (p: Prod) => `${p.title.slice(0, 118)} [${p.n}v${p.variants.length ? ': ' + p.variants.map((v) => v.slice(0, 40)).join(' ¦ ') : ''}]`;
let last = '';
for (const q of pairs) {
  const s = byId.get(q.sourceProductId)!, c = byId.get(q.competitorProductId)!;
  if (q.sourceProductId !== last) { console.log(`\n### ${s.site} :: ${show(s)}`); last = q.sourceProductId; }
  console.log(`  #${q.n} ${c.site.replace('.com', '').replace('www.', '').slice(0, 12).padEnd(12)} ${q.via.join('')}  ${show(c)}`);
}
console.log(`\n${pairs.length} pairs, ${chosen.length} sources, ${compSites.length} competitor websites`);
