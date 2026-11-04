import type { BundleCheck, QuantityCheck } from '@ci/shared';
import { AI_TYPE_STRENGTH, type AiConfidence, type AiDecision, type AiEvidenceItem, type AiMatchType } from './schema.ts';

/**
 * Safeguards applied to every model answer (pure). The model proposes; these rules decide what is allowed to stand:
 *  - a decisive incompatibility the rule engine found (a different part code, vehicle, period, voltage …) is never overridden;
 *  - a verified bundle mismatch, and a bundle whose contents are unknown, can never become a stronger claim than the policy allows;
 *  - different or unknown quantities never give "exact";
 *  - different brands are never assumed to be the same maker, and two different barcodes are never the same item;
 *  - a value the model quotes that is not in the facts it was given is flagged and never counted as support (and too many of them demote the answer);
 *  - price is never evidence (the prompt says so; nothing here reads a price).
 * Every change is recorded in `guards`, so the reviewer sees what the model said and what was allowed.
 */

export interface GuardContext {
  /** The rule engine's own reading of the pair, when available. */
  engine: { relationship: string; conflicts: string[] } | null;
  quantity: QuantityCheck | null;
  bundle: BundleCheck | null;
  sourceBrandKey: string;
  candidateBrandKey: string;
  gtinEqual: boolean;
  gtinDiffer: boolean;
  /** The rule engine found a shared part code, so differing code names the model quotes are aliases of one part rather than a conflict. */
  codesAgree?: boolean;
  /** What kind of product this is (from the dossier): a compatible equivalent can only be verified for parts whose fit can be checked. */
  domain?: 'automotive' | 'grocery' | 'general';
  /** Lower-cased text of the facts sent for each product (see `groundingText`). */
  sourceFacts: string;
  candidateFacts: string;
}

export interface GuardNote {
  code: 'engine_hard_conflict' | 'bundle_mismatch' | 'bundle_unknown' | 'quantity_different' | 'quantity_unknown' | 'different_brands' | 'brand_unknown' | 'different_barcodes' | 'ungrounded_evidence' | 'low_support' | 'identity_conflict' | 'compat_gate';
  note: string;
}

export interface GuardedDecision extends AiDecision {
  /** What the model said before the safeguards. */
  ai_match_type: AiMatchType;
  ai_confidence_level: AiConfidence;
  guards: GuardNote[];
}

const UNITS = new Set(['watts', 'watt', 'lumens', 'lumen', 'volts', 'volt', 'kelvin', 'inch', 'inches', 'pack', 'pcs', 'piece', 'pieces', 'the', 'and', 'for', 'with']);

/** A value quoted by the model counts as grounded when every number and every word of three letters or more (units aside) occurs in the facts it was given. */
export function isGrounded(value: string | null, facts: string): boolean {
  if (value === null) return true;
  const runs = value.toLowerCase().match(/\d+(?:[.,]\d+)?|[a-z]{3,}/g) ?? [];
  const needed = runs.filter((r) => !UNITS.has(r)).map((r) => r.replace(',', '.'));
  if (!needed.length) return true;
  const hay = facts.replace(/,/g, '.');
  return needed.every((r) => hay.includes(r));
}

const cap = (type: AiMatchType, max: AiMatchType): AiMatchType => (AI_TYPE_STRENGTH[type] > AI_TYPE_STRENGTH[max] ? max : type);
const lower = (c: AiConfidence): AiConfidence => (c === 'high' ? 'medium' : 'low');

export function applyGuards(d: AiDecision, ctx: GuardContext): GuardedDecision {
  const guards: GuardNote[] = [];
  let type = d.match_type;
  let confidence = d.confidence_level;
  let review = d.requires_human_review;
  const note = (code: GuardNote['code'], text: string) => guards.push({ code, note: text });

  // evidence the model quoted must come from the facts it was given
  const check = (items: AiEvidenceItem[]): AiEvidenceItem[] => items.map((e) => ({ ...e, grounded: isGrounded(e.source_value, ctx.sourceFacts) && isGrounded(e.candidate_value, ctx.candidateFacts) }));
  const supporting = check(d.supporting_evidence);
  const conflicting = check(d.conflicting_evidence);
  const ungrounded = [...supporting, ...conflicting].filter((e) => e.grounded === false);
  if (ungrounded.length) {
    note('ungrounded_evidence', `${ungrounded.length} quoted value${ungrounded.length === 1 ? ' is' : 's are'} not in the facts that were sent (${ungrounded.slice(0, 2).map((e) => e.attribute).join(', ')}): not counted as evidence.`);
    review = true;
    confidence = lower(confidence);
  }
  const groundedSupport = supporting.filter((e) => e.grounded !== false).length;
  if (AI_TYPE_STRENGTH[type] >= AI_TYPE_STRENGTH.close_equivalent && groundedSupport === 0) {
    note('low_support', 'No supporting fact that can be checked against the product facts, so this cannot stand as a match.');
    type = cap(type, 'no_match_uncertain');
    review = true;
  }

  // the model itself reports that the part code / socket differs (a fact it could check) while calling the products stand-ins: a different part is related at most,
  // unless the rule engine found a shared part code (then the two names are aliases of one part)
  const identityAttr = /\b(part|bulb|socket|connector)\b.*\b(codes?|sizes?|types?|numbers?)\b|\bcodes?\b|\bsockets?\b/i;
  const identityConflict = conflicting.find((e) => e.grounded !== false && e.source_value !== null && e.candidate_value !== null && identityAttr.test(e.attribute.replace(/[_-]/g, ' ')));
  if (identityConflict && !ctx.codesAgree && (type === 'close_equivalent' || type === 'substitute')) {
    type = cap(type, 'related');
    note('identity_conflict', `The part itself differs (${identityConflict.attribute}: ${String(identityConflict.source_value).slice(0, 40)} against ${String(identityConflict.candidate_value).slice(0, 40)}), so it cannot stand in for the product.`);
    review = true;
  }

  // THE COMPATIBILITY GATE. A "close equivalent" is a compatible equivalent: another maker's product verified to do the same job for the stated use. Similar is not verified. It may stand only for
  // a part whose fit can be checked (automotive), when the rule engine found the part code / socket to be the same, found no decisive difference, and the bundle contents and quantity are not
  // in doubt. Everything else the model calls an equivalent is a substitute: food, drink and other goods differ in taste, recipe or brand and are never "equivalents".
  if (type === 'close_equivalent') {
    const why: string[] = [];
    if (ctx.domain !== 'automotive') why.push('only a part whose fit can be checked can be a verified equivalent; other goods are substitutes');
    else {
      if (!ctx.codesAgree) why.push('the bulb or part code is not shown to be the same');
      if (!ctx.engine) why.push('the rule-based check has not judged this pair');
      else if (ctx.engine.conflicts.length > 0 || ctx.engine.relationship === 'non_match') why.push('the rule-based check found a difference in what it fits or does');
      if (ctx.bundle && ctx.bundle.verdict !== 'equivalent') why.push('the bundle contents are not shown to be the same');
      if (ctx.quantity?.verdict === 'different') why.push('the quantities differ');
    }
    if (why.length) {
      type = 'substitute';
      note('compat_gate', `Not a verified compatible equivalent (${why.join('; ')}), so it is a substitute.`);
      review = true;
    }
  }

  // a decisive incompatibility found by the rule engine always stands
  if (ctx.engine?.relationship === 'non_match' && ctx.engine.conflicts.length > 0) {
    const was = type;
    type = cap(type, 'related');
    if (type !== was) note('engine_hard_conflict', `The rule-based check found a decisive difference (${ctx.engine.conflicts[0]!.slice(0, 120)}); the AI cannot override it, so the pair is shown as related at most.`);
    review = true;
  }

  // the bundle policy
  if (ctx.bundle?.verdict === 'mismatch') {
    const was = type;
    type = cap(type, 'related');
    note('bundle_mismatch', `The bundle contents are verified to differ (${ctx.bundle.note.slice(0, 140)}); not comparable on price.`);
    if (type !== was) review = true;
  } else if (ctx.bundle?.verdict === 'unknown' && !ctx.gtinEqual) {
    const was = type;
    type = cap(type, 'no_match_uncertain');
    note('bundle_unknown', 'The contents of a bundle are not established, so the pair cannot be called a match (unknown is never assumed equal).');
    if (type !== was) review = true;
  }

  // the quantity policy
  const qv = ctx.quantity?.verdict ?? 'unknown';
  if (qv === 'different') {
    if (type === 'exact_item') type = 'same_product_different_pack';
    note('quantity_different', 'The two products hold different quantities, so the pair is never an exact item and is not compared on price.');
  } else if (qv === 'unknown' && type === 'exact_item') {
    note('quantity_unknown', 'A quantity is not stated on one or both products, so an exact item cannot be confirmed from the facts; a person should check.');
    review = true;
    confidence = lower(confidence);
  }

  // brands and barcodes
  if (type === 'exact_item' && !ctx.gtinEqual) {
    if (ctx.sourceBrandKey && ctx.candidateBrandKey && ctx.sourceBrandKey !== ctx.candidateBrandKey) {
      type = 'close_equivalent';
      note('different_brands', 'The brands differ, so this cannot be the same item (different brands are never assumed to be the same maker).');
      review = true;
    } else if (!ctx.sourceBrandKey || !ctx.candidateBrandKey) {
      note('brand_unknown', 'A brand is not stated on one or both products, so identity rests on the name alone.');
      review = true;
      confidence = lower(confidence);
    }
  }
  if (ctx.gtinDiffer && (type === 'exact_item' || type === 'same_product_different_pack')) {
    type = 'close_equivalent';
    note('different_barcodes', 'Both products carry a valid barcode and the barcodes are different.');
    review = true;
  }

  // only an exact item of the same verified quantity, with no bundle doubt and no decisive conflict, may be called price-comparable
  const priceComparable = d.price_comparable && type === 'exact_item' && qv === 'same' && (!ctx.bundle || ctx.bundle.verdict === 'equivalent') && !(ctx.engine?.relationship === 'non_match' && ctx.engine.conflicts.length > 0);
  if (type !== d.match_type) review = true;
  if (AI_TYPE_STRENGTH[type] >= AI_TYPE_STRENGTH.close_equivalent && confidence === 'low') review = true;
  return { ...d, match_type: type, ai_match_type: d.match_type, confidence_level: confidence, ai_confidence_level: d.confidence_level, supporting_evidence: supporting, conflicting_evidence: conflicting, price_comparable: priceComparable, requires_human_review: review || type !== 'no_match_uncertain', guards };
}
