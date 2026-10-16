import { describe, expect, it } from 'vitest';
import { nextAttempt, nextPacificMidnight, shouldSkipSync } from './social-backoff.ts';

describe('nextPacificMidnight', () => {
  it('is midnight Pacific Daylight Time (07:00 UTC) in summer', () => {
    expect(nextPacificMidnight(new Date('2026-10-15T20:00:00Z')).toISOString()).toBe('2026-10-16T07:00:00.000Z');
  });
  it('is midnight Pacific Standard Time (08:00 UTC) in winter', () => {
    expect(nextPacificMidnight(new Date('2026-12-15T20:00:00Z')).toISOString()).toBe('2026-12-16T08:00:00.000Z');
  });
  it('just after midnight Pacific still means the NEXT midnight, never the one that just passed', () => {
    expect(nextPacificMidnight(new Date('2026-10-15T07:00:01Z')).toISOString()).toBe('2026-10-16T07:00:00.000Z');
    expect(nextPacificMidnight(new Date('2026-10-15T06:59:59Z')).toISOString()).toBe('2026-10-15T07:00:00.000Z');
  });
  it('handles the day clocks change', () => {
    // US clocks go back on 2026-11-01: that Pacific day has 25 hours, so the next midnight is 08:00 UTC on 11-02.
    expect(nextPacificMidnight(new Date('2026-11-01T12:00:00Z')).toISOString()).toBe('2026-11-02T08:00:00.000Z');
    // …and go forward on 2026-03-08.
    expect(nextPacificMidnight(new Date('2026-03-08T12:00:00Z')).toISOString()).toBe('2026-03-09T07:00:00.000Z');
  });
});

describe('nextAttempt', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  it('a used-up quota waits for the reset, plus a margin', () => {
    expect(nextAttempt({ kind: 'quota' }, 1, now).nextAttemptAt!.toISOString()).toBe('2026-10-16T07:05:00.000Z');
  });
  it('rate limits honour Retry-After, capped at six hours', () => {
    expect(nextAttempt({ kind: 'rate_limit', retryAfterSeconds: 120 }, 1, now).nextAttemptAt!.getTime() - now.getTime()).toBe(120_000);
    expect(nextAttempt({ kind: 'rate_limit', retryAfterSeconds: 999_999 }, 1, now).nextAttemptAt!.getTime() - now.getTime()).toBe(6 * 3_600_000);
  });
  it('rate limits and hiccups back off exponentially, capped at six hours', () => {
    const wait = (kind: 'rate_limit' | 'transient', n: number) => nextAttempt({ kind }, n, now).nextAttemptAt!.getTime() - now.getTime();
    expect([1, 2, 3].map((n) => wait('transient', n))).toEqual([5 * 60_000, 10 * 60_000, 20 * 60_000]);
    expect([1, 2, 3].map((n) => wait('rate_limit', n))).toEqual([15 * 60_000, 30 * 60_000, 60 * 60_000]);
    expect(wait('transient', 30)).toBe(6 * 3_600_000);
  });
  it('a missing approval is re-checked daily; a wrong handle weekly; a refused credential is never retried by itself', () => {
    expect(nextAttempt({ kind: 'permission' }, 1, now).nextAttemptAt!.getTime() - now.getTime()).toBe(24 * 3_600_000);
    expect(nextAttempt({ kind: 'not_found' }, 1, now).nextAttemptAt!.getTime() - now.getTime()).toBe(7 * 24 * 3_600_000);
    expect(nextAttempt({ kind: 'auth' }, 5, now).nextAttemptAt).toBeNull();
  });
});

describe('shouldSkipSync', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const later = new Date('2026-10-15T18:00:00Z');
  const earlier = new Date('2026-10-15T06:00:00Z');
  it('never skips an account that has not failed', () => {
    expect(shouldSkipSync({ failureKind: null, nextAttemptAt: null, credentialFingerprint: null }, 'fp', now, false).skip).toBe(false);
  });
  it('waits for the backoff to pass', () => {
    expect(shouldSkipSync({ failureKind: 'transient', nextAttemptAt: later, credentialFingerprint: 'fp' }, 'fp', now, false).skip).toBe(true);
    expect(shouldSkipSync({ failureKind: 'transient', nextAttemptAt: earlier, credentialFingerprint: 'fp' }, 'fp', now, false).skip).toBe(false);
  });
  it('a changed credential starts fresh, whatever failed before', () => {
    for (const kind of ['quota', 'rate_limit', 'auth', 'permission'] as const) {
      expect(shouldSkipSync({ failureKind: kind, nextAttemptAt: later, credentialFingerprint: 'old' }, 'new', now, false).skip, kind).toBe(false);
    }
  });
  it('a refused credential is not retried by schedule but a person may try again', () => {
    const a = { failureKind: 'auth' as const, nextAttemptAt: null, credentialFingerprint: 'fp' };
    expect(shouldSkipSync(a, 'fp', now, false).skip).toBe(true);
    expect(shouldSkipSync(a, 'fp', now, true).skip).toBe(false);
  });
  it('a person can retry a hiccup early, but never override a quota or a rate limit', () => {
    expect(shouldSkipSync({ failureKind: 'transient', nextAttemptAt: later, credentialFingerprint: 'fp' }, 'fp', now, true).skip).toBe(false);
    expect(shouldSkipSync({ failureKind: 'permission', nextAttemptAt: later, credentialFingerprint: 'fp' }, 'fp', now, true).skip).toBe(false);
    expect(shouldSkipSync({ failureKind: 'quota', nextAttemptAt: later, credentialFingerprint: 'fp' }, 'fp', now, true).skip).toBe(true);
    expect(shouldSkipSync({ failureKind: 'rate_limit', nextAttemptAt: later, credentialFingerprint: 'fp' }, 'fp', now, true).skip).toBe(true);
  });
});
