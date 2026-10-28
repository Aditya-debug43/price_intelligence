import { parseRetryAfter } from './safe-fetch.ts';

/**
 * What a non-success answer from a catalogue source means for the collection.
 *
 * A website that answers "slow down" (429) or is briefly unavailable (5xx, 408) has not refused anything: the collection keeps what it has saved, waits, and
 * continues from where it stopped. Only an explicit refusal (401, 403) or a missing source (404) ends the method. Every other status is reported as it is.
 */
export interface HttpFailure extends Error {
  code: 'rate_limited' | 'temporarily_unavailable' | 'http_error';
  status: number;
  /** How long the website asked us to wait (its Retry-After), when it said. */
  retryAfterMs: number | null;
}

export function httpFailure(res: { status: number; headers: Record<string, string> }, what: string): HttpFailure {
  const retryAfterMs = parseRetryAfter(res.headers['retry-after']);
  if (res.status === 429) {
    return Object.assign(new Error(`${what} asked Shelfwatch to slow down (HTTP 429, too many requests)`), { code: 'rate_limited' as const, status: 429, retryAfterMs });
  }
  if (res.status === 408 || res.status >= 500) {
    return Object.assign(new Error(`${what} was temporarily unavailable (HTTP ${res.status})`), { code: 'temporarily_unavailable' as const, status: res.status, retryAfterMs });
  }
  return Object.assign(new Error(`${what} returned HTTP ${res.status}`), { code: 'http_error' as const, status: res.status, retryAfterMs });
}

/** Failures that say nothing about the website's catalogue and are worth trying again later. */
export const TRANSIENT_CODES: ReadonlySet<string> = new Set(['rate_limited', 'temporarily_unavailable', 'timeout', 'network']);

export function isTransientCode(code: unknown): boolean {
  return typeof code === 'string' && TRANSIENT_CODES.has(code);
}

/** How long a failure asked us to wait, when it said so. */
export function retryAfterOf(e: unknown): number | null {
  const v = (e as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}
