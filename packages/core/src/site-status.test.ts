import { describe, expect, it } from 'vitest';
import { deriveSiteStatus, type SiteStatusInput } from './site-status.ts';

const now = new Date('2026-10-15T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const base: SiteStatusInput = {
  active: true,
  consentStatus: 'confirmed',
  capability: 'full',
  hasUsableMethod: true,
  productCount: 0,
  lastRun: null,
  collecting: false,
  newestObservationAt: null,
  now,
  staleAfterHours: 36,
};
const state = (over: Partial<SiteStatusInput>) => deriveSiteStatus({ ...base, ...over });

describe('site collection status — one honest answer per website', () => {
  it('walks the normal journey: not checked → awaiting permission → not collected → collecting → collected', () => {
    expect(state({ capability: null }).state).toBe('not_profiled');
    expect(state({ consentStatus: 'pending' }).state).toBe('awaiting_permission');
    expect(state({}).state).toBe('not_collected');
    expect(state({ collecting: true, collectingProgress: { saved: 40, estimated: 120 } })).toMatchObject({ state: 'collecting', detail: expect.stringContaining('40 products collected of about 120') });
    expect(state({ productCount: 120, lastRun: { status: 'succeeded', isComplete: true, kind: 'discovery' }, newestObservationAt: hoursAgo(2) })).toMatchObject({ state: 'collected', severity: 'ok' });
  });

  it('a blocked website is "access denied", never an empty catalogue — before and after permission', () => {
    expect(state({ capability: 'blocked', consentStatus: 'pending' }).state).toBe('access_denied');
    expect(state({ capability: 'blocked' }).detail).toMatch(/will not work around it/);
    expect(state({ lastRun: { status: 'blocked', isComplete: false, kind: 'discovery' }, productCount: 0 }).state).toBe('access_denied');
  });

  it('a failed or unreadable collection is "failed", never "collected with no products"', () => {
    const failed = state({ lastRun: { status: 'failed', isComplete: false, kind: 'discovery', error: 'HTTP 500' } });
    expect(failed.state).toBe('failed');
    expect(failed.detail).toMatch(/failure, not an empty catalogue/);
    expect(state({ capability: 'failed' }).state).toBe('failed');
    expect(state({ capability: 'failed' }).detail).toMatch(/not an empty catalogue/);
    // even a run recorded as "succeeded" with nothing saved is a failure, not an empty success
    expect(state({ lastRun: { status: 'succeeded', isComplete: true, kind: 'discovery' }, productCount: 0 }).state).toBe('failed');
  });

  it('a site we have no way to read is "unsupported" and says what the owner can offer instead', () => {
    const s = state({ capability: 'limited', hasUsableMethod: false });
    expect(s.state).toBe('unsupported');
    expect(s.nextAction).toMatch(/product feed|authorised platform connection/);
  });

  it('old data is "stale", and partial coverage is disclosed', () => {
    expect(state({ productCount: 50, lastRun: { status: 'succeeded', isComplete: true, kind: 'discovery' }, newestObservationAt: hoursAgo(40) }).state).toBe('stale');
    expect(state({ productCount: 50, lastRun: { status: 'partial', isComplete: false, kind: 'discovery' }, newestObservationAt: hoursAgo(1) }).state).toBe('partial');
    expect(state({ productCount: 50, lastRun: { status: 'succeeded', isComplete: false, kind: 'sample' }, newestObservationAt: hoursAgo(1) }).state).toBe('partial'); // a small sample is not the catalogue
    expect(state({ productCount: 50, lastRun: { status: 'succeeded', isComplete: false, kind: 'refresh' }, newestObservationAt: hoursAgo(1) }).state).toBe('collected'); // a refresh that re-checked everything known is a full cycle
  });

  it('inactive sites and a collection the customer stopped are explicit', () => {
    expect(state({ active: false }).state).toBe('inactive');
    const revoked = state({ consentStatus: 'revoked' });
    expect(revoked.state).toBe('awaiting_permission');
    expect(revoked.detail).toMatch(/stopped collection/);
  });

  it('a cancelled first collection is not a failure and not a success', () => {
    expect(state({ lastRun: { status: 'cancelled', isComplete: false, kind: 'discovery' } }).state).toBe('not_collected');
  });
});
