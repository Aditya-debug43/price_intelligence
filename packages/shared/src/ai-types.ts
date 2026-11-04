import { z } from 'zod';
import type { DecidableRelationship } from './constants.ts';

/**
 * AI-assisted matching: the shapes shared by the model's answer, the database, the API and the Match Review page. AI suggestions live in their OWN tables and never change a
 * match, a price or a report by themselves; a person's decision on one goes through the existing human-decision functions.
 */

export const AI_MATCH_TYPES = ['exact_item', 'same_product_different_pack', 'close_equivalent', 'substitute', 'related', 'no_match_uncertain'] as const;
export type AiMatchType = (typeof AI_MATCH_TYPES)[number];
export const AI_CONFIDENCE = ['high', 'medium', 'low'] as const;
export type AiConfidence = (typeof AI_CONFIDENCE)[number];
export const AI_EVIDENCE_RESULTS = ['agree', 'different', 'conflict', 'unknown'] as const;
export type AiEvidenceResult = (typeof AI_EVIDENCE_RESULTS)[number];

export const AI_SUGGESTION_STATUSES = ['pending', 'accepted', 'changed', 'uncertain', 'none_of_these', 'stale'] as const;
export type AiSuggestionStatus = (typeof AI_SUGGESTION_STATUSES)[number];
export const AI_RUN_STATUSES = ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled'] as const;
export type AiRunStatus = (typeof AI_RUN_STATUSES)[number];
export const AI_FEEDBACK_ACTIONS = ['accept', 'change', 'uncertain', 'none_of_these', 'choose_other'] as const;
export type AiFeedbackAction = (typeof AI_FEEDBACK_ACTIONS)[number];

/** How strongly each type says "the same thing", for capping (higher = more claim). */
export const AI_TYPE_STRENGTH: Record<AiMatchType, number> = { exact_item: 5, same_product_different_pack: 4, close_equivalent: 3, substitute: 2, related: 1, no_match_uncertain: 0 };

export const AI_TYPE_LABEL: Record<AiMatchType, string> = {
  exact_item: 'Exact item',
  same_product_different_pack: 'Same product, different pack',
  close_equivalent: 'Close equivalent',
  substitute: 'Substitute',
  related: 'Related',
  no_match_uncertain: 'No match / uncertain',
};

/** What each AI type means in the existing relationship model when a PERSON accepts it. "Close equivalent" is stored as a substitute (the finer distinction stays in the AI record and the decision note). */
export const AI_TYPE_TO_RELATIONSHIP: Record<AiMatchType, DecidableRelationship | null> = {
  exact_item: 'exact',
  same_product_different_pack: 'variant',
  close_equivalent: 'substitute',
  substitute: 'substitute',
  related: 'related',
  no_match_uncertain: null,
};

export interface AiEvidenceItem {
  attribute: string;
  source_value: string | null;
  candidate_value: string | null;
  result: AiEvidenceResult;
  /** False when the quoted value cannot be found in the product facts that were sent: shown, but never counted as support. */
  grounded?: boolean;
}

export interface AiGuardNote {
  code: string;
  note: string;
}

export interface AiFoundBy {
  method: string;
  rank: number;
  detail: string;
}

export interface AiEngineReading {
  relationship: string;
  tier: string;
  conflicts: string[];
  summary: string;
}

/** What the deterministic policies found for the pair, shown beside the AI's answer. */
export interface AiPolicyReading {
  quantity: { verdict: 'same' | 'different' | 'unknown'; note: string } | null;
  bundle: { verdict: 'equivalent' | 'mismatch' | 'unknown'; note: string } | null;
}

/** One side of a suggestion as the page shows it (links included). */
export interface AiProductView {
  variantId: string;
  productId: string;
  siteName: string;
  title: string;
  variantTitle: string | null;
  brand: string | null;
  price: number | null;
  currency: string | null;
  url: string | null;
  /** What the product says it is ("headlight bulb") and the identifiers it publishes: shown beside the attributes the AI was given. */
  productType: string | null;
  identifiers: { gtin?: string; mpn?: string; sku?: string };
  /** The attributes the AI was shown (value + where it was read), for a side-by-side comparison. */
  attributes: Record<string, { value: unknown; source: string }>;
  unknown: string[];
  domain: 'automotive' | 'grocery' | 'general';
}

export interface AiSuggestionView {
  id: string;
  status: AiSuggestionStatus;
  matchType: AiMatchType;
  /** What the model said before the safeguards (differs when a safeguard changed it). */
  aiMatchType: AiMatchType;
  confidence: AiConfidence;
  priceComparable: boolean;
  requiresReview: boolean;
  explanation: string;
  supporting: AiEvidenceItem[];
  conflicting: AiEvidenceItem[];
  missing: string[];
  guards: AiGuardNote[];
  foundBy: AiFoundBy[];
  engine: AiEngineReading | null;
  policy: AiPolicyReading;
  source: AiProductView;
  candidate: AiProductView;
  /** The existing pair record, when the rule engine or a person already has one: the page says so and never hides it. */
  existingMatch: { id: string; status: string; relationship: string | null } | null;
  model: string;
  promptVersion: string;
  analysedAt: string;
  review: { by: string | null; at: string; relationship: string | null; note: string | null } | null;
}

export interface AiRunUsage {
  requests: number;
  successes: number;
  failures: number;
  rateLimited: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cachedResults: number;
  candidatesAnswered: number;
  ms: number;
}

export interface AiRunView {
  id: string;
  kind: string;
  status: AiRunStatus;
  model: string;
  promptVersion: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  resumeAt: string | null;
  pauseReason: string | null;
  error: string | null;
  progress: { sources: number; sourcesDone: number; candidates: number; answered: number; cachedResults: number };
  usage: AiRunUsage;
  params: Record<string, unknown>;
}

export interface AiStatusView {
  configured: boolean;
  model: string;
  /** Shelfwatch's own ceilings and what Google's answers have taught it; Google's remaining quota is NOT available through the API. */
  limits: { rpm: number; tpm: number; dailyBudget: number; learned: { rpm?: number; rpd?: number; tpm?: number } };
  today: { day: string; requests: number; inputTokens: number; outputTokens: number; failures: number; rateLimited: number; cachedResults: number };
  state: 'idle' | 'running' | 'paused' | 'stopped' | 'not_configured';
  pausedUntil: string | null;
  pauseReason: string | null;
  stopped: string | null;
  activeRun: AiRunView | null;
  counts: { pending: number; accepted: number; changed: number; uncertain: number; noneOfThese: number; total: number };
  note: string;
}

export const aiRunSchema = z.object({
  /** Which of your products to analyse. `sample`: a spread across categories and the review buckets; `unmatched`: your products with no suggestion or confirmed match yet; `products`: the given ones. */
  scope: z.enum(['sample', 'unmatched', 'products']).default('sample'),
  /** Source VARIANT ids (scope "products"). */
  variantIds: z.array(z.uuid()).max(200).optional(),
  /** How many of your variants to analyse (the free tier allows few requests a day: start small). */
  limit: z.number().int().min(1).max(500).default(20),
  /** Competitor products shortlisted per website. */
  perSite: z.number().int().min(1).max(6).default(3),
});
export type AiRunRequest = z.infer<typeof aiRunSchema>;

export const aiReviewSchema = z.object({
  action: z.enum(AI_FEEDBACK_ACTIONS),
  /** For "change": what the person says the two products are. */
  relationship: z.enum(['exact', 'variant', 'substitute', 'related']).optional(),
  /** For "choose_other": the competitor variant the person chose instead. */
  competitorVariantId: z.uuid().optional(),
  note: z.string().max(500).optional(),
});
export type AiReviewRequest = z.infer<typeof aiReviewSchema>;
