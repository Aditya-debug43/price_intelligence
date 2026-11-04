import { AI_RESPONSE_SCHEMA } from './schema.ts';

/**
 * The instructions and the request payload for batch classification (pure). The instruction text is the SAME for every request (concise, versioned: a change invalidates cached
 * answers); only the compact product facts differ. One request holds one or more GROUPS: a source product with its shortlisted competitor candidates.
 */

export const AI_PROMPT_VERSION = 'ai-match-prompt-2';

export const AI_SYSTEM_PROMPT = `You are a careful retail product-matching analyst. For each group, compare the SOURCE product (the shop's own) with each CANDIDATE (a competitor's) and classify the relationship. Judge only from the facts given. Unknown stays unknown: never invent a specification, barcode, vehicle fitment, quantity or what a bundle contains. Selling price is never evidence.

Types: exact_item = same brand, product line, formulation, size and pack. same_product_different_pack = the same underlying product but size or pack count differs. close_equivalent = a different item (often another brand) that matches in purpose AND in the specifications that matter. substitute = serves the SAME function for the same use but differs in something meaningful (performance, size class, feature, vehicle-specific vs generic). related = connected (accessory, companion part, another part, another function or vehicle) but does not replace it: a different function is related, never a substitute (a pod or ditch light is not a backup bulb, a mat is not a bulb, an adapter is not a bulb). no_match_uncertain = nothing suitable, or too little evidence.

Rules: a shared part code, a similar name or the same vehicle never proves equivalence by itself. Different brands are never assumed to be the same maker. Different quantities make a pair different_pack at most. A bundle or kit against a single item, or bundles with different contents, are not equivalent. Percentages are composition, numbers inside a name belong to the name, a year on wine is a vintage; only a number with a unit is a quantity. "chk" holds verified checks, q (quantity: same/different/unknown) and b (bundle contents: equivalent/mismatch/unknown): never contradict them. price_ok is true only for exact_item whose q is same. Be sceptical: when the facts do not settle it, use a weaker type, say what is missing and set review true. conf says how well the stated facts support your type; it is not a probability.
Vehicle parts: compare bulb/socket code, vehicle and years, lamp position, power, lumens, colour temperature, beam, housing, CAN-bus, bundle contents. Groceries: compare brand, product line, flavour, formulation, form, quantity and pack count.

Answer with JSON only, one decision per candidate id: for = up to 4 facts that agree (a=attribute, s=source value, c=candidate value); against = up to 4 facts that differ or conflict (r=different or conflict); missing = up to 3 unstated facts that would settle it; why = one or two plain sentences naming the decisive facts. Quote values exactly as they appear in the facts.`;

export { AI_RESPONSE_SCHEMA };

export interface PayloadCandidate {
  /** Short id used inside the request ("1.3": group 1, candidate 3). */
  id: string;
  /** What the candidate really is (its variant id): never sent, used to map the answer back. */
  ref: string;
  wire: Record<string, unknown>;
  /** Verified checks from the deterministic policies. */
  chk: { q: 'same' | 'different' | 'unknown'; b?: 'equivalent' | 'mismatch' | 'unknown' };
}

export interface PayloadGroup {
  /** The source product's variant id: never sent. */
  ref: string;
  source: Record<string, unknown>;
  candidates: PayloadCandidate[];
}

/** Compact JSON (no spaces): the facts are the only thing that varies between requests. */
export function buildUserPayload(groups: PayloadGroup[]): string {
  return JSON.stringify({ groups: groups.map((g, gi) => ({ g: gi + 1, s: g.source, c: g.candidates.map((c) => ({ id: c.id, ...c.wire, chk: c.chk })) })) });
}
