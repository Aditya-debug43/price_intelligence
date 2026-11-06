import { and, eq, sql } from 'drizzle-orm';
import { AiLimiter, pacificDay, type AppConfig } from '@ci/core';
import type { AiRunUsage } from '@ci/shared';
import { aiQuotaState, aiUsageDaily, type DbLike } from '@ci/database';

/**
 * The Gemini API keys and what is tracked for each. Every key is kept on the backend only (the environment file), is known elsewhere only by a short label ("k1", "k2" — never a part of the
 * key), and has ITS OWN rate limiter, daily count, learned limits, pause and stop, stored in the database so they survive restarts and are shared by the API and the worker.
 *
 * Work is spread across the keys by headroom: each request goes to the key with the most of its own daily budget left that is not paused or stopped. A key that Google pauses (a quota answer)
 * is skipped until its own pause ends; a key whose project reports a non-free-tier quota, or that Google refuses, is stopped on its own without stopping the other. Nothing is ever sent
 * beyond a key's own ceilings, and no paid model is selected. (Google applies free-tier limits per PROJECT: if both keys belong to one project they share one allowance, which the 429 answers
 * reveal and the limiters then respect.)
 */

export interface AiKey {
  id: string;
  apiKey: string;
}

export interface KeyRuntime extends AiKey {
  limiter: AiLimiter;
}

/** The configured keys, in order. The labels are fixed by position, so a key can be replaced without losing its history. */
export function aiKeysOf(config: Pick<AppConfig, 'GEMINI_API_KEY' | 'GEMINI_API_KEY_2'>): AiKey[] {
  const keys: AiKey[] = [];
  if (config.GEMINI_API_KEY) keys.push({ id: 'k1', apiKey: config.GEMINI_API_KEY });
  if (config.GEMINI_API_KEY_2) keys.push({ id: 'k2', apiKey: config.GEMINI_API_KEY_2 });
  return keys;
}

const limiters = new Map<string, AiLimiter>();
/** The limiters read time through this, set by each job from its services (the clock tests move), so a limiter and the rest of the job always agree about "now". */
let aiClock: () => Date = () => new Date();
export const setAiClock = (fn: () => Date) => { aiClock = fn; };

export interface Ceilings {
  model: string;
  rpm: number;
  tpm: number;
  dailyRequests: number;
  maxConcurrency: number;
}

/** One limiter per process, key and set of ceilings. */
export function limiterFor(c: Ceilings, keyId: string): AiLimiter {
  const k = `${keyId}|${c.model}|${c.rpm}|${c.tpm}|${c.dailyRequests}|${c.maxConcurrency}`;
  let l = limiters.get(k);
  if (!l) {
    l = new AiLimiter({ rpm: c.rpm, tpm: c.tpm, dailyRequests: c.dailyRequests, maxConcurrency: c.maxConcurrency }, () => aiClock().getTime());
    limiters.set(k, l);
  }
  return l;
}

export const runtimeFor = (c: Ceilings, keys: AiKey[]): KeyRuntime[] => keys.map((k) => ({ ...k, limiter: limiterFor(c, k.id) }));

/** The shared truth (the database) is loaded into a key's limiter before work: what that key used today, what Google taught us about it, its pause or stop. */
export async function hydrateLimiter(db: DbLike, l: AiLimiter, model: string, keyId: string, now: Date): Promise<void> {
  const day = pacificDay(now.getTime());
  const [usage] = await db.select({ n: aiUsageDaily.requests }).from(aiUsageDaily).where(and(eq(aiUsageDaily.day, day), eq(aiUsageDaily.model, model), eq(aiUsageDaily.keyId, keyId)));
  l.setToday(day, usage?.n ?? 0);
  const [st] = await db.select().from(aiQuotaState).where(and(eq(aiQuotaState.model, model), eq(aiQuotaState.keyId, keyId)));
  l.restore({
    learned: { ...(st?.learnedRpm ? { rpm: st.learnedRpm } : {}), ...(st?.learnedRpd ? { rpd: st.learnedRpd } : {}), ...(st?.learnedTpm ? { tpm: st.learnedTpm } : {}) },
    pausedUntil: st?.pausedUntil?.getTime() ?? null,
    pauseReason: st?.pauseReason ?? null,
    stopped: st?.stopped ?? null,
  });
}

export async function saveLimiterState(db: DbLike, l: AiLimiter, model: string, keyId: string, now: Date): Promise<void> {
  const s = l.snapshot();
  const values = {
    model, keyId, learnedRpm: s.learned.rpm ?? null, learnedRpd: s.learned.rpd ?? null, learnedTpm: s.learned.tpm ?? null,
    pausedUntil: s.pausedUntil ? new Date(s.pausedUntil) : null, pauseReason: s.pauseReason, stopped: s.stopped, updatedAt: now,
  };
  await db.insert(aiQuotaState).values(values).onConflictDoUpdate({ target: [aiQuotaState.model, aiQuotaState.keyId], set: values });
}

/** Stops one key until a person looks at it (Google refused it, the model is gone, a non-free-tier quota was seen). The other keys carry on. */
export async function markKeyStopped(db: DbLike, model: string, keyId: string, message: string, now: Date): Promise<void> {
  await db.insert(aiQuotaState).values({ model, keyId, stopped: message, updatedAt: now }).onConflictDoUpdate({ target: [aiQuotaState.model, aiQuotaState.keyId], set: { stopped: message, updatedAt: now } });
}

export async function addUsage(db: DbLike, model: string, keyId: string, now: Date, d: Partial<Omit<AiRunUsage, 'candidatesAnswered'>> & { candidatesAnswered?: number }): Promise<void> {
  const day = pacificDay(now.getTime());
  const inc = {
    requests: d.requests ?? 0, successes: d.successes ?? 0, failures: d.failures ?? 0, rateLimited: d.rateLimited ?? 0, inputTokens: d.inputTokens ?? 0, outputTokens: d.outputTokens ?? 0,
    thoughtTokens: d.thoughtTokens ?? 0, cachedResults: d.cachedResults ?? 0, candidatesAnswered: d.candidatesAnswered ?? 0, ms: Math.round(d.ms ?? 0),
  };
  await db
    .insert(aiUsageDaily)
    .values({ day, model, keyId, ...inc, updatedAt: now })
    .onConflictDoUpdate({
      target: [aiUsageDaily.day, aiUsageDaily.model, aiUsageDaily.keyId],
      set: {
        requests: sql`${aiUsageDaily.requests} + ${inc.requests}`, successes: sql`${aiUsageDaily.successes} + ${inc.successes}`, failures: sql`${aiUsageDaily.failures} + ${inc.failures}`,
        rateLimited: sql`${aiUsageDaily.rateLimited} + ${inc.rateLimited}`, inputTokens: sql`${aiUsageDaily.inputTokens} + ${inc.inputTokens}`, outputTokens: sql`${aiUsageDaily.outputTokens} + ${inc.outputTokens}`,
        thoughtTokens: sql`${aiUsageDaily.thoughtTokens} + ${inc.thoughtTokens}`, cachedResults: sql`${aiUsageDaily.cachedResults} + ${inc.cachedResults}`,
        candidatesAnswered: sql`${aiUsageDaily.candidatesAnswered} + ${inc.candidatesAnswered}`, ms: sql`${aiUsageDaily.ms} + ${inc.ms}`, updatedAt: now,
      },
    });
}

/**
 * The keys in the order a request should try them: keys that are working first, the one with the most of its own daily budget left first; keys that are paused after them (soonest back first);
 * stopped keys never.
 */
export function pickOrder(pool: KeyRuntime[], now: number, estimate = 0): KeyRuntime[] {
  const snaps = pool.map((k) => ({ k, s: k.limiter.snapshot(), free: k.limiter.check(estimate).ok })).filter((x) => !x.s.stopped);
  // a key that can take the request this instant comes first (then the one with the most daily budget left), so a key at its per-minute ceiling does not make the other wait
  const ready = snaps.filter((x) => !x.s.pausedUntil || x.s.pausedUntil <= now).sort((a, b) => Number(!a.free) - Number(!b.free) || a.s.requestsToday / Math.max(1, a.s.dailyBudget) - b.s.requestsToday / Math.max(1, b.s.dailyBudget));
  const waiting = snaps.filter((x) => x.s.pausedUntil && x.s.pausedUntil > now).sort((a, b) => a.s.pausedUntil! - b.s.pausedUntil!);
  return [...ready, ...waiting].map((x) => x.k);
}
