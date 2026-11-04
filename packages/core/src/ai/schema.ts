import { z } from 'zod';
import { AI_CONFIDENCE, AI_EVIDENCE_RESULTS, AI_MATCH_TYPES, AI_TYPE_STRENGTH, type AiConfidence, type AiEvidenceItem, type AiEvidenceResult, type AiMatchType } from '@ci/shared';

/**
 * What the AI is asked for and what is stored. The model answers in a COMPACT wire format (short keys: output tokens are the scarce resource of a free tier) which is validated
 * decision by decision and expanded into the readable structure below, so one malformed decision never costs the others.
 */

export { AI_MATCH_TYPES, AI_CONFIDENCE, AI_EVIDENCE_RESULTS, AI_TYPE_STRENGTH, type AiMatchType, type AiConfidence, type AiEvidenceResult, type AiEvidenceItem };

export interface AiDecision {
  candidate_id: string;
  match_type: AiMatchType;
  confidence_level: AiConfidence;
  supporting_evidence: AiEvidenceItem[];
  conflicting_evidence: AiEvidenceItem[];
  missing_evidence: string[];
  explanation: string;
  price_comparable: boolean;
  requires_human_review: boolean;
}

/** The OpenAPI-subset schema handed to Gemini as `responseSchema`. */
export const AI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    decisions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING', description: 'The candidate id exactly as given.' },
          type: { type: 'STRING', enum: [...AI_MATCH_TYPES] },
          conf: { type: 'STRING', enum: [...AI_CONFIDENCE] },
          for: { type: 'ARRAY', description: 'Facts that agree (at most 4).', items: { type: 'OBJECT', properties: { a: { type: 'STRING' }, s: { type: 'STRING' }, c: { type: 'STRING' } }, required: ['a', 's', 'c'] } },
          against: { type: 'ARRAY', description: 'Facts that differ or conflict (at most 4).', items: { type: 'OBJECT', properties: { a: { type: 'STRING' }, s: { type: 'STRING' }, c: { type: 'STRING' }, r: { type: 'STRING', enum: ['different', 'conflict'] } }, required: ['a', 's', 'c', 'r'] } },
          missing: { type: 'ARRAY', description: 'Facts that are not stated and would settle it (at most 3).', items: { type: 'STRING' } },
          why: { type: 'STRING', description: 'One or two plain sentences.' },
          price_ok: { type: 'BOOLEAN' },
          review: { type: 'BOOLEAN' },
        },
        required: ['id', 'type', 'conf', 'for', 'against', 'missing', 'why', 'price_ok', 'review'],
      },
    },
  },
  required: ['decisions'],
} as const;

const str = z.string().transform((s) => s.trim());
const clip = (n: number) => z.string().transform((s) => s.trim().slice(0, n));
const evidenceWire = z.object({ a: clip(60), s: clip(120).nullable().default(null), c: clip(120).nullable().default(null), r: z.enum(['different', 'conflict']).optional() });
const wireDecision = z.object({
  id: str,
  type: z.enum(AI_MATCH_TYPES),
  conf: z.enum(AI_CONFIDENCE),
  for: z.array(evidenceWire).max(8).default([]),
  against: z.array(evidenceWire).max(8).default([]),
  missing: z.array(clip(160)).max(6).default([]),
  why: clip(500),
  price_ok: z.boolean(),
  review: z.boolean().default(true),
});

const NOT_STATED = /^(unknown|unstated|not stated|not provided|not given|not specified|unspecified|no data|n\/a|none|null|-|—)$/i;
const value = (v: string | null) => (v === null || NOT_STATED.test(v) ? null : v);

export interface ParsedDecisions {
  decisions: AiDecision[];
  /** Entries that did not validate (reported, never fatal). */
  invalid: number;
}

/** Validates a model answer decision by decision. A missing `decisions` array is an empty result; the caller decides how to retry what is missing. */
export function parseAiResponse(json: unknown): ParsedDecisions {
  const list = (json && typeof json === 'object' ? (json as { decisions?: unknown }).decisions : null) as unknown;
  if (!Array.isArray(list)) return { decisions: [], invalid: 0 };
  const out: AiDecision[] = [];
  let invalid = 0;
  for (const raw of list) {
    const r = wireDecision.safeParse(raw);
    if (!r.success) { invalid++; continue; }
    const d = r.data;
    out.push({
      candidate_id: d.id,
      match_type: d.type,
      confidence_level: d.conf,
      supporting_evidence: d.for.map((e) => ({ attribute: e.a, source_value: value(e.s), candidate_value: value(e.c), result: 'agree' as const })),
      conflicting_evidence: d.against.map((e) => ({ attribute: e.a, source_value: value(e.s), candidate_value: value(e.c), result: e.r ?? 'different' })),
      missing_evidence: d.missing.filter((m) => m.length > 0),
      explanation: d.why,
      price_comparable: d.price_ok,
      requires_human_review: d.review,
    });
  }
  return { decisions: out, invalid };
}
