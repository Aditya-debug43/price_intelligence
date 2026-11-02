import { and, eq, inArray, sql } from 'drizzle-orm';
import { assessQuantities, measureQuantity, measureStored, prepareVariant, sizeHintOf, type MeasuredQuantity } from '@ci/core';
import type { QuantityCheck } from '@ci/shared';
import { productMatches, products, variants, type DbLike } from '@ci/database';
import { loadNetContent } from './net-content.ts';
import { recordMatchEvents } from './matching-v2.ts';

/**
 * The quantity-compatibility policy applied to pairs the engine did not just evaluate: pairs already stored (a person's confirmations included) and pairs a
 * person makes by hand. A product's quantity is read exactly as the engine reads it (same text, same size hints, same parser), so a pair never gets one answer
 * from a run and another from here.
 */

const tags = (attrs: Record<string, unknown> | null | undefined): string[] => (Array.isArray(attrs?.['tags']) ? (attrs!['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : []);

/** What each of these variants holds (stored products of any state: a delisted product still has the size it had). */
export async function measureVariants(db: DbLike, orgId: string, variantIds: string[]): Promise<Map<string, MeasuredQuantity>> {
  const out = new Map<string, MeasuredQuantity>();
  const ids = [...new Set(variantIds)];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rows = await db
      .select({
        id: variants.id, productId: products.id, siteId: products.siteId, title: products.title, variantTitle: variants.title, brand: products.brand, category: products.category, gtin: variants.gtin, sku: variants.sku,
        mpn: products.mpn, model: products.model, qtyLabel: variants.qtyLabel, qtyKind: variants.qtyKind, qtyTotal: variants.qtyTotal, attrs: products.attrs, options: variants.options,
      })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(and(eq(variants.orgId, orgId), inArray(variants.id, part)));
    const net = await loadNetContent(db, orgId, [...new Set(rows.map((r) => r.productId))]);
    for (const r of rows) {
      const p = prepareVariant(
        { variantId: r.id, productId: r.productId, siteId: r.siteId, title: r.title, variantTitle: r.variantTitle, brand: r.brand, category: r.category, gtin: r.gtin, sku: r.sku, mpn: r.mpn, model: r.model,
          sizeHints: [r.qtyLabel, sizeHintOf(r.attrs)], context: tags(r.attrs).join(' ') || null },
        new Set(),
      );
      const m = measureQuantity(p.qty, { title: p.fullTitle, options: r.options, sizeHints: [r.qtyLabel, sizeHintOf(r.attrs)], netContent: net.get(r.productId) ?? null });
      // nothing readable from the text, but a size was stored when the product was collected: use that rather than nothing
      out.set(r.id, m.dimension ? m : measureStored(r.qtyKind, r.qtyTotal, r.qtyLabel));
    }
  }
  return out;
}

export function checkOf(measured: Map<string, MeasuredQuantity>, sourceVariantId: string, competitorVariantId: string): QuantityCheck {
  return assessQuantities(measured.get(sourceVariantId) ?? measureStored(null, null, null), measured.get(competitorVariantId) ?? measureStored(null, null, null));
}

export interface QuantityAudit {
  pairs: number;
  /** Pairs whose two products hold different actual quantities (INCOMPARABLE_QUANTITY_MISMATCH). */
  different: number;
  /** Pairs whose quantity cannot be verified on one side or both. */
  unknown: number;
  /** The pairs that differ, by what differs: a measure (volume, mass, count, length, area) or `dimension` (the two are measured in different kinds of unit). */
  differentBy: Record<string, number>;
  same: number;
  /** Rows whose recorded policy fields change (what `apply` would write). */
  toWrite: number;
  newlyExcluded: number;
  released: number;
  /** Excluded pairs by what stands on them. */
  excludedByState: { personAccepted: number; personRejected: number; autoConfirmed: number; waitingForReview: number; setAside: number };
  /** Pairs a person accepted, or the engine confirmed automatically, whose quantity is not verified (not excluded). */
  confirmedUnverified: { person: number; automatic: number };
  examples: { id: string; status: string; relationship: string | null; a: string; b: string; note: string }[];
}

/**
 * Reads every stored pair of a workspace against the policy. With `apply`, writes ONLY the policy fields (price_exclusion, price_excluded_at, quantity_check): a pair's status,
 * relationship, decision, decision note and history are never touched, and each change of exclusion is appended to the pair's history. Safe to run again: it writes only what changed.
 */
export async function auditStoredPairs(db: DbLike, orgId: string, opts: { apply?: boolean; now?: Date; examples?: number; /** false: read nothing the policy has written (a database that does not have its columns yet): audit only, never with `apply`. */ markers?: boolean } = {}): Promise<QuantityAudit> {
  const markers = opts.markers !== false;
  if (opts.apply && !markers) throw new Error('apply needs the policy columns');
  const rows = await db
    .select({
      id: productMatches.id, s: productMatches.sourceVariantId, c: productMatches.competitorVariantId, status: productMatches.status, relationship: productMatches.relationship, auto: productMatches.autoConfirmedAt,
      superseded: productMatches.supersededAt,
      exclusion: markers ? productMatches.priceExclusion : sql<null>`null`, excludedAt: markers ? productMatches.priceExcludedAt : sql<null>`null`, verdict: markers ? sql<string | null>`${productMatches.quantityCheck}->>'verdict'` : sql<null>`null`,
    })
    .from(productMatches)
    .where(eq(productMatches.orgId, orgId));
  const measured = await measureVariants(db, orgId, rows.flatMap((r) => [r.s, r.c]));
  const a: QuantityAudit = { pairs: rows.length, different: 0, unknown: 0, differentBy: {}, same: 0, toWrite: 0, newlyExcluded: 0, released: 0, excludedByState: { personAccepted: 0, personRejected: 0, autoConfirmed: 0, waitingForReview: 0, setAside: 0 }, confirmedUnverified: { person: 0, automatic: 0 }, examples: [] };
  const excludedIds: string[] = [];
  const releasedIds: string[] = [];
  const now = opts.now ?? new Date();
  const titles = new Map<string, string>();
  for (const r of rows) {
    const q = checkOf(measured, r.s, r.c);
    a[q.verdict]++;
    if (q.verdict === 'different') { const k = q.a.dimension === q.b.dimension ? (q.a.dimension ?? '?') : 'dimension'; a.differentBy[k] = (a.differentBy[k] ?? 0) + 1; }
    const excluded = q.exclusion !== null;
    if (excluded) {
      if (r.superseded) a.excludedByState.setAside++;
      else if (r.status === 'accepted' && r.auto === null) a.excludedByState.personAccepted++;
      else if (r.status === 'rejected') a.excludedByState.personRejected++;
      else if (r.status === 'accepted') a.excludedByState.autoConfirmed++;
      else a.excludedByState.waitingForReview++;
      if (a.examples.length < (opts.examples ?? 12) && r.status === 'accepted') {
        titles.set(r.s, ''); titles.set(r.c, '');
        a.examples.push({ id: r.id, status: r.auto ? 'auto-confirmed' : 'accepted by a person', relationship: r.relationship, a: r.s, b: r.c, note: q.note });
      }
    } else if (q.verdict === 'unknown' && r.status === 'accepted' && !r.superseded) {
      if (r.auto) a.confirmedUnverified.automatic++;
      else a.confirmedUnverified.person++;
    }
    const changed = (r.exclusion ?? null) !== q.exclusion || r.verdict !== q.verdict;
    if (!changed) continue;
    a.toWrite++;
    if ((r.exclusion ?? null) === null && excluded) { a.newlyExcluded++; excludedIds.push(r.id); }
    if ((r.exclusion ?? null) !== null && !excluded) { a.released++; releasedIds.push(r.id); }
    if (opts.apply) await db.update(productMatches).set({ priceExclusion: q.exclusion, priceExcludedAt: excluded ? (r.excludedAt ?? now) : null, quantityCheck: q }).where(eq(productMatches.id, r.id));
  }
  if (a.examples.length) {
    const t = await db.select({ id: variants.id, title: products.title, vt: variants.title }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(inArray(variants.id, [...titles.keys()]));
    const name = new Map(t.map((x) => [x.id, `${x.title}${x.vt && x.vt.toLowerCase() !== 'default title' ? ` — ${x.vt}` : ''}`]));
    for (const e of a.examples) { e.a = name.get(e.a) ?? e.a; e.b = name.get(e.b) ?? e.b; }
  }
  if (opts.apply) {
    await recordMatchEvents(db, orgId, excludedIds, 'quantity_excluded', { note: 'Left out of price comparison by the quantity policy (INCOMPARABLE_QUANTITY_MISMATCH): the two products hold different quantities. Any decision on this pair is unchanged.' });
    await recordMatchEvents(db, orgId, releasedIds, 'quantity_released', { note: 'No longer left out of price comparison: the quantities of the two products no longer differ.' });
  }
  return a;
}
