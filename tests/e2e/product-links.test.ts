import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { productMatches, sites, variants } from '@ci/database';
import type { ComparisonRow, ReportData } from '@ci/shared';
import { comparisonTable, ensureFxRates, generateReport, loadComparison, loadFxTable, runMatching, startScan } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';

/**
 * Directive 11: a customer can click a price card in the Price Comparison and open that exact product on the website it came from.
 * These tests follow the real chain: website → collection → stored variant URL → matching → comparison → saved report. Nothing here
 * builds a URL: every expectation is read from the fixture shop's own product (handle and origin) or from what collection stored.
 */
let h: Harness;
let t: Tenant;
const ids: Record<string, string> = {};
const db = () => h.db.worker;

const compare = async (): Promise<ComparisonRow[]> => {
  await ensureFxRates(h.svc);
  return loadComparison(db(), { orgId: t.orgId, reportingCurrency: 'USD', fx: await loadFxTable(db()), now: h.svc.clock(), staleAfterHours: 36 });
};
const scan = async (key: string) => {
  await t.tx((tx) => startScan(h.svc, tx, t.orgId, ids[key]!, { kind: 'discovery', trigger: 'manual' }));
  await h.queue.drain();
};
/** The comparison with every link field blanked: what must stay the same whatever happens to the links. */
const withoutLinks = (rows: ComparisonRow[]) =>
  rows.map((r) => ({
    ...r,
    url: null,
    sourcePrice: { ...r.sourcePrice, sourceUrl: null },
    cells: r.cells.map((c) => ({ ...c, url: null, price: { ...c.price, sourceUrl: null } })),
  }));
const hostOf = (url: string) => new URL(url).hostname;

beforeAll(async () => {
  h = await createHarness();
  t = await h.newTenant('Links');
  ids.source = await t.addFixtureSite('source', 'source');
  for (const k of ['woo', 'jsonld', 'html']) ids[k] = await t.addFixtureSite(k, 'competitor');
  for (const k of Object.keys(ids)) await t.tx((tx) => startScan(h.svc, tx, t.orgId, ids[k]!, { kind: 'discovery', trigger: 'manual' }));
  await h.queue.drain();
  await runMatching(h.svc, db(), t.orgId);
}, 120_000);

afterAll(async () => {
  await h.close();
});

describe('where each product’s page address comes from', () => {
  it('the collection stored a page address for every product, on the product’s own website', async () => {
    const rows = await db().select({ url: variants.url, host: sites.hostname }).from(variants).innerJoin(sites, eq(sites.id, variants.siteId)).where(eq(sites.orgId, t.orgId));
    expect(rows.length).toBeGreaterThan(100);
    for (const r of rows) {
      expect(hostOf(r.url), r.url).toBe(r.host);
      expect(new URL(r.url).pathname.length, `${r.url} is not the website's front page`).toBeGreaterThan(1);
    }
  });
});

describe('the Price Comparison links each card to that product’s own page', () => {
  it('links your product and every competitor’s product to a different page, each on its own website', async () => {
    const cmp = await compare();
    const row = cmp.find((r) => r.title === 'Heinz Tomato Ketchup 397g')!;
    expect(row.cells.length).toBeGreaterThanOrEqual(2);

    // What the shops themselves publish for this product, read from the fixture shops (not from Shelfwatch's database).
    const own = h.fixtures.sites.source!.find(9)!;
    const woo = h.fixtures.sites.woo!.find(9)!;
    const ld = h.fixtures.sites.jsonld!.find(9)!;
    expect(row.url!.startsWith(`${h.fixtures.origin('source')}/products/${own.handle}`)).toBe(true);
    // (collection stores the canonical form of a WooCommerce permalink, without the trailing slash; the shop serves the same page)
    expect(row.cells.find((c) => c.siteName.includes('Mart'))!.url).toBe(`${h.fixtures.origin('woo')}/product/${woo.handle}`);
    expect(row.cells.find((c) => c.siteName.includes('Superstore'))!.url).toBe(`${h.fixtures.origin('jsonld')}/p/${ld.handle}`);

    const urls = [row.url, ...row.cells.map((c) => c.url)];
    expect(urls.every((u) => typeof u === 'string')).toBe(true);
    expect(new Set(urls).size, 'one distinct page per website').toBe(urls.length);
    expect(new Set(urls.map((u) => hostOf(u!))).size).toBe(urls.length);
  });

  it('never repeats one competitor’s page under another, and never links a front page', async () => {
    const cmp = await compare();
    const siteHosts = new Map((await db().select().from(sites).where(eq(sites.orgId, t.orgId))).map((s) => [s.name, s.hostname]));
    expect(cmp.length).toBeGreaterThan(15);
    for (const r of cmp) {
      const urls = [r.url, ...r.cells.map((c) => c.url)].filter(Boolean);
      expect(new Set(urls).size, r.title).toBe(urls.length);
      for (const c of r.cells) {
        expect(c.url, `${r.title} @ ${c.siteName}`).toBeTruthy();
        expect(hostOf(c.url!)).toBe(siteHosts.get(c.siteName));
        expect(new URL(c.url!).pathname.length).toBeGreaterThan(1);
      }
    }
  });

  it('shows exactly the page the price was collected from (the stored address, unchanged)', async () => {
    const cmp = await compare();
    const stored = new Map<string, string>();
    const wanted = [...new Set(cmp.flatMap((r) => [r.sourceVariantId, ...r.cells.map((c) => c.variantId)]))];
    for (const r of await db().select({ id: variants.id, url: variants.url }).from(variants).where(inArray(variants.id, wanted))) stored.set(r.id, r.url);
    for (const r of cmp) {
      expect(r.url).toBe(stored.get(r.sourceVariantId));
      expect(r.sourcePrice.sourceUrl).toBe(r.url);
      for (const c of r.cells) {
        expect(c.url).toBe(stored.get(c.variantId));
        expect(c.price.sourceUrl).toBe(c.url);
      }
    }
  });

  it('keeps a link on a different package size, to that size’s own page', async () => {
    const cmp = await compare();
    const packs = cmp.flatMap((r) => r.cells.filter((c) => c.matchClass === 'different_pack').map((c) => ({ r, c })));
    expect(packs.length).toBeGreaterThan(0);
    for (const { r, c } of packs) {
      expect(c.url, c.title).toBeTruthy();
      expect(c.url).not.toBe(r.url);
      expect(c.directlyComparable).toBe(false); // the link does not change how a pack-size difference is judged
    }
  });
});

describe('a missing, damaged or foreign address is never shown as a link', () => {
  it('shows no link for it, invents none, and changes nothing else in the comparison', async () => {
    const before = await compare();
    const matchesBefore = await db().select().from(productMatches).where(eq(productMatches.orgId, t.orgId));
    const row = before.find((r) => r.title === 'Heinz Tomato Ketchup 397g')!;
    const woo = row.cells.find((c) => c.siteName.includes('Mart'))!;
    const original = { source: row.url!, woo: woo.url! };

    const damaged = [
      '', // nothing stored
      '   ',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'ftp://rival-wc.test/product/x/',
      'not a web address',
      '/product/relative-only/',
      'http://someone:secret@rival-wc.test/product/x/', // a password inside the address
      'http://rival-wc.test/', // the shop's front page, not a product
      'https://other-shop.test/product/x/', // another website's page
      'http://rival-wc.test/product/with space/', // a damaged value
    ];
    for (const bad of damaged) {
      await db().update(variants).set({ url: bad }).where(eq(variants.id, woo.variantId));
      const after = await compare();
      const cell = after.find((r) => r.sourceVariantId === row.sourceVariantId)!.cells.find((c) => c.variantId === woo.variantId)!;
      expect(cell.url, JSON.stringify(bad)).toBeNull();
      expect(cell.price.sourceUrl, JSON.stringify(bad)).toBeNull();
      // the other competitors keep their own pages: nothing is borrowed to fill the gap
      const others = after.find((r) => r.sourceVariantId === row.sourceVariantId)!.cells.filter((c) => c.variantId !== woo.variantId);
      expect(others.every((c) => c.url && !c.url.includes('rival-wc.test'))).toBe(true);
      // prices, differences, availability, match classes and ranking are exactly as before
      expect(withoutLinks(after)).toEqual(withoutLinks(before));
    }

    // your own product's address can be missing too
    await db().update(variants).set({ url: 'http://mine.test/' }).where(eq(variants.id, row.sourceVariantId));
    const noOwn = await compare();
    expect(noOwn.find((r) => r.sourceVariantId === row.sourceVariantId)!.url).toBeNull();
    expect(withoutLinks(noOwn)).toEqual(withoutLinks(before));

    await db().update(variants).set({ url: original.woo }).where(eq(variants.id, woo.variantId));
    await db().update(variants).set({ url: original.source }).where(eq(variants.id, row.sourceVariantId));
    expect(await compare()).toEqual(before);
    expect(await db().select().from(productMatches).where(eq(productMatches.orgId, t.orgId))).toEqual(matchesBefore);
  });
});

describe('links survive new collections and saved reports', () => {
  it('a new collection keeps the links while the price moves', async () => {
    const before = await compare();
    const row = before.find((r) => r.title === 'Heinz Tomato Ketchup 397g')!;
    const wooCell = row.cells.find((c) => c.siteName.includes('Mart'))!;
    const fixture = h.fixtures.sites.woo!.find(9)!;
    const old = fixture.price;
    h.fixtures.sites.woo!.setPrice(fixture.itemId, old + 1);
    h.advance(24 * 3_600_000);
    await scan('woo');
    try {
      const after = await compare();
      const r2 = after.find((r) => r.sourceVariantId === row.sourceVariantId)!;
      const c2 = r2.cells.find((c) => c.variantId === wooCell.variantId)!;
      expect(c2.price.amount).toBeCloseTo(old + 1, 2);
      expect(c2.url).toBe(wooCell.url);
      expect(r2.url).toBe(row.url);
      expect(r2.cells.map((c) => c.url)).toEqual(row.cells.map((c) => c.url));
    } finally {
      h.fixtures.sites.woo!.setPrice(fixture.itemId, old);
      h.advance(-24 * 3_600_000);
    }
  });

  it('a saved report carries the same links on every card, and its exports stay valid when one is missing', async () => {
    const report = await generateReport(h.svc, db(), t.orgId, { kind: 'manual', deadlineAt: null, createdBy: t.userId });
    const data = report.data as ReportData;
    const live = await compare();
    expect(data.comparisons.length).toBe(live.length);
    for (const r of data.comparisons) {
      const l = live.find((x) => x.sourceVariantId === r.sourceVariantId)!;
      expect(r.url).toBe(l.url);
      expect(r.cells.map((c) => c.url)).toEqual(l.cells.map((c) => c.url));
      expect(r.url).toMatch(/^https?:\/\//);
    }
    // an old or damaged snapshot cell with no link exports an empty cell, never the word "null"
    const cloned = JSON.parse(JSON.stringify(data)) as ReportData;
    cloned.comparisons[0]!.url = null;
    cloned.comparisons[0]!.cells[0]!.url = null;
    const table = comparisonTable(cloned);
    expect(JSON.stringify(table.rows[0])).not.toMatch(/null/);
  });
});
