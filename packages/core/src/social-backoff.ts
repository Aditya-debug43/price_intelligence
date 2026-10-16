/**
 * When may we ask a social API again after it refused or failed? Pure policy, no I/O.
 *
 *  - quota:      the provider's daily quota is used up. YouTube's quota resets at midnight Pacific Time, so we wait for that.
 *  - rate_limit: too many requests for now. Honour the provider's Retry-After when given, otherwise back off exponentially.
 *  - transient:  the provider (or the network) hiccuped. Exponential backoff, capped.
 *  - permission: the app lacks a feature/permission that platform review may grant later without any change on our side. Check daily.
 *  - not_found:  the handle does not resolve to a public professional account. Someone has to fix the mapping; re-check weekly.
 *  - auth:       the credential is invalid, expired or revoked. Retrying cannot help; wait until the credential changes.
 */

export type SocialFailureKind = 'quota' | 'rate_limit' | 'transient' | 'permission' | 'not_found' | 'auth';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** First instant at or after `now` that is 00:00 on the next calendar day in America/Los_Angeles (handles DST). */
export function nextPacificMidnight(now: Date): Date {
  const parts = (d: Date) =>
    Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(d)
        .filter((p) => p.type !== 'literal')
        .map((p) => [p.type, Number(p.value)]),
    ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute', number>;
  const local = parts(now);
  // Midnight local is between 07:00 and 08:00 UTC of the next local day; find it exactly.
  const guess = Date.UTC(local.year, local.month - 1, local.day + 1, 7, 0, 0);
  for (const offsetH of [0, 1]) {
    const cand = new Date(guess + offsetH * HOUR);
    const p = parts(cand);
    if (p.hour === 0 && p.minute === 0) return cand;
  }
  return new Date(guess + 8 * HOUR); // unreachable in practice; still a safe "tomorrow"
}

export interface BackoffDecision {
  /** Earliest time to try again; null = do not retry until the credential changes. */
  nextAttemptAt: Date | null;
  /** Plain-language reason shown to the customer. */
  reason: string;
}

export function nextAttempt(failure: { kind: SocialFailureKind; retryAfterSeconds?: number | null }, consecutiveFailures: number, now: Date): BackoffDecision {
  const n = Math.max(1, consecutiveFailures);
  const exp = (baseMs: number) => Math.min(6 * HOUR, baseMs * 2 ** (n - 1));
  switch (failure.kind) {
    case 'quota':
      return { nextAttemptAt: new Date(nextPacificMidnight(now).getTime() + 5 * MIN), reason: 'The daily API quota is used up; it resets at midnight Pacific Time.' };
    case 'rate_limit': {
      const wait = failure.retryAfterSeconds && failure.retryAfterSeconds > 0 ? Math.min(6 * HOUR, failure.retryAfterSeconds * 1000) : exp(15 * MIN);
      return { nextAttemptAt: new Date(now.getTime() + wait), reason: 'The platform asked us to slow down.' };
    }
    case 'transient':
      return { nextAttemptAt: new Date(now.getTime() + exp(5 * MIN)), reason: 'The platform did not answer properly.' };
    case 'permission':
      return { nextAttemptAt: new Date(now.getTime() + 24 * HOUR), reason: 'The app does not have the required platform approval yet.' };
    case 'not_found':
      return { nextAttemptAt: new Date(now.getTime() + 7 * 24 * HOUR), reason: 'The account could not be found; check the handle.' };
    case 'auth':
      return { nextAttemptAt: null, reason: 'The credential was refused; it will not be retried until it is replaced.' };
  }
}

/**
 * Should a scheduled or manual sync skip this account right now? Rate limits and quotas are always respected — even a manual sync
 * does not hammer a provider that asked us to wait. Other blocks (bad credential, missing approval, wrong handle) can be retried by a person.
 */
export function shouldSkipSync(
  a: { failureKind: SocialFailureKind | null; nextAttemptAt: Date | null; credentialFingerprint: string | null },
  currentFingerprint: string,
  now: Date,
  manual: boolean,
): { skip: boolean; why: string | null } {
  if (!a.failureKind) return { skip: false, why: null };
  if (a.credentialFingerprint !== currentFingerprint) return { skip: false, why: null }; // the credential changed: start fresh
  if (a.failureKind === 'auth') return manual ? { skip: false, why: null } : { skip: true, why: 'The credential was refused earlier. Replace it, then sync again.' };
  if (a.nextAttemptAt && a.nextAttemptAt > now) {
    const respected = a.failureKind === 'quota' || a.failureKind === 'rate_limit';
    if (manual && !respected) return { skip: false, why: null };
    return { skip: true, why: `Waiting until ${a.nextAttemptAt.toISOString()} before asking again.` };
  }
  return { skip: false, why: null };
}
