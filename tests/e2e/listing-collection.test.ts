import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { crawlQueue, evidence, priceObservations, products, scanRuns, sites, variants } from '@ci/database';
import { addSite, loadAssortment, loadCoverage, loadSiteMaps, runProfile, setConsent, startScan } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';

/**
 * A shop with no feed, no sitemap and no structured data — only the pages every shop has: a landing page, category listings with a
 * "next page" link, and product pages. It must be collected by reading the listings and following the site's own links, completely (when
 * the whole catalogue was read) and honestly (partial when it was not). A shop whose robots.txt forbids its product pages must come back
 * as blocked — not "limited", and not collected.
 */
let h: Harness;
let t: Tenant;
let listingId: string;
let closedId: string;
let gridId: string;
const db = () => h.db.worker;
const liveItems = () => h.fixtures.sites.listing!.products.filter((p) => !p.removed);

beforeAll(async () => {
  h = await createHarness();
  t = await h.newTenant('Listing');
  listingId = await t.addFixtureSite('listing', 'source');
  closedId = await t.addFixtureSite('catblocked', 'competitor');
  gridId = await t.addFixtureSite('homegrid', 'competitor');
});
afterAll(async () => {
  await h.close();
});

const lastRun = async (siteId: string) => (await db().select().from(scanRuns).where(eq(scanRuns.siteId, siteId)).orderBy(scanRuns.createdAt)).at(-1)!;

describe('a shop that shows its products only on listing pages', () => {
  it('is profiled as partial access with the listing strategy, the currency read from the prices, and the reason in plain words', async () => {
    const p = await runProfile(h.svc, t.orgId, listingId);
    expect(p.status).toBe('partial');
    expect(p.catalogue.listing).toMatchObject({ found: true });
    expect(p.catalogue.listing!.categoryLinks).toBeGreaterThanOrEqual(3);
    expect(p.strategy.primary).toBe('listing-crawl');
    expect(p.currency.detected).toBe('GBP');
    expect(p.summary).toMatch(/listing pages/i);
    expect(p.summary).toMatch(/Brands, barcodes and descriptions are not read/);
    expect(p.limitations.map((l) => l.code)).not.toContain('robots_disallow');
  });

  it('a small sample stops by design: partial, never complete', async () => {
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, listingId, { kind: 'sample', limit: 8, trigger: 'manual' }));
    await h.queue.drain();
    const run = await lastRun(listingId);
    expect(run).toMatchObject({ kind: 'sample', connector: 'listing-crawl', isComplete: false });
    expect(run.productsSaved, JSON.stringify({ s: run.status, n: run.notes, f: run.urlsFetched, d: run.urlsDiscovered, e: run.error })).toBeGreaterThanOrEqual(8);
    expect(run.productsSaved).toBeLessThan(liveItems().length);
  });

  it('collects the whole catalogue through the site’s own category and pagination links, and says it is complete', async () => {
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, listingId, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    const run = await lastRun(listingId);
    expect(run).toMatchObject({ kind: 'discovery', status: 'succeeded', connector: 'listing-crawl', isComplete: true });
    const stored = await db().select().from(products).where(eq(products.siteId, listingId));
    expect(stored).toHaveLength(liveItems().length);
    // the frontier held listing pages (landing + categories + next pages), not product pages
    const queue = await db().select().from(crawlQueue).where(eq(crawlQueue.scanRunId, run.id));
    expect(queue.every((q) => q.kind === 'listing')).toBe(true);
    expect(queue.length).toBeGreaterThan(5); // more than one page per category
    expect(queue.every((q) => q.status === 'done')).toBe(true);
  });

  it('every stored product has its own page as source, the price shown on the listing, its currency and availability — nothing invented', async () => {
    const rows = await db().select({ title: products.title, url: products.canonicalUrl, method: products.extractionMethod, price: variants.price, currency: variants.currency, availability: variants.availability, brand: products.brand }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(eq(variants.siteId, listingId));
    expect(rows).toHaveLength(liveItems().length);
    for (const p of liveItems()) {
      const r = rows.find((x) => x.url === `http://rival-listing.test/item/${p.handle}`);
      expect(r, p.title).toBeDefined();
      expect(r!.title).toBe(p.title); // the whole name from the link's title, not the shortened heading
      expect(r!.price).toBeCloseTo(p.price, 2);
      expect(r!.currency).toBe('GBP');
      expect(r!.availability).toBe(p.available ? 'in_stock' : 'out_of_stock');
      expect(r!.method).toBe('listing_card');
      expect(r!.brand).toBeNull(); // not published on a listing: left empty, not guessed
    }
  });

  it('observations are tied to the listing page that showed them, with a stored copy and a fingerprint', async () => {
    const obs = await db().select({ src: priceObservations.sourceUrl, evidenceId: priceObservations.evidenceId, at: priceObservations.observedAt, provenance: priceObservations.provenance }).from(priceObservations).where(eq(priceObservations.siteId, listingId));
    expect(obs.length).toBeGreaterThanOrEqual(liveItems().length);
    const ev = await db().select().from(evidence).where(eq(evidence.siteId, listingId));
    expect(ev.some((e) => /\/c\//.test(e.url))).toBe(true);
    for (const o of obs.slice(0, 20)) {
      expect(o.evidenceId).toBeTruthy();
      expect(o.provenance).toBe('public_web');
    }
    expect(ev.filter((e) => /\/c\//.test(e.url)).every((e) => /^[0-9a-f]{64}$/.test(e.contentHash ?? ''))).toBe(true);
  });

  it('a refresh re-reads the listings: a changed price is a new observation and the old one is kept', async () => {
    const item = liveItems()[1]!;
    const originalPrice = item.price; // the fictional shop edits this very object when its price changes
    h.fixtures.sites.listing!.setPrice(item.itemId, 99.99);
    h.advance(3_600_000);
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, listingId, { kind: 'refresh', trigger: 'manual' }));
    await h.queue.drain();
    const run = await lastRun(listingId);
    expect(run, JSON.stringify([run.status, run.notes, run.requestBudget, run.requestsMade])).toMatchObject({ kind: 'refresh', connector: 'listing-crawl', isComplete: true });
    const history = await db().select({ price: priceObservations.price }).from(priceObservations).innerJoin(variants, eq(variants.id, priceObservations.variantId)).innerJoin(products, eq(products.id, variants.productId)).where(and(eq(products.siteId, listingId), eq(products.title, item.title))).orderBy(priceObservations.observedAt);
    const prices = history.map((x) => Number(x.price));
    expect(prices[0]).toBeCloseTo(originalPrice, 2); // the first observation is kept
    expect(prices.at(-1)).toBeCloseTo(99.99, 2); // the change is the newest one
    expect(prices.length).toBeGreaterThanOrEqual(2); // history, not an overwrite
  });

  it('a small request budget leaves pages behind and the run says so: partial, with the reason', async () => {
    await db().update(sites).set({ maxRequestsPerRun: 3 }).where(eq(sites.id, listingId));
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, listingId, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    const run = await lastRun(listingId);
    expect(run.isComplete).toBe(false);
    expect(run.status, JSON.stringify(run.notes)).toBe('partial');
    expect((run.notes ?? []).join(' ')).toMatch(/request budget/i);
    await db().update(sites).set({ maxRequestsPerRun: 2000 }).where(eq(sites.id, listingId));
  });
});

describe('a shop whose robots.txt forbids its product pages', () => {
  it('is profiled as BLOCKED, with the reason and the paths — not "limited"', async () => {
    const p = await runProfile(h.svc, t.orgId, closedId);
    expect(p.status).toBe('blocked');
    expect(p.limitations.map((l) => l.code)).toContain('robots_disallow');
    expect(p.summary).toMatch(/robots\.txt does not permit/);
    expect(p.summary).toMatch(/\/shop/);
    expect(p.summary).toMatch(/nothing was collected/i);
  });

  it('nothing is collected from it, and nothing is stored as if it were an empty catalogue', async () => {
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, closedId, { kind: 'discovery', trigger: 'manual' })).catch(() => {});
    await h.queue.drain();
    expect(await db().select().from(products).where(eq(products.siteId, closedId))).toHaveLength(0);
    const run = await lastRun(closedId);
    expect(['blocked', 'failed']).toContain(run.status);
    expect(run.isComplete).toBe(false);
    // not one request went to a forbidden path
    expect(h.fixtures.sites.catblocked!.requests.filter((r) => r.path.startsWith('/shop')).map((r) => r.method + ' ' + r.path)).toEqual([]);
  });
});

describe('a storefront whose home page is the first page of the whole catalogue (the shape of a plain bookshop)', () => {
  const gridItems = () => h.fixtures.sites.homegrid!.products.filter((p) => !p.removed);

  it('is recognised from the home page itself, with pagination and a category sidebar', async () => {
    const p = await runProfile(h.svc, t.orgId, gridId);
    expect(p.catalogue.listing).toMatchObject({ found: true, pageUrl: null, hasPagination: true });
    expect(p.catalogue.listing!.totalHint).toBe(gridItems().length);
    expect(p.strategy.primary).toBe('listing-crawl');
    expect(p.currency.detected).toBe('GBP');
  });

  it('collects every product — through next-page links written relative to the page and through very small category pages — and says it is complete', async () => {
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, gridId, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    const run = await lastRun(gridId);
    expect(run, JSON.stringify([run.status, run.notes, run.error])).toMatchObject({ status: 'succeeded', connector: 'listing-crawl', isComplete: true });
    const stored = await db().select().from(products).where(eq(products.siteId, gridId));
    expect(stored).toHaveLength(gridItems().length);
    // every page of the frontier was read: nothing failed, nothing was left behind (a category with two products is still read)
    const queue = await db().select().from(crawlQueue).where(eq(crawlQueue.scanRunId, run.id));
    expect(queue.filter((q) => q.status !== 'done').map((q) => [q.url, q.status, q.lastError])).toEqual([]);
    expect(queue.some((q) => q.url.includes('/category/breakfast/'))).toBe(true);
    expect(queue.some((q) => q.url.endsWith('/catalogue/page-3.html'))).toBe(true);
  });

  it('a small sample still reads beyond the first page until it has what it asked for', async () => {
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, gridId, { kind: 'sample', limit: 15, trigger: 'manual' }));
    await h.queue.drain();
    const run = await lastRun(gridId);
    expect(run).toMatchObject({ kind: 'sample', isComplete: false });
    expect(run.productsSaved, JSON.stringify([run.status, run.notes, run.error])).toBeGreaterThanOrEqual(15);
  });
});

describe('the page the customer points at counts, not only the website’s home page', () => {
  it('keeps the page that was typed, and a bare address has none', async () => {
    const t2 = await h.newTenant('EntryKept');
    const typed = await t2.tx((tx) => addSite(h.svc, tx, t2.orgId, t2.userId, { url: `${h.fixtures.origin('listing')}/c/beverages?utm_source=newsletter#top`, role: 'competitor' }));
    expect(typed.entryPath).toBe('/c/beverages'); // tracking parameter and fragment dropped, nothing else
    expect(typed.url).toBe(`${h.fixtures.origin('listing')}/`); // the website is still tracked as a whole
    const bare = await t2.tx((tx) => addSite(h.svc, tx, t2.orgId, t2.userId, { url: h.fixtures.origin('homegrid'), role: 'competitor' }));
    expect(bare.entryPath).toBeNull();
  });

  it('a page robots.txt forbids is refused even though the home page is open: blocked, with the path and the reason, and the page is never requested', async () => {
    const t2 = await h.newTenant('EntryBlocked');
    const site = await t2.tx((tx) => addSite(h.svc, tx, t2.orgId, t2.userId, { url: `${h.fixtures.origin('catblocked')}/shop/`, role: 'competitor' }));
    h.fixtures.sites.catblocked!.requests.length = 0;
    const p = await runProfile(h.svc, t2.orgId, site.id);
    expect(p.status).toBe('blocked');
    expect(p.access.robots).toMatchObject({ allowsHome: true, entryAllowed: false });
    expect(p.limitations.find((l) => l.code === 'robots_disallow')?.message).toMatch(/page you gave \(\/shop\)/);
    expect(p.summary).toMatch(/nothing was collected/i);
    expect(h.fixtures.sites.catblocked!.requests.filter((r) => r.path.startsWith('/shop')).map((r) => r.path)).toEqual([]);
  });

  it('a shop that starts on a deeper page is found from it: the listing is read from the typed page and the whole catalogue follows from there', async () => {
    const t2 = await h.newTenant('EntryListing');
    const site = await t2.tx((tx) => addSite(h.svc, tx, t2.orgId, t2.userId, { url: `${h.fixtures.origin('listing')}/c/beverages`, role: 'competitor' }));
    await t2.tx((tx) => setConsent(h.svc, tx, t2.orgId, t2.userId, site.id, { status: 'confirmed', attest: true, note: 'test' }));
    const p = await runProfile(h.svc, t2.orgId, site.id);
    expect(p.site.entryPath).toBe('/c/beverages');
    expect(p.access.robots.entryAllowed).toBe(true);
    expect(p.catalogue.listing).toMatchObject({ found: true, pageUrl: `${h.fixtures.origin('listing')}/c/beverages`, hasPagination: true });
    await t2.tx((tx) => startScan(h.svc, tx, t2.orgId, site.id, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    const run = await lastRun(site.id);
    expect(run, JSON.stringify([run.status, run.notes, run.error])).toMatchObject({ status: 'succeeded', connector: 'listing-crawl', isComplete: true });
    expect(run.productsSaved).toBe(liveItems().length);
  });
});

describe('"no equivalent found" says how much of each catalogue was actually read', () => {
  const basisOf = async (tenant: Tenant) => {
    const maps = await tenant.tx((tx) => loadSiteMaps(tx, tenant.orgId));
    const coverage = await tenant.tx((tx) => loadCoverage(tx, tenant.orgId, h.svc.clock(), 36));
    return tenant.tx((tx) => loadAssortment(tx, tenant.orgId, maps, coverage));
  };

  it('a competitor that was blocked, and a source that was only sampled, weaken the claim — and are named', async () => {
    const t4 = await h.newTenant('Basis');
    const mine = await t4.addFixtureSite('listing', 'source');
    const closed = await t4.addFixtureSite('catblocked', 'competitor');
    await t4.tx((tx) => startScan(h.svc, tx, t4.orgId, mine, { kind: 'sample', limit: 8, trigger: 'manual' }));
    await t4.tx((tx) => startScan(h.svc, tx, t4.orgId, closed, { kind: 'discovery', trigger: 'manual' })).catch(() => {});
    await h.queue.drain();
    const a = await basisOf(t4);
    expect(a.sourceOnly.length).toBeGreaterThanOrEqual(8); // eight collected products, none with a counterpart
    expect(a.basis.competitorsComplete).toBe(false);
    expect(a.basis.competitorGaps.map((g) => g.name)).toEqual([h.fixtures.sites.catblocked!.spec.label]);
    expect(a.basis.sourceComplete).toBe(false);
    expect(a.note).toMatch(/Not every competitor catalogue was read completely/);
    expect(a.note).toMatch(/Your own catalogue was not read completely/);
    expect(a.note).toMatch(/not “nobody sells it”/);
    void closed;
  });

  it('when every catalogue was read completely, an unmatched product is reported as not found in any of them', async () => {
    const t5 = await h.newTenant('BasisComplete');
    const mine = await t5.addFixtureSite('listing', 'source');
    const rival = await t5.addFixtureSite('homegrid', 'competitor');
    for (const id of [mine, rival]) await t5.tx((tx) => startScan(h.svc, tx, t5.orgId, id, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    const a = await basisOf(t5);
    expect(a.basis, JSON.stringify([a.basis, a.note])).toMatchObject({ competitorsComplete: true, competitorGaps: [], sourceComplete: true });
    expect(a.note).toMatch(/^Every competitor catalogue was read completely/);
  });
});
