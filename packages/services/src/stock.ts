import { and, eq, inArray } from 'drizzle-orm';
import { evaluateCollectionHealth, evaluateStock, type StockEvent } from '@ci/core';
import type { AlertType, Availability, QuantitySource, StockState } from '@ci/shared';
import { collectionHealth, integrationConnections, orgSettings, sites, stockObservations, stockStates, variants, products, type DbLike } from '@ci/database';
import type { InventoryItemRecord } from '@ci/connectors';
import type { Services } from './context.ts';
import { raiseAlert, emailAlertDigest, resolveClearedAlerts } from './alerts.ts';
import { provenanceFor } from './workspace.ts';

export interface StockObservationInput {
  orgId: string;
  siteId: string;
  variantId: string;
  title: string;
  availability: Availability;
  quantity: number | null;
  quantitySource: QuantitySource | null;
  tracked: boolean;
  threshold: number;
  observedAt: Date;
  evidenceId?: string | null;
  scanRunId?: string | null;
  isFixture: boolean;
  /** When per-location rows were already written, the aggregate state update must not add another observation. */
  skipObservationRow?: boolean;
  locationId?: string | null;
  locationName?: string | null;
  connectionId?: string | null;
}

const STALE_AUTHORISED_MS = 36 * 3_600_000;

function describeBasis(basis: string, quantity: number | null, threshold: number, title: string, simulated: boolean): { title: string; body: string } {
  const tag = simulated ? '[SIMULATED] ' : '';
  switch (basis) {
    case 'authorised_quantity':
    case 'simulated_quantity':
      return { title: `${tag}Low stock: ${title}`, body: `${tag}${quantity} unit${quantity === 1 ? '' : 's'} left (alert threshold ${threshold}). Source: ${simulated ? 'simulated inventory' : 'your authorised inventory connection'}.` };
    case 'public_quantity_claim':
      return { title: `Low stock: ${title}`, body: `Your website says only ${quantity} left (threshold ${threshold}). This is a public claim, not an authorised inventory count.` };
    default:
      return { title: `Limited availability: ${title}`, body: 'Your website marks this item as limited availability. No unit count is published, so the remaining quantity is unknown.' };
  }
}

/** Public/authorised stock observation for the customer's own site: persists state + deduplicated alerts. */
export async function applyStockObservation(db: DbLike, p: StockObservationInput): Promise<{ events: StockEvent[]; alertIds: string[]; state: StockState }> {
  const [row] = await db.select().from(stockStates).where(eq(stockStates.variantId, p.variantId));
  const memory = row ? { currentState: row.state, lastKnownState: row.lastKnownState, episode: row.episode, quantity: row.quantity } : null;
  const { next, events, classification } = evaluateStock(memory, { availability: p.availability, quantity: p.quantity, quantitySource: p.quantitySource, tracked: p.tracked }, p.threshold);

  if (!p.skipObservationRow) {
    await db.insert(stockObservations).values({
      orgId: p.orgId, siteId: p.siteId, variantId: p.variantId, observedAt: p.observedAt, availability: p.availability, quantity: p.quantity, quantitySource: p.quantitySource,
      tracked: p.tracked, locationId: p.locationId ?? null, locationName: p.locationName ?? null, connectionId: p.connectionId ?? null, evidenceId: p.evidenceId ?? null, scanRunId: p.scanRunId ?? null, isFixture: p.isFixture,
      provenance: provenanceFor({ isFixture: p.isFixture, quantitySource: p.quantitySource }),
    });
  }
  const changed = !row || row.state !== next.currentState;
  const values = {
    state: next.currentState, lastKnownState: next.lastKnownState, episode: next.episode, quantity: p.tracked ? p.quantity : null, quantitySource: p.quantity !== null ? p.quantitySource : null,
    basis: classification.basis, updatedAt: p.observedAt, ...(changed ? { lastChangeAt: p.observedAt } : {}),
  };
  if (row) await db.update(stockStates).set(values).where(eq(stockStates.variantId, p.variantId));
  else await db.insert(stockStates).values({ variantId: p.variantId, orgId: p.orgId, lastChangeAt: p.observedAt, ...values });

  const alertIds: string[] = [];
  for (const ev of events) {
    const simulated = p.quantitySource === 'simulated';
    let alert: { type: 'low_stock' | 'out_of_stock' | 'restocked'; severity: 'info' | 'warning' | 'critical'; title: string; body: string };
    if (ev.type === 'low_stock') {
      const d = describeBasis(ev.basis, ev.quantity, p.threshold, p.title, simulated);
      alert = { type: 'low_stock', severity: 'warning', title: d.title, body: d.body };
    } else if (ev.type === 'out_of_stock') {
      alert = { type: 'out_of_stock', severity: 'critical', title: `${simulated ? '[SIMULATED] ' : ''}Out of stock: ${p.title}`, body: ev.quantity !== null ? `${simulated ? '[SIMULATED] ' : ''}Available quantity is ${ev.quantity}.` : 'Your website now shows this item as unavailable.' };
    } else {
      alert = { type: 'restocked', severity: 'info', title: `${simulated ? '[SIMULATED] ' : ''}Back in stock: ${p.title}`, body: ev.quantity !== null ? `${ev.quantity} units available again.` : 'Your website shows this item as available again.' };
    }
    const id = await raiseAlert(db, { orgId: p.orgId, ...alert, siteId: p.siteId, variantId: p.variantId, evidenceId: p.evidenceId ?? null, dedupeKey: `${ev.type}:${p.variantId}:${ev.dedupeSuffix}`, data: { quantity: ev.quantity, threshold: p.threshold, basis: ev.basis, from: ev.from, to: ev.to, baseline: ev.baseline, quantitySource: p.quantitySource, observedAt: p.observedAt.toISOString(), connectionId: p.connectionId ?? null } });
    if (id) alertIds.push(id);
  }
  // An alert describes a condition. When the observed state is no longer that condition, the alert is resolved — by this observation, which
  // is kept as the resolution evidence. An "unknown" reading proves nothing and resolves nothing.
  if (changed) {
    const clears: AlertType[] = next.currentState === 'in_stock' ? ['low_stock', 'out_of_stock'] : next.currentState === 'low_stock' ? ['out_of_stock'] : next.currentState === 'out_of_stock' ? ['low_stock'] : [];
    if (clears.length) {
      const note =
        next.currentState === 'in_stock'
          ? p.quantity !== null ? `Back in stock (${p.quantity} available).` : 'Your website shows this item as available again.'
          : next.currentState === 'low_stock' ? 'No longer out of stock; the stock is now low.' : 'The item is now out of stock.';
      await resolveClearedAlerts(db, { orgId: p.orgId, types: clears, variantId: p.variantId, note, now: p.observedAt, evidenceId: p.evidenceId ?? null });
    }
  }
  if (p.quantity !== null || !p.tracked) {
    await db.update(variants).set({ quantity: p.tracked ? p.quantity : null, quantitySource: p.tracked && p.quantity !== null ? p.quantitySource : null }).where(eq(variants.id, p.variantId));
  }
  return { events, alertIds, state: next.currentState };
}

/** Skip public evaluation while a fresher authorised/simulated quantity is in force for the variant. */
export async function hasFreshAuthorisedStock(db: DbLike, variantIds: string[], now: Date): Promise<Set<string>> {
  if (!variantIds.length) return new Set();
  const rows = await db.select({ id: stockStates.variantId, q: stockStates.quantitySource, at: stockStates.updatedAt }).from(stockStates).where(inArray(stockStates.variantId, variantIds));
  return new Set(rows.filter((r) => (r.q === 'authorised_inventory' || r.q === 'simulated') && now.getTime() - r.at.getTime() < STALE_AUTHORISED_MS).map((r) => r.id));
}

export async function orgThreshold(db: DbLike, orgId: string): Promise<number> {
  const [s] = await db.select({ t: orgSettings.lowStockThreshold }).from(orgSettings).where(eq(orgSettings.orgId, orgId));
  return s?.t ?? 5;
}

// ───────────────────────────────────────────────────── collection health (failure/blocked alerts)

export async function recordCollectionOutcome(svc: Services, db: DbLike, p: { orgId: string; siteId: string; siteName: string; outcome: 'ok' | 'failed' | 'blocked'; reason?: string | null }): Promise<string | null> {
  const [row] = await db.select().from(collectionHealth).where(eq(collectionHealth.siteId, p.siteId));
  const { next, alert, recovered } = evaluateCollectionHealth(row ? { failing: row.failing, episode: row.episode } : null, p.outcome);
  const now = svc.clock();
  if (row) await db.update(collectionHealth).set({ failing: next.failing, episode: next.episode, updatedAt: now, ...(p.outcome === 'ok' ? { lastOkAt: now } : {}) }).where(eq(collectionHealth.siteId, p.siteId));
  else await db.insert(collectionHealth).values({ siteId: p.siteId, orgId: p.orgId, failing: next.failing, episode: next.episode, updatedAt: now, lastOkAt: p.outcome === 'ok' ? now : null });
  if (recovered) await resolveClearedAlerts(db, { orgId: p.orgId, types: ['collection_failure'], siteId: p.siteId, note: 'The latest collection of this website completed.', now });
  if (!alert) return null;
  return raiseAlert(db, {
    orgId: p.orgId,
    type: 'collection_failure',
    severity: alert.kind === 'blocked' ? 'warning' : 'critical',
    title: alert.kind === 'blocked' ? `Collection blocked: ${p.siteName}` : `Collection failed: ${p.siteName}`,
    body: `${p.reason ?? 'The latest collection did not complete.'} Existing data is kept and shown with its original observation time; nothing is treated as an empty catalogue.`,
    siteId: p.siteId,
    dedupeKey: `collection_failure:${p.siteId}:${alert.dedupeSuffix}`,
    data: { kind: alert.kind },
  });
}

// ───────────────────────────────────────────────────── authorised inventory sync

export interface InventorySyncResult {
  items: number;
  matched: number;
  unmatchedSkus: string[];
  alerts: number;
  untracked: number;
}

/** Applies a provider's inventory listing to the SOURCE site's variants (matched by SKU), location-aware. */
export async function applyInventory(svc: Services, db: DbLike, p: { orgId: string; connectionId: string; items: InventoryItemRecord[]; simulated: boolean }): Promise<InventorySyncResult> {
  const [source] = await db.select().from(sites).where(and(eq(sites.orgId, p.orgId), eq(sites.role, 'source'), eq(sites.active, true)));
  if (!source) throw new Error('Add your own website (source) before syncing inventory.');
  const threshold = await orgThreshold(db, p.orgId);
  const now = svc.clock();
  const rows = await db
    .select({ id: variants.id, sku: variants.sku, title: products.title, vTitle: variants.title, threshold: variants.lowStockThreshold, availability: variants.availability })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(eq(variants.siteId, source.id));
  const bySku = new Map(rows.filter((r) => r.sku).map((r) => [r.sku!.toLowerCase(), r]));
  const result: InventorySyncResult = { items: p.items.length, matched: 0, unmatchedSkus: [], alerts: 0, untracked: 0 };
  const alertIds: string[] = [];
  const source_: QuantitySource = p.simulated ? 'simulated' : 'authorised_inventory';

  for (const item of p.items) {
    const v = item.sku ? bySku.get(item.sku.toLowerCase()) : undefined;
    if (!v) {
      if (item.sku) result.unmatchedSkus.push(item.sku);
      continue;
    }
    result.matched++;
    const known = item.levels.filter((l) => l.available !== null);
    const total = item.tracked && known.length ? known.reduce((a, l) => a + (l.available as number), 0) : null;
    if (!item.tracked) result.untracked++;
    for (const l of item.levels) {
      await db.insert(stockObservations).values({
        orgId: p.orgId, siteId: source.id, variantId: v.id, observedAt: now, availability: total === null ? v.availability : total > 0 ? 'in_stock' : 'out_of_stock', quantity: l.available,
        quantitySource: item.tracked ? source_ : null, tracked: item.tracked, locationId: l.locationId, locationName: l.locationName, connectionId: p.connectionId, isFixture: p.simulated || source.isFixture,
        provenance: provenanceFor({ isFixture: p.simulated || source.isFixture, quantitySource: item.tracked ? source_ : null }),
      });
    }
    const r = await applyStockObservation(db, {
      orgId: p.orgId, siteId: source.id, variantId: v.id, title: v.vTitle && v.vTitle !== 'Default Title' ? `${v.title} (${v.vTitle})` : v.title,
      availability: total === null ? v.availability : total > 0 ? 'in_stock' : 'out_of_stock', quantity: total, quantitySource: total === null ? null : source_, tracked: item.tracked && total !== null,
      threshold: v.threshold ?? threshold, observedAt: now, isFixture: p.simulated || source.isFixture, skipObservationRow: true, connectionId: p.connectionId,
    });
    alertIds.push(...r.alertIds);
  }
  result.alerts = alertIds.length;
  await emailAlertDigest(svc, db, p.orgId, alertIds, 'inventory sync');
  await db.update(integrationConnections).set({ lastSyncAt: now, lastError: null }).where(eq(integrationConnections.id, p.connectionId));
  return result;
}
