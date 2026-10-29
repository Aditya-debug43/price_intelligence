import { describe, expect, it } from 'vitest';
import { candidateRecall, cohensKappa, evaluate, expectedCalibrationError, prf, wilsonLower, type LabelledPair, type Prediction } from './metrics.ts';

describe('evaluation arithmetic', () => {
  it('Wilson lower bound is far below the observed rate for few pairs and approaches it for many', () => {
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(29, 33)).toBeCloseTo(0.727, 2);
    expect(wilsonLower(29, 33)).toBeLessThan(0.879);
    expect(wilsonLower(950, 1000)).toBeGreaterThan(0.93);
    expect(wilsonLower(10, 10)).toBeLessThan(0.75);
  });
  it('precision, recall and F1', () => {
    const r = prf(8, 10, 16);
    expect(r.precision).toBe(0.8);
    expect(r.recall).toBe(0.5);
    expect(r.f1).toBeCloseTo(0.615, 2);
    expect(prf(0, 0, 5).precision).toBeNull();
  });
  it('separates what was suggested in the strong tier from what only reached review, and lists the damaging errors', () => {
    const labels: LabelledPair[] = [
      { source: 'a', competitor: '1', label: 'substitute', set: 'dev' },
      { source: 'a', competitor: '2', label: 'related', set: 'dev' },
      { source: 'b', competitor: '3', label: 'substitute', set: 'dev' },
      { source: 'c', competitor: '4', label: 'non_match', set: 'dev' },
      { source: 'd', competitor: '5', label: 'exact', set: 'dev' },
    ];
    const preds: Prediction[] = [
      { source: 'a', competitor: '1', relationship: 'substitute', tier: 'strong' },
      { source: 'a', competitor: '2', relationship: 'substitute', tier: 'strong' },
      { source: 'b', competitor: '3', relationship: 'substitute', tier: 'medium' },
      { source: 'c', competitor: '4', relationship: 'related', tier: 'medium' },
    ];
    const r = evaluate(labels, preds);
    expect(r.positives).toBe(3);
    expect(r.strong).toMatchObject({ tp: 1, predicted: 2 });
    expect(r.review).toMatchObject({ tp: 2, predicted: 3 });
    expect(r.strongFalse.map((l) => l.competitor)).toEqual(['2']);
    expect(r.missed.map((l) => l.competitor)).toEqual(['5']);
    expect(r.confusion['related']).toEqual({ 'substitute/strong': 1 });
  });
  it('candidate recall counts only labelled positives found among the top k of their website', () => {
    const cand = new Map([['s1', new Map([['siteA', ['x', 'y', 'z']]])]]);
    const r = candidateRecall(
      [{ source: 's1', competitor: 'y', site: 'siteA' }, { source: 's1', competitor: 'z', site: 'siteA' }, { source: 's1', competitor: 'q', site: 'siteA' }],
      (s) => cand.get(s) ?? new Map(),
      2,
    );
    expect(r).toMatchObject({ hits: 1, total: 3 });
  });
  it('calibration error is zero for perfectly calibrated scores and large for confident wrong ones', () => {
    const good = Array.from({ length: 100 }, (_, i) => ({ p: 0.8, positive: i < 80 }));
    expect(expectedCalibrationError(good).ece).toBeCloseTo(0, 5);
    const bad = Array.from({ length: 100 }, (_, i) => ({ p: 0.95, positive: i < 50 }));
    expect(expectedCalibrationError(bad).ece).toBeCloseTo(0.45, 2);
    expect(expectedCalibrationError([]).ece).toBeNull();
  });
  it("Cohen's kappa", () => {
    expect(cohensKappa(['a', 'a', 'b', 'b'], ['a', 'a', 'b', 'b'])).toBe(1);
    expect(cohensKappa(['a', 'b', 'a', 'b'], ['b', 'a', 'b', 'a'])).toBe(-1);
    expect(cohensKappa([], [])).toBeNull();
  });
});
