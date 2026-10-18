import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { evidence, exchangeRates, priceObservations, products, scanRuns, siteProfiles, sites, variants } from '@ci/database';
import { addSite, loadAssortment, loadCoverage, loadComparison, loadFxTable, loadSiteMaps, ensureFxRates, refreshMarketRates, runMatching, runProfile, setConsent, startScan } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';

/**
 * THE LIVE PROCEDURE. Unlike every other test, this one talks to the real internet: real DNS, real TLS, real robots.txt, real pages, the
 * production fetch policy and pacing (1.5 s between requests per host), the real clock, a real PostgreSQL. No fictional website, no
 * transport stand-in. It runs only via \`npm run test:live\` because it sends requests to real websites.
 *
 * Targets (override with LIVE_SOURCE_URL and LIVE_COMPETITOR_URLS, comma separated — only for websites you are entitled to collect from):
 *   default source      https://books.toscrape.com/        a sandbox shop built for scraping practice (static HTML, pagination, GBP)
 *   default competitors https://scrapeme.live/shop/        a WooCommerce sandbox built for scraping practice
 *                       https://www.scrapingcourse.com/ecommerce/  a sandbox whose robots.txt DISALLOWS "/ecommerce/*": the page given is refused, so it must come back as blocked
 *
 * What it proves, from the real network: the whole add → profile → confirm → collect → store chain; that every stored product and price has
 * its real source URL and a real observation time; that the stored numbers appear in the raw page the collector actually fetched (parser vs
 * source of truth, for every stored observation); that a sample of pages re-fetched now still shows the same price; and that a website whose
 * robots.txt disallows collection is reported as blocked and not collected.
 *
 * What it does NOT prove: price COMPARISON on real overlapping products (the default sandboxes sell different things) — that needs your own
 * source and competitor websites.
 */
const SOURCE = process.env['LIVE_SOURCE_URL'] ?? 'https://books.toscrape.com/';
const COMPETITORS = (process.env['LIVE_COMPETITOR_URLS'] ?? 'https://scrapeme.live/shop/,https://www.scrapingcourse.com/ecommerce/').split(',').map((s) => s.trim()).filter(Boolean);
const DEFAULT_TARGETS = !process.env['LIVE_SOURCE_URL'];
const SAMPLE = Number(process.env['LIVE_SAMPLE'] ?? 40);
const RECHECK = Number(process.env['LIVE_RECHECK'] ?? 4);
const UA = 'CompetitorIntelBot/1.0 (+https://example.invalid/bot; respects robots.txt)';

let h: Harness;
let t: Tenant;
const record: Record<string, unknown> = { startedAt: new Date().toISOString(), sample: SAMPLE, sites: [] as unknown[] };
const siteIds = new Map<string, string>();

beforeAll(async () => {
  h = await createHarness({ real: true, extraEnv: { COLLECTOR_DEFAULT_MAX_REQUESTS: '250' } });
  t = await h.newTenant('LiveRun');
}, 180_000);

afterAll(async () => {
  record['finishedAt'] = new Date().toISOString();
  const dir = path.resolve(import.meta.dirname, '..', '..', '.data', 'live-runs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `live-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(`\nLive run record written to ${file}\n`);
  await h?.close();
});

/** All the ways a price can be written on a page (1299 → "1299.00", "1,299.00", "1.299,00", "1299"). */
function priceCandidates(amount: number): string[] {
  const fixed = amount.toFixed(2);
  const [int, dec] = fixed.split('.') as [string, string];
  const grouped = (sep: string) => int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const out = new Set([fixed, `${int},${dec}`, `${grouped(',')}.${dec}`, `${grouped('.')},${dec}`, `${grouped(' ')}.${dec}`, `${grouped(' ')},${dec}`]);
  if (Number.isInteger(amount)) out.add(int).add(grouped(','));
  return [...out];
}
const appears = (haystack: string, amount: number) => priceCandidates(amount).some((c) => new RegExp(`(?<![\\d.,])${c.replace(/[.,\s]/g, (x) => (x === ' ' ? '[\\s\\u00a0\\u202f]' : `\\${x}`))}(?![\\d])`).test(haystack));
const norm = (s: string) => s.toLowerCase().replace(/&amp;|&#38;/g, '&').replace(/&#39;|&apos;|&#8217;/g, "'").replace(/&quot;|&#34;/g, '"').replace(/\\u0026/g, '&').replace(/\s+/g, ' ').trim();

describe('real websites: add, check, confirm, collect', () => {
  it('adds the source and the competitors with the production URL rules (real DNS, public hosts only)', async () => {
    const targets: [('source' | 'competitor'), string][] = [['source', SOURCE], ...COMPETITORS.map((u): ['competitor', string] => ['competitor', u])];
    for (const [role, url] of targets) {
      const s = await t.tx((tx) => addSite(h.svc, tx, t.orgId, t.userId, { url, role }));
      siteIds.set(url, s.id);
      expect(s.consentStatus).toBe('pending');
    }
    expect(siteIds.size).toBe(1 + COMPETITORS.length);
  });

  it('checks what each website allows, from the real network', async () => {
    for (const [url, id] of siteIds) {
      const p = await runProfile(h.svc, t.orgId, id);
      const row = { url, status: p.status, platform: p.platform.id, currency: p.currency.detected, robotsDisallowsAll: p.access.robots.disallowsAll, limitations: p.limitations.map((l) => l.code), requests: p.requestsMade };
      console.log('PROFILE', JSON.stringify(row));
      (record['sites'] as unknown[]).push({ ...row, profile: true });
      expect(['full', 'partial', 'limited', 'blocked', 'failed']).toContain(p.status);
      if (DEFAULT_TARGETS && url.includes('scrapingcourse.com')) {
        // its robots.txt really does say "Disallow: /ecommerce/*": the page that was given must be refused, not worked around
        expect(p.status).toBe('blocked');
        expect(p.access.robots.entryAllowed).toBe(false);
        expect(p.limitations.some((l) => l.code === 'robots_disallow')).toBe(true);
      }
    }
  });

  it('collects a sample from every website whose rules allow it; a website that forbids it is blocked and nothing is stored', async () => {
    for (const [url, id] of siteIds) {
      await t.tx((tx) => setConsent(h.svc, tx, t.orgId, t.userId, id, { status: 'confirmed', attest: true, note: 'live verification run' }));
      await t.tx((tx) => startScan(h.svc, tx, t.orgId, id, { kind: 'sample', limit: SAMPLE, trigger: 'manual' })).catch((e) => console.log('SCAN REFUSED', url, (e as Error).message));
    }
    await h.queue.drain();
    for (const [url, id] of siteIds) {
      const [run] = await h.db.worker.select().from(scanRuns).where(eq(scanRuns.siteId, id)).orderBy(scanRuns.createdAt);
      const [{ n } = { n: 0 }] = await h.db.worker.select({ n: sql<number>`count(*)::int` }).from(products).where(eq(products.siteId, id));
      const summary = { url, run: run ? { status: run.status, connector: run.connector, isComplete: run.isComplete, urlsFetched: run.urlsFetched, productsSaved: run.productsSaved, error: run.error } : null, productsStored: n };
      console.log('COLLECTED', JSON.stringify(summary));
      const entry = (record['sites'] as { url: string }[]).find((s) => s.url === url);
      if (entry) Object.assign(entry, { collected: summary });
      if (DEFAULT_TARGETS && url.includes('scrapingcourse.com')) {
        expect(n, 'a website that forbids collection holds no products').toBe(0);
        expect(run?.status).not.toBe('succeeded');
      }
    }
    const withData = [...siteIds.values()];
    const counts = await h.db.worker.select({ siteId: products.siteId, n: sql<number>`count(*)::int` }).from(products).where(inArray(products.siteId, withData)).groupBy(products.siteId);
    expect(counts.length, 'at least one real website was collected').toBeGreaterThan(0);
  });
});

describe('what was stored is real, traceable and correct', () => {
  it('every product and price carries its real source page and observation time', async () => {
    const rows = await h.db.worker.select({ siteId: priceObservations.siteId, price: priceObservations.price, currency: priceObservations.currency, sourceUrl: priceObservations.sourceUrl, observedAt: priceObservations.observedAt, evidenceId: priceObservations.evidenceId, host: sites.hostname }).from(priceObservations).innerJoin(sites, eq(sites.id, priceObservations.siteId)).where(eq(priceObservations.orgId, t.orgId));
    expect(rows.length).toBeGreaterThan(5);
    const now = Date.now();
    for (const r of rows) {
      expect(new URL(r.sourceUrl).hostname.replace(/^www\./, ''), r.sourceUrl).toBe(r.host.replace(/^www\./, ''));
      expect(now - r.observedAt.getTime(), 'observed during this run').toBeLessThan(30 * 60_000);
      expect(r.evidenceId).toBeTruthy();
      if (r.price !== null) {
        expect(r.price).toBeGreaterThan(0);
        expect(r.currency, `currency of ${r.sourceUrl}`).toBeTruthy();
      }
    }
    expect(rows.every((r) => !/localhost|127\.0\.0\.1|\.test\b/.test(r.sourceUrl))).toBe(true);
  });

  it('the stored price and title appear in the raw page the collector fetched (parser vs source of truth), for every stored observation', async () => {
    const rows = await h.db.worker
      .select({ price: priceObservations.price, title: products.title, url: priceObservations.sourceUrl, snapshot: evidence.snapshotRef, hash: evidence.contentHash, host: sites.hostname })
      .from(priceObservations)
      .innerJoin(variants, eq(variants.id, priceObservations.variantId))
      .innerJoin(products, eq(products.id, variants.productId))
      .innerJoin(evidence, eq(evidence.id, priceObservations.evidenceId))
      .innerJoin(sites, eq(sites.id, priceObservations.siteId))
      .where(and(eq(priceObservations.orgId, t.orgId), isNotNull(priceObservations.price)));
    let checked = 0;
    const misses: string[] = [];
    const bySnapshot = new Map<string, string>();
    for (const r of rows) {
      expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
      if (!r.snapshot) continue;
      let body = bySnapshot.get(r.snapshot);
      if (body === undefined) {
        body = (await h.svc.storage.get(r.snapshot))?.toString('utf8') ?? '';
        bySnapshot.set(r.snapshot, body);
      }
      if (!body) continue;
      checked++;
      const priceOk = appears(body, r.price!);
      const titleOk = norm(body).includes(norm(r.title).slice(0, 40));
      if (!priceOk || !titleOk) misses.push(`${r.url} price ${r.price} ${priceOk ? '' : 'NOT FOUND '}title ${titleOk ? '' : 'NOT FOUND'}`);
    }
    console.log(`SNAPSHOT CHECK: ${checked} stored observations checked against their raw pages; ${misses.length} mismatches`, misses.slice(0, 5));
    (record['snapshotCheck'] as unknown) = { checked, mismatches: misses.length, examples: misses.slice(0, 10) };
    expect(checked).toBeGreaterThan(5);
    expect(misses, 'every stored price and title is present in the raw page that was fetched').toEqual([]);
  });

  it('a sample of those pages, fetched again now, still shows the same price', async () => {
    const rows = await h.db.worker
      .select({ siteId: priceObservations.siteId, price: priceObservations.price, url: evidence.url })
      .from(priceObservations)
      .innerJoin(evidence, eq(evidence.id, priceObservations.evidenceId))
      .where(and(eq(priceObservations.orgId, t.orgId), isNotNull(priceObservations.price)));
    const perSite = new Map<string, typeof rows>();
    for (const r of rows) perSite.set(r.siteId, [...(perSite.get(r.siteId) ?? []), r]);
    const result: { url: string; price: number; stillShown: boolean }[] = [];
    for (const [, list] of perSite) {
      const seen = new Set<string>();
      for (const r of list) {
        if (seen.has(r.url) || seen.size >= RECHECK) continue;
        seen.add(r.url);
        await new Promise((res) => setTimeout(res, 1600)); // the same pace the collector keeps
        const res = await fetch(r.url, { headers: { 'user-agent': UA, accept: 'text/html,application/json' }, redirect: 'follow' });
        const body = await res.text();
        result.push({ url: r.url, price: r.price!, stillShown: res.ok && appears(body, r.price!) });
      }
    }
    console.log('RECHECK', JSON.stringify(result));
    (record['recheck'] as unknown) = result;
    expect(result.length).toBeGreaterThan(0);
    const ok = result.filter((x) => x.stillShown).length;
    expect(ok / result.length, 'at least 90% of re-fetched pages still show the stored price').toBeGreaterThanOrEqual(0.9);
  });

  it('shows what was stored, so a person can compare it with the websites by eye', async () => {
    const sample = await h.db.worker
      .select({ site: sites.hostname, title: products.title, price: variants.price, currency: variants.currency, availability: variants.availability, url: products.canonicalUrl })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .innerJoin(sites, eq(sites.id, variants.siteId))
      .where(eq(variants.orgId, t.orgId))
      .orderBy(sites.hostname, products.title)
      .limit(12);
    console.log('STORED SAMPLE\n' + sample.map((s) => `  ${s.site}  |  ${s.title}  |  ${s.price} ${s.currency}  |  ${s.availability}  |  ${s.url}`).join('\n'));
    (record['storedSample'] as unknown) = sample;
    expect(sample.length).toBeGreaterThan(0);
  });
});

describe('honest comparison on real data', () => {
  it('the market exchange rate comes from the real provider with its source and time (no key, no cost); the Aruba peg stays a stated constant', async (ctx) => {
    await ensureFxRates(h.svc); // the stated AWG peg, seeded exactly as the running application seeds it
    const before = await h.db.worker.select().from(exchangeRates);
    const svc = { db: h.db.worker, clock: () => new Date(), config: { ...h.svc.config, FX_PROVIDER: 'open-er-api' as const }, log: h.svc.log };
    const n = await refreshMarketRates(svc as never).catch((e: Error) => {
      // a provider outage is a fact about the provider, not about this product: it is recorded and shown as a SKIPPED test, never as a pass
      console.log('FX PROVIDER UNAVAILABLE', e.message);
      (record['fx'] as unknown) = { ok: false, error: e.message };
      return null;
    });
    if (n === null) return ctx.skip(`the exchange-rate provider did not answer: ${(record['fx'] as { error: string }).error}`);
    const after = await h.db.worker.select().from(exchangeRates);
    const gbp = after.find((r) => r.base === 'USD' && r.quote === 'GBP' && !r.isFixed);
    console.log('FX', JSON.stringify({ rows: n, usdGbp: gbp?.rate, source: gbp?.source, fetchedAt: gbp?.fetchedAt }));
    (record['fx'] as unknown) = { ok: true, rows: n, usdGbp: gbp?.rate, source: gbp?.source, fetchedAt: gbp?.fetchedAt, before: before.length, after: after.length };
    expect(n).toBeGreaterThan(100);
    expect(gbp, 'USD→GBP is present').toBeDefined();
    expect(gbp!.rate).toBeGreaterThan(0.3);
    expect(gbp!.rate).toBeLessThan(2);
    expect(gbp!.source).toMatch(/open\.er-api\.com/);
    expect(gbp!.provenance).toBe('exchange_rate_service');
    expect(Math.abs(Date.now() - gbp!.fetchedAt.getTime()), 'the rate carries the time of the provider’s last update, within two days').toBeLessThan(2 * 86_400_000);
    expect(after.some((r) => r.quote === 'AWG' && r.isFixed && r.provenance === 'configuration'), 'the AWG peg is still the stated constant, not a market rate').toBe(true);
    expect(after.filter((r) => r.quote === 'AWG' && !r.isFixed)).toEqual([]);
  });

  it('matching and comparison run on the real observations; a product with no counterpart is listed as such — never as cheaper, never as zero', async () => {
    await runMatching(h.svc, h.db.worker, t.orgId);
    await ensureFxRates(h.svc);
    const fx = await loadFxTable(h.db.worker);
    const rows = await t.tx((tx) => loadComparison(tx, { orgId: t.orgId, reportingCurrency: 'USD', fx, now: new Date(), staleAfterHours: 36 }));
    const maps = await t.tx((tx) => loadSiteMaps(tx, t.orgId));
    const coverage = await t.tx((tx) => loadCoverage(tx, t.orgId, new Date(), 36));
    const assortment = await t.tx((tx) => loadAssortment(tx, t.orgId, maps, coverage));
    const sourceStored = (await h.db.worker.select({ n: sql<number>`count(*)::int` }).from(products).where(eq(products.siteId, siteIds.get(SOURCE)!)))[0]!.n;
    console.log(`COMPARISON: ${rows.length} source products with a match; ${rows.filter((r) => r.cells.some((c) => c.price.amount !== null)).length} with at least one competitor price; ${assortment.sourceOnly.length} of ${sourceStored} source products have no counterpart`);
    (record['comparison'] as unknown) = { sourceProducts: sourceStored, withMatch: rows.length, withCompetitorPrice: rows.filter((r) => r.cells.some((c) => c.price.amount !== null)).length, withoutCounterpart: assortment.sourceOnly.length };
    expect(sourceStored).toBeGreaterThan(0);
    // every stored source product is either in the matrix with a counterpart or listed as having none: nothing disappears and nothing is invented
    expect(rows.length + assortment.sourceOnly.length).toBe(sourceStored);
    // a competitor that was blocked, or read only as a sample, means "no equivalent found" is NOT "nobody sells it": the basis must say so
    expect(assortment.basis.competitorsComplete, 'no competitor was read completely in this run').toBe(false);
    expect(assortment.note).toMatch(/not.*read completely/i);
    // the default sandboxes sell different things (books, Pokémon): finding "matches" between them would be an error
    if (DEFAULT_TARGETS) expect(rows, 'books and monsters do not match').toHaveLength(0);
    for (const r of rows) for (const c of r.cells) if (c.price.amount === null) expect(c.diffPct, 'no price means no difference is invented').toBeNull();
    const profiles = await h.db.worker.select().from(siteProfiles).where(eq(siteProfiles.orgId, t.orgId));
    expect(profiles.length).toBe(siteIds.size);
  });
});
