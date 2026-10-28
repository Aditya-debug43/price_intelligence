import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { priceObservations, products, scanRuns, variants } from '@ci/database';
import { recoverScans, runProfile, startScan } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';
import type { FixtureProduct } from '../support/fixtures/catalogue.ts';
import type { FixtureSiteHandle } from '../support/fixtures/server.ts';

/**
 * THE RELIABILITY MEASUREMENT (directive 14). A fixed list of representative collection scenarios, each run through the real pipeline (profile, method choice,
 * paging, saving, pausing, continuing) against fictional websites that behave like the real ones we have met — healthy shops of every supported kind, and the
 * trouble real websites cause: a feed that answers "slow down" in the middle of the catalogue, a brief outage, a throttled sitemap or robots.txt, an impossible
 * price, a feed that ends early, a worker that died. Nothing is clicked: the collection has to finish by itself, as it does in production.
 *
 * A scenario counts as SUCCESSFUL only when the last run is "succeeded", marked complete, holds exactly the products the website publishes, and a second
 * collection creates no duplicate product or variant. A partial result is a failure here, never a success.
 *
 * Websites where collection is not supported, not authorised or not possible (robots.txt forbids, bot challenge, login, always down, no catalogue, a feed that
 * cannot be paged) are NOT in the success rate: they are listed separately, and what is measured for them is that Shelfwatch ends in the right honest state
 * (never "succeeded", never an endless retry).
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
afterEach(() => {
  for (const s of Object.values(h.fixtures.sites)) {
    s.rateLimit = null;
    s.feedIgnoresPaging = false;
    s.failFeedFromPage = s.spec.kind === 'flaky' ? 3 : null;
    s.mode = 'ok';
  }
});

interface Result {
  group: string;
  name: string;
  eligible: boolean;
  /** Eligible: finished complete, with exactly the published products and no duplicates. Not eligible: ended in the honest state expected for it. */
  ok: boolean;
  detail: string;
}
const results: Result[] = [];

const limit = (site: FixtureSiteHandle, allowance: number, o: { blockMs?: number; paths?: RegExp; search?: RegExp; retryAfterSeconds?: number; liftAfterMs?: number } = {}) => {
  site.rateLimit = {
    allowance,
    blockMs: o.blockMs ?? 10 * MIN,
    retryAfterSeconds: o.retryAfterSeconds ?? null,
    paths: o.paths ?? /^\/products\.json$/,
    ...(o.liftAfterMs !== undefined ? { liftAfterMs: o.liftAfterMs } : {}),
    ...(o.search ? { search: o.search } : o.paths ? {} : { search: /limit=250/ }),
    served: 0,
    blockedUntil: null,
    refused: 0,
  };
};
const live = (s: FixtureSiteHandle) => s.products.filter((p) => !p.removed).length;
const latest = async (siteId: string) => (await db().select().from(scanRuns).where(eq(scanRuns.siteId, siteId)).orderBy(desc(scanRuns.createdAt)).limit(1))[0]!;
const counts = async (siteId: string) => ({
  products: (await db().select().from(products).where(eq(products.siteId, siteId))).length,
  variants: (await db().select().from(variants).where(eq(variants.siteId, siteId))).length,
  observations: (await db().select().from(priceObservations).where(eq(priceObservations.siteId, siteId))).length,
});
async function collect(t: Tenant, siteId: string) {
  await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
  await h.queue.drain();
}
/** Nobody clicks anything: time passes and the scheduler's recovery pass runs, as it does every minute in production. */
async function unattended(t: Tenant, siteId: string, o: { rounds?: number; stepMs?: number } = {}) {
  await collect(t, siteId);
  for (let round = 0; round < (o.rounds ?? 14); round++) {
    if ((await latest(siteId)).status !== 'partial') break;
    h.advance(o.stepMs ?? 10 * MIN);
    await recoverScans(h.svc);
    await h.queue.drain();
  }
  return latest(siteId);
}

interface Scenario {
  group: string;
  name: string;
  key: string;
  /** Sets the website up (its catalogue, its faults). Runs after the website was checked, unless `checkedFirst` is false. */
  prepare?: (shop: FixtureSiteHandle) => void;
  checkedFirst?: boolean;
  /** Overrides how many products the complete catalogue holds (default: what the website publishes). */
  expected?: (shop: FixtureSiteHandle) => number;
}

async function runEligible(s: Scenario) {
  const shop = h.fixtures.sites[s.key]!;
  const t = await h.newTenant('Reliability');
  const siteId = await t.addFixtureSite(s.key, 'competitor');
  if (s.checkedFirst !== false) await runProfile(h.svc, t.orgId, siteId);
  s.prepare?.(shop);
  const expected = s.expected ? s.expected(shop) : live(shop);
  const run = await unattended(t, siteId);
  const first = await counts(siteId);
  let detail = `${run.status}${run.isComplete ? ' complete' : ' NOT complete'}, ${run.productsSaved}/${expected} products${run.errorCode ? `, ${run.errorCode}` : ''}`;
  let ok = run.status === 'succeeded' && run.isComplete && run.productsSaved === expected && first.products === expected;
  if (ok) {
    // a second collection changes nothing that did not change: no duplicate products or variants
    await collect(t, siteId);
    const again = await counts(siteId);
    const noDuplicates = again.products === first.products && again.variants === first.variants;
    if (!noDuplicates) detail += `; DUPLICATES after a second collection (${first.products}/${first.variants} → ${again.products}/${again.variants})`;
    ok = noDuplicates;
  }
  results.push({ group: s.group, name: s.name, eligible: true, ok, detail });
}

const wooExtras = (n: number): FixtureProduct[] =>
  Array.from({ length: n }, (_, i) => ({ itemId: 7000 + i, handle: `woo-extra-${i}`, title: `Reliability Extra Item ${String(i).padStart(3, '0')}`, brand: 'Extra', category: 'Extra', size: '1 each', price: 1 + (i % 40) * 0.25, compareAt: null, currency: 'USD', available: true, claimedLeft: null, gtin: null, sku: `EXTRA-${i}` }));

const ELIGIBLE: Scenario[] = [
  // ── healthy websites of every supported kind
  { group: 'healthy', name: 'Shopify shop (feed + sitemap), 32 products', key: 'source' },
  { group: 'healthy', name: 'Shopify shop with a vendor label, zero-priced item and a standing "regular price"', key: 'vendorshop' },
  { group: 'healthy', name: 'Shopify shop whose sizes are only in tags', key: 'tagsize' },
  { group: 'healthy', name: 'Shopify corporate shop (the store an information site links to)', key: 'corpshop' },
  { group: 'healthy', name: 'Shopify shop whose terms only restrict copying (owner’s informed decision)', key: 'termscopy' },
  { group: 'healthy', name: 'WooCommerce Store API shop', key: 'woo' },
  { group: 'healthy', name: 'Shop with JSON-LD product pages and a sitemap', key: 'jsonld' },
  { group: 'healthy', name: 'Shop with plain HTML product pages', key: 'html' },
  { group: 'healthy', name: 'Shop with listing pages only (no feed, sitemap or structured data)', key: 'listing' },
  { group: 'healthy', name: 'Storefront whose home page is page 1 of the whole catalogue', key: 'homegrid' },
  { group: 'healthy', name: 'Shopify shop with 600 products on three feed pages', key: 'flaky', prepare: (s) => void (s.failFeedFromPage = null) },
  { group: 'healthy', name: 'Shopify feed that ends early (12 of 30); the sitemaps list all 30', key: 'shortfeed' },
  { group: 'healthy', name: 'Shopify shop whose feed lists an impossible compare-at price (the lasfit.com case)', key: 'source', prepare: (s) => s.setPrice(s.products[3]!.itemId, 317.94, 139982999149929.98) },
  // ── the trouble real websites cause
  { group: 'rate limit', name: 'Feed: "slow down" (429) after page 2 of 3, for ten minutes (the auxito.com case)', key: 'flaky', prepare: (s) => { s.failFeedFromPage = null; limit(s, 2); } },
  { group: 'rate limit', name: 'Feed: "slow down" after page 1, with Retry-After: 600', key: 'flaky', prepare: (s) => { s.failFeedFromPage = null; limit(s, 1, { retryAfterSeconds: 600 }); } },
  { group: 'rate limit', name: 'Feed: one page allowed every ten minutes (three windows)', key: 'flaky', prepare: (s) => { s.failFeedFromPage = null; limit(s, 1); } },
  { group: 'rate limit', name: 'Feed: refused from the very first page (after a healthy check)', key: 'source', prepare: (s) => limit(s, 0, { paths: /^\/products\.json$/, search: /limit=250/, liftAfterMs: 15 * MIN }) },
  { group: 'rate limit', name: 'Website limits us while it is being checked (the check cannot judge it)', key: 'source', checkedFirst: false, prepare: (s) => limit(s, 0, { paths: /^\/(products\.json|sitemap.*|products\/.+)$/, liftAfterMs: 15 * MIN }) },
  { group: 'rate limit', name: 'robots.txt answers "slow down" for ten minutes', key: 'source', checkedFirst: false, prepare: (s) => limit(s, 0, { paths: /^\/robots\.txt$/, liftAfterMs: 15 * MIN }) },
  { group: 'rate limit', name: 'WooCommerce store with 250 products, "slow down" after the first of three pages', key: 'woo', prepare: (s) => { for (const p of wooExtras(220)) s.add(p); limit(s, 1, { paths: /^\/wp-json\/wc\/store\/v1\/products$/, search: /per_page=100/ }); } },
  { group: 'rate limit', name: 'Product pages throttled after twelve (JSON-LD shop, page crawl)', key: 'jsonld', prepare: (s) => limit(s, 12, { paths: /^\/p\// }) },
  { group: 'rate limit', name: 'Sitemap throttled at discovery (JSON-LD shop)', key: 'jsonld', prepare: (s) => limit(s, 0, { paths: /^\/sitemap/, liftAfterMs: 15 * MIN }) },
  // ── brief outages
  { group: 'outage', name: 'Feed: HTTP 503 from page 3 for a while (brief outage)', key: 'flaky', prepare: (s) => void (s.failFeedFromPage = 3), expected: () => 600 },
];

describe('representative collection scenarios the product must complete by itself', () => {
  for (const s of ELIGIBLE) {
    it(`${s.group}: ${s.name}`, async () => {
      // the "brief outage" lasts until the clock has moved on: lift it a little after the first sitting by making the fixture recover on a timer
      if (s.group === 'outage') {
        const shop = h.fixtures.sites[s.key]!;
        const t0 = h.svc.clock().getTime();
        const timer = setInterval(() => {
          if (h.svc.clock().getTime() - t0 > 12 * MIN) shop.failFeedFromPage = null;
        }, 1);
        try {
          await runEligible(s);
        } finally {
          clearInterval(timer);
        }
      } else await runEligible(s);
      expect(true).toBe(true); // the measurement is the summary below; each scenario records its own outcome
    }, 120_000);
  }

  it('a worker that died mid-collection: the stalled run is found and finished (recovery, not a restart)', async () => {
    const shop = h.fixtures.sites.flaky!;
    shop.failFeedFromPage = null;
    const t = await h.newTenant('Crash');
    const siteId = await t.addFixtureSite('flaky', 'competitor');
    await runProfile(h.svc, t.orgId, siteId);
    limit(shop, 2);
    await collect(t, siteId);
    // as if the worker had been killed right after saving two pages: "running", no heartbeat for an hour, the saved page kept
    const [run] = await db().select().from(scanRuns).where(eq(scanRuns.siteId, siteId));
    await db().update(scanRuns).set({ status: 'running', finishedAt: null, nextAttemptAt: null, errorCode: null, error: null, heartbeatAt: new Date(h.svc.clock().getTime() - 60 * MIN) }).where(eq(scanRuns.id, run!.id));
    shop.rateLimit = null;
    h.advance(MIN);
    await recoverScans(h.svc);
    await h.queue.drain();
    const done = await latest(siteId);
    const c = await counts(siteId);
    results.push({ group: 'recovery', name: 'Worker died after two of three feed pages: recovery continues the same run', eligible: true, ok: done.id === run!.id && done.status === 'succeeded' && done.isComplete && c.products === 600 && c.observations === 600, detail: `${done.status}${done.isComplete ? ' complete' : ''}, ${c.products} products, ${c.observations} observations` });
  }, 120_000);
});

describe('websites that cannot or must not be collected: the honest end state, never "succeeded", never an endless retry', () => {
  const NOT: { name: string; key: string; prepare?: (s: FixtureSiteHandle) => void; accept: (r: { status: string; isComplete: boolean; errorCode: string | null; nextAttemptAt: Date | null }) => boolean; role?: 'source' | 'competitor' }[] = [
    { name: 'robots.txt forbids the whole site', key: 'blocked', accept: (r) => r.status === 'blocked' },
    { name: 'robots.txt forbids the shop pages', key: 'catblocked', accept: (r) => ['blocked', 'failed'].includes(r.status) },
    { name: 'a bot challenge protects the site', key: 'challenge', accept: (r) => r.status === 'blocked' },
    { name: 'a login is required', key: 'login', accept: (r) => ['blocked', 'failed'].includes(r.status) },
    { name: 'the website is down (HTTP 500)', key: 'failing', accept: (r) => r.status === 'failed' && r.nextAttemptAt === null },
    { name: 'an information site with no catalogue', key: 'infosite', accept: (r) => r.status === 'failed' && ['catalogue_elsewhere', 'not_a_shop', 'unsupported_site'].includes(r.errorCode ?? '') },
    { name: 'a feed that ignores its page number', key: 'flaky', prepare: (s) => { s.failFeedFromPage = null; s.feedIgnoresPaging = true; }, accept: (r) => r.status === 'partial' && !r.isComplete && r.errorCode === 'feed_not_paging' && r.nextAttemptAt === null },
    { name: 'a website that limits us for a month (it is asked less and less, then left alone)', key: 'flaky', prepare: (s) => { s.failFeedFromPage = null; limit(s, 2, { blockMs: 30 * 24 * 60 * MIN }); }, accept: (r) => r.status === 'partial' && !r.isComplete && r.nextAttemptAt === null },
  ];
  for (const n of NOT) {
    it(n.name, async () => {
      const shop = h.fixtures.sites[n.key]!;
      n.prepare?.(shop);
      const t = await h.newTenant('NotCollectable');
      const siteId = await t.addFixtureSite(n.key, 'competitor');
      // long enough for the whole waiting ladder (2 + 4 + 8 + 16 + 32 + 60 + 60 minutes) to run out
      const run = await unattended(t, siteId, { rounds: 30, stepMs: 15 * MIN });
      const ok = n.accept(run);
      results.push({ group: 'not collectable', name: n.name, eligible: false, ok, detail: `${run.status}${run.isComplete ? ' complete' : ''}${run.errorCode ? `, ${run.errorCode}` : ''}${run.nextAttemptAt ? ', still retrying' : ''}` });
      expect(run.status).not.toBe('succeeded');
    }, 120_000);
  }
});

describe('the measurement', () => {
  it('at least 95% of the eligible scenarios complete by themselves, and every non-collectable website ends in its honest state', () => {
    const eligible = results.filter((r) => r.eligible);
    const ok = eligible.filter((r) => r.ok);
    const rate = eligible.length ? ok.length / eligible.length : 0;
    const notEligible = results.filter((r) => !r.eligible);
    const table = [...results].map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.eligible ? 'eligible    ' : 'not eligible'}  ${r.group.padEnd(15)} ${r.name} — ${r.detail}`).join('\n');
    const summary = `RELIABILITY (fictional websites through the real pipeline): ${ok.length} of ${eligible.length} eligible scenarios completed = ${(rate * 100).toFixed(1)}%; non-collectable websites ending in the right honest state: ${notEligible.filter((r) => r.ok).length} of ${notEligible.length}`;
    console.log(`\n${summary}\n${table}\n`);
    try {
      const dir = path.resolve(import.meta.dirname, '../../.data/live-runs');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `reliability-fixtures-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ summary, rate, eligible: eligible.length, completed: ok.length, results }, null, 1));
    } catch {
      /* the record is a convenience */
    }
    expect(eligible.length, 'the list of eligible scenarios must stay representative (not be shrunk to reach the target)').toBeGreaterThanOrEqual(24);
    expect(notEligible.length).toBeGreaterThanOrEqual(8);
    expect(rate, summary + '\n' + table).toBeGreaterThanOrEqual(0.95);
    expect(notEligible.filter((r) => !r.ok), table).toEqual([]);
  });
});
