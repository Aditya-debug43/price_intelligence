import type { EvidenceTier, MatchEvidence, MatchRelationship } from '@ci/shared';
import { buildCandidateIndex, DEFAULT_CANDIDATE_OPTIONS, retrieveCandidates, type CandidateOptions } from './candidates.ts';
import { analyseCatalogue, type Corpus } from './corpus.ts';
import type { Dossier, DossierInput } from './dossier.ts';
import { evaluatePair, type PairEvaluation } from './evidence.ts';

/**
 * Matching engine v2, end to end for one workspace: dossiers → candidates → evidence → the few suggestions worth a person's time.
 * Pure: no database, no network, no clock. Nothing here accepts anything: every suggestion is for a person to confirm.
 */

export const ENGINE_VERSION = 'match-v2.7';

export interface EngineOptions {
  candidates: CandidateOptions;
  /** Suggestions kept per product of yours and competitor website (exact / variant / substitute). The right number is decided by evaluation. */
  perSiteKeep: number;
  /** "Related" and "not enough information" are kept at most this many per product and website, and only when nothing better exists there. */
  perSiteKeepWeak: number;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = { candidates: DEFAULT_CANDIDATE_OPTIONS, perSiteKeep: 3, perSiteKeepWeak: 1 };

export interface Suggestion {
  sourceVariantId: string;
  competitorVariantId: string;
  competitorSiteId: string;
  relationship: MatchRelationship;
  tier: EvidenceTier;
  evidence: MatchEvidence;
  method: PairEvaluation['method'];
  rank: number;
  /** Fingerprint of what both products said when this was judged: a change means the suggestion must be looked at again. */
  pairHash: string;
  engineVersion: string;
}

export interface EngineStats {
  sources: number;
  competitors: number;
  candidatesLooked: number;
  suggestions: number;
  byRelationship: Record<MatchRelationship, number>;
  byTier: Record<EvidenceTier, number>;
  /** Pairs dropped as decisively incompatible, by reason: the list to read when a true match seems to be missing. */
  droppedAsNonMatch: number;
  droppedReasons: Record<string, number>;
  sourcesWithSuggestion: number;
  ms: number;
}

export interface EngineResult {
  suggestions: Suggestion[];
  stats: EngineStats;
  corpus: Corpus;
}

/** 53-bit string hash (cyrb53): stable between runs and machines, not cryptographic — it only detects change. */
export function hashText(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** What a product said, reduced to what matching reads: if none of it changed, a judgement made earlier still stands. */
export function dossierHash(d: Dossier): string {
  return hashText(
    JSON.stringify([d.title, d.brand.name, d.category, d.identifiers.gtin?.value, d.identifiers.mpn?.value, d.identifiers.sku?.value, d.legacy.qty.label, d.axes, d.tags]),
  );
}

const REL_ORDER: Record<MatchRelationship, number> = { exact: 0, variant: 1, substitute: 2, related: 3, insufficient: 4, non_match: 5 };
const TIER_ORDER: Record<EvidenceTier, number> = { strong: 0, medium: 1, insufficient: 2 };

export function runEngine(sources: DossierInput[], competitors: DossierInput[], opts: EngineOptions = DEFAULT_ENGINE_OPTIONS): EngineResult {
  const t0 = Date.now();
  const corpus = analyseCatalogue([...sources, ...competitors]);
  const src = sources.map((s) => corpus.byVariant.get(s.variantId)!);
  const comp = competitors.map((c) => corpus.byVariant.get(c.variantId)!);
  const index = buildCandidateIndex(comp, corpus, opts.candidates);

  const out: Suggestion[] = [];
  const stats: EngineStats = {
    sources: src.length, competitors: comp.length, candidatesLooked: 0, suggestions: 0,
    byRelationship: { exact: 0, variant: 0, substitute: 0, related: 0, non_match: 0, insufficient: 0 },
    byTier: { strong: 0, medium: 0, insufficient: 0 }, droppedAsNonMatch: 0, droppedReasons: {}, sourcesWithSuggestion: 0, ms: 0,
  };
  for (const s of src) {
    const bySite = new Map<string, { d: Dossier; e: PairEvaluation }[]>();
    for (const r of retrieveCandidates(s, index, corpus, opts.candidates)) {
      stats.candidatesLooked++;
      const e = evaluatePair(s, r.competitor, corpus);
      if (e.relationship === 'non_match') {
        stats.droppedAsNonMatch++;
        const reason = e.conflicts[0]?.replace(/\(.*\)/, '').trim() || 'no shared identifying evidence';
        stats.droppedReasons[reason] = (stats.droppedReasons[reason] ?? 0) + 1;
        continue;
      }
      const list = bySite.get(r.competitor.siteId) ?? [];
      list.push({ d: r.competitor, e });
      bySite.set(r.competitor.siteId, list);
    }
    let any = false;
    for (const [siteId, list] of bySite) {
      list.sort((x, y) => REL_ORDER[x.e.relationship] - REL_ORDER[y.e.relationship] || TIER_ORDER[x.e.tier] - TIER_ORDER[y.e.tier] || y.e.rank - x.e.rank);
      // a competitor product offers its variants once each: keep the best variant of each product for this variant of yours
      const seenProduct = new Set<string>();
      const bestPerProduct = list.filter((x) => (seenProduct.has(x.d.productId) ? false : (seenProduct.add(x.d.productId), true)));
      const strongList = bestPerProduct.filter((x) => x.e.relationship === 'exact' || x.e.relationship === 'variant' || x.e.relationship === 'substitute');
      const weakList = bestPerProduct.filter((x) => x.e.relationship === 'related' || x.e.relationship === 'insufficient');
      // weak suggestions only when nothing better exists for this product at this website
      const keep = strongList.length ? strongList.slice(0, opts.perSiteKeep) : weakList.slice(0, opts.perSiteKeepWeak);
      for (const { d, e } of keep) {
        any = true;
        stats.byRelationship[e.relationship]++;
        stats.byTier[e.tier]++;
        stats.suggestions++;
        out.push({
          sourceVariantId: s.variantId, competitorVariantId: d.variantId, competitorSiteId: siteId, relationship: e.relationship, tier: e.tier, evidence: e.evidence, method: e.method, rank: e.rank,
          pairHash: hashText(`${dossierHash(s)}|${dossierHash(d)}`), engineVersion: ENGINE_VERSION,
        });
      }
    }
    if (any) stats.sourcesWithSuggestion++;
  }
  stats.ms = Date.now() - t0;
  return { suggestions: out, stats, corpus };
}
