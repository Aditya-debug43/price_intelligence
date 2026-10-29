import type { MatchRelationship } from '@ci/shared';

/**
 * Evaluation arithmetic for the matcher, kept pure so the same numbers are produced by the offline harness, the tests and any later monitoring.
 * Nothing here knows about products: it counts agreements between a labelled set and what the matcher said.
 */

/** Lower bound of the Wilson score interval for a proportion (default 95 %). With few labelled pairs the bound is far below the observed rate — which is the point. */
export function wilsonLower(successes: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

export function wilsonUpper(successes: number, n: number, z = 1.96): number {
  if (n === 0) return 1;
  const p = successes / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.min(1, (centre + margin) / (1 + z2 / n));
}

export interface Prf {
  tp: number;
  predicted: number;
  positives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** Lower 95 % bound of the precision. */
  precisionLower: number | null;
}

export function prf(tp: number, predicted: number, positives: number): Prf {
  const precision = predicted ? tp / predicted : null;
  const recall = positives ? tp / positives : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return { tp, predicted, positives, precision, recall, f1, precisionLower: predicted ? wilsonLower(tp, predicted) : null };
}

export interface LabelledPair {
  source: string;
  competitor: string;
  label: MatchRelationship;
  /** Which part of the evaluation this pair belongs to; tuning must never touch `heldout`. */
  set: 'dev' | 'heldout';
}

export interface Prediction {
  source: string;
  competitor: string;
  relationship: MatchRelationship;
  tier: 'strong' | 'medium' | 'insufficient';
}

/** What counts as "the matcher found a comparable product": the three relationships a person could confirm for comparison. */
const COMPARABLE: readonly MatchRelationship[] = ['exact', 'variant', 'substitute'];

export interface EvaluationReport {
  pairs: number;
  /** Labelled pairs a person would confirm (exact, variant or substitute). */
  positives: number;
  /** Of those, how many the matcher had among its suggestions at all (any relationship): candidate-and-decision recall without the tier. */
  surfacedAny: Prf;
  /** Suggested as exact/variant/substitute in the strong tier. */
  strong: Prf;
  /** Suggested as exact/variant/substitute in the strong or the medium tier (what a reviewer is shown to confirm). */
  review: Prf;
  /** Strong + medium + the relationship also right (an "exact" suggested for a labelled substitute is an error of kind, not of existence). */
  reviewExactKind: Prf;
  /** Labelled pairs that are NOT comparable but were suggested as strong. These are the errors that would damage trust. */
  strongFalse: LabelledPair[];
  /** Labelled comparable pairs the matcher did not suggest in strong+medium. */
  missed: LabelledPair[];
  confusion: Record<string, Record<string, number>>;
}

export function evaluate(labels: LabelledPair[], predictions: Prediction[]): EvaluationReport {
  const pred = new Map(predictions.map((p) => [`${p.source}|${p.competitor}`, p]));
  const isPos = (l: MatchRelationship) => COMPARABLE.includes(l);
  const positives = labels.filter((l) => isPos(l.label));
  const get = (l: LabelledPair) => pred.get(`${l.source}|${l.competitor}`);
  const inTier = (p: Prediction | undefined, tiers: string[]) => !!p && COMPARABLE.includes(p.relationship) && tiers.includes(p.tier);
  const predictedStrong = labels.filter((l) => inTier(get(l), ['strong']));
  const predictedReview = labels.filter((l) => inTier(get(l), ['strong', 'medium']));
  const confusion: Record<string, Record<string, number>> = {};
  for (const l of labels) {
    const p = get(l);
    const key = p ? `${p.relationship}/${p.tier}` : 'not suggested';
    (confusion[l.label] ??= {})[key] = ((confusion[l.label] ??= {})[key] ?? 0) + 1;
  }
  return {
    pairs: labels.length,
    positives: positives.length,
    surfacedAny: prf(positives.filter((l) => !!get(l)).length, labels.filter((l) => !!get(l)).length, positives.length),
    strong: prf(predictedStrong.filter((l) => isPos(l.label)).length, predictedStrong.length, positives.length),
    review: prf(predictedReview.filter((l) => isPos(l.label)).length, predictedReview.length, positives.length),
    reviewExactKind: prf(predictedReview.filter((l) => l.label === get(l)?.relationship).length, predictedReview.length, positives.length),
    strongFalse: predictedStrong.filter((l) => !isPos(l.label)),
    missed: positives.filter((l) => !inTier(get(l), ['strong', 'medium'])),
    confusion,
  };
}

/**
 * Candidate recall: of the comparable pairs a person labelled, the share whose competitor product is among the candidates retrieved for the source
 * product, measured before any decision is made. `candidatesOf` gives, per source id, the competitor ids retrieved per website in rank order.
 */
export function candidateRecall(positives: { source: string; competitor: string; site: string }[], candidatesOf: (source: string) => Map<string, string[]>, k: number): { hits: number; total: number; recall: number | null; lower: number | null } {
  let hits = 0;
  for (const p of positives) {
    const list = candidatesOf(p.source).get(p.site) ?? [];
    if (list.slice(0, k).includes(p.competitor)) hits++;
  }
  return { hits, total: positives.length, recall: positives.length ? hits / positives.length : null, lower: positives.length ? wilsonLower(hits, positives.length) : null };
}

/**
 * Expected calibration error for scores in [0,1] against 0/1 outcomes, over equal-width bins. Only meaningful when the scores are probabilities
 * fitted on reviewed pairs; until then no percentage may be shown.
 */
export function expectedCalibrationError(samples: { p: number; positive: boolean }[], bins = 10): { ece: number | null; bins: { from: number; to: number; n: number; meanP: number; rate: number }[] } {
  if (!samples.length) return { ece: null, bins: [] };
  const out: { from: number; to: number; n: number; meanP: number; rate: number }[] = [];
  let ece = 0;
  for (let b = 0; b < bins; b++) {
    const from = b / bins;
    const to = (b + 1) / bins;
    const inBin = samples.filter((s) => s.p >= from && (b === bins - 1 ? s.p <= to : s.p < to));
    if (!inBin.length) continue;
    const meanP = inBin.reduce((a, s) => a + s.p, 0) / inBin.length;
    const rate = inBin.filter((s) => s.positive).length / inBin.length;
    out.push({ from, to, n: inBin.length, meanP, rate });
    ece += (inBin.length / samples.length) * Math.abs(meanP - rate);
  }
  return { ece, bins: out };
}

/** Cohen's kappa for two labellers over the same pairs. */
export function cohensKappa(a: string[], b: string[]): number | null {
  if (a.length !== b.length || !a.length) return null;
  const n = a.length;
  const agree = a.filter((x, i) => x === b[i]).length / n;
  const cats = [...new Set([...a, ...b])];
  const expected = cats.reduce((s, c) => s + (a.filter((x) => x === c).length / n) * (b.filter((x) => x === c).length / n), 0);
  return expected === 1 ? 1 : (agree - expected) / (1 - expected);
}
