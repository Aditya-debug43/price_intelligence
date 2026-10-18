import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { alerts, emailOutbox, integrationConnections, products, stockObservations, stockStates, variants } from '@ci/database';
import { disconnectIntegration, startScan, integrationOverview, runInventorySync, acknowledgeAlert, loadSiteMaps, loadStock } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';
import { createTestInventory, resyncTestInventory, setTestQuantity } from '../support/inventory.ts';

let h: Harness;
let t: Tenant;
let sourceId: string;
const db = () => h.db.worker;

async function scan() {
  await t.tx((tx) => startScan(h.svc, tx, t.orgId, sourceId, { kind: 'discovery', trigger: 'manual' }));
  await h.queue.drain();
}
const alertsOf = async (type: string) => db().select().from(alerts).where(and(eq(alerts.orgId, t.orgId), eq(alerts.type, type as never)));
const variantFor = async (itemId: number) => {
  const p = h.fixtures.sites.source!.find(itemId)!;
  const [row] = await db().select({ v: variants, p: products }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(and(eq(variants.siteId, sourceId), eq(products.title, p.title)));
  return row!;
};
const stateOf = async (variantId: string) => (await db().select().from(stockStates).where(eq(stockStates.variantId, variantId)))[0];

beforeAll(async () => {
  h = await createHarness();
  t = await h.newTenant('Stock');
  sourceId = await t.addFixtureSite('source', 'source');
  await scan(); // baseline
});
afterAll(async () => {
  await h.close();
});

describe('public mode (availability only — never an invented quantity)', () => {
  it('stores availability states from the first scan and does not alert on baseline out-of-stock items', async () => {
    const oos = await variantFor(4);
    expect(oos.v.availability).toBe('out_of_stock');
    expect((await stateOf(oos.v.id))!.state).toBe('out_of_stock');
    expect(await alertsOf('out_of_stock')).toHaveLength(0); // already-unavailable at onboarding is a state, not news
    const inStock = await variantFor(0);
    expect((await stateOf(inStock.v.id))).toMatchObject({ state: 'in_stock', quantity: null, quantitySource: null });
  });

  it('never stores a quantity for a simple available/unavailable signal', async () => {
    const rows = await db().select().from(stockObservations).where(eq(stockObservations.siteId, sourceId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.quantity === null && r.quantitySource === null)).toBe(true);
    const states = await db().select().from(stockStates).where(eq(stockStates.orgId, t.orgId));
    expect(states.every((s) => s.quantity === null)).toBe(true);
  });

  it('alerts once when an item goes out of stock, not again while unchanged, and again only after a restock', async () => {
    const item = await variantFor(0);
    h.fixtures.sites.source!.setAvailability(0, false);
    await scan();
    expect(await alertsOf('out_of_stock')).toHaveLength(1);
    await scan();
    await scan();
    expect(await alertsOf('out_of_stock')).toHaveLength(1); // unchanged state ⇒ no repeat
    const [a] = await alertsOf('out_of_stock');
    expect(a!.title).toMatch(/Out of stock/);
    expect(a!.variantId).toBe(item.v.id);
    expect((a!.data as { quantity: number | null }).quantity).toBeNull();

    h.fixtures.sites.source!.setAvailability(0, true);
    await scan();
    expect(await alertsOf('restocked')).toHaveLength(1);
    h.fixtures.sites.source!.setAvailability(0, false);
    await scan();
    expect(await alertsOf('out_of_stock')).toHaveLength(2); // a NEW episode
    h.fixtures.sites.source!.setAvailability(0, true);
    await scan();
  });

  it('a competitor going out of stock never raises a customer alert', async () => {
    const before = (await db().select().from(alerts).where(eq(alerts.orgId, t.orgId))).length;
    const comp = await t.addFixtureSite('woo', 'competitor');
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, comp, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    h.fixtures.sites.woo!.setAvailability(0, false);
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, comp, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    const after = await db().select().from(alerts).where(and(eq(alerts.orgId, t.orgId)));
    expect(after.filter((a) => a.siteId === comp)).toHaveLength(0);
    expect(after.length).toBe(before);
    h.fixtures.sites.woo!.setAvailability(0, true);
  });

  it('emails alert digests (one email, not one per product)', async () => {
    const mails = (await db().select().from(emailOutbox).where(eq(emailOutbox.orgId, t.orgId))).filter((m) => m.kind === 'alert-digest');
    expect(mails.length).toBeGreaterThan(0);
    expect(mails.every((m) => m.status === 'dev_logged')).toBe(true);
    expect(mails.some((m) => /Out of stock/.test(m.subject + m.text))).toBe(true);
  });
});

describe('connected inventory mode (a test-built authorised connection feeding the real inventory logic)', () => {
  let connectionId: string;
  const sku = () => h.fixtures.sites.source!.find(1)!.sku;
  const lowAlerts = async () => (await alertsOf('low_stock')).filter((a) => (a.data as { quantitySource?: string }).quantitySource === 'authorised_inventory');

  it('creates an authorised connection and exposes it without secrets', async () => {
    const r = await t.tx((tx) => createTestInventory(h.svc, tx, t.orgId, t.userId));
    connectionId = r.connectionId;
    expect(r.rows).toBeGreaterThan(20);
    const overview = await t.tx((tx) => integrationOverview(h.svc, tx, t.orgId));
    const conn = overview.connections.find((c) => c.id === connectionId)!;
    expect(conn).toMatchObject({ provider: 'shopify', status: 'connected' });
    expect(JSON.stringify(overview)).not.toMatch(/accessTokenEnc|refreshTokenEnc|access_token/);
    expect(overview.shopify.configured).toBe(false);
    expect(overview.shopify.missing).toContain('SHOPIFY_CLIENT_ID');
  });

  it('alerts when quantity crosses from above the threshold to the threshold, once per episode', async () => {
    const v = await variantFor(1);
    await t.tx((tx) => setTestQuantity(h.svc, tx, t.orgId, connectionId, { sku: sku(), locationName: 'Main warehouse', quantity: 20 }));
    expect((await stateOf(v.v.id))).toMatchObject({ state: 'in_stock', quantity: 20, quantitySource: 'authorised_inventory' });
    expect(await lowAlerts()).toHaveLength(0);

    const r = await t.tx((tx) => setTestQuantity(h.svc, tx, t.orgId, connectionId, { sku: sku(), locationName: 'Main warehouse', quantity: 5 })); // exactly the threshold
    expect(r.alerts).toBe(1);
    let low = await lowAlerts();
    expect(low).toHaveLength(1);
    expect(low[0]!.title).toMatch(/Low stock/);
    expect(low[0]!.title).not.toMatch(/SIMULATED/i);
    expect((low[0]!.data as { quantity: number; threshold: number }).quantity).toBe(5);
    expect((low[0]!.data as { threshold: number }).threshold).toBe(5);

    for (const q of [5, 4, 3, 2]) await t.tx((tx) => setTestQuantity(h.svc, tx, t.orgId, connectionId, { sku: sku(), locationName: 'Main warehouse', quantity: q }));
    expect(await lowAlerts()).toHaveLength(1); // same low-stock state ⇒ no repeats

    await t.tx((tx) => setTestQuantity(h.svc, tx, t.orgId, connectionId, { sku: sku(), locationName: 'Main warehouse', quantity: 0 }));
    expect((await alertsOf('out_of_stock')).filter((a) => (a.data as { quantitySource?: string }).quantitySource === 'authorised_inventory')).toHaveLength(1);

    await t.tx((tx) => setTestQuantity(h.svc, tx, t.orgId, connectionId, { sku: sku(), locationName: 'Main warehouse', quantity: 30 }));
    expect((await alertsOf('restocked')).some((a) => (a.data as { quantitySource?: string }).quantitySource === 'authorised_inventory')).toBe(true);
    await t.tx((tx) => setTestQuantity(h.svc, tx, t.orgId, connectionId, { sku: sku(), locationName: 'Main warehouse', quantity: 3 }));
    low = await lowAlerts();
    expect(low).toHaveLength(2); // new episode after the restock
    expect(new Set(low.map((a) => a.dedupeKey)).size).toBe(2);
  });

  it('syncing the same inventory twice is idempotent (no duplicate alerts)', async () => {
    const before = (await lowAlerts()).length;
    await t.tx((tx) => resyncTestInventory(h.svc, tx, t.orgId, connectionId));
    await t.tx((tx) => resyncTestInventory(h.svc, tx, t.orgId, connectionId));
    expect((await lowAlerts()).length).toBe(before);
  });

  it('a later PUBLIC scan does not overwrite fresher authorised quantities', async () => {
    const v = await variantFor(1);
    expect((await stateOf(v.v.id))).toMatchObject({ state: 'low_stock', quantity: 3, quantitySource: 'authorised_inventory' });
    const restockedBefore = (await alertsOf('restocked')).length;
    await scan(); // public availability says "in stock"
    expect((await stateOf(v.v.id))).toMatchObject({ state: 'low_stock', quantity: 3, quantitySource: 'authorised_inventory' });
    expect((await alertsOf('restocked')).length).toBe(restockedBefore); // no spurious restock from the weaker public signal
  });

  it('respects a per-product threshold and the configured default', async () => {
    const v = await variantFor(2);
    await db().update(variants).set({ lowStockThreshold: 10 }).where(eq(variants.id, v.v.id));
    const s = h.fixtures.sites.source!.find(2)!.sku;
    await t.tx((tx) => setTestQuantity(h.svc, tx, t.orgId, connectionId, { sku: s, locationName: 'Main warehouse', quantity: 9 }));
    expect((await lowAlerts()).some((a) => a.variantId === v.v.id)).toBe(true); // 9 > 5 default, but ≤ 10 per-product
  });

  it('untracked inventory is unknown, not zero, and raises no alert', async () => {
    const v = await variantFor(6);
    const s = h.fixtures.sites.source!.find(6)!.sku;
    const before = (await db().select().from(alerts).where(eq(alerts.orgId, t.orgId))).length;
    await t.tx((tx) => setTestQuantity(h.svc, tx, t.orgId, connectionId, { sku: s, locationName: 'Main warehouse', quantity: null }));
    const st = await stateOf(v.v.id);
    expect(st!.quantity).toBeNull();
    expect(st!.state).not.toBe('out_of_stock');
    expect((await db().select().from(alerts).where(eq(alerts.orgId, t.orgId))).length).toBe(before);
  });

  it('flags a disagreement between the public page and authorised inventory instead of silently picking one', async () => {
    const v = await variantFor(3);
    const s = h.fixtures.sites.source!.find(3)!.sku;
    await t.tx((tx) => setTestQuantity(h.svc, tx, t.orgId, connectionId, { sku: s, locationName: 'Main warehouse', quantity: 12 }));
    h.fixtures.sites.source!.setAvailability(3, false); // the page says sold out while inventory holds 12 units
    await scan();
    const view = await t.tx(async (tx) => loadStock(tx, new Date(), await loadSiteMaps(tx, t.orgId), 5));
    const row = view.rows.find((r) => r.variantId === v.v.id)!;
    expect(row, 'a conflicting in-stock item must stay visible').toBeDefined();
    expect(row).toMatchObject({ state: 'in_stock', quantity: 12, conflict: true });
    expect(row.note).toMatch(/12 units/);
    // an agreeing item is not flagged
    const agreeing = view.rows.find((r) => r.variantId !== v.v.id && r.conflict);
    expect(agreeing).toBeUndefined();
    h.fixtures.sites.source!.setAvailability(3, true);
    await scan();
    const after = await t.tx(async (tx) => loadStock(tx, new Date(), await loadSiteMaps(tx, t.orgId), 5, { includeInStock: true }));
    expect(after.rows.find((r) => r.variantId === v.v.id)!.conflict).toBe(false);
  });

  it('unmatched SKUs are reported, not guessed', async () => {
    const [c] = await db().select().from(integrationConnections).where(eq(integrationConnections.id, connectionId));
    const meta = c!.meta as { testInventory: { sku: string; productTitle: string; levels: unknown[] }[] };
    meta.testInventory.push({ sku: 'NOT-IN-SHOP', productTitle: 'Ghost', levels: [{ locationId: 'x', locationName: 'x', available: 1 }] });
    await db().update(integrationConnections).set({ meta }).where(eq(integrationConnections.id, connectionId));
    const r = await t.tx((tx) => resyncTestInventory(h.svc, tx, t.orgId, connectionId));
    expect(r.unmatchedSkus).toContain('NOT-IN-SHOP');
  });

  it('disconnecting revokes the connection and wipes stored credentials', async () => {
    const r = await t.tx((tx) => disconnectIntegration(h.svc, tx, t.orgId, t.userId, connectionId));
    expect(r.revokedRemotely).toBe(false); // the test connection holds no Shopify token, so nothing could be revoked remotely
    const [c] = await db().select().from(integrationConnections).where(eq(integrationConnections.id, connectionId));
    expect(c).toMatchObject({ status: 'revoked', accessTokenEnc: null, refreshTokenEnc: null });
    await expect(t.tx((tx) => runInventorySync(h.svc, tx, t.orgId, connectionId))).rejects.toThrow(/not active/);
  });
});

describe('alert acknowledgement', () => {
  it('acknowledges alerts for the owning workspace only', async () => {
    const [a] = await alertsOf('out_of_stock');
    const stranger = await h.newTenant('Stranger');
    expect(await stranger.tx((tx) => acknowledgeAlert(tx, stranger.orgId, a!.id, stranger.userId, h.svc.clock()))).toBe(false);
    expect(await t.tx((tx) => acknowledgeAlert(tx, t.orgId, a!.id, t.userId, h.svc.clock()))).toBe(true);
    const [after] = await db().select().from(alerts).where(eq(alerts.id, a!.id));
    expect(after!.acknowledgedBy).toBe(t.userId);
  });
});
