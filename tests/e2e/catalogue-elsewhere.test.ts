import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { products, scanRuns } from '@ci/database';
import { explainScanRun } from '@ci/core';
import { listSites, loadCoverage, runProfile, startScan } from '@ci/services';
import { createHarness, type Harness } from '../support/harness.ts';

/**
 * Found with a real website: www.lingandsons.com is a company's INFORMATION website (news, deals, rewards, contact, terms — 19 pages in its
 * sitemap, none a product page). Its online shop is a separate website that its menu links to ("Online Shopping"). Shelfwatch used to:
 *  • count the 19 sitemap pages as "about 19 products" and "~20 requests";
 *  • list barcode / brand / stock / currency warnings for products that do not exist;
 *  • fail every collection with "ask the owner for a product feed" — when the owner already runs a public shop.
 * Now it says what the address is, names the shop the website itself links to, never adds or collects that shop for the customer, and keeps
 * every other kind of website (feeds, structured data, plain listings, JavaScript-only shops) exactly as it was.
 */
let h: Harness;
const db = () => h.db.worker;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('a website that lists no products but links to its online shop', () => {
  it('says so in the capability report: no catalogue size, no product-field noise, and where the shop is', async () => {
    const t = await h.newTenant('Info report');
    const siteId = await t.addFixtureSite('infosite', 'competitor', true);
    const profile = await runProfile(h.svc, t.orgId, siteId);

    expect(profile.status).toBe('limited');
    expect(profile.strategy.primary).toBeNull();
    expect(profile.catalogue.estimatedProducts).toBeNull();
    expect(profile.catalogue.estimateBasis).toMatch(/ordinary pages, not products/);
    expect(profile.storefront).toEqual({ url: 'http://shop.rival-corp.test/', label: 'Online Shopping', host: 'shop.rival-corp.test' });

    const codes = profile.limitations.map((l) => l.code);
    expect(codes).toContain('catalogue_elsewhere');
    expect(codes).not.toContain('not_a_shop');
    for (const noise of ['currency_unknown', 'no_gtin', 'no_brand', 'no_stock_quantity', 'weak_structured_data']) expect(codes, noise).not.toContain(noise);
    expect(profile.limitations.find((l) => l.code === 'catalogue_elsewhere')).toMatchObject({ severity: 'warning' });
    expect(profile.summary).toMatch(/does not list products itself/);
    expect(profile.summary).toContain('http://shop.rival-corp.test/');
    expect(profile.summary).not.toMatch(/about \d+ products/);
  });

  it('fails the collection honestly — nothing requested, nothing saved — and names the shop instead of asking for a feed', async () => {
    const t = await h.newTenant('Info scan');
    const siteId = await t.addFixtureSite('infosite', 'competitor', true);
    await runProfile(h.svc, t.orgId, siteId);
    const productRequests = () => h.fixtures.sites.infosite!.requests.filter((r) => /\/p\/|\/products|\/item\//.test(r.path)).length;
    const before = h.fixtures.sites.infosite!.requests.length;
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();

    const [run] = await db().select().from(scanRuns).where(eq(scanRuns.siteId, siteId)).orderBy(desc(scanRuns.createdAt));
    expect(run!.status).toBe('failed');
    expect(run!.errorCode).toBe('catalogue_elsewhere');
    expect(run!.requestsMade).toBe(0);
    expect(run!.productsSaved).toBe(0);
    expect(run!.error).toContain('http://shop.rival-corp.test/');
    expect(run!.error).not.toMatch(/product feed/i);
    expect(h.fixtures.sites.infosite!.requests.length).toBe(before); // the scan itself asked the website for nothing
    expect(productRequests()).toBe(0);
    expect(await db().select().from(products).where(eq(products.siteId, siteId))).toHaveLength(0);

    const why = explainScanRun({ status: run!.status, kind: run!.kind, isComplete: false, errorCode: run!.errorCode, error: run!.error, productsSaved: 0, estimatedTotal: null, requestsMade: 0, requestBudget: null, urlsDiscovered: 0, urlsFetched: 0, errorsCount: 0 });
    expect(why.reason).toContain('http://shop.rival-corp.test/');
    expect(why.nextStep).toMatch(/Add the online store/);
    expect(why.nextStep).not.toMatch(/product feed/i);
  });

  it('shows the same honest state on the websites list, with the next step', async () => {
    const t = await h.newTenant('Info status');
    const siteId = await t.addFixtureSite('infosite', 'competitor', true);
    await runProfile(h.svc, t.orgId, siteId);
    const cov = (await t.tx((tx) => loadCoverage(tx, t.orgId, h.svc.clock(), 48))).find((c) => c.siteId === siteId)!;
    expect(cov.status).toMatchObject({ state: 'unsupported', label: 'No products at this address', severity: 'warn' });
    expect(cov.status!.detail).toContain('http://shop.rival-corp.test/');
    expect(cov.status!.nextAction).toBe('Add http://shop.rival-corp.test/ as a website');
  });

  it('never adds or collects the shop for the customer; once the customer adds it, it collects like any other website', async () => {
    const t = await h.newTenant('Info then shop');
    const infoId = await t.addFixtureSite('infosite', 'competitor', true);
    await runProfile(h.svc, t.orgId, infoId);
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, infoId, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    expect((await t.tx((tx) => listSites(tx, t.orgId))).map((s) => s.hostname)).toEqual(['www.rival-corp.test']);
    expect(h.fixtures.sites.corpshop!.requests.length).toBe(0);

    const shopId = await t.addFixtureSite('corpshop', 'competitor', true); // the customer's own action
    const profile = await runProfile(h.svc, t.orgId, shopId);
    expect(profile.status).toBe('full');
    expect(profile.storefront).toBeUndefined();
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, shopId, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    const [run] = await db().select().from(scanRuns).where(eq(scanRuns.siteId, shopId)).orderBy(desc(scanRuns.createdAt));
    expect(run).toMatchObject({ status: 'succeeded', isComplete: true });
    const saved = await db().select().from(products).where(eq(products.siteId, shopId));
    expect(saved.length).toBe(h.fixtures.sites.corpshop!.products.length);
    expect(saved.length).toBeGreaterThan(10);
  });

  it('without any link to a shop, the address is reported as not listing products — with no shop invented', async () => {
    const t = await h.newTenant('Info plain');
    const siteId = await t.addFixtureSite('infoplain', 'competitor', true);
    const profile = await runProfile(h.svc, t.orgId, siteId);
    expect(profile.status).toBe('limited');
    expect(profile.storefront).toBeUndefined();
    const codes = profile.limitations.map((l) => l.code);
    expect(codes).toContain('not_a_shop');
    expect(codes).not.toContain('catalogue_elsewhere');
    expect(profile.summary).toMatch(/does not appear to list products/);
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    const [run] = await db().select().from(scanRuns).where(eq(scanRuns.siteId, siteId)).orderBy(desc(scanRuns.createdAt));
    expect(run).toMatchObject({ status: 'failed', errorCode: 'not_a_shop', requestsMade: 0, productsSaved: 0 });
    const cov = (await t.tx((tx) => loadCoverage(tx, t.orgId, h.svc.clock(), 48))).find((c) => c.siteId === siteId)!;
    expect(cov.status).toMatchObject({ state: 'unsupported', label: 'No products at this address', nextAction: 'Check that this is the address of the online shop' });
  });
});

describe('every other kind of website is described exactly as before', () => {
  it.each(['jsonld', 'html', 'woo', 'listing', 'homegrid', 'jsrender', 'termscopy'])('%s: no "not a shop" verdict, no storefront, catalogue size kept when it had one', async (key) => {
    const t = await h.newTenant(`Unchanged ${key}`);
    const siteId = await t.addFixtureSite(key, 'competitor', false);
    const profile = await runProfile(h.svc, t.orgId, siteId);
    const codes = profile.limitations.map((l) => l.code);
    expect(codes).not.toContain('not_a_shop');
    expect(codes).not.toContain('catalogue_elsewhere');
    expect(profile.storefront).toBeUndefined();
    if (key !== 'jsrender') expect(profile.strategy.primary, key).not.toBeNull();
    if (['jsonld', 'html', 'woo', 'termscopy'].includes(key)) expect(profile.catalogue.estimatedProducts, key).toBeGreaterThan(0);
  });
});
