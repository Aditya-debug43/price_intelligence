import type { Corpus } from './corpus.ts';
import type { Dossier } from './dossier.ts';

/**
 * Multi-key candidate generation (matching engine v2, stage 1). A competitor product becomes a candidate for a product of yours when ANY
 * independent key points at it, so one missing identifier or one different word cannot hide it:
 *
 *   identifier   the same barcode, or the same brand + manufacturer part number
 *   code         a shared identity code (aliases folded: H4 = 9003 = HB2)
 *   subject      the same vehicle / device words (learned from the catalogue, see corpus.ts)
 *   word         a shared descriptive word that is not everywhere (a word in more than a quarter of all listings only adds noise; it still counts
 *                later, when the pair is judged)
 *   legacy name  the earlier engine's name-token overlap, kept so nothing the earlier engine could find is lost
 *
 * Retrieval is per competitor website, so a large website cannot crowd out a small one. It decides only WHAT IS LOOKED AT: whether a candidate
 * is a match is the evidence model's job, and the two are measured separately (candidate recall vs. final accuracy).
 */

export interface CandidateOptions {
  /** How many candidates to look at per competitor website for each of your products. */
  perSiteRetrieve: number;
  /** Words in more than this share of all listings are not used to find candidates. */
  commonShare: number;
  /** The earlier engine's cap on how common a name token may be and still find candidates. */
  legacyMaxPosting: number;
  legacyMaxCandidates: number;
  sameBrandExtra: number;
}

export const DEFAULT_CANDIDATE_OPTIONS: CandidateOptions = { perSiteRetrieve: 25, commonShare: 0.25, legacyMaxPosting: 2500, legacyMaxCandidates: 30, sameBrandExtra: 40 };

export interface CandidateIndex {
  gtin: Map<string, Dossier[]>;
  mpn: Map<string, Dossier[]>;
  code: Map<string, Dossier[]>;
  subject: Map<string, Dossier[]>;
  word: Map<string, Dossier[]>;
  legacy: Map<string, Dossier[]>;
  brand: Map<string, Dossier[]>;
  size: number;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

export function buildCandidateIndex(competitors: Dossier[], corpus: Corpus, opts: CandidateOptions = DEFAULT_CANDIDATE_OPTIONS): CandidateIndex {
  const ix: CandidateIndex = { gtin: new Map(), mpn: new Map(), code: new Map(), subject: new Map(), word: new Map(), legacy: new Map(), brand: new Map(), size: competitors.length };
  const common = Math.max(50, Math.floor(opts.commonShare * corpus.n));
  for (const c of competitors) {
    if (c.identifiers.gtin) push(ix.gtin, c.identifiers.gtin.value, c);
    if (c.identifiers.mpn && c.brand.key) push(ix.mpn, `${c.brand.key}|${c.identifiers.mpn.value}`, c);
    for (const k of c.codes) push(ix.code, k, c);
    for (const k of c.subject) push(ix.subject, k, c);
    for (const w of c.words) if ((corpus.df.get(`w:${w}`) ?? 0) <= common) push(ix.word, w, c);
    for (const t of new Set(c.legacy.core)) push(ix.legacy, t, c);
    if (c.brand.key) push(ix.brand, c.brand.key, c);
  }
  return ix;
}

export interface Retrieved {
  competitor: Dossier;
  /** Which keys pointed at it. */
  keys: Set<'identifier' | 'code' | 'subject' | 'word' | 'legacy' | 'brand'>;
  score: number;
}

export function retrieveCandidates(source: Dossier, ix: CandidateIndex, corpus: Corpus, opts: CandidateOptions = DEFAULT_CANDIDATE_OPTIONS): Retrieved[] {
  const acc = new Map<Dossier, Retrieved>();
  const hit = (c: Dossier, key: Retrieved['keys'] extends Set<infer K> ? K : never, w: number) => {
    if (c.siteId === source.siteId) return;
    const e = acc.get(c) ?? { competitor: c, keys: new Set(), score: 0 };
    e.keys.add(key);
    e.score += w;
    acc.set(c, e);
  };
  if (source.identifiers.gtin) for (const c of ix.gtin.get(source.identifiers.gtin.value) ?? []) hit(c, 'identifier', 10);
  if (source.identifiers.mpn && source.brand.key) for (const c of ix.mpn.get(`${source.brand.key}|${source.identifiers.mpn.value}`) ?? []) hit(c, 'identifier', 8);
  for (const k of source.codes) for (const c of ix.code.get(k) ?? []) hit(c, 'code', 2 * corpus.idf(`c:${k}`));
  for (const k of source.subject) for (const c of ix.subject.get(k) ?? []) hit(c, 'subject', corpus.idf(`w:${k}`) || 1);
  for (const w of source.words) {
    const post = ix.word.get(w);
    if (post) for (const c of post) hit(c, 'word', 0.5 * corpus.idf(`w:${w}`));
  }
  // the earlier engine's name-token overlap, with its original caps, so its candidates are never lost
  const legacyCounts = new Map<Dossier, number>();
  for (const t of new Set(source.legacy.core)) {
    const post = ix.legacy.get(t);
    if (!post || post.length > opts.legacyMaxPosting) continue;
    for (const c of post) legacyCounts.set(c, (legacyCounts.get(c) ?? 0) + 1);
  }
  for (const [c] of [...legacyCounts.entries()].sort((x, y) => y[1] - x[1]).slice(0, opts.legacyMaxCandidates)) hit(c, 'legacy', 0.3);
  if (source.brand.key) for (const c of (ix.brand.get(source.brand.key) ?? []).slice(0, opts.sameBrandExtra)) hit(c, 'brand', 0.2);

  // the best few per competitor website, then everything the legacy keys found
  const bySite = new Map<string, Retrieved[]>();
  for (const r of acc.values()) {
    const l = bySite.get(r.competitor.siteId) ?? [];
    l.push(r);
    bySite.set(r.competitor.siteId, l);
  }
  const out: Retrieved[] = [];
  for (const l of bySite.values()) {
    l.sort((x, y) => y.score - x.score);
    const keep = new Set(l.slice(0, opts.perSiteRetrieve));
    for (const r of l) if (keep.has(r) || r.keys.has('legacy') || r.keys.has('identifier')) out.push(r);
  }
  return out;
}
