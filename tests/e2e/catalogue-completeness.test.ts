import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { products, scanRuns, variants } from '@ci/database';
import { explainScanRun } from '@ci/core';
import { loadStock, loadSiteMaps, runProfile, startScan } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';

/**
 * Found when the owner asked why the app showed 2,385 "products" for a store whose admin said 3,116: (1) the collector had NOT missed any public
 * product (the feed, the sitemaps and the database were the same 2,381 products), (2) My Stock printed the number of VARIANTS as "products", and
 * (3) a feed run was declared "complete" the moment the feed returned a short page, without checking the site's own sitemaps — so a feed that
 * ended early would have been reported as a whole catalogue. Now a feed run may only claim "complete" when the sitemaps list nothing more; the
 * products the feed missed are read from their own pages, and anything unreadable keeps the run partial, with the numbers.
 */
let h: Harness;
const db = () => h.db.worker;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

async function collect(label: string, key: string): Promise<{ t: Tenant; siteId: string; run: typeof scanRuns.$inferSelect }> {
  const t = await h.newTenant(label);
  const siteId = await t.addFixtureSite(key, 'competitor', true);
  await runProfile(h.svc, t.orgId, siteId);
  await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
  await h.queue.drain();
  const [run] = await db().select().from(scanRuns).where(eq(scanRuns.siteId, siteId)).orderBy(desc(scanRuns.createdAt));
  return { t, siteId, run: run! };
}
const productCount = async (siteId: string) => (await db().select({ id: products.id }).from(products).where(eq(products.siteId, siteId))).length;
const sitemapRequests = (key: string) => h.fixtures.sites[key]!.requests.filter((r) => /sitemap/.test(r.path)).length;

describe('a feed that ends early is not reported as a complete catalogue', () => {
  it('reads the products the feed did not return from their own pages, saves them once, and says what happened', async () => {
    const total = h.fixtures.sites.shortfeed!.products.length;
    expect(total).toBe(30);
    const { siteId, run } = await collect('Short feed', 'shortfeed');

    // all 30 are collected — not the 12 the feed returned
    expect(await productCount(siteId)).toBe(30);
    expect((await db().select({ id: variants.id }).from(variants).where(eq(variants.siteId, siteId))).length).toBe(30);
    expect(run).toMatchObject({ status: 'succeeded', isComplete: true, productsSaved: 30, errorCode: null });
    const notes = run.notes.join(' ');
    expect(notes).toMatch(/feed ended early: it listed 12 products, but the site's product sitemaps list 30/);
    expect(notes).toMatch(/18 of the 18 products the feed did not return were read from their own pages and saved/);
    // the explanation names the scope of the number
    const why = explainScanRun({ status: run.status, kind: run.kind, isComplete: run.isComplete, errorCode: run.errorCode, error: run.error, productsSaved: run.productsSaved, estimatedTotal: run.estimatedTotal, requestsMade: run.requestsMade, requestBudget: run.requestBudget, urlsDiscovered: run.urlsDiscovered, urlsFetched: run.urlsFetched, errorsCount: run.errorsCount });
    expect(why.completeness).toBe('complete');
    expect(why.scopeNote).toMatch(/30 products collected of the 30 the website lists publicly/);
    expect(why.scopeNote).toMatch(/admin total can be higher/);
  });

  it('repeating the collection changes nothing: no duplicates, still complete', async () => {
    const { t, siteId } = await collect('Short feed again', 'shortfeed');
    const idsBefore = (await db().select({ id: products.id, ext: products.externalId }).from(products).where(eq(products.siteId, siteId))).sort((a, b) => a.ext!.localeCompare(b.ext!));
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    const idsAfter = (await db().select({ id: products.id, ext: products.externalId }).from(products).where(eq(products.siteId, siteId))).sort((a, b) => a.ext!.localeCompare(b.ext!));
    expect(idsAfter).toEqual(idsBefore); // the same 30 rows with the same identifiers
    const [again] = await db().select().from(scanRuns).where(eq(scanRuns.siteId, siteId)).orderBy(desc(scanRuns.createdAt));
    expect(again).toMatchObject({ status: 'succeeded', isComplete: true });
  });

  it('keeps the run PARTIAL — with the numbers and the unreadable products named — when some missing products cannot be read', async () => {
    const { siteId, run } = await collect('Short feed, hidden pages', 'shortfeedhidden');
    expect(await productCount(siteId)).toBe(27); // 12 from the feed + 15 read from their pages; the 3 unreadable ones are NOT counted
    expect(run).toMatchObject({ status: 'partial', isComplete: false, productsSaved: 27, errorCode: 'feed_shorter_than_catalogue' });
    const notes = run.notes.join(' ');
    expect(notes).toMatch(/it listed 12 products, but the site's product sitemaps list 30/);
    expect(notes).toMatch(/15 of the 18 products the feed did not return were read from their own pages and saved/);
    expect(notes).toMatch(/3 could not be read/);
    expect(notes).toMatch(/They are not counted as collected/);
    const why = explainScanRun({ status: run.status, kind: run.kind, isComplete: false, errorCode: run.errorCode, error: run.error, productsSaved: run.productsSaved, estimatedTotal: run.estimatedTotal, requestsMade: run.requestsMade, requestBudget: run.requestBudget, urlsDiscovered: run.urlsDiscovered, urlsFetched: run.urlsFetched, errorsCount: run.errorsCount });
    expect(why.completeness).toBe('partial');
    expect(why.summary).toMatch(/Partly collected: 27 products of about 30/);
    expect(why.reason).toMatch(/feed ended before the website’s own product sitemaps did/);
  });

  it('costs nothing when the feed covers the catalogue: a normal store makes no extra sitemap request during the collection', async () => {
    const t = await h.newTenant('Normal feed');
    const siteId = await t.addFixtureSite('corpshop', 'competitor', true);
    await runProfile(h.svc, t.orgId, siteId);
    const before = sitemapRequests('corpshop');
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    expect(sitemapRequests('corpshop')).toBe(before); // the profile read them; the collection did not need to
    const [run] = await db().select().from(scanRuns).where(eq(scanRuns.siteId, siteId)).orderBy(desc(scanRuns.createdAt));
    expect(run).toMatchObject({ status: 'succeeded', isComplete: true });
    expect(run!.notes.join(' ')).not.toMatch(/ended early/);
  });

  it('an out-of-date estimate does not turn a complete collection into a partial one: the sitemaps are re-read and list nothing the feed lacks', async () => {
    const t = await h.newTenant('Stale estimate');
    const siteId = await t.addFixtureSite('corpshop', 'competitor', true);
    await runProfile(h.svc, t.orgId, siteId); // the profile estimates 14 products from the sitemaps
    const site = h.fixtures.sites.corpshop!;
    const live = site.products.filter((p) => !p.removed);
    for (const p of live.slice(-3)) site.remove(p.itemId); // three products disappear from the store after the profile was made
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    const [run] = await db().select().from(scanRuns).where(eq(scanRuns.siteId, siteId)).orderBy(desc(scanRuns.createdAt));
    expect(run).toMatchObject({ status: 'succeeded', isComplete: true, productsSaved: live.length - 3 });
    expect(run!.notes.join(' ')).not.toMatch(/ended early/);
    for (const p of live.slice(-3)) site.restore(p.itemId);
  });
});

describe('My Stock reports items and products separately and truthfully', () => {
  it('counts variants as items and distinct products as products — a product with several variants is one product', async () => {
    const t = await h.newTenant('Stock counts');
    const siteId = await t.addFixtureSite('woo', 'source', true); // the WooCommerce fixture has variable products (several variants each)
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    const nProducts = (await db().select({ id: products.id }).from(products).where(eq(products.siteId, siteId))).length;
    const nVariants = (await db().select({ id: variants.id }).from(variants).where(eq(variants.siteId, siteId))).length;
    const view = await t.tx(async (tx) => loadStock(tx, h.svc.clock(), await loadSiteMaps(tx, t.orgId), 5, { includeInStock: false }));
    expect(view.total).toBe(nVariants);
    expect(view.products).toBe(nProducts);
    expect(nVariants).toBeGreaterThan(nProducts); // so the two numbers genuinely differ here, and the page must not call the larger one "products"
    expect(view.counts.in + view.counts.low + view.counts.out + view.counts.unknown).toBe(view.total);
  });
});
