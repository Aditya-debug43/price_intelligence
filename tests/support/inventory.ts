import { and, eq } from 'drizzle-orm';
import type { InventoryItemRecord } from '@ci/connectors';
import { auditEvents, integrationConnections, products, sites, variants, type DbLike } from '@ci/database';
import { applyInventory, type InventorySyncResult, type Services } from '@ci/services';

/**
 * TEST-ONLY stand-in for an authorised inventory source. The product has no way to invent quantities: real quantities come only from a store
 * owner's authorised connection (Shopify). Tests that exercise the stock-alert rules need *some* source of authorised numbers, so this helper
 * creates a connection row and feeds the product's real `applyInventory` the numbers a test chooses — exactly what a Shopify sync does
 * after it has fetched the store's levels. Nothing here is importable from the application.
 */
interface Row {
  sku: string;
  productTitle: string;
  variantTitle: string | null;
  tracked: boolean;
  levels: { locationId: string; locationName: string; available: number | null }[];
}

const rowsOf = (meta: Record<string, unknown>): Row[] => ((meta['testInventory'] as Row[] | undefined) ?? []).map((r) => ({ ...r, levels: r.levels.map((l) => ({ ...l })) }));

/** One connection for the workspace's own site, with every SKU of the own catalogue at 12 units (0 where the page says out of stock). */
export async function createTestInventory(svc: Services, db: DbLike, orgId: string, userId: string): Promise<{ connectionId: string; rows: number }> {
  const [source] = await db.select().from(sites).where(and(eq(sites.orgId, orgId), eq(sites.role, 'source'), eq(sites.active, true)));
  if (!source) throw new Error('Add your own website first.');
  const found = await db
    .select({ sku: variants.sku, title: products.title, vTitle: variants.title, availability: variants.availability })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(eq(variants.siteId, source.id));
  const rows: Row[] = found
    .filter((r) => r.sku)
    .map((r) => ({ sku: r.sku!, productTitle: r.title, variantTitle: r.vTitle, tracked: true, levels: [{ locationId: 'test-main', locationName: 'Main warehouse', available: r.availability === 'out_of_stock' ? 0 : 12 }] }));
  const [conn] = await db
    .insert(integrationConnections)
    .values({ orgId, provider: 'shopify', siteId: source.id, status: 'connected', shopDomain: 'test-store.myshopify.com', connectedBy: userId, connectedAt: svc.clock(), meta: { testInventory: rows } })
    .returning({ id: integrationConnections.id });
  await db.insert(auditEvents).values({ orgId, userId, action: 'test.inventory.created', target: conn!.id });
  return { connectionId: conn!.id, rows: rows.length };
}

/** Feeds the stored levels through the product's real inventory application (what a successful store sync does). */
export async function resyncTestInventory(svc: Services, db: DbLike, orgId: string, connectionId: string): Promise<InventorySyncResult> {
  const [c] = await db.select().from(integrationConnections).where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.orgId, orgId)));
  if (!c) throw new Error('Test inventory connection not found.');
  if (c.status !== 'connected') throw new Error('This connection is not active.');
  const items: InventoryItemRecord[] = rowsOf(c.meta).map((r) => ({ externalVariantId: `test:${r.sku}`, sku: r.sku, productTitle: r.productTitle, variantTitle: r.variantTitle, tracked: r.tracked, levels: r.levels }));
  return applyInventory(svc, db, { orgId, connectionId, items });
}

export async function setTestQuantity(svc: Services, db: DbLike, orgId: string, connectionId: string, p: { sku: string; locationName?: string; quantity: number | null }): Promise<InventorySyncResult> {
  const [c] = await db.select().from(integrationConnections).where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.orgId, orgId)));
  if (!c) throw new Error('Test inventory connection not found.');
  const rows = rowsOf(c.meta);
  const row = rows.find((r) => r.sku.toLowerCase() === p.sku.toLowerCase());
  if (!row) throw new Error(`SKU ${p.sku} is not in the test inventory.`);
  const level = (p.locationName ? row.levels.find((l) => l.locationName === p.locationName) : undefined) ?? row.levels[0]!;
  level.available = p.quantity;
  row.tracked = p.quantity !== null;
  await db.update(integrationConnections).set({ meta: { ...c.meta, testInventory: rows } }).where(eq(integrationConnections.id, c.id));
  return resyncTestInventory(svc, db, orgId, connectionId);
}
