import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { offers, priceObservations, productMatches, products, scanRuns, variants } from '@ci/database';
import { runMatching, startScan } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';

/**
 * Shapes of real shop data that the first live run on real grocery shops showed and that cleanly-labelled fictional data never does:
 *  • the vendor field holding the country or the shop's name ("Aruba" on 96 % of a catalogue) — it is not a brand and must not stop matching;
 *  • a gift card listed at 0.00 — not a price;
 *  • a "regular price" shown beside EVERY selling price at about the same percentage — a standing display, not 2,000 sales.
 */
let h: Harness;
let t: Tenant;
let sourceId: string;
let vendorId: string;
const db = () => h.db.worker;

beforeAll(async () => {
  h = await createHarness();
  t = await h.newTenant('Shapes');
  sourceId = await t.addFixtureSite('source', 'source');
  vendorId = await t.addFixtureSite('vendorshop', 'competitor');
  for (const id of [sourceId, vendorId]) await t.tx((tx) => startScan(h.svc, tx, t.orgId, id, { kind: 'discovery', trigger: 'manual' }));
  await h.queue.drain();
  await runMatching(h.svc, db(), t.orgId);
});
afterAll(async () => {
  await h.close();
});

describe('a price of 0 is not a price', () => {
  it('the gift card listed at 0.00 is stored as having no price — in the catalogue and in the history — and everything else keeps its price', async () => {
    const gift = h.fixtures.sites.vendorshop!.products.find((p) => p.price === 0)!;
    expect(gift, 'the fictional shop lists one item at 0.00').toBeDefined();
    const rows = await db().select({ price: variants.price, compareAt: variants.compareAtPrice, title: sql<string>`(select title from products where id = ${variants.productId})` }).from(variants).where(eq(variants.siteId, vendorId));
    expect(rows).toHaveLength(h.fixtures.sites.vendorshop!.products.length);
    expect(rows.filter((r) => r.price === null).map((r) => r.title)).toEqual([gift.title]);
    expect(rows.filter((r) => r.price === 0)).toHaveLength(0);
    const obs = await db().select({ price: priceObservations.price }).from(priceObservations).where(eq(priceObservations.siteId, vendorId));
    expect(obs.filter((o) => o.price === 0)).toHaveLength(0);
    expect(obs.filter((o) => o.price === null)).toHaveLength(1);
  });
});

describe('a "regular price" on every product is not a sale', () => {
  it('the shop that shows one beside every selling price gets no per-product sale offers, keeps the regular prices as data, and the run says what it saw', async () => {
    const sale = await db().select({ n: sql<number>`count(*)::int` }).from(offers).where(and(eq(offers.siteId, vendorId), eq(offers.kind, 'sale_price')));
    expect(sale[0]!.n).toBe(0);
    const withRegular = await db().select({ n: sql<number>`count(*)::int` }).from(variants).where(and(eq(variants.siteId, vendorId), sql`${variants.compareAtPrice} is not null`));
    expect(withRegular[0]!.n).toBeGreaterThanOrEqual(24);
    const [run] = await db().select().from(scanRuns).where(eq(scanRuns.siteId, vendorId)).orderBy(scanRuns.createdAt);
    expect((run!.notes ?? []).join(' ')).toMatch(/Nearly every product \(\d+ %\) shows a regular price about 8(\.\d)? % above its selling price/);
    expect((run!.notes ?? []).join(' ')).toMatch(/not a promotion, so these were not counted as offers/);
  });

  it('a normal shop with a few real sales still gets its offers (the control)', async () => {
    const sale = await db().select({ n: sql<number>`count(*)::int` }).from(offers).where(and(eq(offers.siteId, sourceId), eq(offers.kind, 'sale_price')));
    expect(sale[0]!.n).toBe(2);
    const [run] = await db().select().from(scanRuns).where(eq(scanRuns.siteId, sourceId)).orderBy(scanRuns.createdAt);
    expect((run!.notes ?? []).join(' ')).not.toMatch(/Nearly every product/);
  });
});

describe('a vendor field that is not a brand does not stop products matching', () => {
  it('the shop whose vendor is "Aruba" on every product is matched to the other shop’s identical products as identical — not "different brands"', async () => {
    const rows = await db().select({ cls: productMatches.matchClass, status: productMatches.status, reasons: productMatches.reasons }).from(productMatches).where(and(eq(productMatches.orgId, t.orgId), eq(productMatches.competitorSiteId, vendorId)));
    const identical = rows.filter((r) => r.cls === 'identical');
    expect(identical.length, JSON.stringify(rows.slice(0, 3))).toBeGreaterThanOrEqual(15);
    expect(rows.flatMap((r) => r.reasons).filter((x) => /Different brands/.test(x) && /Aruba/.test(x))).toEqual([]);
    // identical names, brand (read from the names) and size are accepted on their own; "Horizon Whole Milk" vs "Horizon Chocolate Whole Milk" (similarity 0.8) correctly waits for a person
    const autoAccepted = identical.filter((r) => r.status === 'auto');
    expect(autoAccepted.length).toBeGreaterThanOrEqual(14);
    expect(identical.filter((r) => r.status !== 'auto').every((r) => r.reasons.some((x) => /Name similarity 0.[0-8]/.test(x)))).toBe(true);
  });
});

describe('a shop label is not stored as a brand', () => {
  it('the vendor "Aruba" is cleared from the brand of every product of that shop (kept as vendorLabel), and the other shop keeps its real brands', async () => {
    const mine = await db().select({ brand: products.brand, attrs: products.attrs }).from(products).where(eq(products.siteId, vendorId));
    expect(mine.length).toBeGreaterThan(20);
    expect(mine.every((p) => p.brand === null)).toBe(true);
    expect(mine.every((p) => (p.attrs as Record<string, unknown>)['vendorLabel'] === 'Aruba')).toBe(true);
    const other = await db().select({ brand: products.brand }).from(products).where(eq(products.siteId, sourceId));
    expect(other.filter((p) => p.brand !== null).length).toBeGreaterThan(20);
  });
});
