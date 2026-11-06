import { evaluateGate, wilson, DEFAULT_GATE, type GateResult, type GateThresholds, type Interval, type Proportion } from './gate.ts';
import { AUTO_POLICY_VERSION, type BulbPolicyResult } from './policy.ts';

/**
 * Scoring the matching system against INDEPENDENT human labels (pure). A case is one of your variants at one competitor website. A person judged the candidates there: which are acceptable
 * counterparts (and what each is: several may be valid), which are explicitly NOT counterparts, and whether the list of acceptable counterparts is complete. A candidate nobody judged is
 * UNJUDGED, not wrong. Nothing here invents a label and nothing treats the system's own answers as truth.
 *
 * Scoring parity: the gate scores EXACTLY the decision set the deployed policy would approve: every answer at a case that meets the deterministic conditions of a class, not just the strongest.
 * A deliberately wrong second candidate counts against precision like any other.
 */

export const POSITIVE_RELATIONSHIPS = ['exact', 'variant', 'equivalent', 'substitute'] as const;
export type PositiveRelationship = (typeof POSITIVE_RELATIONSHIPS)[number];
export type JudgedRelationship = PositiveRelationship | 'related';
export const isPositive = (r: string | null | undefined): r is PositiveRelationship => (POSITIVE_RELATIONSHIPS as readonly string[]).includes(r ?? '');

export type EvalDomain = 'automotive' | 'grocery' | 'general';
export type EvalSystem = 'rule' | 'ai' | 'combined';
export type AutoClass = 'exact_item' | 'compatible_equivalent';
/** The classes a person may switch on. Only policies that are actually defined are offered: groceries have no equivalent policy (a different brand there is a labelled substitute). */
export const SUPPORTED_POLICIES: readonly { domain: EvalDomain; autoClass: AutoClass }[] = [
  { domain: 'automotive', autoClass: 'exact_item' },
  { domain: 'automotive', autoClass: 'compatible_equivalent' },
  { domain: 'grocery', autoClass: 'exact_item' },
];

export interface EvalPrediction {
  variantId: string;
  relationship: JudgedRelationship;
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
  /** The product family (sibling variants and duplicate listings share one): the unit of independence. */
  familyKey: string;
  /** Acceptable counterparts, each with what the two are. */
  acceptable: { variantId: string; relationship: PositiveRelationship }[];
  /** Candidates a person judged NOT to be counterparts, and those among them whose approval would be a critical compatibility violation. */
  incorrect: string[];
  critical: string[];
  /** The labeller says the acceptable list is complete: a candidate that is not on it is wrong (an empty list = no counterpart here). */
  complete: boolean;
  /** Whether a true counterpart was among the candidates retrieval produced (null: not measured). */
  candidateHit: boolean | null;
  rule: EvalPrediction | null;
  ai: EvalPrediction | null;
  combined: EvalPrediction | null;
  /** EVERY answer here that meets the conditions of an automatic-approval class (what production would approve). */
  eligible: EvalPrediction[];
  autoApproved: boolean;
  needsHuman: boolean;
  expertise: 'knowledgeable' | 'general';
}

export interface SystemScore {
  found: Proportion;
  correct: Proportion;
  precision: Proportion;
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
  autoPrecision: Proportion;
  automaticCoverage: Proportion;
  humanReviewShare: Proportion;
  unresolvedShare: Proportion;
  /** Pair-level scoring of everything production would approve (all eligible answers, not only the strongest). */
  eligibleDecisions: { pairs: number; correct: number; wrong: number; unjudged: number };
}

const P = (hits: number, total: number): Proportion => ({ hits, total });
const hasTruth = (c: EvalCase) => c.acceptable.length > 0;
const noCounterpart = (c: EvalCase) => c.complete && c.acceptable.length === 0;
const right = (p: EvalPrediction | null | undefined, c: EvalCase) => !!p && c.acceptable.some((a) => a.variantId === p.variantId && a.relationship === p.relationship);
const isTrueCounterpart = (p: EvalPrediction | null | undefined, c: EvalCase) => !!p && c.acceptable.some((a) => a.variantId === p.variantId);

/** Correct, wrong, or not judged: an acceptable counterpart with the right relationship is correct; an explicitly incorrect one, a wrong relationship, or anything off a complete list is wrong. */
export function judge(p: EvalPrediction, c: EvalCase): 'correct' | 'wrong' | 'unjudged' {
  if (right(p, c)) return 'correct';
  if (isTrueCounterpart(p, c) || c.incorrect.includes(p.variantId) || c.complete) return 'wrong';
  return 'unjudged';
}

function system(cases: EvalCase[], pick: (c: EvalCase) => EvalPrediction | null): SystemScore {
  const positives = cases.filter(hasTruth);
  const none = cases.filter(noCounterpart);
  const predicted = cases.filter((c) => isPositive(pick(c)?.relationship));
  const judged = predicted.filter((c) => judge(pick(c)!, c) !== 'unjudged');
  return {
    found: P(positives.filter((c) => isTrueCounterpart(pick(c), c) && isPositive(pick(c)?.relationship)).length, positives.length),
    correct: P(positives.filter((c) => right(pick(c), c)).length, positives.length),
    precision: P(judged.filter((c) => judge(pick(c)!, c) === 'correct').length, judged.length),
    falseOnNone: P(none.filter((c) => isPositive(pick(c)?.relationship)).length, none.length),
  };
}

export function scoreGroup(cases: EvalCase[]): GroupScore {
  const positives = cases.filter(hasTruth);
  const measured = positives.filter((c) => c.candidateHit !== null);
  const auto = cases.filter((c) => c.autoApproved && isPositive(c.combined?.relationship) && judge(c.combined!, c) !== 'unjudged');
  const autoCorrect = positives.filter((c) => c.autoApproved && right(c.combined, c));
  const review = positives.filter((c) => !c.autoApproved && c.needsHuman);
  const eligible = cases.flatMap((c) => c.eligible.map((p) => judge(p, c)));
  return {
    cases: cases.length,
    positives: positives.length,
    noCounterpart: cases.filter(noCounterpart).length,
    candidateRecall: P(measured.filter((c) => c.candidateHit).length, measured.length),
    rule: system(cases, (c) => c.rule),
    ai: system(cases, (c) => c.ai),
    combined: system(cases, (c) => c.combined),
    autoPrecision: P(auto.filter((c) => right(c.combined, c)).length, auto.length),
    automaticCoverage: P(autoCorrect.length, positives.length),
    humanReviewShare: P(review.length, positives.length),
    unresolvedShare: P(positives.length - autoCorrect.length - review.length, positives.length),
    eligibleDecisions: { pairs: eligible.length, correct: eligible.filter((x) => x === 'correct').length, wrong: eligible.filter((x) => x === 'wrong').length, unjudged: eligible.filter((x) => x === 'unjudged').length },
  };
}

export interface LabelEvaluationReport {
  split: 'development' | 'holdout' | 'all';
  overall: GroupScore;
  byDomain: Record<string, GroupScore>;
  bySite: Record<string, GroupScore>;
  byCategory: Record<string, GroupScore>;
  byStratum: Record<string, GroupScore>;
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

/** The deterministic conditions for approving an AI answer automatically. They are measured BEFORE they are used: the gate scores exactly the answers that meet them. */
export interface AutoFacts {
  matchType: string;
  confidence: 'high' | 'medium' | 'low';
  guardCodes: string[];
  domain: EvalDomain;
  gtinEqual: boolean;
  sameBrand: boolean;
  mpnEqual: boolean;
  /** What the category policy established from SOURCED evidence (null when no policy covers the pair). Codes that merely co-occur in the catalogue are not evidence here. */
  policy: BulbPolicyResult | null;
  quantity: 'same' | 'different' | 'unknown';
  bundle: 'equivalent' | 'mismatch' | 'unknown' | null;
  engine: { relationship: string; conflicts: string[] } | null;
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
  // a compatible equivalent: a category policy covers the pair and established every critical field from sourced evidence; quantity not shown to differ (an unknown pack only limits the price view)
  if (f.matchType === 'close_equivalent') return f.domain === 'automotive' && !!f.policy?.eligible && f.quantity !== 'different' ? 'compatible_equivalent' : null;
  return null;
}

export const CLASS_RELATIONSHIP: Record<AutoClass, PositiveRelationship> = { exact_item: 'exact', compatible_equivalent: 'equivalent' };

export interface ClassGate {
  domain: EvalDomain;
  autoClass: AutoClass;
  policyVersion: string;
  result: GateResult;
  /** How the independent units were counted: families (not duplicated rows), judged, and how many eligible answers nobody judged. */
  units: { families: number; correct: number; critical: number; unjudgedAnswers: number; incompleteFamilies: number };
}

/**
 * The gate for ONE narrow policy in one domain, on the HOLDOUT cases only, for the CURRENT policy version. The unit is the product family (sibling variants and duplicate listings count once, and
 * a family is correct only if every judged answer in it is). Passing needs at least 100 independent families, precision >= 98% with a 95% lower bound above 90%, and no critical violation.
 * Whole-domain candidate recall and match recall are reported beside it as product goals; they do not block a precise policy. For automotive only knowledgeable labels count.
 */
export function gateForClass(cases: EvalCase[], domain: EvalDomain, autoClass: AutoClass, thresholds: GateThresholds = DEFAULT_GATE): ClassGate {
  const used = cases.filter((c) => c.split === 'holdout' && c.domain === domain && (domain !== 'automotive' || c.expertise === 'knowledgeable'));
  const positives = used.filter(hasTruth);
  const measured = positives.filter((c) => c.candidateHit !== null);
  const answers = used.flatMap((c) => c.eligible.filter((p) => p.autoClass === autoClass).map((p) => ({ c, p, verdict: judge(p, c) })));
  const critical = answers.filter((a) => a.verdict === 'wrong' && a.c.critical.includes(a.p.variantId)).length;
  // one verdict per family: wrong if ANY of its answers is wrong; correct only if every answer is judged and correct. A family with an answer nobody judged and no wrong one is NOT counted: an
  // unjudged answer can never help the policy pass (it is reported as unjudged, to be labelled).
  const byFamily = new Map<string, { wrong: boolean; unjudged: boolean }>();
  for (const a of answers) {
    const cur = byFamily.get(a.c.familyKey) ?? { wrong: false, unjudged: false };
    byFamily.set(a.c.familyKey, { wrong: cur.wrong || a.verdict === 'wrong', unjudged: cur.unjudged || a.verdict === 'unjudged' });
  }
  const counted = [...byFamily.values()].filter((f) => f.wrong || !f.unjudged);
  const families = counted.length;
  const correct = counted.filter((f) => !f.wrong).length;
  const found = positives.filter((c) => isTrueCounterpart(c.combined, c) && isPositive(c.combined?.relationship));
  return {
    domain,
    autoClass,
    policyVersion: AUTO_POLICY_VERSION,
    units: { families, correct, critical, unjudgedAnswers: answers.filter((a) => a.verdict === 'unjudged').length, incompleteFamilies: [...byFamily.values()].filter((f) => !f.wrong && f.unjudged).length },
    result: evaluateGate({ precision: P(correct, families), criticalViolations: critical, candidateRecall: P(measured.filter((c) => c.candidateHit).length, measured.length), matchRecall: P(found.length, positives.length) }, thresholds),
  };
}

/**
 * How many more independent families a policy needs before its measurement can mean anything: the shortfall to the minimum, and (only when the observed precision already meets the target) how many
 * in all would bring the lower confidence bound above the line at that same rate. Null when more examples cannot help (precision is below the target) or the rate is not yet known.
 */
export function neededFamilies(g: ClassGate, t: GateThresholds = DEFAULT_GATE): { toMinimum: number; toCertainty: number | null } {
  const toMinimum = Math.max(0, t.minExamples - g.units.families);
  if (g.units.families === 0) return { toMinimum, toCertainty: null };
  const rate = g.units.correct / g.units.families;
  if (rate < t.autoPrecision) return { toMinimum, toCertainty: null };
  for (let n = Math.max(g.units.families, t.minExamples); n <= 5000; n++) {
    if ((wilson(Math.round(rate * n), n).low ?? 0) > t.precisionLowerBound) return { toMinimum, toCertainty: Math.max(0, n - g.units.families) };
  }
  return { toMinimum, toCertainty: null };
}
