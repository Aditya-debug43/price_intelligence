import { and, eq } from 'drizzle-orm';
import { AUTO_POLICY_VERSION, CLASS_RELATIONSHIP, autoClassOf, type AutoClass, type AutoFacts, type BulbPolicyResult } from '@ci/core';
import { classOfRelationship, type BundleCheck, type QuantityCheck } from '@ci/shared';
import { aiMatchSuggestions, auditEvents, matchAutoApproval, productMatches, type DbLike } from '@ci/database';
import { recordMatchEvents } from './matching-v2.ts';

/**
 * The ONE operation that decides whether an AI answer becomes an approved match. It is called after a new model answer, after a cache hit, when a policy is switched on, and when a product's
 * evidence or the policy changes: so a pair's approval always follows the CURRENT evidence and the CURRENT rules, never a stored label.
 *
 * It re-derives eligibility from current facts (it does not trust a stored class), checks that the policy is switched on for THIS version of the rules, and writes in one transaction that locks
 * the pair's row, so a person's decision made at the same moment wins and a stale write cannot override newer evidence. A person's acceptance or rejection is never reversed. Repeating it
 * changes nothing and records nothing twice. An approval made by an earlier run is taken back (returned to the review queue) when its evidence changed or its policy is no longer valid.
 */

export type ReconcileOutcome =
  | 'approved'
  | 'already_approved'
  | 'withdrawn'
  | 'human_decision_preserved'
  | 'stale_analysis'
  | 'missing_critical_facts'
  | 'conflict'
  | 'ambiguous_candidate'
  | 'policy_not_enabled'
  | 'not_eligible';

export interface ReconcileResult {
  outcome: ReconcileOutcome;
  autoClass: AutoClass | null;
  reason: string | null;
}

/** Policies switched on for a workspace: "domain:class" → the policy version they were switched on for. */
export type EnabledPolicies = Map<string, string>;

export async function enabledPolicies(db: DbLike, orgId: string): Promise<EnabledPolicies> {
  const rows = await db.select().from(matchAutoApproval).where(and(eq(matchAutoApproval.orgId, orgId), eq(matchAutoApproval.enabled, true)));
  return new Map(rows.map((r) => [`${r.domain}:${r.autoClass}`, r.policyVersion ?? '']));
}

export interface PairInput {
  orgId: string;
  sv: string;
  cv: string;
  siteId: string;
  facts: Omit<AutoFacts, 'decidedByPerson'>;
  quantity: QuantityCheck | null;
  bundle: BundleCheck | null;
  /** The fingerprints of what the stored answer was made from, and of what the products say NOW. A difference means the answer is stale. */
  fingerprints: { stored: { s: string; c: string } | null; current: { s: string; c: string } };
  /** Other answers at this website for this source that also qualify as an identical item: two rival identical items are ambiguous and neither is approved. */
  rivalExactItems: number;
}

const blockerOutcome = (p: BulbPolicyResult | null): ReconcileOutcome =>
  !p ? 'not_eligible' : p.blocker === 'missing_fitment' || p.blocker === 'ambiguous_variant' ? 'missing_critical_facts' : p.blocker === 'conflicting_fitment' ? 'conflict' : 'not_eligible';

export async function reconcileOne(db: DbLike, p: PairInput, enabled: EnabledPolicies, now: Date): Promise<ReconcileResult> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as DbLike;
    const [m] = await t.select().from(productMatches).where(and(eq(productMatches.sourceVariantId, p.sv), eq(productMatches.competitorVariantId, p.cv))).for('update');
    // a person's decision is final: it is preserved whatever the evidence now says
    if (m && m.decidedBy !== null) return { outcome: 'human_decision_preserved', autoClass: null, reason: null };
    const mine = !!m && m.status === 'accepted' && m.autoConfirmedAt !== null && m.method === 'ai_auto';

    const withdraw = async (outcome: ReconcileOutcome, reason: string): Promise<ReconcileResult> => {
      if (mine) {
        await t.update(productMatches).set({ status: 'needs_review', autoConfirmedAt: null, decidedAt: null, decisionNote: null, updatedAt: now }).where(eq(productMatches.id, m!.id));
        await t.update(aiMatchSuggestions).set({ status: 'pending', reviewedBy: null, reviewedAt: null, reviewRelationship: null, reviewNote: null, updatedAt: now }).where(and(eq(aiMatchSuggestions.sourceVariantId, p.sv), eq(aiMatchSuggestions.competitorVariantId, p.cv), eq(aiMatchSuggestions.status, 'accepted')));
        await recordMatchEvents(t, p.orgId, [m!.id], 'auto_withdrawn', { note: `Automatic approval taken back: ${reason}` });
        await t.insert(auditEvents).values({ orgId: p.orgId, userId: null, action: 'match_auto.withdraw', target: m!.id, meta: { reason } });
        return { outcome: 'withdrawn', autoClass: null, reason };
      }
      return { outcome, autoClass: null, reason };
    };

    // 1. is the stored answer still about what the products say now?
    const fp = p.fingerprints;
    if (!fp.stored || fp.stored.s !== fp.current.s || fp.stored.c !== fp.current.c) return withdraw('stale_analysis', 'the products\' facts changed since the answer was made');
    // 2. recompute eligibility from the CURRENT facts and rules
    const autoClass = autoClassOf({ ...p.facts, decidedByPerson: false });
    if (!autoClass) return withdraw(blockerOutcome(p.facts.policy), p.facts.policy?.reasons[0] ?? 'the conditions for automatic approval are not met');
    // 3. is this class switched on for THIS version of the rules?
    if (enabled.get(`${p.facts.domain}:${autoClass}`) !== AUTO_POLICY_VERSION) return withdraw('policy_not_enabled', 'this policy is not switched on for the current rules');
    // 4. two rival identical items are ambiguous
    if (autoClass === 'exact_item' && p.rivalExactItems > 0) return withdraw('ambiguous_candidate', 'another candidate at this website also qualifies as the identical item');
    // 5. approve (once)
    if (m && m.status === 'accepted' && m.autoConfirmedAt !== null) return { outcome: 'already_approved', autoClass, reason: null };
    if (m && m.status === 'accepted') return { outcome: 'already_approved', autoClass, reason: null };
    if (m && m.status === 'rejected') return { outcome: 'human_decision_preserved', autoClass, reason: null };
    const relationship = CLASS_RELATIONSHIP[autoClass];
    const exclusion = p.quantity?.exclusion ?? p.bundle?.exclusion ?? null;
    const reasons = [`Approved automatically under the ${autoClass === 'exact_item' ? 'identical-item' : 'compatible-equivalent'} policy (${AUTO_POLICY_VERSION})`, ...(p.facts.policy?.eligible ? p.facts.policy.reasons : [])];
    const values = {
      matchClass: classOfRelationship(relationship), confidence: 0, status: 'accepted' as const, method: 'ai_auto', relationship, tier: 'strong' as const, reasons, supersededAt: null, needsReevaluation: false, autoConfirmedAt: now, decidedAt: now,
      decisionNote: 'Confirmed automatically under a policy that passed its independent accuracy gate. You can overrule it in Match review.', priceExclusion: exclusion, priceExcludedAt: exclusion ? now : null, quantityCheck: p.quantity, bundleCheck: p.bundle, updatedAt: now,
    };
    const row = m
      ? (await t.update(productMatches).set(values).where(eq(productMatches.id, m.id)).returning())[0]!
      : (await t.insert(productMatches).values({ orgId: p.orgId, sourceVariantId: p.sv, competitorVariantId: p.cv, competitorSiteId: p.siteId, components: {}, ...values }).returning())[0]!;
    await t.update(aiMatchSuggestions).set({ status: 'accepted', reviewRelationship: relationship, reviewNote: `Approved automatically (${autoClass}, policy ${AUTO_POLICY_VERSION}).`, reviewedAt: now }).where(and(eq(aiMatchSuggestions.sourceVariantId, p.sv), eq(aiMatchSuggestions.competitorVariantId, p.cv)));
    await recordMatchEvents(t, p.orgId, [row.id], 'auto_confirmed', { note: `AI answer approved automatically (${autoClass}, policy ${AUTO_POLICY_VERSION}).` });
    await t.insert(auditEvents).values({ orgId: p.orgId, userId: null, action: 'match_auto.approve', target: row.id, meta: { autoClass, policy: AUTO_POLICY_VERSION } });
    return { outcome: 'approved', autoClass, reason: null };
  });
}

/** A short tally of outcomes, for logs, run records and the funnel. */
export const tally = (rs: ReconcileResult[]): Record<string, number> => rs.reduce<Record<string, number>>((m, r) => ((m[r.outcome] = (m[r.outcome] ?? 0) + 1), m), {});
