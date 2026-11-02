import { eq, sql } from 'drizzle-orm';
import { analyseCatalogue, evaluatePair } from '@ci/core';
import type { PriceExclusion } from '@ci/shared';
import { productMatches, type DbLike } from '@ci/database';
import { exclusionEvent, recordMatchEvents } from './matching-v2.ts';
import { loadEngineInputs } from './matching.ts';

/**
 * The bundle-contents policy (core/match/bundle.ts) applied to pairs ALREADY stored: a person's confirmations and the matcher's earlier suggestions included. Every stored pair is
 * evaluated by the very code a matching run uses (`evaluatePair` over the workspace's own catalogue, so bulb codes resolve the same way), whether or not a run would propose it today.
 */

export interface BundleAudit {
  pairs: number;
  /** Pairs the policy had something to say about (at least one side is a lighting bundle). */
  assessed: number;
  equivalent: number;
  mismatch: number;
  unknown: number;
  /** Pairs with a product that is no longer active (not assessed). */
  notEvaluable: number;
  /** Rows whose recorded policy fields would change (what `apply` writes). */
  toWrite: number;
  /** Mismatched pairs not already left out of price comparison for another reason, and pairs released from the bundle reason. */
  newlyExcluded: number;
  released: number;
  /** Mismatched pairs that the quantity policy had already left out. */
  alsoQuantity: number;
  /** Mismatched pairs by what stands on them. */
  mismatchByState: { personAccepted: number; personRejected: number; autoConfirmed: number; waitingForReview: number; setAside: number };
  /** Confirmed pairs (a person, or the matcher) whose bundle contents are not established: not left out, labelled. */
  confirmedUnknown: { person: number; automatic: number };
  /** Of the pairs that would be compared today (current, not rejected), how many are valid bundle comparisons that stay. */
  equivalentCurrent: number;
  examples: { id: string; status: string; relationship: string | null; a: string; b: string; note: string }[];
}

export async function auditBundleContents(db: DbLike, orgId: string, opts: { apply?: boolean; now?: Date; examples?: number; /** false: the database has no `bundle_check` column yet: audit only. */ bundleColumn?: boolean } = {}): Promise<BundleAudit> {
  const column = opts.bundleColumn !== false;
  if (opts.apply && !column) throw new Error('apply needs the bundle_check column');
  const inputs = await loadEngineInputs(db, orgId);
  const corpus = analyseCatalogue(inputs);
  const name = new Map(inputs.map((i) => [i.variantId, `${i.title}${i.variantTitle && i.variantTitle.toLowerCase() !== 'default title' ? ` — ${i.variantTitle}` : ''}`]));
  const rows = await db
    .select({
      id: productMatches.id, s: productMatches.sourceVariantId, c: productMatches.competitorVariantId, status: productMatches.status, relationship: productMatches.relationship, auto: productMatches.autoConfirmedAt,
      superseded: productMatches.supersededAt, exclusion: productMatches.priceExclusion, excludedAt: productMatches.priceExcludedAt,
      quantityExclusion: sql<string | null>`${productMatches.quantityCheck}->>'exclusion'`,
      bundleVerdict: column ? sql<string | null>`${productMatches.bundleCheck}->>'verdict'` : sql<null>`null`,
    })
    .from(productMatches)
    .where(eq(productMatches.orgId, orgId));
  const a: BundleAudit = {
    pairs: rows.length, assessed: 0, equivalent: 0, mismatch: 0, unknown: 0, notEvaluable: 0, toWrite: 0, newlyExcluded: 0, released: 0, alsoQuantity: 0,
    mismatchByState: { personAccepted: 0, personRejected: 0, autoConfirmed: 0, waitingForReview: 0, setAside: 0 }, confirmedUnknown: { person: 0, automatic: 0 }, equivalentCurrent: 0, examples: [],
  };
  const moved: Record<string, string[]> = { quantity_excluded: [], quantity_released: [], bundle_excluded: [], bundle_released: [] };
  const now = opts.now ?? new Date();
  for (const r of rows) {
    const dS = corpus.byVariant.get(r.s);
    const dC = corpus.byVariant.get(r.c);
    if (!dS || !dC) { a.notEvaluable++; continue; }
    const bc = evaluatePair(dS, dC, corpus).bundle;
    if (bc) {
      a.assessed++;
      a[bc.verdict]++;
      const current = !r.superseded && r.status !== 'rejected';
      if (bc.verdict === 'mismatch') {
        if (r.quantityExclusion) a.alsoQuantity++;
        if (r.superseded) a.mismatchByState.setAside++;
        else if (r.status === 'accepted' && r.auto === null) a.mismatchByState.personAccepted++;
        else if (r.status === 'rejected') a.mismatchByState.personRejected++;
        else if (r.status === 'accepted') a.mismatchByState.autoConfirmed++;
        else a.mismatchByState.waitingForReview++;
        if (a.examples.length < (opts.examples ?? 14) && (r.status === 'accepted' || a.examples.length < 6)) a.examples.push({ id: r.id, status: r.status === 'accepted' ? (r.auto ? 'auto-confirmed' : 'accepted by a person') : r.status, relationship: r.relationship, a: name.get(r.s) ?? r.s, b: name.get(r.c) ?? r.c, note: bc.note });
      } else if (bc.verdict === 'unknown' && r.status === 'accepted' && current) {
        if (r.auto) a.confirmedUnknown.automatic++;
        else a.confirmedUnknown.person++;
      } else if (bc.verdict === 'equivalent' && current) a.equivalentCurrent++;
    }
    const exclusionNow = (r.quantityExclusion ?? bc?.exclusion ?? null) as PriceExclusion | null;
    const changed = (r.exclusion ?? null) !== exclusionNow || (r.bundleVerdict ?? null) !== (bc?.verdict ?? null);
    if (!changed) continue;
    a.toWrite++;
    if ((r.exclusion ?? null) === null && exclusionNow !== null) a.newlyExcluded++;
    if ((r.exclusion ?? null) !== null && exclusionNow === null) a.released++;
    const ev = exclusionEvent(r.exclusion, exclusionNow);
    if (ev) moved[ev]!.push(r.id);
    if (opts.apply) await db.update(productMatches).set({ bundleCheck: bc, priceExclusion: exclusionNow, priceExcludedAt: exclusionNow ? (r.excludedAt ?? now) : null }).where(eq(productMatches.id, r.id));
  }
  if (opts.apply) {
    await recordMatchEvents(db, orgId, moved.bundle_excluded!, 'bundle_excluded', { note: 'Left out of price comparison by the bundle-contents policy (INCOMPARABLE_BUNDLE_CONTENT_MISMATCH): the two bundles hold different contents. Any decision on this pair is unchanged.' });
    await recordMatchEvents(db, orgId, moved.bundle_released!, 'bundle_released', { note: 'No longer left out of price comparison by the bundle-contents policy.' });
    await recordMatchEvents(db, orgId, moved.quantity_excluded!, 'quantity_excluded', { note: 'Left out of price comparison by the quantity policy (INCOMPARABLE_QUANTITY_MISMATCH). Any decision on this pair is unchanged.' });
    await recordMatchEvents(db, orgId, moved.quantity_released!, 'quantity_released', { note: 'No longer left out of price comparison by the quantity policy.' });
  }
  return a;
}
