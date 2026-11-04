import { nextPacificMidnight } from '../social-backoff.ts';

/**
 * Shared rate limiter for the Gemini free tier (pure: the clock and the randomness are injected, so it is tested without waiting).
 *
 * It enforces Shelfwatch's OWN ceilings — requests per minute, tokens per minute and a daily request budget — which are always kept below Google's free-tier limits, then
 * lowers them further with whatever Google's own 429 answers reveal (the limit named in a quota error). It never raises a limit above the configured one and never tries to
 * get around a quota: after a 429 it waits for the time Google named (plus jitter), a used-up daily quota pauses until the quota resets (midnight Pacific Time), and a quota that
 * is not a free-tier one stops everything. Concurrency adapts: it grows slowly while requests succeed and is halved by a rate-limit answer.
 */

export interface LimiterConfig {
  rpm: number;
  tpm: number;
  dailyRequests: number;
  maxConcurrency: number;
}

export type BlockReason = 'rpm' | 'tpm' | 'daily' | 'paused' | 'concurrency' | 'stopped';

export type Check = { ok: true } | { ok: false; reason: BlockReason; waitMs: number };

export interface RateLimitSignal {
  kind: 'quota_minute' | 'quota_day' | 'quota_tokens' | 'paid_tier' | 'overloaded' | 'transient' | 'timeout';
  retryAfterSeconds?: number;
  quotaValue?: number;
}

const DAY_MS = 86_400_000;

/** The calendar day in Pacific Time (when the free daily quota resets) of an instant. */
export function pacificDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/** The first instant (ms) of the next Pacific day, when the free daily quota resets (the same helper the YouTube quota uses). */
const nextResetMs = (ms: number): number => nextPacificMidnight(new Date(ms)).getTime();

export interface LimiterSnapshot {
  rpm: number;
  tpm: number;
  dailyBudget: number;
  requestsLastMinute: number;
  tokensLastMinute: number;
  requestsToday: number;
  day: string;
  concurrency: number;
  inFlight: number;
  pausedUntil: number | null;
  pauseReason: string | null;
  stopped: string | null;
  learned: { rpm?: number; rpd?: number; tpm?: number };
}

export class AiLimiter {
  private requests: number[] = [];
  private tokens: { at: number; n: number }[] = [];
  private day = '';
  private today = 0;
  private pausedUntil = 0;
  private pauseReason: string | null = null;
  private stopped: string | null = null;
  private successes = 0;
  private failures = 0;
  inFlight = 0;
  concurrency: number;
  learned: { rpm?: number; rpd?: number; tpm?: number } = {};

  constructor(private cfg: LimiterConfig, private now: () => number = Date.now, private random: () => number = Math.random) {
    this.concurrency = Math.min(2, cfg.maxConcurrency);
  }

  /** What the limiter would let through right now: Shelfwatch's ceiling, lowered by anything Google has told us. */
  effective(): { rpm: number; tpm: number; daily: number } {
    return {
      rpm: Math.max(1, Math.min(this.cfg.rpm, this.learned.rpm ? Math.floor(this.learned.rpm * 0.85) : Infinity)),
      tpm: Math.max(1000, Math.min(this.cfg.tpm, this.learned.tpm ? Math.floor(this.learned.tpm * 0.85) : Infinity)),
      daily: Math.max(1, Math.min(this.cfg.dailyRequests, this.learned.rpd ? Math.floor(this.learned.rpd * 0.9) : Infinity)),
    };
  }

  /** Loads the requests already made today (kept in the database, so a restart does not forget them). */
  setToday(day: string, requests: number): void {
    this.day = day;
    this.today = requests;
  }

  private roll(now: number): void {
    const d = pacificDay(now);
    if (d !== this.day) {
      this.day = d;
      this.today = 0;
      if (this.pauseReason === 'daily') this.pausedUntil = 0;
    }
    this.requests = this.requests.filter((t) => now - t < 60_000);
    this.tokens = this.tokens.filter((t) => now - t.at < 60_000);
  }

  check(estimatedTokens: number): Check {
    const now = this.now();
    this.roll(now);
    if (this.stopped) return { ok: false, reason: 'stopped', waitMs: DAY_MS };
    if (this.pausedUntil > now) return { ok: false, reason: 'paused', waitMs: this.pausedUntil - now };
    const eff = this.effective();
    if (this.today >= eff.daily) return { ok: false, reason: 'daily', waitMs: nextResetMs(now) - now };
    if (this.inFlight >= this.concurrency) return { ok: false, reason: 'concurrency', waitMs: 250 };
    if (this.requests.length >= eff.rpm) return { ok: false, reason: 'rpm', waitMs: Math.max(250, this.requests[0]! + 60_000 - now) };
    const used = this.tokens.reduce((s, t) => s + t.n, 0);
    if (this.tokens.length && used + estimatedTokens > eff.tpm) return { ok: false, reason: 'tpm', waitMs: Math.max(500, this.tokens[0]!.at + 60_000 - now) };
    return { ok: true };
  }

  /** Reserves a slot for a request about to be sent. */
  start(estimatedTokens: number): void {
    const now = this.now();
    this.roll(now);
    this.requests.push(now);
    this.tokens.push({ at: now, n: estimatedTokens });
    this.today++;
    this.inFlight++;
  }

  /** Replaces the estimate with the tokens Google reported. */
  finish(estimatedTokens: number, actualTokens: number | null): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (actualTokens !== null) {
      const slot = this.tokens.find((t) => t.n === estimatedTokens);
      if (slot) slot.n = actualTokens;
    }
  }

  success(): void {
    this.failures = 0;
    this.successes++;
    const eff = this.effective();
    // grow slowly, and only while the minute is not already nearly full
    if (this.successes >= 8 && this.concurrency < this.cfg.maxConcurrency && this.requests.length < eff.rpm * 0.7) {
      this.concurrency++;
      this.successes = 0;
    }
  }

  /** A quota or an overload answer: wait as Google asked (plus jitter), adapt, remember what the answer taught. */
  signal(s: RateLimitSignal): void {
    const now = this.now();
    this.roll(now);
    const jitter = 0.85 + this.random() * 0.3;
    this.successes = 0;
    if (s.kind === 'paid_tier') {
      this.stopped = 'Google reports a non-free-tier quota for this project; Gemini processing is stopped so that nothing could be billed.';
      return;
    }
    if (s.kind === 'quota_day') {
      if (s.quotaValue) this.learned.rpd = s.quotaValue;
      this.pausedUntil = nextResetMs(now) + Math.floor(this.random() * 60_000);
      this.pauseReason = 'daily';
      this.concurrency = 1;
      return;
    }
    if (s.kind === 'quota_minute' || s.kind === 'quota_tokens') {
      if (s.quotaValue) this.learned[s.kind === 'quota_minute' ? 'rpm' : 'tpm'] = s.quotaValue;
      this.pausedUntil = Math.max(this.pausedUntil, now + Math.max(5, s.retryAfterSeconds ?? 20) * 1000 * jitter);
      this.pauseReason = 'rate';
      this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
      return;
    }
    // overloaded, transient, timeout: exponential backoff with jitter, capped
    this.failures++;
    const base = Math.min(300, 5 * 2 ** (this.failures - 1));
    this.pausedUntil = Math.max(this.pausedUntil, now + Math.max(s.retryAfterSeconds ?? 0, base) * 1000 * jitter);
    this.pauseReason = 'backoff';
    if (s.kind === 'overloaded') this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
  }

  /**
   * Loads what the database says (the shared truth between the API and the worker, and across restarts): what Google's answers taught us, a pause, a stop. Authoritative, so a
   * person clearing a stop or a pause in the database takes effect here too. The sliding one-minute windows are not stored: they only matter within a process.
   */
  restore(s: { learned?: { rpm?: number; rpd?: number; tpm?: number }; pausedUntil?: number | null; pauseReason?: string | null; stopped?: string | null }): void {
    const now = this.now();
    this.learned = { ...(s.learned ?? {}) };
    this.stopped = s.stopped ?? null;
    if (s.pausedUntil && s.pausedUntil > now) {
      this.pausedUntil = s.pausedUntil;
      this.pauseReason = s.pauseReason ?? 'paused';
    } else if (this.pausedUntil <= now || this.pauseReason === 'daily') {
      this.pausedUntil = 0;
      this.pauseReason = null;
    }
  }

  /** Forgets a pause (an operator resumed, or the pause is over). */
  clearPause(): void {
    this.pausedUntil = 0;
    this.pauseReason = null;
  }

  snapshot(): LimiterSnapshot {
    const now = this.now();
    this.roll(now);
    const eff = this.effective();
    return {
      rpm: eff.rpm,
      tpm: eff.tpm,
      dailyBudget: eff.daily,
      requestsLastMinute: this.requests.length,
      tokensLastMinute: this.tokens.reduce((s, t) => s + t.n, 0),
      requestsToday: this.today,
      day: this.day,
      concurrency: this.concurrency,
      inFlight: this.inFlight,
      pausedUntil: this.pausedUntil > now ? this.pausedUntil : null,
      pauseReason: this.pausedUntil > now ? this.pauseReason : null,
      stopped: this.stopped,
      learned: { ...this.learned },
    };
  }
}
