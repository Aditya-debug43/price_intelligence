import { evaluateGate, wilson, DEFAULT_GATE, type GateResult, type GateThresholds, type Interval, type Proportion } from './gate.ts';

/**
 * Scoring the matching system against INDEPENDENT human labels (pure). A case is one of your variants at one competitor website, with what a person established as its true counterpart there
 * (a specific competitor variant and what the two are to each other) or that it has none. Nothing here invents a label and nothing treats the system's own answers as truth.
 *
 * Why not "accuracy over all pairs": nearly every random pair of products is a non-match, so that figure looks excellent while real matches are missed. The measures below are the ones the
 * release gate uses: candidate recall (the right VARIANT reached the shortlist), match recall, precision of what would be approved automatically, mistakes on products with no counterpart,
 * and how the decisions split between automatic, human review and unresolved.
 */

export const POSITIVE_RELATIONSHIPS = ['exact', 'variant', 'equivalent', 'substitute'] as const;
export type PositiveRelationship = (typeof POSITIVE_RELATIONSHIPS)[number];
export type TruthRelationship = PositiveRelationship | 'related' | 'none';
export const isPositive = (r: string | null | undefined): r is PositiveRelationship => (POSITIVE_RELATIONSHIPS as readonly string[]).includes(r ?? '');

export type EvalDomain = 'automotive' | 'grocery' | 'general';
export type EvalSystem = 'rule' | 'ai' | 'combined';
export type AutoClass = 'exact_item' | 'compatible_equivalent';

export interface EvalPrediction {
  variantId: string;
  relationship: PositiveRelationship | 'related';
  /** The deterministic conditions for automatic approval were met (see `autoClassOf`), and for which class. Null: they were not. */
  autoClass: AutoClass | null;
}

export interface EvalCase {
  id: string;
  domain: EvalDomain;
  siteId: string;
  siteName: string;
  category: string | null;
  split: 'development' | 'holdout';
  stratum: string;
  truthVariantId: string | null;
  truthRelationship: TruthRelationship;
  /** Whether the true variant was among the candidates retrieval produced (null: not measured). */
  candidateHit: boolean | null;
  rule: EvalPrediction | null;
  ai: EvalPrediction | null;
  combined: EvalPrediction | null;
  /** The pair is confirmed by the matcher itself (not by a person). */
  autoApproved: boolean;
  /** The system has a pair here that waits for a person's decision. */
  needsHuman: boolean;
  /** The labeller said they know these products (for automotive, the gate counts only knowledgeable labels). */
  expertise: 'knowledgeable' | 'general';
}

export interface SystemScore {
  /** Positives (a true counterpart exists) where the system's pair is that exact variant. */
  found: Proportion;
  /** ...and the relationship is right too. */
  correct: Proportion;
  /** Of the system's positive predictions, those that are the true variant with the true relationship. */
  precision: Proportion;
  /** Of the cases that truly have no counterpart, those given a positive prediction anyway. */
  falseOnNone: Proportion;
}

export interface GroupScore {
  cases: number;
  positives: number;
  noCounterpart: number;
  candidateRecall: Proportion;
  rule: SystemScore;
  ai: SystemScore;
  combined: SystemScore;
  /** Of the pairs the matcher confirmed itself: the right ones. */
  autoPrecision: Proportion;
  /** Of the positives: the share that got a CORRECT automatic decision; the share that went to a person; the share left unresolved. */
  automaticCoverage: Proportion;
  humanReviewShare: Proportion;
  unresolvedShare: Proportion;
}

const P = (hits: number, total: number): Proportion => ({ hits, total });
const hasTruth = (c: EvalCase) => c.truthRelationship !== 'none' && c.truthVariantId !== null && isPositive(c.truthRelationship);
const right = (p: EvalPrediction | null, c: EvalCase) => !!p && p.variantId === c.truthVariantId && p.relationship === c.truthRelationship;

function system(cases: EvalCase[], pick: (c: EvalCase) => EvalPrediction | null): SystemScore {
  const positives = cases.filter(hasTruth);
  const none = cases.filter((c) => c.truthRelationship === 'none');
  const predicted = cases.filter((c) => isPositive(pick(c)?.relationship));
  return {
    found: P(positives.filter((c) => pick(c)?.variantId === c.truthVariantId && isPositive(pick(c)?.relationship)).length, positives.length),
    correct: P(positives.filter((c) => right(pick(c), c)).length, positives.length),
    precision: P(predicted.filter((c) => right(pick(c), c)).length, predicted.length),
    falseOnNone: P(none.filter((c) => isPositive(pick(c)?.relationship)).length, none.length),
  };
}

export function scoreGroup(cases: EvalCase[]): GroupScore {
  const positives = cases.filter(hasTruth);
  const measured = positives.filter((c) => c.candidateHit !== null);
  const auto = cases.filter((c) => c.autoApproved && isPositive(c.combined?.relationship));
  const autoCorrect = positives.filter((c) => c.autoApproved && right(c.combined, c));
  const review = positives.filter((c) => !c.autoApproved && c.needsHuman);
  return {
    cases: cases.length,
    positives: positives.length,
    noCounterpart: cases.filter((c) => c.truthRelationship === 'none').length,
    candidateRecall: P(measured.filter((c) => c.candidateHit).length, measured.length),
    rule: system(cases, (c) => c.rule),
    ai: system(cases, (c) => c.ai),
    combined: system(cases, (c) => c.combined),
    autoPrecision: P(auto.filter((c) => right(c.combined, c)).length, auto.length),
    automaticCoverage: P(autoCorrect.length, positives.length),
    humanReviewShare: P(review.length, positives.length),
    unresolvedShare: P(positives.length - autoCorrect.length - review.length, positives.length),
  };
}

export interface LabelEvaluationReport {
  split: 'development' | 'holdout' | 'all';
  overall: GroupScore;
  byDomain: Record<string, GroupScore>;
  bySite: Record<string, GroupScore>;
  byCategory: Record<string, GroupScore>;
  byStratum: Record<string, GroupScore>;
  /** Intervals for the headline proportions of the overall group. */
  intervals: Record<string, Interval>;
}

const groupBy = (cases: EvalCase[], key: (c: EvalCase) => string) => {
  const m = new Map<string, EvalCase[]>();
  for (const c of cases) (m.get(key(c)) ?? m.set(key(c), []).get(key(c))!).push(c);
  return Object.fromEntries([...m].map(([k, v]) => [k, scoreGroup(v)]));
};

export function scoreEvaluation(all: EvalCase[], split: LabelEvaluationReport['split'] = 'all'): LabelEvaluationReport {
  const cases = split === 'all' ? all : all.filter((c) => c.split === split);
  const overall = scoreGroup(cases);
  const iv = (p: Proportion) => wilson(p.hits, p.total);
  return {
    split,
    overall,
    byDomain: groupBy(cases, (c) => c.domain),
    bySite: groupBy(cases, (c) => c.siteName),
    byCategory: groupBy(cases, (c) => c.category ?? 'uncategorised'),
    byStratum: groupBy(cases, (c) => c.stratum),
    intervals: { candidateRecall: iv(overall.candidateRecall), matchRecall: iv(overall.combined.found), combinedPrecision: iv(overall.combined.precision), autoPrecision: iv(overall.autoPrecision), automaticCoverage: iv(overall.automaticCoverage), humanReviewShare: iv(overall.humanReviewShare), falseOnNone: iv(overall.combined.falseOnNone) },
  };
}

/** The deterministic conditions for approving an AI answer automatically. They are measured BEFORE they are used: `precision by class` below is computed over exactly the predictions that meet them. */
export interface AutoFacts {
  matchType: string;
  confidence: 'high' | 'medium' | 'low';
  /** Codes of the safeguards that fired. Any of the codes in `BLOCKING_GUARDS` stops an automatic approval. */
  guardCodes: string[];
  domain: EvalDomain;
  gtinEqual: boolean;
  sameBrand: boolean;
  mpnEqual: boolean;
  codesAgree: boolean;
  quantity: 'same' | 'different' | 'unknown';
  bundle: 'equivalent' | 'mismatch' | 'unknown' | null;
  engine: { relationship: string; conflicts: string[] } | null;
  /** A person already decided this pair. */
  decidedByPerson: boolean;
}

export const BLOCKING_GUARDS = ['ungrounded_evidence', 'identity_conflict', 'engine_hard_conflict', 'bundle_mismatch', 'bundle_unknown', 'quantity_different', 'quantity_unknown', 'different_brands', 'brand_unknown', 'different_barcodes', 'low_support', 'compat_gate'];

export function autoClassOf(f: AutoFacts): AutoClass | null {
  if (f.decidedByPerson || f.confidence === 'low') return null;
  if (f.guardCodes.some((g) => BLOCKING_GUARDS.includes(g))) return null;
  if (f.engine && (f.engine.conflicts.length > 0 || f.engine.relationship === 'non_match')) return null;
  if (f.bundle !== null && f.bundle !== 'equivalent') return null;
  // an identical item: a valid equal barcode, or the same maker's part number, and the same verified quantity (and contents)
  if (f.matchType === 'exact_item') return f.quantity === 'same' && (f.gtinEqual || (f.sameBrand && f.mpnEqual)) ? 'exact_item' : null;
  // a compatible equivalent: a part whose fit can be checked, the same bulb/socket code, nothing in doubt, quantity not shown to differ
  if (f.matchType === 'close_equivalent') return f.domain === 'automotive' && f.codesAgree && f.quantity !== 'different' ? 'compatible_equivalent' : null;
  return null;
}

export const CLASS_RELATIONSHIP: Record<AutoClass, PositiveRelationship> = { exact_item: 'exact', compatible_equivalent: 'equivalent' };

export interface ClassGate {
  domain: EvalDomain;
  autoClass: AutoClass;
  result: GateResult;
}

/**
 * The gate for one class in one domain, measured on the HOLDOUT cases only: candidate recall of the domain, match recall of the domain, and the precision of the AI predictions that met the
 * deterministic conditions for this class. For automotive only labels from someone who knows the parts count. Too few examples is never a pass.
 */
export function gateForClass(cases: EvalCase[], domain: EvalDomain, autoClass: AutoClass, thresholds: GateThresholds = DEFAULT_GATE): ClassGate {
  const used = cases.filter((c) => c.split === 'holdout' && c.domain === domain && (domain !== 'automotive' || c.expertise === 'knowledgeable'));
  const positives = used.filter(hasTruth);
  const measured = positives.filter((c) => c.candidateHit !== null);
  const eligible = used.filter((c) => c.ai?.autoClass === autoClass);
  const rel = CLASS_RELATIONSHIP[autoClass];
  const correct = eligible.filter((c) => c.ai!.variantId === c.truthVariantId && c.truthRelationship === rel);
  const found = positives.filter((c) => isPositive(c.combined?.relationship) && c.combined!.variantId === c.truthVariantId);
  return {
    domain,
    autoClass,
    result: evaluateGate({ candidateRecall: P(measured.filter((c) => c.candidateHit).length, measured.length), autoPrecision: P(correct.length, eligible.length), matchRecall: P(found.length, positives.length) }, thresholds),
  };
}
