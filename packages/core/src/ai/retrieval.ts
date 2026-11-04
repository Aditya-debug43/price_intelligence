import { buildCandidateIndex, retrieveCandidates, type CandidateIndex } from '../match/candidates.ts';
import { fitmentYears, type Corpus } from '../match/corpus.ts';
import { evaluatePair, type PairEvaluation } from '../match/evidence.ts';
import type { Dossier } from '../match/dossier.ts';

/**
 * Candidate discovery for AI-assisted matching (pure: no database, network or clock).
 *
 * The rule engine keeps about 25 candidates per competitor website, ranked by one token score, so a genuine match can be crowded out by hundreds of similar variants
 * before anything judges it. This module searches the WHOLE competitor catalogue with several independent methods, fuses their rankings (reciprocal-rank fusion) and then
 * keeps a SMALL, DIVERSE shortlist per competitor website: at most one variant of each competitor product, and a fixed number of products per website, so that one
 * website's many near-identical listings cannot push out another product or another website. The shortlist is what an AI model is asked about; everything here is local.
 *
 * Every candidate carries which methods found it (and the evidence they found), so a reviewer can see why it was suggested.
 */

export type RetrievalMethod = 'identifier' | 'code' | 'fitment' | 'spec' | 'keywords' | 'text' | 'type' | 'rules' | 'semantic';

export interface RetrievalOptions {
  /** Competitor PRODUCTS kept per competitor website (each represented by its best variant). */
  perSiteProducts: number;
  /** Products per website that are looked at (and judged by the rule engine's evidence) before the best `perSiteProducts` are chosen. */
  poolPerSite: number;
  /** Variants of one competitor product that go through the rule engine's evidence check: the best VARIANT (the right size, the right position) is chosen by evidence, not by how well its title matched the text search. */
  variantsPerProduct: number;
  /** Candidates the rule engine finds decisively incompatible (a different part code, vehicle, period, voltage…) are left out: an AI verdict could not override them anyway. */
  dropHardConflicts: boolean;
  /** How deep each method's own ranking goes before fusion. */
  perMethod: number;
  /** 'sum': each method's scores are scaled to its best hit and added with the weights (a decisive signal such as a shared code keeps its weight); 'rrf': reciprocal-rank fusion. */
  fusion: 'sum' | 'rrf';
  /** Reciprocal-rank-fusion constant: larger = a deep rank still counts. */
  rrfK: number;
  weights: Record<RetrievalMethod, number>;
  /** Maximal-marginal-relevance trade-off inside one website's shortlist: 0 = the best products only, higher = more different from each other. */
  diversity: number;
}

export const DEFAULT_RETRIEVAL_OPTIONS: RetrievalOptions = {
  perSiteProducts: 4,
  poolPerSite: 30,
  variantsPerProduct: 3,
  dropHardConflicts: true,
  perMethod: 80,
  fusion: 'sum',
  rrfK: 30,
  weights: { identifier: 3, code: 1.5, fitment: 1, spec: 0.5, keywords: 1.2, text: 0.8, type: 0.5, rules: 1.2, semantic: 1.2 },
  diversity: 0.25,
};

export interface FoundBy {
  method: RetrievalMethod;
  /** 1-based rank within that method. */
  rank: number;
  /** What it matched on, in plain words ("codes H11, HB3"). */
  detail: string;
}

export interface AiCandidate {
  variantId: string;
  productId: string;
  siteId: string;
  /** Fused score (higher first). Never shown as a probability. */
  score: number;
  foundBy: FoundBy[];
  /** Position among this website's shortlist (1 = best). */
  siteRank: number;
  /** What the rule engine's evidence says about the pair (computed once here, reused for the guard and the display). */
  engine: PairEvaluation | null;
}

export interface ShortlistStats {
  /** Products per website that were judged before choosing. */
  considered: number;
  /** Left out because the rule engine found a decisive incompatibility. */
  droppedHardConflict: number;
}

export interface SemanticHit {
  variantId: string;
  score: number;
}

interface Doc {
  d: Dossier;
  tokens: string[];
  tri: Set<string>;
}

export interface RetrievalIndex {
  docs: Doc[];
  at: Map<string, number>;
  postings: Map<string, number[]>;
  idf: Map<string, number>;
  avgLen: number;
  triPostings: Map<string, number[]>;
  byCode: Map<string, number[]>;
  bySubject: Map<string, number[]>;
  bySpec: Map<string, number[]>;
  byType: Map<string, number[]>;
  byGtin: Map<string, number[]>;
  byMpn: Map<string, number[]>;
  /** The rule engine's own candidate index: its ranking is one more method, so nothing the rule engine would have found is lost. */
  rules: CandidateIndex;
  corpus: Corpus;
  n: number;
}

const push = <K>(m: Map<K, number[]>, k: K, v: number) => {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** A text for character-level similarity: the listing as written, without years and quantities that only add noise. */
const textOf = (d: Dossier) => norm(`${d.title} ${Object.values(d.axes ?? {}).join(' ')}`).replace(/\b(19|20)\d\d\b/g, ' ').replace(/\s+/g, ' ');

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Spec keys bucketed so that figures within about 10 % fall into neighbouring buckets (power 30 W and 32 W find each other). */
const bucket = (v: number) => Math.round(Math.log(Math.max(v, 1e-6)) / Math.log(1.12));
const SPEC_BUCKETED = new Set(['power_w', 'light_lm', 'colour_temp_k']);
const specKeys = (d: Dossier): string[] => d.specs.filter((s) => SPEC_BUCKETED.has(s.key)).map((s) => `${s.key}:${bucket(s.value)}`);
const typeKeys = (d: Dossier): string[] => [...d.kindWords.map((w) => `k:${w}`), ...d.position.map((w) => `p:${w}`), ...(d.category ? d.category.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3).map((w) => `c:${w}`) : [])];
/** "F-250" and "250" name the same model. */
const subjectKey = (t: string) => t.replace(/^[a-z]{1,2}(?=\d{3,4}$)/, '');
const tokensOf = (d: Dossier): string[] => [...new Set([...d.words, ...d.codes.map((c) => `c:${c}`), ...d.subject.map((s) => `s:${s}`)])];

export function buildRetrievalIndex(competitors: Dossier[], corpus: Corpus): RetrievalIndex {
  const docs: Doc[] = competitors.map((d) => ({ d, tokens: tokensOf(d), tri: trigrams(textOf(d)) }));
  const at = new Map(docs.map((x, i) => [x.d.variantId, i]));
  const postings = new Map<string, number[]>();
  const triPostings = new Map<string, number[]>();
  const byCode = new Map<string, number[]>();
  const bySubject = new Map<string, number[]>();
  const bySpec = new Map<string, number[]>();
  const byType = new Map<string, number[]>();
  const byGtin = new Map<string, number[]>();
  const byMpn = new Map<string, number[]>();
  let total = 0;
  docs.forEach((x, i) => {
    total += x.tokens.length;
    for (const t of x.tokens) push(postings, t, i);
    for (const g of x.tri) push(triPostings, g, i);
    for (const c of x.d.codes) push(byCode, c, i);
    for (const s of new Set(x.d.subject.map(subjectKey))) push(bySubject, s, i);
    for (const k of specKeys(x.d)) push(bySpec, k, i);
    for (const k of typeKeys(x.d)) push(byType, k, i);
    if (x.d.identifiers.gtin) push(byGtin, x.d.identifiers.gtin.value, i);
    if (x.d.identifiers.mpn && x.d.brand.key) push(byMpn, `${x.d.brand.key}|${x.d.identifiers.mpn.value}`, i);
  });
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const [t, p] of postings) idf.set(t, Math.log(1 + (n - p.length + 0.5) / (p.length + 0.5)));
  return { docs, at, postings, idf, avgLen: total / Math.max(1, n), triPostings, byCode, bySubject, bySpec, byType, byGtin, byMpn, rules: buildCandidateIndex(competitors, corpus), corpus, n };
}

interface Ranked {
  doc: number;
  score: number;
  detail: string;
}

const topN = (scores: Map<number, { s: number; detail: string }>, n: number): Ranked[] =>
  [...scores.entries()]
    .map(([doc, v]) => ({ doc, score: v.s, detail: v.detail }))
    .sort((a, b) => b.score - a.score || a.doc - b.doc)
    .slice(0, n);

/** Every method returns its own ranking. Pure functions of the index and the source dossier. */
function rankings(ix: RetrievalIndex, s: Dossier, o: RetrievalOptions, semantic: SemanticHit[] | null): Partial<Record<RetrievalMethod, Ranked[]>> {
  const out: Partial<Record<RetrievalMethod, Ranked[]>> = {};

  // identifier: the same barcode, or the same brand + manufacturer part number
  const idHits = new Map<number, { s: number; detail: string }>();
  if (s.identifiers.gtin) for (const i of ix.byGtin.get(s.identifiers.gtin.value) ?? []) idHits.set(i, { s: 10, detail: `barcode ${s.identifiers.gtin.value}` });
  if (s.identifiers.mpn && s.brand.key) for (const i of ix.byMpn.get(`${s.brand.key}|${s.identifiers.mpn.value}`) ?? []) idHits.set(i, { s: Math.max(8, idHits.get(i)?.s ?? 0), detail: `brand and part number ${s.identifiers.mpn.value}` });
  if (idHits.size) out.identifier = topN(idHits, o.perMethod);

  // code: shared identity codes, weighted by how rare the code is
  const codeHits = new Map<number, { s: number; detail: string; shared: string[] }>();
  for (const c of s.codes) {
    const w = ix.corpus.idf(`c:${c}`) || 1;
    for (const i of ix.byCode.get(c) ?? []) {
      const h = codeHits.get(i) ?? { s: 0, detail: '', shared: [] };
      h.s += w;
      h.shared.push(c.toUpperCase());
      codeHits.set(i, h);
    }
  }
  if (codeHits.size) {
    // inside a large pool of same-code listings, prefer the ones that also share words (vehicle, kind), so the pool is ranked by similarity rather than by position
    const bm = bm25(ix, s);
    const m = new Map<number, { s: number; detail: string }>();
    for (const [i, h] of codeHits) m.set(i, { s: h.s + 0.05 * (bm.get(i) ?? 0), detail: `part code${h.shared.length > 1 ? 's' : ''} ${h.shared.slice(0, 4).join(', ')}` });
    out.code = topN(m, o.perMethod);
  }

  // fitment: the same vehicle words with overlapping years
  if (s.subject.length) {
    const fit = s.fitment ? fitmentYears(s.fitment) : null;
    const hits = new Map<number, { s: number; detail: string; shared: string[] }>();
    for (const w of new Set(s.subject.map(subjectKey))) {
      const weight = ix.corpus.idf(`w:${w}`) || ix.corpus.idf(`c:${w}`) || 1;
      for (const i of ix.bySubject.get(w) ?? []) {
        const h = hits.get(i) ?? { s: 0, detail: '', shared: [] };
        h.s += weight;
        h.shared.push(w);
        hits.set(i, h);
      }
    }
    const m = new Map<number, { s: number; detail: string }>();
    for (const [i, h] of hits) {
      const d = ix.docs[i]!.d;
      let years = 0.5;
      if (fit && d.fitment) {
        const y = fitmentYears(d.fitment);
        let shared = 0;
        for (const v of y) if (fit.has(v)) shared++;
        years = shared / Math.max(1, Math.min(fit.size, y.size));
      }
      if (years === 0) continue;
      m.set(i, { s: h.s * (0.4 + 0.6 * years), detail: `vehicle ${h.shared.slice(0, 3).join(' ')}${fit && d.fitment ? ' with overlapping years' : ''}` });
    }
    if (m.size) out.fitment = topN(m, o.perMethod);
  }

  // spec: power, light output and colour temperature within about 10 %
  const sk = specKeys(s);
  if (sk.length) {
    const hits = new Map<number, { s: number; detail: string; keys: string[] }>();
    for (const k of sk) {
      const [name, b] = k.split(':') as [string, string];
      for (const nb of [Number(b) - 1, Number(b), Number(b) + 1]) for (const i of ix.bySpec.get(`${name}:${nb}`) ?? []) {
        const h = hits.get(i) ?? { s: 0, detail: '', keys: [] };
        if (!h.keys.includes(name)) { h.s += 1; h.keys.push(name); }
        hits.set(i, h);
      }
    }
    const bm = bm25(ix, s);
    const m = new Map<number, { s: number; detail: string }>();
    for (const [i, h] of hits) m.set(i, { s: h.s + 0.02 * (bm.get(i) ?? 0), detail: `similar ${h.keys.map((x) => x.replace('_w', ' power').replace('_lm', ' light output').replace('_k', '')).join(', ')}` });
    out.spec = topN(m, o.perMethod);
  }

  // keywords: BM25 over descriptive words, codes and vehicle words (rare words count most)
  const bm = bm25(ix, s);
  const kw = new Map<number, { s: number; detail: string }>();
  for (const [i, v] of bm) kw.set(i, { s: v, detail: sharedWords(ix, s, i) });
  out.keywords = topN(kw, o.perMethod);

  // text: character-level similarity of the two listings (spelling variants, joined words, model names)
  const tri = trigrams(textOf(s));
  const counts = new Map<number, number>();
  for (const g of tri) {
    const p = ix.triPostings.get(g);
    if (!p || p.length > ix.n * 0.3) continue;
    for (const i of p) counts.set(i, (counts.get(i) ?? 0) + 1);
  }
  const tx = new Map<number, { s: number; detail: string }>();
  for (const [i, c] of counts) {
    const dice = (2 * c) / (tri.size + ix.docs[i]!.tri.size);
    if (dice >= 0.18) tx.set(i, { s: dice, detail: `similar wording (${Math.round(dice * 100)} %)` });
  }
  if (tx.size) out.text = topN(tx, o.perMethod);

  // type: the same kind of product / position / category (keeps other kinds of listing in reach when the words differ)
  const tk = typeKeys(s);
  if (tk.length) {
    const hits = new Map<number, { s: number; detail: string; keys: string[] }>();
    for (const k of tk) for (const i of ix.byType.get(k) ?? []) {
      const h = hits.get(i) ?? { s: 0, detail: '', keys: [] };
      h.s += k.startsWith('k:') ? 1 : 0.6;
      h.keys.push(k.slice(2));
      hits.set(i, h);
    }
    const m = new Map<number, { s: number; detail: string }>();
    for (const [i, h] of hits) m.set(i, { s: h.s + 0.05 * (bm.get(i) ?? 0), detail: `same kind/position/category: ${h.keys.slice(0, 3).join(', ')}` });
    out.type = topN(m, o.perMethod);
  }

  // rules: the rule engine's own retrieval (name tokens, codes, vehicle words, brand), so this retrieval is never narrower than the engine's
  const rl = new Map<number, { s: number; detail: string }>();
  for (const r of retrieveCandidates(s, ix.rules, ix.corpus)) {
    const i = ix.at.get(r.competitor.variantId);
    if (i !== undefined) rl.set(i, { s: r.score, detail: `rule engine retrieval (${[...r.keys].join(', ')})` });
  }
  if (rl.size) out.rules = topN(rl, o.perMethod);

  // semantic: embedding similarity, supplied by the caller (it is cached and costs quota, so it is optional)
  if (semantic?.length) {
    const m = new Map<number, { s: number; detail: string }>();
    for (const h of semantic) { const i = ix.at.get(h.variantId); if (i !== undefined) m.set(i, { s: h.score, detail: `similar meaning (${h.score.toFixed(2)})` }); }
    if (m.size) out.semantic = topN(m, o.perMethod);
  }
  return out;
}

function bm25(ix: RetrievalIndex, s: Dossier): Map<number, number> {
  const k1 = 1.2;
  const b = 0.75;
  const scores = new Map<number, number>();
  for (const t of tokensOf(s)) {
    const p = ix.postings.get(t);
    if (!p || p.length > ix.n * 0.5) continue;
    const idf = ix.idf.get(t) ?? 0;
    for (const i of p) {
      const len = ix.docs[i]!.tokens.length;
      scores.set(i, (scores.get(i) ?? 0) + idf * ((k1 + 1) / (1 + k1 * (1 - b + (b * len) / ix.avgLen))));
    }
  }
  return scores;
}

function sharedWords(ix: RetrievalIndex, s: Dossier, i: number): string {
  const doc = new Set(ix.docs[i]!.tokens);
  const shared = tokensOf(s).filter((t) => doc.has(t)).map((t) => t.replace(/^[cs]:/, '')).sort((a, b) => (ix.idf.get(b) ?? 0) - (ix.idf.get(a) ?? 0));
  return `words ${shared.slice(0, 5).join(', ')}`;
}

/**
 * The shortlist for one of your variants: fused over all methods, one variant per competitor product, `perSiteProducts` products per competitor website.
 * A website with nothing plausible contributes nothing.
 */
export function retrieveShortlist(ix: RetrievalIndex, source: Dossier, opts: Partial<RetrievalOptions> = {}, semantic: SemanticHit[] | null = null, stats?: ShortlistStats): AiCandidate[] {
  const o: RetrievalOptions = { ...DEFAULT_RETRIEVAL_OPTIONS, ...opts, weights: { ...DEFAULT_RETRIEVAL_OPTIONS.weights, ...(opts.weights ?? {}) } };
  const ranks = rankings(ix, source, o, semantic);
  const fused = new Map<number, { score: number; by: FoundBy[] }>();
  for (const [method, list] of Object.entries(ranks) as [RetrievalMethod, Ranked[]][]) {
    const top = list[0]?.score || 1;
    list.forEach((r, i) => {
      const e = fused.get(r.doc) ?? { score: 0, by: [] };
      e.score += o.fusion === 'rrf' ? o.weights[method] / (o.rrfK + i + 1) : (o.weights[method] * r.score) / top;
      e.by.push({ method, rank: i + 1, detail: r.detail });
      fused.set(r.doc, e);
    });
  }
  // the best `variantsPerProduct` variants of each competitor product are kept through the evidence check (a wrong-size or wrong-position variant must not win an early text-score choice and
  // hide the right one); the product is represented by its best-scoring variant until then, and the best `poolPerSite` products of each website are judged
  type Hit = { doc: number; score: number; by: FoundBy[] };
  const variantsOf = new Map<string, Hit[]>();
  for (const [doc, e] of fused) {
    const d = ix.docs[doc]!.d;
    if (d.siteId === source.siteId) continue;
    const list = variantsOf.get(d.productId) ?? variantsOf.set(d.productId, []).get(d.productId)!;
    list.push({ doc, score: e.score, by: e.by });
  }
  const bySite = new Map<string, (Hit & { alts: Hit[] })[]>();
  for (const all of variantsOf.values()) {
    all.sort((a, b) => b.score - a.score || a.doc - b.doc);
    const alts = all.slice(0, Math.max(1, o.variantsPerProduct));
    const rep = { ...alts[0]!, alts };
    const site = ix.docs[rep.doc]!.d.siteId;
    (bySite.get(site) ?? bySite.set(site, []).get(site)!).push(rep);
  }
  const REL: Record<string, number> = { exact: 1, variant: 1, substitute: 1, related: 0.5, insufficient: 0.35, non_match: 0.15 };
  const out: AiCandidate[] = [];
  for (const list of bySite.values()) {
    list.sort((a, b) => b.score - a.score || a.doc - b.doc);
    const best = list[0]?.score || 1;
    // the rule engine's evidence about each pool member: a decisive incompatibility removes it, otherwise the evidence is blended with the retrieval score
    const judged = list.slice(0, o.poolPerSite).map((p) => {
      // every kept variant of the product is judged; the one the evidence likes best represents the product
      const options = p.alts.map((v) => {
        const e = evaluatePair(source, ix.docs[v.doc]!.d, ix.corpus);
        return { doc: v.doc, score: v.score, by: v.by, e, blend: 0.45 * (v.score / best) + 0.55 * ((REL[e.relationship] ?? 0.2) * (e.tier === 'strong' ? 1 : 0.85) * (0.6 + 0.4 * Math.min(1, e.rank))) };
      });
      return options.sort((a, b) => b.blend - a.blend || a.doc - b.doc)[0]!;
    });
    const hard = (x: (typeof judged)[number]) => x.e.relationship === 'non_match' && x.e.conflicts.length > 0;
    if (stats) { stats.considered += judged.length; stats.droppedHardConflict += judged.filter(hard).length; }
    const pool = judged.filter((x) => !(o.dropHardConflicts && hard(x))).sort((a, b) => b.blend - a.blend || a.doc - b.doc);
    // maximal marginal relevance: after the best product, prefer products that are good AND different from the ones already chosen (so a pool of near-identical listings cannot fill the shortlist)
    const chosen: typeof pool = [];
    const top = pool[0]?.blend || 1;
    while (chosen.length < o.perSiteProducts && pool.length) {
      let pick = 0;
      let pickScore = -Infinity;
      pool.forEach((v, i) => {
        const sim = chosen.length ? Math.max(...chosen.map((c) => dice(ix.docs[v.doc]!.tri, ix.docs[c.doc]!.tri))) : 0;
        const mmr = (1 - o.diversity) * (v.blend / top) - o.diversity * sim;
        if (mmr > pickScore) { pickScore = mmr; pick = i; }
      });
      chosen.push(pool.splice(pick, 1)[0]!);
    }
    chosen.forEach((v, i) => {
      const d = ix.docs[v.doc]!.d;
      out.push({ variantId: d.variantId, productId: d.productId, siteId: d.siteId, score: v.blend, foundBy: v.by.sort((a, b) => a.rank - b.rank), siteRank: i + 1, engine: v.e });
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (big.has(g)) n++;
  return (2 * n) / (a.size + b.size);
}
