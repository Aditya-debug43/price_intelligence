/**
 * The release gate for automatic approval (pure). Nothing in Shelfwatch approves a match from an AI answer: a class of pairs may only be switched to automatic approval after it has been
 * measured against an INDEPENDENTLY labelled test set that was kept out of development and threshold tuning, and has passed every line below. The gate does the arithmetic and says which
 * line failed; it decides nothing by itself, and it never treats "too few examples" as a pass.
 *
 * "Accuracy across all possible pairs" is deliberately not a measure here: nearly every random pair of products is a non-match, so it looks excellent while real matches are missed.
 */

export interface GateThresholds {
  /** The correct VARIANT reaches the shortlist when a counterpart exists. */
  candidateRecall: number;
  /** Of the pairs that would be approved automatically, the share that are truly correct. */
  autoPrecision: number;
  /** Of the real counterparts in the test set, the share the system identifies. */
  matchRecall: number;
  /** Fewest labelled examples a class needs before its precision means anything. */
  minExamples: number;
}

export const DEFAULT_GATE: GateThresholds = { candidateRecall: 0.95, autoPrecision: 0.98, matchRecall: 0.9, minExamples: 100 };

export interface Proportion {
  hits: number;
  total: number;
}

/** What the measurement of one class of automatic approval (or of one domain) found. */
export interface GateInput {
  candidateRecall: Proportion;
  autoPrecision: Proportion;
  matchRecall: Proportion;
  /** Of the own variants known to have a counterpart: how many got a correct automatic decision, how many went to a person, how many stayed unresolved. For the report; not a pass/fail line. */
  coverage?: { automatic: number; review: number; unresolved: number };
  /** Products with no counterpart that received a positive suggestion, and how many such products there were: measured and reported, with its own ceiling. */
  noCounterpartMistakes?: Proportion;
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
  name: 'candidate recall' | 'automatic approval precision' | 'match recall';
  interval: Interval;
  needed: number;
  examples: number;
  passed: boolean;
  why: string;
}

export interface GateResult {
  passed: boolean;
  lines: GateLine[];
  coverage: { automatic: number; review: number; unresolved: number } | null;
  noCounterpartMistakeRate: Interval | null;
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`);

/** A line passes when the measured share reaches the threshold AND there are enough labelled examples to mean it. */
export function evaluateGate(input: GateInput, t: GateThresholds = DEFAULT_GATE): GateResult {
  const line = (name: GateLine['name'], p: Proportion, needed: number): GateLine => {
    const interval = wilson(p.hits, p.total);
    const enough = p.total >= t.minExamples;
    const reached = interval.estimate !== null && interval.estimate >= needed;
    return {
      name, interval, needed, examples: p.total, passed: enough && reached,
      why: !enough ? `only ${p.total} labelled example${p.total === 1 ? '' : 's'} (at least ${t.minExamples} are needed)` : reached ? `${pct(interval.estimate)} (95% interval ${pct(interval.low)}–${pct(interval.high)}) reaches ${pct(needed)}` : `${pct(interval.estimate)} (95% interval ${pct(interval.low)}–${pct(interval.high)}) is below ${pct(needed)}`,
    };
  };
  const lines = [line('candidate recall', input.candidateRecall, t.candidateRecall), line('automatic approval precision', input.autoPrecision, t.autoPrecision), line('match recall', input.matchRecall, t.matchRecall)];
  return { passed: lines.every((l) => l.passed), lines, coverage: input.coverage ?? null, noCounterpartMistakeRate: input.noCounterpartMistakes ? wilson(input.noCounterpartMistakes.hits, input.noCounterpartMistakes.total) : null };
}
