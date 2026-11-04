import type { PayloadCandidate, PayloadGroup } from './prompt.ts';
import { AI_SYSTEM_PROMPT, buildUserPayload } from './prompt.ts';

/**
 * Token-aware batching (pure). One request judges one or more GROUPS (a source product with its shortlisted candidates). A group with few candidates is packed together with
 * others, so a small shortlist does not cost a whole request; a request never exceeds the configured number of candidates or the estimated input/output token ceilings, so a
 * response is not truncated and individual decisions are not confused.
 */

/** A rough count of tokens from text length, calibrated against what Google actually reported (`calibrate`). English and numbers: about 3.3 characters per token. */
export const DEFAULT_CHARS_PER_TOKEN = 3.3;
export const estimateTokens = (text: string, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number => Math.ceil(text.length / charsPerToken);

/** The characters-per-token ratio that matches the last answers (smoothed), kept within a sane range. */
export function calibrate(current: number, estimatedTokens: number, actualTokens: number, weight = 0.3): number {
  if (!(estimatedTokens > 0) || !(actualTokens > 0)) return current;
  const observed = (estimatedTokens * current) / actualTokens;
  return Math.min(5, Math.max(2, current * (1 - weight) + observed * weight));
}

export interface BatchLimits {
  /** Candidates judged in one request. */
  maxCandidates: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** What one decision costs in output tokens (measured; the default is a safe estimate for the compact answer format). */
  tokensPerDecision: number;
  charsPerToken: number;
}

export const DEFAULT_BATCH_LIMITS: BatchLimits = { maxCandidates: 10, maxInputTokens: 9000, maxOutputTokens: 6000, tokensPerDecision: 190, charsPerToken: DEFAULT_CHARS_PER_TOKEN };

export interface PlannedRequest {
  groups: PayloadGroup[];
  candidates: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

const renumber = (groups: PayloadGroup[]): PayloadGroup[] => groups.map((g, gi) => ({ ref: g.ref, source: g.source, candidates: g.candidates.map((c, ci): PayloadCandidate => ({ ...c, id: `${gi + 1}.${ci + 1}` })) }));

/** Packs groups into requests. The order of groups is kept (most important first), so a pause midway leaves the best work done. */
export function planBatches(input: PayloadGroup[], limits: BatchLimits = DEFAULT_BATCH_LIMITS): PlannedRequest[] {
  const systemTokens = estimateTokens(AI_SYSTEM_PROMPT, limits.charsPerToken);
  // a group with more candidates than a request may hold (by count, or by what the answer may cost in output tokens) is cut into several groups of the same source
  const perRequest = Math.max(1, Math.min(limits.maxCandidates, Math.floor((limits.maxOutputTokens * 0.8) / limits.tokensPerDecision)));
  const pieces: PayloadGroup[] = [];
  for (const g of input) for (let i = 0; i < g.candidates.length; i += perRequest) pieces.push({ ref: g.ref, source: g.source, candidates: g.candidates.slice(i, i + perRequest) });
  const out: PlannedRequest[] = [];
  let cur: PayloadGroup[] = [];
  const finalize = () => {
    if (!cur.length) return;
    const groups = renumber(cur);
    const candidates = groups.reduce((n, g) => n + g.candidates.length, 0);
    out.push({ groups, candidates, estimatedInputTokens: systemTokens + estimateTokens(buildUserPayload(groups), limits.charsPerToken), estimatedOutputTokens: candidates * limits.tokensPerDecision });
    cur = [];
  };
  for (const piece of pieces) {
    if (!piece.candidates.length) continue;
    const next = [...cur, piece];
    const count = next.reduce((n, g) => n + g.candidates.length, 0);
    const input = systemTokens + estimateTokens(buildUserPayload(renumber(next)), limits.charsPerToken);
    if (cur.length && (count > limits.maxCandidates || input > limits.maxInputTokens || count * limits.tokensPerDecision > limits.maxOutputTokens * 0.8)) finalize();
    cur.push(piece);
  }
  finalize();
  return out;
}
