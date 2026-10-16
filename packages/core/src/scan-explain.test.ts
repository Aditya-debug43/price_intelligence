import { describe, expect, it } from 'vitest';
import { explainScanRun, type ScanRunFacts } from './scan-explain.ts';

const base: ScanRunFacts = { status: 'succeeded', kind: 'discovery', isComplete: true, errorCode: null, error: null, productsSaved: 120, estimatedTotal: 120, requestsMade: 140, requestBudget: 2000, urlsDiscovered: 120, urlsFetched: 120, errorsCount: 0 };
const run = (o: Partial<ScanRunFacts>, q: Record<string, number> = {}) => explainScanRun({ ...base, ...o }, q);

describe('scan run explanations never claim more than the run established', () => {
  it('a complete run says so, and lists unreadable pages instead of hiding them', () => {
    const e = run({}, { failed: 3 });
    expect(e.completeness).toBe('complete');
    expect(e.summary).toMatch(/whole accessible catalogue was collected: 120 products/);
    expect(e.summary).toMatch(/3 pages could not be read/);
    expect(e.reason).toBeNull();
  });

  it('a partial run gives the real reason and the next step', () => {
    const budget = run({ status: 'partial', isComplete: false, errorCode: 'request_budget', productsSaved: 60, estimatedTotal: 120 });
    expect(budget.completeness).toBe('partial');
    expect(budget.summary).toMatch(/60 products of about 120/);
    expect(budget.reason).toMatch(/request budget.*2000 requests/);
    expect(budget.nextStep).toMatch(/again/);
    expect(run({ status: 'partial', isComplete: false, errorCode: 'deadline' }).reason).toMatch(/time limit/);
  });

  it('a small sample is described as a sample, not as the catalogue', () => {
    const e = run({ status: 'partial', isComplete: false, kind: 'sample', productsSaved: 25 });
    expect(e.completeness).toBe('partial');
    expect(e.reason).toMatch(/small sample on purpose/);
    expect(e.nextStep).toMatch(/full collection/);
  });

  it('a high page-failure rate is named as the reason', () => {
    const e = run({ status: 'partial', isComplete: false, productsSaved: 80, urlsFetched: 100 }, { failed: 20 });
    expect(e.reason).toMatch(/20 pages could not be read \(20%/);
  });

  it('blocked, failed and unsupported runs are failures with causes — never empty catalogues', () => {
    expect(run({ status: 'blocked', isComplete: false, productsSaved: 0, errorCode: 'robots' })).toMatchObject({ completeness: 'none', reason: expect.stringMatching(/robots\.txt/) });
    expect(run({ status: 'blocked', isComplete: false, productsSaved: 0, errorCode: 'access_denied' }).reason).toMatch(/never works around it/);
    const failed = run({ status: 'failed', isComplete: false, productsSaved: 0, errorCode: 'empty_feed' });
    expect(failed.summary).toMatch(/failure, not an empty catalogue/);
    expect(failed.reason).toMatch(/listed no products/);
    expect(run({ status: 'failed', isComplete: false, productsSaved: 0, errorCode: 'unsupported_site' }).nextStep).toMatch(/product feed/);
    const lost = run({ status: 'failed', isComplete: false, productsSaved: 40, errorCode: 'worker_lost' });
    expect(lost.completeness).toBe('partial'); // what was saved before the worker went silent is kept, and is not called complete
    expect(lost.summary).toMatch(/40 products saved before the failure/);
    expect(lost.reason).toMatch(/stopped responding several times/);
    expect(lost.reason).toMatch(/Everything collected before that is kept/);
    expect(run({ status: 'failed', isComplete: false, productsSaved: 0, errorCode: 'something_new', error: 'Strange error' }).reason).toBe('Strange error');
  });

  it('queued, running and cancelled runs describe themselves honestly', () => {
    expect(run({ status: 'queued' }).summary).toMatch(/Waiting/);
    expect(run({ status: 'running', productsSaved: 40, estimatedTotal: 120 }, { pending: 80 }).summary).toMatch(/40 products of about 120 collected so far, 80 pages still to read/);
    const cancelled = run({ status: 'cancelled', isComplete: false, productsSaved: 0 });
    expect(cancelled.completeness).toBe('none');
    expect(cancelled.summary).toMatch(/Cancelled after collecting 0 products/);
  });
});
