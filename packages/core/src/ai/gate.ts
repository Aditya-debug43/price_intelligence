/**
 * The release gate for automatic approval (pure). Nothing in Shelfwatch approves a match from an AI answer on a hunch: a NARROW policy (one class in one domain) may only be switched on after the
 * answers it would approve have been audited against an INDEPENDENTLY labelled holdout that was kept out of development and tuning. The gate does the arithmetic and says which line failed; it
 * decides nothing by itself, and it never treats "too few examples" as a pass.
 *
 * What blocks a policy: too few independent examples, precision below the threshold or a lower confidence bound that is too low, or ANY critical compatibility violation. What does not block it:
 * whole-domain candidate recall and match recall. Those are product goals, reported beside the gate, because poor recall elsewhere says nothing about whether a precise policy is reliable.
 *
 * "Accuracy across all possible pairs" is deliberately not a measure: nearly every random pair of products is a non-match, so it looks excellent while real matches are missed.
 */

export interface GateThresholds {
  /** Observed precision needed. */
  autoPrecision: number;
  /** ...and the 95% lower confidence bound must be above this. */
  precisionLowerBound: number;
  /** Fewest independent units (product families) needed before precision means anything. */
  minExamples: number;
  /** Product goals (reported, not blocking). */
  candidateRecall: number;
  matchRecall: number;
}

export const DEFAULT_GATE: GateThresholds = { autoPrecision: 0.98, precisionLowerBound: 0.9, minExamples: 100, candidateRecall: 0.95, matchRecall: 0.9 };

export interface Proportion {
  hits: number;
  total: number;
}

export interface GateInput {
  /** Independent families whose judged answers were all correct, of all judged families. */
  precision: Proportion;
  /** Judged answers that would have been critical compatibility violations if approved. */
  criticalViolations: number;
  candidateRecall: Proportion;
  matchRecall: Proportion;
}

export interface Interval {
  estimate: number | null;
  low: number | null;
  high: number | null;
}

/** The Wilson score interval: honest about small samples (a 20 out of 20 is not "100%"). */
export function wilson(hits: number, total: number, z = 1.96): Interval {
  if (total <= 0) return { estimate: null, low: null, high: null };
  const p = hits / total;
  const z2 = z * z;
  const centre = (p + z2 / (2 * total)) / (1 + z2 / total);
  const half = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / (1 + z2 / total);
  return { estimate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export interface GateLine {
  name: 'automatic approval precision' | 'critical violations' | 'candidate recall' | 'match recall';
  interval: Interval;
  needed: number;
  examples: number;
  /** Whether this line decides the gate. Candidate recall and match recall are goals: shown, never blocking. */
  required: boolean;
  passed: boolean;
  why: string;
}

export interface GateResult {
  passed: boolean;
  lines: GateLine[];
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`);

export function evaluateGate(input: GateInput, t: GateThresholds = DEFAULT_GATE): GateResult {
  const iv = wilson(input.precision.hits, input.precision.total);
  const enough = input.precision.total >= t.minExamples;
  const reached = iv.estimate !== null && iv.estimate >= t.autoPrecision;
  const bound = iv.low !== null && iv.low > t.precisionLowerBound;
  const precision: GateLine = {
    name: 'automatic approval precision', interval: iv, needed: t.autoPrecision, examples: input.precision.total, required: true, passed: enough && reached && bound,
    why: !enough ? `only ${input.precision.total} independent labelled example${input.precision.total === 1 ? '' : 's'} (at least ${t.minExamples} are needed)`
      : !reached ? `${pct(iv.estimate)} (95% interval ${pct(iv.low)}–${pct(iv.high)}) is below ${pct(t.autoPrecision)}`
      : !bound ? `${pct(iv.estimate)} reaches ${pct(t.autoPrecision)} but the 95% lower bound ${pct(iv.low)} is not above ${pct(t.precisionLowerBound)}: more examples are needed`
      : `${pct(iv.estimate)} (95% interval ${pct(iv.low)}–${pct(iv.high)}) reaches ${pct(t.autoPrecision)} with a lower bound above ${pct(t.precisionLowerBound)}`,
  };
  const critical: GateLine = {
    name: 'critical violations', interval: { estimate: input.criticalViolations, low: null, high: null }, needed: 0, examples: input.precision.total, required: true, passed: input.criticalViolations === 0,
    why: input.criticalViolations === 0 ? 'none found' : `${input.criticalViolations} critical compatibility violation${input.criticalViolations === 1 ? '' : 's'} found: this rule stays blocked until repaired and retested`,
  };
  const goal = (name: GateLine['name'], p: Proportion, needed: number): GateLine => {
    const i = wilson(p.hits, p.total);
    return { name, interval: i, needed, examples: p.total, required: false, passed: i.estimate !== null && i.estimate >= needed, why: p.total === 0 ? 'not measured (no labelled examples)' : `${pct(i.estimate)} (95% interval ${pct(i.low)}–${pct(i.high)}); the goal is ${pct(needed)}. A product goal: it does not block a precise policy` };
  };
  const lines = [precision, critical, goal('candidate recall', input.candidateRecall, t.candidateRecall), goal('match recall', input.matchRecall, t.matchRecall)];
  return { passed: lines.filter((l) => l.required).every((l) => l.passed), lines };
}
