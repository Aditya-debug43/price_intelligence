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

export const AI_SUGGESTION_STATUSES = ['pending', 'accepted', 'changed', 'rejected', 'uncertain', 'none_of_these', 'stale'] as const;
export type AiSuggestionStatus = (typeof AI_SUGGESTION_STATUSES)[number];
export const AI_RUN_STATUSES = ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled'] as const;
export type AiRunStatus = (typeof AI_RUN_STATUSES)[number];
export const AI_FEEDBACK_ACTIONS = ['accept', 'change', 'reject', 'uncertain', 'none_of_these', 'choose_other'] as const;
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

/** What each AI type means in the relationship model when a PERSON accepts it. "Close equivalent" is stored as a compatible equivalent (its own relationship, with its own price benchmark). */
export const AI_TYPE_TO_RELATIONSHIP: Record<AiMatchType, DecidableRelationship | null> = {
  exact_item: 'exact',
  same_product_different_pack: 'variant',
  close_equivalent: 'equivalent',
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
/** What a category policy established, field by field, from sourced evidence (never from codes that merely co-occur in the catalogue). */
export interface AiCompatReading {
  version: string;
  category: string;
  fields: { code: string; function: string; colour: string };
  sharedCode: string | null;
  eligible: boolean;
  blocker: string | null;
  reasons: string[];
}

export interface AiPolicyReading {
  /** The category policy's reading (automotive replacement bulbs), when one covers the pair. */
  compat?: AiCompatReading | null;
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
  /** Which kind of fact each attribute is: identity (what it is), offer (what is sold), compatibility (what it fits or does), physical (how big or strong). */
  groups?: Record<string, 'identity' | 'offer' | 'compatibility' | 'physical'>;
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

/** One API key as the page shows it: a label (never any part of the key), its own use today and its own pause or stop. */
export interface AiKeyView {
  id: string;
  label: string;
  state: 'ready' | 'paused' | 'stopped';
  pausedUntil: string | null;
  pauseReason: string | null;
  stopped: string | null;
  today: { requests: number; inputTokens: number; outputTokens: number; failures: number; rateLimited: number };
  learned: { rpm?: number; rpd?: number; tpm?: number };
}

export interface AiStatusView {
  configured: boolean;
  /** Each configured key with its own quota tracking; the figures below are their totals. */
  keys?: AiKeyView[];
  /** Whether this workspace's matching runs by itself after each collection. */
  continuous?: boolean;
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
  /** Which of your products to analyse. `sample`: a spread across categories and the review buckets; `unmatched`: your products with no suggestion or confirmed match yet; `products`: the given ones; `sweep`: the whole active catalogue, unseen and changed products first (what continuous matching runs). */
  scope: z.enum(['sample', 'unmatched', 'products', 'sweep']).default('sample'),
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
  relationship: z.enum(['exact', 'variant', 'equivalent', 'substitute', 'related']).optional(),
  /** For "choose_other": the competitor variant the person chose instead. */
  competitorVariantId: z.uuid().optional(),
  note: z.string().max(500).optional(),
});
export type AiReviewRequest = z.infer<typeof aiReviewSchema>;

// ───────────────────────────────────────────────────────────── coverage and the matching funnel

export interface FunnelStage {
  key: 'active' | 'candidate' | 'judged' | 'eligible' | 'approved' | 'approved_automatic' | 'visible';
  label: string;
  /** Distinct own variants that reached this stage. */
  variants: number;
  /** Share of all active variants. */
  share: number;
}

export interface FunnelReason {
  key: string;
  label: string;
  variants: number;
}

export interface CoverageTarget {
  share: number;
  variants: number;
  met: boolean;
  /** How many more variants would reach it. */
  shortfall: number;
}

/**
 * Where your active products are in matching, counted as DISTINCT own variants (never pairs). Candidate coverage (a possible counterpart exists) is not automation: only variants with a
 * current approved counterpart are covered. Nothing here is a model score.
 */
export interface MatchFunnelView {
  generatedAt: string;
  policyVersion: string;
  domain: 'automotive' | 'grocery' | 'all';
  active: number;
  parents: number;
  stages: FunnelStage[];
  /** Variants with a current automatically approved identical item, pack variant or equivalent / all active; and the same for parent products. */
  coverage: {
    automatic: { variants: number; share: number; parents: number; parentShare: number };
    approved: { variants: number; share: number; parents: number; parentShare: number };
    candidate: { variants: number; share: number };
  };
  /** The delivery targets (automotive): half and 60% of active variants covered by an automatically approved counterpart. Null for a domain that has none. */
  targets: { floor: CoverageTarget; stretch: CoverageTarget; parentFloor: CoverageTarget; parentStretch: CoverageTarget } | null;
  /** Why each variant that is not approved is not (one reason each), in order of size. */
  notApproved: FunnelReason[];
  /** When below the floor: the shortfall attributed to causes. */
  attribution: FunnelReason[] | null;
  /** Work waiting for people: suggestions to review and variants waiting for more evidence. */
  workload: { pendingSuggestions: number; needsEvidence: number; waitingForQuota: number; notYetWorked: number };
  /** Audited pair-level precision of each policy, with its uncertainty, from the latest evaluation (null when none was made). */
  precision: { domain: string; autoClass: string; policyVersion: string; families: number; correct: number; observed: number | null; low: number | null; high: number | null; passed: boolean; critical: number; enabled: boolean; needed: { toMinimum: number; toCertainty: number | null } }[];
  /** Candidate recall measured against people's labels (null when none). */
  candidateRecall: { hits: number; total: number } | null;
}
