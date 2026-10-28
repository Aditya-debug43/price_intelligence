import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq, sql } from 'drizzle-orm';
import { crawlQueue, priceObservations, products, scanRuns, variants } from '@ci/database';
import { MAX_IDLE_CONTINUATIONS, recoverScans, runProfile, startScan } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';
import type { FixtureSiteHandle } from '../support/fixtures/server.ts';

/**
 * Directive 14 (auxito.com): the Shopify feed answered HTTP 429 at page 4 of 6. Three pages (750 of 1,483) were saved, the run ended "partial", and
 * "run the collection again to continue where it stopped" was not true: a new run starts at page 1 and meets the same limit at the same place. The same
 * happened to shop.lingandsons.com the same day (750 of 1,850). These tests rebuild that situation with fictional shops whose feed or pages answer 429/503
 * for a while, and pin the behaviour that must replace it: keep what was read, wait politely, continue from the saved place, finish — by itself.
 */
let h: Harness;
const db = () => h.db.worker;
const MIN = 60_000;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);
afterAll(async () => {
  await h.close();
});

const limitAfter = (site: FixtureSiteHandle, allowance: number, opts: { blockMs?: number; retryAfterSeconds?: number | null; paths?: RegExp; search?: RegExp } = {}) => {
  // By default only the feed's 250-product pages count (not the profile's small probe), so "after 2 pages" means exactly that.
  site.rateLimit = { allowance, blockMs: opts.blockMs ?? 10 * MIN, retryAfterSeconds: opts.retryAfterSeconds ?? null, paths: opts.paths ?? /^\/products\.json$/, ...(opts.search ? { search: opts.search } : opts.paths ? {} : { search: /limit=250/ }), served: 0, blockedUntil: null, refused: 0 };
};
afterEach(() => {
  for (const s of Object.values(h.fixtures.sites)) {
    s.rateLimit = null;
    s.feedIgnoresPaging = false;
    s.failFeedFromPage = s.spec.kind === 'flaky' ? 3 : null;
  }
});

const feedShop = () => {
  const s = h.fixtures.sites.flaky!;
  s.failFeedFromPage = null; // healthy: 600 products on 3 pages (250 + 250 + 100)
  return s;
};
const start = async (t: Tenant, siteId: string) => {
  const { run } = await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
  await h.queue.drain();
  return run.id;
};
const runRow = async (id: string) => (await db().select().from(scanRuns).where(eq(scanRuns.id, id)))[0]!;
const runsOf = (siteId: string) => db().select().from(scanRuns).where(eq(scanRuns.siteId, siteId)).orderBy(desc(scanRuns.createdAt));
/** Time passes and the scheduler's recovery pass runs, as it does every minute in production. */
const later = async (ms: number) => {
  h.advance(ms);
  const r = await recoverScans(h.svc);
  await h.queue.drain();
  return r;
};
const counts = async (siteId: string) => ({
  products: (await db().select().from(products).where(eq(products.siteId, siteId))).length,
  variants: (await db().select().from(variants).where(eq(variants.siteId, siteId))).length,
  observations: (await db().select().from(priceObservations).where(eq(priceObservations.siteId, siteId))).length,
});
const newSite = async (key: string, label: string) => {
  const t = await h.newTenant(label);
  return { t, siteId: await t.addFixtureSite(key, 'competitor') };
};

describe('the website asks to slow down in the middle of the catalogue', () => {
  it('keeps what was read, pauses, continues from the saved page by itself, and finishes: one run, nothing read twice', async () => {
    const shop = feedShop();
    limitAfter(shop, 2); // pages 1 and 2 are served, page 3 answers 429 for ten minutes
    const { t, siteId } = await newSite('flaky', 'Pause1');
    const id = await start(t, siteId);

    const paused = await runRow(id);
    expect(paused.status).toBe('partial');
    expect(paused.isComplete).toBe(false);
    expect(paused.errorCode).toBe('rate_limited');
    expect(paused.error).toMatch(/asked Shelfwatch to slow down/);
    expect(paused.productsSaved).toBe(500);
    expect(paused.cursor).toEqual({ page: 3 });
    expect(paused.nextAttemptAt!.getTime() - h.svc.clock().getTime()).toBe(2 * MIN);
    expect(paused.notes.join(' ')).toMatch(/continue this collection by itself/);
    expect(await counts(siteId)).toMatchObject({ products: 500, variants: 500, observations: 500 });

    // nothing happens before the waiting time is over, and the website is not asked again
    const asked = shop.rateLimit!.refused;
    expect((await later(MIN)).resumed).toEqual([]);
    expect(shop.rateLimit!.refused).toBe(asked);

    // the waiting time is over but the website is still limiting: wait again, longer
    expect((await later(2 * MIN)).resumed).toEqual([id]);
    const again = await runRow(id);
    expect(again.status).toBe('partial');
    expect(again.continuations).toBe(1);
    expect(again.nextAttemptAt!.getTime() - h.svc.clock().getTime()).toBe(4 * MIN);

    // the website lets us in again: the SAME run continues at page 3 and completes
    expect((await later(11 * MIN)).resumed).toEqual([id]);
    const done = await runRow(id);
    expect(done.status).toBe('succeeded');
    expect(done.isComplete).toBe(true);
    expect(done.productsSaved).toBe(600);
    expect(done.variantsSaved).toBe(600); // the run's own count of variants is what the database holds for it
    expect(done.nextAttemptAt).toBeNull();
    expect(done.error).toBeNull();
    expect(await runsOf(siteId)).toHaveLength(1);
    // pages 1 and 2 were read once: 600 observations, not 1,100
    expect(await counts(siteId)).toMatchObject({ products: 600, variants: 600, observations: 600 });
    expect(done.requestsMade).toBeGreaterThan(paused.requestsMade);
  });

  it('a later full collection changes nothing that did not change: no duplicate products or variants', async () => {
    const { t, siteId } = await newSite('flaky', 'Pause1Again');
    feedShop();
    await start(t, siteId);
    const before = await counts(siteId);
    expect(before).toMatchObject({ products: 600, variants: 600 });
    const id2 = await start(t, siteId);
    expect((await runRow(id2)).status).toBe('succeeded');
    const after = await counts(siteId);
    expect(after.products).toBe(600);
    expect(after.variants).toBe(600);
    expect(after.observations).toBe(before.observations + 600);
  });

  it('"Collect catalogue" after a pause continues the same run instead of starting again at page 1', async () => {
    const shop = feedShop();
    limitAfter(shop, 2);
    const { t, siteId } = await newSite('flaky', 'PauseManual');
    const id = await start(t, siteId);
    expect((await runRow(id)).productsSaved).toBe(500);
    h.advance(11 * MIN); // the limit is lifted; the scheduler has not looked yet
    const { run, created } = await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
    expect(created).toBe(true);
    expect(run.id).toBe(id);
    await h.queue.drain();
    const done = await runRow(id);
    expect(done.status).toBe('succeeded');
    expect(done.isComplete).toBe(true);
    expect(done.productsSaved).toBe(600);
    expect(await runsOf(siteId)).toHaveLength(1);
    expect((await counts(siteId)).observations).toBe(600); // pages 1 and 2 were not read again
  });

  it('a website that keeps limiting us is asked less and less often, then left alone; what was saved is kept; a click continues later', async () => {
    const shop = feedShop();
    limitAfter(shop, 2, { blockMs: 30 * 24 * 60 * MIN }); // limited for a month
    const { t, siteId } = await newSite('flaky', 'PauseGiveUp');
    const id = await start(t, siteId);
    const waits: number[] = [];
    for (let i = 0; i < MAX_IDLE_CONTINUATIONS + 1; i++) {
      const r = await runRow(id);
      expect(r.status).toBe('partial');
      expect(r.nextAttemptAt, `sitting ${i + 1} is followed by another attempt`).not.toBeNull();
      waits.push(Math.round((r.nextAttemptAt!.getTime() - h.svc.clock().getTime()) / MIN));
      const resumed = (await later(r.nextAttemptAt!.getTime() - h.svc.clock().getTime() + 1000)).resumed;
      expect(resumed).toEqual([id]);
    }
    expect(waits).toEqual([2, 4, 8, 16, 32, 60, 60]); // never faster than the ladder, never longer than an hour
    const stopped = await runRow(id);
    expect(stopped.status).toBe('partial');
    expect(stopped.nextAttemptAt).toBeNull();
    expect(stopped.productsSaved).toBe(500);
    expect(stopped.notes.join(' ')).toMatch(/stopped trying by itself/);
    expect(await counts(siteId)).toMatchObject({ products: 500, variants: 500 });
    expect((await later(5 * MIN)).resumed).toEqual([]); // the scheduler leaves it alone now

    // the website lets us in again: one click continues from the saved place
    shop.rateLimit = null;
    const { run } = await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
    expect(run.id).toBe(id);
    await h.queue.drain();
    const done = await runRow(id);
    expect(done.status).toBe('succeeded');
    expect(done.isComplete).toBe(true);
    expect(done.productsSaved).toBe(600);
  });

  it('honours the website’s own Retry-After as the minimum wait (and never waits more than an hour)', async () => {
    const shop = feedShop();
    limitAfter(shop, 2, { retryAfterSeconds: 600 }); // "come back in ten minutes"
    const { t, siteId } = await newSite('flaky', 'RetryAfter');
    const id = await start(t, siteId);
    const r = await runRow(id);
    expect(r.nextAttemptAt!.getTime() - h.svc.clock().getTime()).toBe(10 * MIN);
    shop.rateLimit = null;
    expect((await later(9 * MIN)).resumed).toEqual([]);
    expect((await later(2 * MIN)).resumed).toEqual([id]);
    expect((await runRow(id)).productsSaved).toBe(600);
  });

  it('a brief outage (HTTP 503) at page 3 is handled the same way', async () => {
    const shop = feedShop();
    shop.failFeedFromPage = 3;
    const { t, siteId } = await newSite('flaky', 'Outage');
    const id = await start(t, siteId);
    const r = await runRow(id);
    expect(r).toMatchObject({ status: 'partial', errorCode: 'temporarily_unavailable', productsSaved: 500 });
    expect(r.error).toMatch(/temporarily unavailable \(HTTP 503\)/);
    shop.failFeedFromPage = null;
    await later(3 * MIN);
    expect(await runRow(id)).toMatchObject({ status: 'succeeded', isComplete: true, productsSaved: 600 });
  });

  it('a run saved before pausing existed (recorded as a plain HTTP error with its saved page, like auxito.com’s) is picked up and finished', async () => {
    const shop = feedShop();
    limitAfter(shop, 2);
    const { t, siteId } = await newSite('flaky', 'Legacy');
    const id = await start(t, siteId);
    // exactly what production holds for auxito.com: partial, "http_error", the page it stopped at, and no time to continue
    await db().update(scanRuns).set({ errorCode: 'http_error', error: 'Shopify feed returned HTTP 429', nextAttemptAt: null, continuations: 0, notes: ['Stopped after an error: Shopify feed returned HTTP 429. Progress was saved and the run can resume.'] }).where(eq(scanRuns.id, id));
    shop.rateLimit = null;
    expect((await later(MIN)).resumed).toEqual([]); // not before the shortest waiting time
    expect((await later(2 * MIN)).resumed).toEqual([id]);
    expect(await runRow(id)).toMatchObject({ status: 'succeeded', isComplete: true, productsSaved: 600 });
    expect(await counts(siteId)).toMatchObject({ products: 600, variants: 600, observations: 600 });
  });

  it('a newer collection supersedes an older paused one, which is then left alone', async () => {
    const shop = feedShop();
    limitAfter(shop, 2);
    const { t, siteId } = await newSite('flaky', 'Superseded');
    const first = await start(t, siteId);
    shop.rateLimit = null;
    // a scheduled run (it belongs to its own daily report) starts its own run
    const { run } = await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'scheduled', dailyRunId: null }));
    expect(run.id).toBe(first); // no daily report involved: it continues the paused run
    await h.queue.drain();
    expect((await runRow(first)).status).toBe('succeeded');
    expect((await later(30 * MIN)).resumed).toEqual([]);
  });
});

describe('the website limits us before anything was read', () => {
  it('while it is being checked: nothing is judged or collected from a guess; the run pauses, checks again later, and then collects', async () => {
    const shop = h.fixtures.sites.source!; // a Shopify shop with a feed, a sitemap and product pages
    limitAfter(shop, 0, { paths: /^\/(products\.json|products\/.+|sitemap.*)$/ });
    shop.requests.length = 0;
    const { t, siteId } = await newSite('source', 'ProfileLimited');
    const id = await start(t, siteId);
    const r = await runRow(id);
    expect(r).toMatchObject({ status: 'partial', errorCode: 'rate_limited', productsSaved: 0 });
    expect(r.nextAttemptAt).not.toBeNull();
    expect(r.error).toMatch(/slow down|temporarily|busy/i);
    // the capability report says it could not be confirmed, instead of declaring the feed "restricted"
    const profile = await db().execute(sql`select data->'limitations' as l from site_profiles where site_id = ${siteId} order by created_at desc limit 1`);
    expect(JSON.stringify(profile.rows[0]!['l'])).toMatch(/rate_limited/);
    // only the check's own few sample pages were asked for (and refused): no product page was crawled as a "second method"
    expect(shop.requests.filter((q) => /^\/products\/[^.]+$/.test(q.path.split('?')[0]!)).length).toBeLessThanOrEqual(3);
    shop.rateLimit = null;
    await later(5 * MIN);
    expect(await runRow(id)).toMatchObject({ status: 'succeeded', isComplete: true, productsSaved: shop.products.length, connector: 'shopify-products-json' });
  });

  it('on the first page of the feed (after a healthy check): pauses and tries again later; it never switches to a method that needs more requests', async () => {
    const shop = h.fixtures.sites.source!;
    const { t, siteId } = await newSite('source', 'FirstPage');
    await runProfile(h.svc, t.orgId, siteId); // checked while the website is healthy
    limitAfter(shop, 0, { paths: /^\/(products\.json|products\/.+|sitemap.*)$/, search: /limit=250|^$/ });
    shop.requests.length = 0;
    const id = await start(t, siteId);
    const r = await runRow(id);
    expect(r.status).toBe('partial');
    expect(r.errorCode).toBe('rate_limited');
    expect(r.productsSaved).toBe(0);
    expect(r.nextAttemptAt).not.toBeNull();
    expect(r.connector).toBe('shopify-products-json');
    // no product page and no sitemap file was asked for as a "second method"
    expect(shop.requests.filter((q) => /^\/products\/[^.]+$/.test(q.path.split('?')[0]!))).toHaveLength(0);
    expect(shop.requests.filter((q) => q.path.startsWith('/sitemap'))).toHaveLength(0);
    expect(shop.requests.filter((q) => q.path.startsWith('/products.json')).length).toBeLessThanOrEqual(4);
    shop.rateLimit = null;
    await later(5 * MIN);
    expect(await runRow(id)).toMatchObject({ status: 'succeeded', isComplete: true, productsSaved: shop.products.length });
  });
});

describe('collections that read pages, not a feed', () => {
  it('a page the website refuses to serve right now is never counted as read: the run pauses and reads the rest later', async () => {
    const shop = h.fixtures.sites.jsonld!;
    const { t, siteId } = await newSite('jsonld', 'Pages');
    await runProfile(h.svc, t.orgId, siteId); // checked while the website is healthy
    limitAfter(shop, 12, { paths: /^\/p\// }); // the first twelve product pages are served, then the website asks us to slow down
    const id = await start(t, siteId);
    const paused = await runRow(id);
    expect(paused.status).toBe('partial');
    expect(paused.isComplete).toBe(false);
    expect(paused.errorCode).toBe('rate_limited');
    expect(paused.productsSaved).toBe(12);
    expect(paused.nextAttemptAt).not.toBeNull();
    // the pages that were refused are still waiting in the queue, not marked as read
    const queue = await db().select().from(crawlQueue).where(eq(crawlQueue.scanRunId, id));
    expect(queue.filter((q) => q.status === 'done')).toHaveLength(12);
    expect(queue.filter((q) => q.status === 'pending').length).toBe(shop.products.length - 12);
    expect(queue.filter((q) => q.status === 'failed')).toHaveLength(0);

    await later(11 * MIN);
    await later(11 * MIN);
    await later(11 * MIN);
    const done = await runRow(id);
    expect(done.status).toBe('succeeded');
    expect(done.isComplete).toBe(true);
    expect(done.productsSaved).toBe(shop.products.length);
    expect(await counts(siteId)).toMatchObject({ products: shop.products.length });
  });

  it('a sitemap the website refuses to serve right now does not send the run to link crawling: it pauses and starts the page list again later', async () => {
    const shop = h.fixtures.sites.jsonld!;
    const { t, siteId } = await newSite('jsonld', 'Sitemap429');
    await runProfile(h.svc, t.orgId, siteId); // checked while the website is healthy
    limitAfter(shop, 0, { paths: /^\/sitemap/ });
    shop.requests.length = 0;
    const id = await start(t, siteId);
    const r = await runRow(id);
    expect(r.status).toBe('partial');
    expect(r.errorCode).toBe('rate_limited');
    expect(r.productsSaved).toBe(0);
    expect(shop.requests.filter((q) => q.path.startsWith('/p/'))).toHaveLength(0); // no product page was read as a "second method"
    shop.rateLimit = null;
    await later(5 * MIN);
    const done = await runRow(id);
    expect(done).toMatchObject({ status: 'succeeded', isComplete: true });
    expect(done.productsSaved).toBe(shop.products.length);
  });
});

describe('a feed that does not advance', () => {
  it('stops with an honest explanation instead of reading the same page until the budget is gone', async () => {
    const shop = feedShop();
    shop.feedIgnoresPaging = true;
    shop.requests.length = 0;
    const { t, siteId } = await newSite('flaky', 'NoPaging');
    const id = await start(t, siteId);
    const r = await runRow(id);
    expect(r.status).toBe('partial');
    expect(r.isComplete).toBe(false);
    expect(r.errorCode).toBe('feed_not_paging');
    expect(r.productsSaved).toBe(250);
    expect(r.notes.join(' ')).toMatch(/does not advance/);
    expect(shop.requests.filter((q) => q.path.startsWith('/products.json')).length).toBeLessThanOrEqual(4);
    expect(await counts(siteId)).toMatchObject({ products: 250, variants: 250 });
    expect(r.nextAttemptAt).toBeNull(); // not a temporary condition: nothing is retried by itself
  });
});
