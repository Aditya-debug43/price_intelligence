import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { productMatches, variants } from '@ci/database';
import { runMatching, startScan } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';

/**
 * Found auditing a real grocery shop: 1,266 of its 1,293 size-less titles carried the size in a "Size_9oz" / "Size_1kg" tag, which the collector
 * never read — so more than half of the catalogue could not be compared with anything. The size in a shop's own tag is used when the name has none.
 */
let h: Harness;
let t: Tenant;
let sourceId: string;
let tagId: string;
const db = () => h.db.worker;

beforeAll(async () => {
  h = await createHarness();
  t = await h.newTenant('TagSize');
  sourceId = await t.addFixtureSite('source', 'source');
  tagId = await t.addFixtureSite('tagsize', 'competitor');
  for (const id of [sourceId, tagId]) await t.tx((tx) => startScan(h.svc, tx, t.orgId, id, { kind: 'discovery', trigger: 'manual' }));
  await h.queue.drain();
  await runMatching(h.svc, db(), t.orgId);
});
afterAll(async () => {
  await h.close();
});

describe('a size kept only in the shop’s tags', () => {
  it('is read at collection: every product of a shop whose titles state no size has a size, from its tag', async () => {
    const shop = h.fixtures.sites.tagsize!;
    expect(shop.products.every((p) => !/\d\s?(?:ml|cl|l|g|kg|oz|lb|ct|pack)\b/i.test(p.title))).toBe(true); // the fictional titles really state no size
    const rows = await db().select({ label: variants.qtyLabel, total: variants.qtyTotal }).from(variants).where(eq(variants.siteId, tagId));
    expect(rows).toHaveLength(shop.products.length);
    expect(rows.filter((r) => r.label === null || r.total === null)).toHaveLength(0);
  });

  it('lets the size-less title be matched to the same product elsewhere, as identical, because the sizes agree', async () => {
    const m = await db().select({ cls: productMatches.matchClass, qty: sql<string>`${productMatches.components}->>'quantity'` }).from(productMatches).where(and(eq(productMatches.orgId, t.orgId), eq(productMatches.competitorSiteId, tagId)));
    const identical = m.filter((x) => x.cls === 'identical');
    // the fictional shop shares 16 products with the own shop (items 0–15)
    expect(identical.length).toBeGreaterThanOrEqual(14);
    expect(identical.every((x) => x.qty === 'same_total')).toBe(true); // every identical pair was confirmed on the size taken from the tag
  });

  it('the control: a shop that states the size in its titles has no size-less products, and nothing was changed for it', async () => {
    const n = await db().select({ n: sql<number>`count(*)::int` }).from(variants).where(and(eq(variants.siteId, sourceId), sql`${variants.qtyLabel} is null`));
    // the control: the own fictional shop states sizes in its titles, so nothing there is size-less
    expect(n[0]!.n).toBe(0);
  });
});
