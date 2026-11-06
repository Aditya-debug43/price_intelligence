import { AI_PROMPT_VERSION, AI_RESPONSE_SCHEMA, AI_SYSTEM_PROMPT, buildUserPayload, calibrate, estimateTokens, parseAiResponse, planBatches, DEFAULT_BATCH_LIMITS, type AiDecision, type AiLimiter, type BlockReason, type PayloadGroup, type PlannedRequest } from '@ci/core';
import { geminiGenerateJson, type GeminiError, type GeminiHttp, type GeminiUsage } from '@ci/connectors';

/**
 * Asking Gemini for one planned request, safely (no database here: the caller records usage through `onRequest`, so the worker job and the offline evaluation share it).
 *
 *  - every request waits for the shared limiter (requests, tokens, the daily budget and concurrency); a wait longer than `maxWaitMs` is not slept through: the caller is told when
 *    to come back, so a worker job ends cleanly and resumes later instead of sitting on a queue slot;
 *  - a 429 is never a failure of the job: the limiter learns from it and the request is retried after the time Google named;
 *  - a cut-off or unparsable answer is retried with half the candidates, down to one; candidates the model left out are asked again once, alone;
 *  - a permanent problem (refused key, model not offered, a non-free-tier quota) stops processing with a reason and is not retried.
 */

export interface AskConfig {
  apiKey?: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Never sleep longer than this inside one call; return `blocked` instead. */
  maxWaitMs: number;
}

export interface UsageEvent {
  ok: boolean;
  errorKind?: string;
  /** Google's quota name and limit, when an answer named one. */
  quotaId?: string;
  quotaValue?: number;
  usage?: GeminiUsage;
  ms: number;
  candidates: number;
}

export interface AskDeps {
  cfg: AskConfig;
  limiter: AiLimiter;
  http?: GeminiHttp;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  onRequest: (e: UsageEvent) => void | Promise<void>;
  shouldStop: () => boolean | Promise<boolean>;
  /** The characters-per-token ratio, calibrated from what Google reports; shared across calls. */
  tokens: { charsPerToken: number };
}

/** Answers are keyed by the PAIR (source variant, candidate variant), so a competitor product that appears under two source products in one request keeps both answers. */
export const pairKey = (sourceRef: string, candidateRef: string): string => `${sourceRef}|${candidateRef}`;

export type AskResult =
  | { status: 'done'; decisions: Map<string, AiDecision>; unanswered: string[] }
  | { status: 'blocked'; reason: BlockReason; resumeAt: number; partial: Map<string, AiDecision> }
  | { status: 'stopped'; partial: Map<string, AiDecision> }
  | { status: 'failed'; error: GeminiError; partial: Map<string, AiDecision> };

const PERMANENT = new Set(['paid_tier', 'invalid_key', 'model_unavailable', 'not_configured', 'bad_request']);

export async function askRequest(req: PlannedRequest, deps: AskDeps): Promise<AskResult> {
  const answers = new Map<string, AiDecision>();
  const keyOf = new Map<string, string>();
  for (const g of req.groups) for (const c of g.candidates) keyOf.set(c.id, pairKey(g.ref, c.ref));
  const estimate = () => req.estimatedInputTokens + req.estimatedOutputTokens;

  for (let attempt = 0; attempt < 5; attempt++) {
    if (await deps.shouldStop()) return { status: 'stopped', partial: answers };
    // wait for the limiter (or hand back control when the wait is long)
    for (;;) {
      const c = deps.limiter.check(estimate());
      if (c.ok) break;
      if (c.reason === 'stopped') return { status: 'failed', error: { kind: 'paid_tier', status: 429, message: deps.limiter.snapshot().stopped ?? 'Gemini processing is stopped.' }, partial: answers };
      if (c.waitMs > deps.cfg.maxWaitMs || c.reason === 'daily') return { status: 'blocked', reason: c.reason, resumeAt: deps.now() + c.waitMs, partial: answers };
      await deps.sleep(Math.min(c.waitMs + 50, deps.cfg.maxWaitMs));
      if (await deps.shouldStop()) return { status: 'stopped', partial: answers };
    }
    deps.limiter.start(estimate());
    const res = await geminiGenerateJson({ apiKey: deps.cfg.apiKey, model: deps.cfg.model, timeoutMs: deps.cfg.timeoutMs }, { system: AI_SYSTEM_PROMPT, user: buildUserPayload(req.groups), schema: AI_RESPONSE_SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: deps.cfg.maxOutputTokens, temperature: 0 }, deps.http);
    const usage = res.ok ? res.usage : res.usage;
    deps.limiter.finish(estimate(), usage ? usage.totalTokens : null);
    if (usage) deps.tokens.charsPerToken = calibrate(deps.tokens.charsPerToken, req.estimatedInputTokens, usage.promptTokens);
    await deps.onRequest({ ok: res.ok, errorKind: res.ok ? undefined : res.error.kind, quotaId: res.ok ? undefined : res.error.quotaId, quotaValue: res.ok ? undefined : res.error.quotaValue, usage, ms: res.ms, candidates: req.candidates });

    if (res.ok) {
      deps.limiter.success();
      const parsed = parseAiResponse(res.json);
      for (const d of parsed.decisions) {
        const key = keyOf.get(d.candidate_id);
        if (key && !answers.has(key)) answers.set(key, { ...d, candidate_id: key.split('|')[1]! });
      }
      const missing = [...keyOf.values()].filter((k) => !answers.has(k));
      if (!missing.length) return { status: 'done', decisions: answers, unanswered: [] };
      // the model left some out (or they did not validate): ask for just those, once
      if (req.candidates > missing.length && attempt < 4) {
        const rest = restrict(req, new Set(missing), deps);
        const r = await askRequest(rest, deps);
        for (const [k, v] of r.status === 'done' ? r.decisions : r.partial) answers.set(k, v);
        if (r.status === 'done') return { status: 'done', decisions: answers, unanswered: r.unanswered };
        return r.status === 'failed' ? { ...r, partial: answers } : { ...r, partial: answers };
      }
      return { status: 'done', decisions: answers, unanswered: missing };
    }

    const e = res.error;
    if (e.kind === 'paid_tier') { deps.limiter.signal({ kind: 'paid_tier' }); return { status: 'failed', error: e, partial: answers }; }
    if (PERMANENT.has(e.kind)) return { status: 'failed', error: e, partial: answers };
    if (e.kind === 'quota_day') { deps.limiter.signal({ kind: 'quota_day', quotaValue: e.quotaValue }); return { status: 'blocked', reason: 'daily', resumeAt: deps.now() + (deps.limiter.check(0) as { waitMs?: number }).waitMs!, partial: answers }; }
    if (e.kind === 'quota_minute' || e.kind === 'quota_tokens') deps.limiter.signal({ kind: e.kind, retryAfterSeconds: e.retryAfterSeconds, quotaValue: e.quotaValue });
    else if (e.kind === 'overloaded' || e.kind === 'timeout' || e.kind === 'transient') deps.limiter.signal({ kind: e.kind });
    if (e.kind === 'truncated' || e.kind === 'blocked') {
      // fewer candidates in one answer: halve, down to one candidate
      if (req.candidates > 1) {
        const flat = req.groups.flatMap((g) => g.candidates.map((c) => ({ g, c })));
        const half = Math.ceil(flat.length / 2);
        for (const part of [flat.slice(0, half), flat.slice(half)]) {
          const groups: PayloadGroup[] = [...new Set(part.map((x) => x.g))].map((g) => ({ ref: g.ref, source: g.source, candidates: part.filter((x) => x.g === g).map((x) => x.c) }));
          const sub = planBatches(groups, { ...DEFAULT_BATCH_LIMITS, maxCandidates: 999, maxOutputTokens: 1e9, maxInputTokens: 1e9, charsPerToken: deps.tokens.charsPerToken })[0]!;
          const r = await askRequest(sub, deps);
          for (const [k, v] of r.status === 'done' ? r.decisions : r.partial) answers.set(k, v);
          if (r.status !== 'done') return { ...r, partial: answers } as AskResult;
        }
        return { status: 'done', decisions: answers, unanswered: [...keyOf.values()].filter((k) => !answers.has(k)) };
      }
      return { status: 'done', decisions: answers, unanswered: [...keyOf.values()] };
    }
    // a 429 or an overload: the limiter now holds a pause; the next loop waits for it (or hands control back)
  }
  return { status: 'done', decisions: answers, unanswered: [...keyOf.values()].filter((k) => !answers.has(k)) };
}

/** The same request reduced to the pairs that still need an answer. */
export function restrict(req: PlannedRequest, keys: Set<string>, deps: Pick<AskDeps, 'tokens'>): PlannedRequest {
  const groups: PayloadGroup[] = req.groups.map((g) => ({ ref: g.ref, source: g.source, candidates: g.candidates.filter((c) => keys.has(pairKey(g.ref, c.ref))) })).filter((g) => g.candidates.length);
  return planBatches(groups, { ...DEFAULT_BATCH_LIMITS, maxCandidates: 999, maxOutputTokens: 1e9, maxInputTokens: 1e9, charsPerToken: deps.tokens.charsPerToken })[0]!;
}

export { AI_PROMPT_VERSION, estimateTokens };
