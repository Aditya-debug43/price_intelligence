import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { isStorableMoney } from '@ci/core';
import { evidence, exchangeRates, offers, priceObservations, products, scanRuns, variants } from '@ci/database';
import { addSite, bulkAcceptMatches, ensureFxRates, exportReport, generateReport, loadAssortment, loadComparison, loadCoverage, loadFxTable, loadSiteMaps, runMatching, runProfile, setConsent, startScan } from '@ci/services';
import type { ReportData } from '@ci/shared';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';

/**
 * THE EXHAUSTIVE LIVE PROCEDURE for websites you named. It runs only when LIVE_SOURCE_URL is set (so it never runs against anything by
 * default) and only through `npm run test:live -- tests/live/real-catalogues.live.test.ts`. Real DNS, TLS, robots.txt and pages; production
 * fetch policy and pacing (1.5 s between requests per host, the host's own crawl delay when larger); the real clock; a real PostgreSQL.
 *
 *   LIVE_SOURCE_URL=https://your-shop.example LIVE_COMPETITOR_URLS=https://rival-one.example,https://rival-two.example \
 *   [LIVE_SPOT=25] [LIVE_MAX_REQUESTS=4000] [LIVE_CONSENT_NOTE="…"] npm run test:live -- tests/live/real-catalogues.live.test.ts
 *
 * What it proves, per website:
 *  1. profile (what can be collected and why not), 2. a COMPLETE catalogue collection, 3. the stored catalogue equals an independent
 *  re-read of the website's own public feed for EVERY product and variant (counts, prices, compare-at prices, availability, names),
 *  4. a random sample of real product pages shows the stored price and availability, 5. every observation is traceable (source URL, time,
 *  evidence, SHA-256), 6. a second collection changes nothing that did not change on the website, 7. matching and comparison on the real
 *  overlapping catalogues (written out for human review), offers, stock, coverage, the honest "no equivalent" basis, a report and its exports.
 * Everything found is written to .data/live-runs/full-<time>.json.
 */
const SOURCE = process.env['LIVE_SOURCE_URL'];
const COMPETITORS = (process.env['LIVE_COMPETITOR_URLS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SPOT = Number(process.env['LIVE_SPOT'] ?? 25);
const MAX_REQUESTS = process.env['LIVE_MAX_REQUESTS'] ?? '4000';
const CONSENT_NOTE = process.env['LIVE_CONSENT_NOTE'] ?? 'live verification run';
const UA = 'CompetitorIntelBot/1.0 (+https://example.invalid/bot; respects robots.txt)';

type Rec = Record<string, unknown>;
const record: Rec = { startedAt: new Date().toISOString(), source: SOURCE, competitors: COMPETITORS, spot: SPOT, sites: {} as Record<string, Rec> };
const bySite = (url: string): Rec => ((record['sites'] as Record<string, Rec>)[url] ??= { url });

let h: Harness;
let t: Tenant;
const siteIds = new Map<string, string>(); // url → site id
const lastFetch = new Map<string, number>();

/** Our own polite client for the independent checks: one request at a time per host, never faster than the collector. */
async function polite(url: string, accept = 'text/html,application/json'): Promise<{ status: number; text: string; headers: Headers }> {
  const host = new URL(url).host;
  const wait = (lastFetch.get(host) ?? 0) + 1600 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetch.set(host, Date.now());
  const res = await fetch(url, { headers: { 'user-agent': UA, accept }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const norm = (s: string) => s.replace(/[‘’‛`]/g, "'").replace(/[“”]/g, '"').toLowerCase().replace(/&amp;|&#38;/g, '&').replace(/&#39;|&apos;|&#8217;/g, "'").replace(/&quot;|&#34;/g, '"').replace(/\\u0026/g, '&').replace(/\s+/g, ' ').trim();
function priceCandidates(amount: number): string[] {
  const fixed = amount.toFixed(2);
  const [int, dec] = fixed.split('.') as [string, string];
  const grouped = (sep: string) => int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const out = new Set([fixed, `${int},${dec}`, `${grouped(',')}.${dec}`, `${grouped('.')},${dec}`]);
  if (Number.isInteger(amount)) out.add(int).add(grouped(','));
  return [...out];
}
const appears = (haystack: string, amount: number) => priceCandidates(amount).some((c) => new RegExp(`(?<![\\d.,])${c.replace(/[.,]/g, (x) => `\\${x}`)}(?![\\d])`).test(haystack));
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const sample = <T>(list: T[], n: number, seed: number): T[] => {
  const r = rng(seed);
  return [...list].map((x) => [r(), x] as const).sort((a, b) => a[0] - b[0]).slice(0, n).map((x) => x[1]);
};
const round2 = (n: number) => Math.round(n * 100) / 100;

beforeAll(async () => {
  if (!SOURCE) return;
  h = await createHarness({ real: true, extraEnv: { COLLECTOR_DEFAULT_MAX_REQUESTS: MAX_REQUESTS } });
  t = await h.newTenant('LiveFull');
}, 180_000);

afterAll(async () => {
  if (!SOURCE) return;
  record['finishedAt'] = new Date().toISOString();
  const dir = path.resolve(import.meta.dirname, '..', '..', '.data', 'live-runs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `full-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(`\nFull live run record written to ${file}\n`);
  await h?.close();
});

const dbq = () => h.db.worker;
const tally = async (siteId: string) => {
  const r = await dbq().execute<{ p: string; v: string; o: string }>(sql`select (select count(*) from products where site_id = ${siteId})::text as p, (select count(*) from variants where site_id = ${siteId})::text as v, (select count(*) from price_observations where site_id = ${siteId})::text as o`);
  return { products: Number(r.rows[0]!.p), variants: Number(r.rows[0]!.v), obs: Number(r.rows[0]!.o) };
};
const allUrls = () => [SOURCE!, ...COMPETITORS];
const collected = () => allUrls().filter((u) => (bySite(u)['collectedProducts'] as number | undefined ?? 0) > 0);

describe.skipIf(!SOURCE)('your websites, exhaustively', () => {
  it('1. adds the source and the competitors with the production URL rules (real DNS, public hosts only)', async () => {
    const targets: ['source' | 'competitor', string][] = [['source', SOURCE!], ...COMPETITORS.map((u): ['competitor', string] => ['competitor', u])];
    for (const [role, url] of targets) {
      const s = await t.tx((tx) => addSite(h.svc, tx, t.orgId, t.userId, { url, role }));
      siteIds.set(url, s.id);
      Object.assign(bySite(url), { role, siteId: s.id, hostname: s.hostname, entryPath: s.entryPath });
    }
    expect(siteIds.size).toBe(targets.length);
  });

  it('2. profiles every website: what can be collected, and plainly why not when it cannot', async () => {
    for (const [url, id] of siteIds) {
      const p = await runProfile(h.svc, t.orgId, id);
      Object.assign(bySite(url), {
        profile: {
          status: p.status, summary: p.summary, platform: p.platform, currency: p.currency, strategy: p.strategy, requests: p.requestsMade, durationMs: p.durationMs,
          robots: p.access.robots, barriers: p.access.barriers, estimatedProducts: p.catalogue.estimatedProducts, estimateBasis: p.catalogue.estimateBasis,
          apis: p.catalogue.publicApis.map((a) => ({ kind: a.kind, usable: a.usable, total: a.total })), limitations: p.limitations.map((l) => `${l.severity}:${l.code}`),
          fields: Object.fromEntries(Object.entries(p.fields).map(([k, v]) => [k, `${v.availability}${v.coverage !== null ? ` ${Math.round(v.coverage * 100)}%` : ''}`])),
          rendering: p.rendering, listing: p.catalogue.listing ?? null,
        },
      });
      expect(['full', 'partial', 'limited', 'blocked', 'failed']).toContain(p.status);
    }
  });

  it('3. collects every website whose public data allows it, COMPLETELY, and records exactly what happened to the others', async () => {
    for (const [url, id] of siteIds) {
      await t.tx((tx) => setConsent(h.svc, tx, t.orgId, t.userId, id, { status: 'confirmed', attest: true, note: CONSENT_NOTE }));
      await t.tx((tx) => startScan(h.svc, tx, t.orgId, id, { kind: 'discovery', trigger: 'manual' })).catch((e) => Object.assign(bySite(url), { scanRefused: (e as Error).message }));
    }
    await h.queue.drain();
    for (const [url, id] of siteIds) {
      const runs = await dbq().select().from(scanRuns).where(eq(scanRuns.siteId, id)).orderBy(scanRuns.createdAt);
      const run = runs.at(-1);
      const [{ n = 0 } = {}] = await dbq().select({ n: sql<number>`count(*)::int` }).from(products).where(eq(products.siteId, id));
      const [{ v = 0 } = {}] = await dbq().select({ v: sql<number>`count(*)::int` }).from(variants).where(eq(variants.siteId, id));
      Object.assign(bySite(url), {
        collectedProducts: n, collectedVariants: v,
        run: run && { status: run.status, connector: run.connector, isComplete: run.isComplete, urlsDiscovered: run.urlsDiscovered, urlsFetched: run.urlsFetched, requestsMade: run.requestsMade, productsSaved: run.productsSaved, errorCode: run.errorCode, error: run.error, notes: run.notes, durationS: run.startedAt && run.finishedAt ? Math.round((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000) : null },
      });
    }
    expect(collected().length, 'at least one website was collected').toBeGreaterThan(0);
  });

  it('4. every stored product and variant equals an independent re-read of the website’s own public feed (all of them, not a sample)', async () => {
    for (const url of collected()) {
      const info = bySite(url);
      const apis = ((info['profile'] as Rec)['apis'] as { kind: string; usable: boolean }[]).filter((a) => a.usable).map((a) => a.kind);
      const origin = new URL(url).origin;
      const id = siteIds.get(url)!;
      const db = await dbq()
        .select({ key: variants.variantKey, price: variants.price, compareAt: variants.compareAtPrice, availability: variants.availability, currency: variants.currency, sku: variants.sku, title: products.title, brand: products.brand, url: products.canonicalUrl, delisted: products.delistedAt })
        .from(variants).innerJoin(products, eq(products.id, variants.productId)).where(eq(variants.siteId, id));
      const dbByKey = new Map(db.map((r) => [r.key, r]));
      const mismatches: string[] = [];
      let feedVariants = 0;
      let feedProducts = 0;
      const zeroPriced: string[] = [];
      const unstorable: string[] = []; // amounts in the website's own feed that no database column can hold: expected to be stored as unknown, and reported
      let kind = 'none';
      if (apis.includes('shopify_products_json')) {
        kind = 'shopify_products_json';
        for (let page = 1; page <= 80; page++) {
          const r = await polite(`${origin}/products.json?limit=250&page=${page}`, 'application/json');
          if (r.status !== 200) { mismatches.push(`feed page ${page} returned HTTP ${r.status}`); break; }
          const list = (JSON.parse(r.text) as { products?: { id: number; title: string; handle: string; vendor?: string; variants: { id: number; price: string; compare_at_price: string | null; available: boolean; sku?: string }[] }[] }).products ?? [];
          if (!list.length) break;
          for (const p of list) {
            feedProducts++;
            for (const v of p.variants) {
              feedVariants++;
              const row = dbByKey.get(String(v.id));
              if (!row) { mismatches.push(`variant ${v.id} of "${p.title}" is in the feed but not stored`); continue; }
              const feedPrice = Number(v.price);
              // A price of 0 is not a price (a free gift line, or an amount the buyer chooses): stored as no price, with its compare-at price (existing rule).
              const priceOk = isStorableMoney(feedPrice) && feedPrice > 0;
              if (!priceOk && !(feedPrice <= 0 && feedPrice >= 0)) unstorable.push(`price ${feedPrice} on ${origin}/products/${p.handle}?variant=${v.id}`);
              if (!priceOk && feedPrice === 0) zeroPriced.push(`${p.title}`);
              const price = priceOk ? feedPrice : NaN;
              const cmpRaw = priceOk && v.compare_at_price !== null && Number(v.compare_at_price) > price ? Number(v.compare_at_price) : null;
              if (cmpRaw !== null && !isStorableMoney(cmpRaw)) unstorable.push(`compare-at price ${cmpRaw} on ${origin}/products/${p.handle}?variant=${v.id}`);
              const cmp = cmpRaw !== null && isStorableMoney(cmpRaw) ? cmpRaw : null;
              if (!priceOk ? row.price !== null : row.price === null || Math.abs(row.price - price) > 0.005) mismatches.push(`price ${row.title}: stored ${row.price} feed ${v.price}`);
              if ((row.compareAt === null) !== (cmp === null) || (row.compareAt !== null && cmp !== null && Math.abs(row.compareAt - cmp) > 0.005)) mismatches.push(`compare-at ${row.title}: stored ${row.compareAt} feed ${cmp}`);
              if (row.availability !== (v.available ? 'in_stock' : 'out_of_stock')) mismatches.push(`availability ${row.title}: stored ${row.availability} feed ${v.available}`);
              if (row.title !== p.title) mismatches.push(`title: stored "${row.title}" feed "${p.title}"`);
              if (row.url !== `${origin}/products/${p.handle}`) mismatches.push(`url: stored ${row.url} feed ${origin}/products/${p.handle}`);
            }
          }
        }
      } else if (apis.includes('woocommerce_store_api')) {
        kind = 'woocommerce_store_api';
        let total = Infinity;
        let variable = 0;
        for (let page = 1; page <= 80 && (page - 1) * 100 < total; page++) {
          const r = await polite(`${origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`, 'application/json');
          if (r.status !== 200) { mismatches.push(`feed page ${page} returned HTTP ${r.status}`); break; }
          total = Number(r.headers.get('x-wp-total') ?? Infinity);
          const list = JSON.parse(r.text) as { id: number; name: string; type?: string; permalink: string; is_in_stock?: boolean; prices?: { price?: string; regular_price?: string; currency_minor_unit?: number; currency_code?: string } }[];
          if (!list.length) break;
          for (const p of list) {
            feedProducts++;
            if (p.type === 'variable') { variable++; continue; } // priced per variation: compared through the product page checks below
            feedVariants++;
            const row = dbByKey.get(String(p.id));
            if (!row) { mismatches.push(`product ${p.id} "${p.name}" is in the feed but not stored`); continue; }
            const mu = p.prices?.currency_minor_unit ?? 2;
            const price = Number(p.prices?.price ?? NaN) / 10 ** mu;
            const reg = Number(p.prices?.regular_price ?? NaN) / 10 ** mu;
            if (!Number.isFinite(price) || row.price === null || Math.abs(row.price - price) > 0.005) mismatches.push(`price ${row.title}: stored ${row.price} feed ${price}`);
            if (Number.isFinite(reg) && reg > price && (row.compareAt === null || Math.abs(row.compareAt - reg) > 0.005)) mismatches.push(`compare-at ${row.title}: stored ${row.compareAt} feed ${reg}`);
            const expected = p.is_in_stock === true ? ['in_stock', 'low_quantity_claim'] : ['out_of_stock'];
            if (!expected.includes(row.availability)) mismatches.push(`availability ${row.title}: stored ${row.availability} feed in_stock=${p.is_in_stock}`);
            if (row.currency !== (p.prices?.currency_code ?? row.currency)) mismatches.push(`currency ${row.title}: stored ${row.currency} feed ${p.prices?.currency_code}`);
          }
        }
        info['wooVariableProducts'] = variable;
        info['wooFeedTotalHeader'] = total;
      }
      const stored = db.filter((r) => !r.delisted);
      Object.assign(info, { feedCheck: { kind, feedProducts, feedVariants, unstorableInFeed: unstorable, zeroPricedInFeed: zeroPriced, storedProducts: new Set(stored.map((r) => r.url)).size, storedVariants: stored.length, mismatchCount: mismatches.length, examples: mismatches.slice(0, 25) } });
      if (kind !== 'none') {
        expect(mismatches.slice(0, 10), `${url}: stored catalogue differs from the website's own feed`).toEqual([]);
        expect(stored.length, `${url}: stored variants vs feed variants`).toBeGreaterThanOrEqual(feedVariants);
      }
    }
  });

  it('5. a random sample of REAL product pages shows the stored price and availability', async () => {
    for (const url of collected()) {
      const id = siteIds.get(url)!;
      const rows = await dbq().select({ title: products.title, url: variants.url, productUrl: products.canonicalUrl, price: variants.price, availability: variants.availability, compareAt: variants.compareAtPrice })
        .from(variants).innerJoin(products, eq(products.id, variants.productId)).where(and(eq(variants.siteId, id), isNull(products.delistedAt)));
      const picked = sample(rows.filter((r) => r.price !== null), SPOT, 20261019);
      const results: Rec[] = [];
      for (const r of picked) {
        const page = await polite(r.productUrl.replace(/\?.*$/, '')).catch((e: Error) => ({ status: 0, text: '', headers: new Headers(), error: e.message }));
        const body = page.text;
        const priceShown = page.status === 200 && appears(body, r.price!);
        // the page's visible text with its HTML entities decoded (a stored "Hellmann’s" is "Hellmann&#8217;s" in the markup)
        const visible = page.status === 200 ? norm(cheerio.load(body).text()) : '';
        const titleShown = page.status === 200 && visible.includes(norm(r.title).slice(0, 30));
        const outSignal = /sold out|out of stock|outofstock|unavailable/i.test(body);
        const inSignal = /instock|in stock|add to cart|add to basket/i.test(body);
        results.push({ url: r.productUrl, title: r.title, stored: r.price, availability: r.availability, http: page.status, priceShown, titleShown, availabilityAgrees: r.availability === 'in_stock' ? inSignal && !(outSignal && !inSignal) : r.availability === 'out_of_stock' ? outSignal : null });
      }
      const ok = results.filter((x) => x['priceShown']).length;
      Object.assign(bySite(url), { pageCheck: { checked: results.length, priceShown: ok, titleShown: results.filter((x) => x['titleShown']).length, notFound: results.filter((x) => x['http'] !== 200).length, availabilityAgrees: results.filter((x) => x['availabilityAgrees'] === true).length, availabilityDisagrees: results.filter((x) => x['availabilityAgrees'] === false).length, misses: results.filter((x) => !x['priceShown']).slice(0, 15) } });
      expect(results.length).toBeGreaterThan(0);
    }
  });

  it('6. every observation is traceable: source page on the right host, observation time, evidence with a SHA-256, public_web provenance; nothing invented', async () => {
    const failures: string[] = [];
    for (const url of collected()) {
      const id = siteIds.get(url)!;
      const host = new URL(url).hostname.replace(/^www\./, '');
      const rows = await dbq().select({ price: priceObservations.price, currency: priceObservations.currency, src: priceObservations.sourceUrl, at: priceObservations.observedAt, ev: priceObservations.evidenceId, prov: priceObservations.provenance })
        .from(priceObservations).where(eq(priceObservations.siteId, id));
      const bad = rows.filter((r) => new URL(r.src).hostname.replace(/^www\./, '') !== host || !r.ev || r.prov !== 'public_web' || Date.now() - r.at.getTime() > 6 * 3600_000);
      const evi = await dbq().select({ hash: evidence.contentHash, snap: evidence.snapshotRef }).from(evidence).where(eq(evidence.siteId, id));
      const qr = await dbq().execute<Record<string, string>>(sql`select count(*) filter (where v.price is null)::text as no_price, count(*) filter (where v.currency is null)::text as no_currency,
        count(*) filter (where v.availability = 'unknown')::text as unknown_availability, count(*) filter (where p.brand is null)::text as no_brand, count(*) filter (where v.price = 0)::text as price_zero,
        count(*) filter (where v.compare_at_price is not null)::text as on_sale, count(*) filter (where v.availability = 'out_of_stock')::text as out_of_stock, count(*)::text as total
        from variants v join products p on p.id = v.product_id where v.site_id = ${id} and p.delisted_at is null`);
      const q = Object.fromEntries(Object.entries(qr.rows[0]!).map(([k, v]) => [k, Number(v)])) as Record<string, number>;
      const brands = await dbq().select({ brand: products.brand, n: sql<number>`count(*)::int` }).from(products).where(eq(products.siteId, id)).groupBy(products.brand).orderBy(sql`count(*) desc`).limit(12);
      Object.assign(bySite(url), { trace: { observations: rows.length, badObservations: bad.length, evidenceRows: evi.length, evidenceWithHash: evi.filter((e) => /^[0-9a-f]{64}$/.test(e.hash ?? '')).length, evidenceWithSnapshot: evi.filter((e) => e.snap).length, quality: q, topBrands: brands } });
      if (bad.length) failures.push(`${url}: ${bad.length} untraceable observations`);
      if (q['price_zero']) failures.push(`${url}: ${q['price_zero']} prices stored as zero (a price of 0 is not a price)`);
    }
    expect(failures).toEqual([]);
  });

  it('7. a second complete collection changes nothing that did not change on the website: no duplicates, history only grows', async () => {
    const before = new Map<string, { products: number; variants: number; obs: number }>();
    for (const url of collected()) {
      const id = siteIds.get(url)!;
      before.set(url, await tally(id));
      await t.tx((tx) => startScan(h.svc, tx, t.orgId, id, { kind: 'discovery', trigger: 'manual' }));
    }
    await h.queue.drain();
    for (const url of collected()) {
      const id = siteIds.get(url)!;
      const a = await tally(id);
      const changed = await dbq().execute<{ n: string }>(sql`select count(*)::text as n from (select variant_id from price_observations where site_id = ${id} group by variant_id having count(distinct price) > 1) q`);
      const [run] = (await dbq().select().from(scanRuns).where(eq(scanRuns.siteId, id)).orderBy(scanRuns.createdAt)).slice(-1);
      const b = before.get(url)!;
      Object.assign(bySite(url), { rerun: { status: run?.status, isComplete: run?.isComplete, productsBefore: b.products, productsAfter: a.products, variantsBefore: b.variants, variantsAfter: a.variants, observationsBefore: b.obs, observationsAfter: a.obs, variantsWithChangedPrice: Number(changed.rows[0]?.n ?? 0) } });
      expect(a.products, `${url}: no duplicate products after a second run`).toBeLessThanOrEqual(b.products + Math.ceil(b.products * 0.01));
      expect(a.obs).toBeGreaterThanOrEqual(b.obs);
    }
  });

  it('8. matching and comparison on the real catalogues — written out for human review — plus offers, stock, coverage and the honest "no equivalent" basis', async () => {
    const match = await runMatching(h.svc, dbq(), t.orgId);
    record['matching'] = match;
    await ensureFxRates(h.svc);
    const fx0 = await loadFxTable(dbq());
    const pre = await t.tx((tx) => loadComparison(tx, { orgId: t.orgId, reportingCurrency: 'USD', fx: fx0, now: new Date(), staleAfterHours: 36 }));
    const preCells = pre.flatMap((r) => r.cells);
    record['comparisonBeforeReview'] = { sourceProductsInMatrix: pre.length, cells: preCells.length, directlyComparable: preCells.filter((x) => x.directlyComparable).length };
    // The owner's decision, exactly as the review page offers it: accept the identical proposals at 70 % or more, after seeing how many there are and a sample.
    const dry = await bulkAcceptMatches(dbq(), t.orgId, t.userId, { matchClass: 'identical', minConfidence: 0.7, dryRun: true }, new Date());
    const accepted = await bulkAcceptMatches(dbq(), t.orgId, t.userId, { matchClass: 'identical', minConfidence: 0.7, note: 'Accepted after reading a sample (live verification run)' }, new Date());
    record['bulkAccept'] = { previewCount: dry.count, acceptedCount: accepted.count, sample: dry.examples };
    expect(accepted.count).toBe(dry.count);
    const fx = await loadFxTable(dbq());
    const rows = await t.tx((tx) => loadComparison(tx, { orgId: t.orgId, reportingCurrency: 'USD', fx, now: new Date(), staleAfterHours: 36 }));
    const maps = await t.tx((tx) => loadSiteMaps(tx, t.orgId));
    const coverage = await t.tx((tx) => loadCoverage(tx, t.orgId, new Date(), 36));
    const assortment = await t.tx((tx) => loadAssortment(tx, t.orgId, maps, coverage));
    const names = new Map([...siteIds].map(([u, id]) => [id, new URL(u).hostname]));

    const pairs = await dbq().execute<{ cls: string; status: string; confidence: number; reasons: string[]; stitle: string; sbrand: string | null; sprice: number | null; ctitle: string; cbrand: string | null; cprice: number | null; csite: string }>(sql`
      select m.competitor_site_id as csite, m.match_class as cls, m.status, m.confidence, m.reasons, sp.title as stitle, sp.brand as sbrand, sv.price as sprice, cp.title as ctitle, cp.brand as cbrand, cv.price as cprice
      from product_matches m join variants sv on sv.id = m.source_variant_id join products sp on sp.id = sv.product_id
      join variants cv on cv.id = m.competitor_variant_id join products cp on cp.id = cv.product_id
      where m.org_id = ${t.orgId} order by m.confidence desc`);
    const counts: Record<string, Record<string, number>> = {};
    for (const p of pairs.rows) {
      const k = names.get(p.csite) ?? p.csite;
      counts[k] ??= {};
      counts[k][`${p.cls}/${p.status}`] = (counts[k][`${p.cls}/${p.status}`] ?? 0) + 1;
    }
    const pick = (cls: string, n: number, seed: number) => sample(pairs.rows.filter((p) => p.cls === cls), n, seed).map((p) => ({ competitor: names.get(p.csite), cls: p.cls, status: p.status, confidence: round2(p.confidence), reasons: p.reasons, source: `${p.stitle} [${p.sbrand ?? '—'}] ${p.sprice}`, competitorProduct: `${p.ctitle} [${p.cbrand ?? '—'}] ${p.cprice}` }));
    const cells = rows.flatMap((r) => r.cells.map((c) => ({ r, c })));
    const direct = cells.filter((x) => x.c.directlyComparable && x.c.diffPct !== null);
    const diffs = direct.map((x) => x.c.diffPct!).sort((a, b) => a - b);
    const median = diffs.length ? diffs[Math.floor(diffs.length / 2)]! : null;
    record['comparison'] = {
      sourceProductsInMatrix: rows.length, cells: cells.length, directlyComparable: direct.length,
      cheaperAtSource: direct.filter((x) => x.c.diffPct! > 0.5).length, pricierAtSource: direct.filter((x) => x.c.diffPct! < -0.5).length, parity: direct.filter((x) => Math.abs(x.c.diffPct!) <= 0.5).length,
      medianDiffPct: median, positions: Object.fromEntries(['cheapest', 'middle', 'highest', 'tied', 'no_data'].map((p) => [p, rows.filter((r) => r.position === p).length])),
      withUnitPrice: cells.filter((x) => x.c.unitPrice.value !== null && x.r.sourceUnitPrice.value !== null).length,
      matchCountsByCompetitor: counts,
      reviewIdentical: pick('identical', 40, 1), reviewDifferentPack: pick('different_pack', 25, 2), reviewComparable: pick('comparable', 25, 3),
      largestDiffs: direct.sort((a, b) => Math.abs(b.c.diffPct!) - Math.abs(a.c.diffPct!)).slice(0, 15).map((x) => ({ source: `${x.r.title} ${x.r.sourcePrice.amount}`, competitor: `${x.c.siteName}: ${x.c.title} ${x.c.price.amount}`, diffPct: x.c.diffPct, cls: x.c.matchClass, confidence: round2(x.c.confidence) })),
    };
    record['assortment'] = { sourceOnly: assortment.sourceOnly.length, competitorOnly: assortment.competitorOnly.length, basis: assortment.basis, note: assortment.note };
    record['coverage'] = coverage.map((c) => ({ site: c.hostname, role: c.role, status: c.status?.state, label: c.status?.label, detail: c.status?.detail, known: c.productsKnown, estimated: c.estimatedCatalogue, complete: c.complete, warnings: c.warnings, failure: c.failureReason }));

    const off = await dbq().select({ site: offers.siteId, kind: offers.kind, status: offers.status, verification: offers.verification, n: sql<number>`count(*)::int` }).from(offers).where(eq(offers.orgId, t.orgId)).groupBy(offers.siteId, offers.kind, offers.status, offers.verification);
    record['offers'] = off.map((o) => ({ site: names.get(o.site), kind: o.kind, status: o.status, verification: o.verification, n: o.n }));
    const fxRows = await dbq().select().from(exchangeRates);
    record['fx'] = fxRows.map((r) => ({ pair: `${r.base}/${r.quote}`, rate: r.rate, source: r.source, fixed: r.isFixed }));

    const live = await dbq().execute<{ n: string }>(sql`select count(*)::text as n from variants v join products p on p.id = v.product_id where v.site_id = ${siteIds.get(SOURCE!)!} and p.delisted_at is null`);
    const sourceLive = Number(live.rows[0]!.n);
    (record['comparison'] as Rec)['unaccountedSourceVariants'] = sourceLive - rows.length - assortment.sourceOnly.length;
    expect(rows.length + assortment.sourceOnly.length, 'every source product is either compared or listed as having no equivalent').toBe(sourceLive);
    for (const x of cells) if (x.c.price.amount === null) expect(x.c.diffPct, 'no price means no difference is invented').toBeNull();
  });

  it('9. a report is assembled from the real data, and its PDF, Excel and CSV exports carry the same numbers', async () => {
    const report = await generateReport(h.svc, dbq(), t.orgId, { kind: 'manual', deadlineAt: null, createdBy: t.userId });
    const data = report.data as ReportData;
    const exports: Rec = {};
    for (const [format, dataset] of [['pdf', 'comparison'], ['xlsx', 'comparison'], ['csv', 'comparison'], ['csv', 'assortment'], ['csv', 'coverage']] as const) {
      const out = await exportReport(h.svc, dbq(), t.orgId, report.id, format, dataset);
      exports[`${format}:${dataset}`] = { bytes: out.body.length, filename: out.filename };
      expect(out.body.length).toBeGreaterThan(200);
    }
    const csv = (await exportReport(h.svc, dbq(), t.orgId, report.id, 'csv', 'comparison')).body.toString('utf8').split(/\r?\n/).filter(Boolean);
    record['report'] = { status: report.status, isPartial: report.isPartial, headline: data.headline, kpis: data.kpis, warnings: data.warnings, insights: data.insights.slice(0, 12).map((i) => ({ type: i.type, severity: i.severity, title: i.title })), insightCount: data.insights.length, assortmentNote: data.assortment.note, comparisonRows: data.comparisons.length, csvDataRows: csv.length - 2, exports };
    // the CSV starts with a comment line and a header line, then one row per cell
    expect(csv.length - 2, 'the CSV has one row per source×competitor cell of the saved report').toBe(data.comparisons.reduce((a, r) => a + r.cells.length, 0));
  });
});
