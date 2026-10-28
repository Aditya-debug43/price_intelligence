import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { priceObservations, products, scanRuns, variants } from '@ci/database';
import { MAX_STORABLE_MONEY } from '@ci/core';
import { describeDatabaseError, startScan } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';

/**
 * Directive 13 (lasfit.com). One variant in the owner's own Shopify feed listed a compare-at price of 139982999149929.98 (price 317.94). Prices are stored
 * as numeric(14,4), which holds less than 10 billion, so the insert raised "numeric field overflow"; the batch's transaction rolled back, the whole
 * collection "crashed", 0 products were saved, and the screen showed only the truncated SQL ("Failed query: insert into variants … params: …") — the
 * database's own reason was dropped. These tests reproduce that with real collections of a fictional shop and pin what must happen instead.
 */
let h: Harness;
let t: Tenant;
let siteId: string;
const db = () => h.db.worker;
const shop = () => h.fixtures.sites.source!;

const scan = async () => {
  await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
  await h.queue.drain();
  const [run] = await db().select().from(scanRuns).where(eq(scanRuns.siteId, siteId)).orderBy(desc(scanRuns.createdAt)).limit(1);
  return run!;
};
const counts = async () => ({
  products: (await db().select().from(products).where(eq(products.siteId, siteId))).length,
  variants: (await db().select().from(variants).where(eq(variants.siteId, siteId))).length,
  observations: (await db().select().from(priceObservations).where(eq(priceObservations.siteId, siteId))).length,
});
const variantOf = async (handle: string) => {
  const [row] = await db()
    .select({ price: variants.price, compareAt: variants.compareAtPrice, sku: variants.sku, productUrl: products.canonicalUrl })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(and(eq(variants.siteId, siteId), eq(products.canonicalUrl, `${h.fixtures.origin('source')}/products/${handle}`)));
  return row;
};

beforeAll(async () => {
  h = await createHarness();
  t = await h.newTenant('DataErrors');
  siteId = await t.addFixtureSite('source', 'source');
}, 120_000);
afterAll(async () => {
  await h.close();
});

describe('a shop whose feed lists an amount no database column can hold', () => {
  const total = () => shop().products.length;

  it('saves every product, leaves out only the impossible amount, and says so (the real lasfit.com case)', async () => {
    const [a, b] = [shop().products[3]!, shop().products[4]!];
    shop().setPrice(a.itemId, 317.94, 139982999149929.98); // the real value: a sane price with an absurd "was" price
    shop().setPrice(b.itemId, 1_200_000_000_000, 5); // an absurd price itself
    const run = await scan();
    expect(run.status, run.error ?? '').toBe('succeeded');
    expect(run.isComplete).toBe(true);
    expect(run.productsSaved).toBe(total());
    expect(run.error).toBeNull();
    expect(await counts()).toMatchObject({ products: total(), variants: total() });

    // the product with the sane price keeps it; only the impossible compare-at is left out
    expect(await variantOf(a.handle)).toMatchObject({ price: 317.94, compareAt: null });
    // an impossible price is "no price" (never a made-up one), and the product itself is still there
    expect(await variantOf(b.handle)).toMatchObject({ price: null, compareAt: null });
    // every other product is exactly what the shop published
    const other = shop().products[7]!;
    expect(await variantOf(other.handle)).toMatchObject({ price: other.price });

    // the owner is told which product and which value, in plain words, so they can fix it at the source
    const notes = run.notes.join(' ');
    expect(notes).toContain('139982999149929.98');
    expect(notes).toContain(a.handle);
    expect(notes).toContain('1200000000000');
    expect(notes).toMatch(/left out|ignored|not stored/i);
    expect(notes).not.toMatch(/Failed query|params:/);
  });

  it('collecting again changes nothing that did not change: no duplicate products, variants or records', async () => {
    const before = await counts();
    const run = await scan();
    expect(run.status).toBe('succeeded');
    const after = await counts();
    expect(after.products).toBe(before.products);
    expect(after.variants).toBe(before.variants);
    expect(after.observations).toBe(before.observations + total()); // history grows by one observation per variant, as it always does
  });

  it('the amounts the database cannot hold are exactly the ones the code leaves out (limit tied to the real columns)', async () => {
    const cols = await h.db.admin.query<{ table_name: string; column_name: string; numeric_precision: number; numeric_scale: number }>(
      `select table_name, column_name, numeric_precision, numeric_scale from information_schema.columns where table_schema = 'public' and table_name in ('variants', 'price_observations') and column_name in ('price', 'compare_at_price', 'shipping_cost')`,
    );
    expect(cols.rows).toHaveLength(6);
    for (const c of cols.rows) expect(10 ** (c.numeric_precision - c.numeric_scale) - 1, `${c.table_name}.${c.column_name}`).toBe(MAX_STORABLE_MONEY);
  });
});

describe('what the database really said is what gets reported', () => {
  it('reads the reason from a real "numeric field overflow" instead of showing the SQL statement and the shop’s values', async () => {
    let caught: unknown = null;
    try {
      await db().update(variants).set({ compareAtPrice: 139982999149929.98 }).where(eq(variants.siteId, siteId));
    } catch (e) {
      caught = e;
    }
    expect(caught, 'the database must refuse this amount').toBeTruthy();
    expect((caught as Error).message).toMatch(/^Failed query: update "variants"/); // what the query layer puts in its message (and what the screen used to show)
    const failure = describeDatabaseError(caught)!;
    expect(failure).toMatchObject({ code: '22003', rowData: true }); // (Postgres does not name the column for a numeric overflow)
    expect(failure.message).toMatch(/too large for the database/);
    expect(failure.message).not.toMatch(/Failed query|params|update "variants"|139982999149929/);
  });

  it('does not treat a lost connection or any other non-data failure as a bad product (the run must still stop)', () => {
    expect(describeDatabaseError(Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' }))).toBeNull();
    expect(describeDatabaseError(Object.assign(new Error('x'), { cause: Object.assign(new Error('the database system is shutting down'), { code: '57P01' }) }))).toMatchObject({ code: '57P01', rowData: false });
    expect(describeDatabaseError(new Error('plain'))).toBeNull();
  });
});

describe('one product the database refuses must not take the catalogue down', () => {
  it('skips only that product, saves the rest, reports a partial run with the reason, and keeps what was saved before', async () => {
    const admin = h.db.admin;
    const before = await counts();
    const [bad, moved] = [shop().products[10]!, shop().products[11]!];
    const badBefore = await variantOf(bad.handle);
    const oldSku = bad.sku;
    // The database refuses any variant whose SKU is POISON (a stand-in for any data the schema rejects: an overlong value, a forbidden character…).
    await admin.query(`create or replace function test_refuse_poison() returns trigger language plpgsql as $$ begin if new.sku = 'POISON' then raise exception 'test: this variant is refused by the database' using errcode = '23514'; end if; return new; end $$`);
    await admin.query(`create trigger test_refuse_poison before insert or update on variants for each row execute function test_refuse_poison()`);
    try {
      bad.sku = 'POISON';
      const newPrice = moved.price + 1;
      shop().setPrice(moved.itemId, newPrice);
      const run = await scan();
      expect(run.status).toBe('partial'); // never "succeeded" or "complete": one product is missing from this run
      expect(run.isComplete).toBe(false);
      expect(run.errorCode).toBe('products_skipped');
      expect(run.errorsCount).toBe(1);
      expect(run.productsSaved).toBe(shop().products.length - 1);
      expect(run.error ?? '').toMatch(/1 product/i);
      const text = `${run.error} ${run.notes.join(' ')}`;
      expect(text).toContain(bad.handle); // which product
      expect(text).toMatch(/refused by the database/); // the database's own reason, not just "Failed query"
      expect(text).not.toMatch(/Failed query|params:|insert into/i);

      // the other product's new price was saved; the refused product still has exactly what it had before (nothing half-written)
      expect(await variantOf(moved.handle)).toMatchObject({ price: newPrice });
      expect(await variantOf(bad.handle)).toEqual(badBefore);
      const after = await counts();
      expect(after.products).toBe(before.products);
      expect(after.variants).toBe(before.variants);
    } finally {
      await admin.query(`drop trigger if exists test_refuse_poison on variants`);
      await admin.query(`drop function if exists test_refuse_poison()`);
      bad.sku = oldSku;
    }
    // once the shop's data is accepted again the next collection completes and picks everything up
    const next = await scan();
    expect(next.status).toBe('succeeded');
    expect(next.isComplete).toBe(true);
    expect(next.errorsCount).toBe(0);
    expect(await variantOf(bad.handle)).toMatchObject({ sku: oldSku });
  });
});
