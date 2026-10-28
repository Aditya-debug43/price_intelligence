import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { htmlGenericConnector, profileSite, rankConnectors, shopifyConnector, structuredDataConnector, woocommerceConnector } from '@ci/connectors';
import { isValidGtin } from '@ci/core';
import { startFixtureServer, type FixtureServer } from '../support/fixtures/server.ts';
import { fixtureFetcher, testContext } from '../support/net.ts';

let fx: FixtureServer;
beforeAll(async () => {
  fx = await startFixtureServer();
});
afterAll(async () => {
  await fx.close();
});

const profile = async (key: string, caps = { browserEnabled: false, aiEnabled: false }) => {
  const fetcher = fixtureFetcher(fx);
  return profileSite(fx.origin(key), { fetcher, capabilities: caps, defaultCrawlDelayMs: 0, defaultMaxRequests: 2000 });
};

describe('site profiler against fixture sites (FIXTURES — not live data)', () => {
  it('Shopify-style site: Full, feed usable, currency detected, catalogue estimated from sitemap', async () => {
    const p = await profile('source');
    expect(p.status).toBe('full');
    expect(p.platform.id).toBe('shopify');
    expect(p.catalogue.publicApis[0]).toMatchObject({ kind: 'shopify_products_json', usable: true });
    expect(p.currency).toMatchObject({ detected: 'AWG', conflicting: false });
    expect(p.catalogue.estimatedProducts).toBe(32);
    expect(p.strategy.primary).toBe('shopify-products-json');
    expect(p.fields.stock_quantity.availability).toBe('missing');
    expect(p.fields.gtin.availability).toBe('missing');
    expect(p.limitations.some((l) => l.code === 'no_stock_quantity')).toBe(true);
    expect(p.social.facebook).toContain('facebook.com/fixturesource');
    expect(p.promotions.bannerTexts.join(' ')).toMatch(/Free delivery/);
  });

  it('WooCommerce-style site: Full, catalogue size from X-WP-Total, USD from the API', async () => {
    const p = await profile('woo');
    expect(p.status).toBe('full');
    expect(p.platform.id).toBe('woocommerce');
    expect(p.catalogue.publicApis[0]).toMatchObject({ kind: 'woocommerce_store_api', usable: true, total: fx.sites.woo!.products.length });
    expect(p.currency.detected).toBe('USD');
    expect(p.fields.stock_quantity.availability).toBe('partial');
    expect(p.strategy.primary).toBe('woocommerce-store-api');
  });

  it('JSON-LD site: structured prices, sitemap index, flyer and social links discovered', async () => {
    const p = await profile('jsonld');
    expect(p.status).toBe('full');
    expect(p.platform.id).toBe('unknown');
    expect(p.currency.detected).toBe('AWG');
    expect(p.catalogue.sitemaps.some((s) => s.kind === 'index')).toBe(true);
    expect(p.catalogue.estimatedProducts).toBe(fx.sites.jsonld!.products.length);
    expect(p.fields.price.availability).toBe('available');
    expect(p.fields.gtin.coverage).toBeGreaterThan(0);
    expect(p.promotions.flyerLinks.some((l) => l.endsWith('weekly-specials.pdf'))).toBe(true);
    expect(p.promotions.couponMentions).toContain('FRESH10');
    expect(p.social.youtube).toContain('@fixturejsonld');
    expect(p.social.facebook).toContain('facebook.com/fixturejsonld'); // not the sharer link
    expect(p.strategy.primary).toBe('sitemap-structured-data');
  });

  it('plain-HTML site: only Partial (heuristic extraction), with a plain-language reason', async () => {
    const p = await profile('html');
    expect(p.status).toBe('partial');
    expect(p.fields.price.availability).not.toBe('missing');
    expect(p.summary).toMatch(/Partial access/);
    expect(p.strategy.recommended).toContain('html-generic');
  });

  it('robots.txt that disallows everything → Blocked, and no product page is requested', async () => {
    const p = await profile('blocked');
    expect(p.status).toBe('blocked');
    expect(p.limitations[0]!.code).toBe('robots_disallow');
    expect(fx.sites.blocked!.requests.filter((r) => r.path !== '/robots.txt')).toEqual([]);
  });

  it('bot-protection challenge → Blocked; we never try to get around it', async () => {
    const p = await profile('challenge');
    expect(p.status).toBe('blocked');
    expect(p.access.challengeDetected).toBe(true);
    expect(p.access.challengeKind).toBe('Cloudflare challenge');
    expect(p.summary).toMatch(/respect/i);
  });

  it('HTTP 500 → Failed (a technical error), never an empty catalogue', async () => {
    const p = await profile('failing');
    expect(p.status).toBe('failed');
    expect(p.catalogue.estimatedProducts).toBeNull();
    expect(p.summary).toMatch(/not an empty catalogue|temporary technical/i);
  });

  it('JavaScript-only site without browser rendering → Limited, with the reason', async () => {
    const p = await profile('jsrender');
    expect(p.status).toBe('limited');
    expect(p.rendering.requiresJavaScript).toBe(true);
    expect(p.limitations.some((l) => l.code === 'js_required')).toBe(true);
  });

  it('login-gated site → Blocked; we never log in', async () => {
    const p = await profile('login');
    expect(p.status).toBe('blocked');
    expect(p.access.loginRequired).toBe(true);
  });

  it('refuses private/internal targets without making any request', async () => {
    const fetcher = fixtureFetcher(fx);
    const p = await profileSite('http://169.254.169.254/', { fetcher, capabilities: { browserEnabled: false, aiEnabled: false }, defaultCrawlDelayMs: 0, defaultMaxRequests: 100 });
    expect(p.status).toBe('blocked');
    expect(p.limitations[0]!.code).toBe('unsafe_address');
    expect(fetcher.requestLog).toEqual([]);
  });

  it('rejects malformed input as a failed profile (not a crash)', async () => {
    const p = await profileSite('ftp://example.com', { fetcher: fixtureFetcher(fx), capabilities: { browserEnabled: false, aiEnabled: false }, defaultCrawlDelayMs: 0, defaultMaxRequests: 100 });
    expect(p.status).toBe('failed');
    expect(p.limitations[0]!.code).toBe('invalid_url');
  });

  it('ranks connectors from the profile and hides ones that cannot run', async () => {
    const js = await profile('jsrender');
    expect(rankConnectors(js, { browserEnabled: false, aiEnabled: false }).map((r) => r.id)).not.toContain('browser-rendered');
    expect(rankConnectors(js, { browserEnabled: true, aiEnabled: false })[0]!.id).toBe('browser-rendered');
  });
});

describe('Shopify products.json connector', () => {
  it('maps products, variants, prices, compare-at and public availability; never invents quantities', async () => {
    const fetcher = fixtureFetcher(fx);
    const ctx = testContext(fetcher, fx.origin('source'), { siteCurrency: 'AWG' });
    const batch = await shopifyConnector.fetchPage(ctx, null);
    expect(batch.done).toBe(true);
    expect(batch.products).toHaveLength(32);
    const sale = batch.products.find((p) => p.title.includes('Sprite'))!;
    const v = sale.variants[0]!;
    expect(v.price).toBe(fx.sites.source!.find(3)!.price);
    expect(v.compareAtPrice).toBeGreaterThan(v.price!);
    expect(v.currency).toBe('AWG');
    expect(v.quantity).toBeNull();
    expect(v.quantitySource).toBeNull();
    expect(batch.products.find((p) => p.title.includes('Fanta'))!.variants[0]!.availability).toBe('out_of_stock');
    expect(sale.method).toBe('shopify_products_json');
    expect(sale.url).toContain('/products/');
  });

  it('paginates and resumes from a cursor; a mid-catalogue failure surfaces as an error, not an empty catalogue', async () => {
    const fetcher = fixtureFetcher(fx);
    const ctx = testContext(fetcher, fx.origin('flaky'), { siteCurrency: 'AWG' });
    fx.sites.flaky!.failFeedFromPage = 3;
    const p1 = await shopifyConnector.fetchPage(ctx, null);
    expect(p1.products).toHaveLength(250);
    expect(p1.done).toBe(false);
    expect(p1.cursor).toEqual({ page: 2 });
    const p2 = await shopifyConnector.fetchPage(ctx, p1.cursor);
    expect(p2.products).toHaveLength(250);
    await expect(shopifyConnector.fetchPage(ctx, p2.cursor)).rejects.toMatchObject({ code: 'temporarily_unavailable', status: 503 });
    // site recovers; resuming from the saved cursor finishes the catalogue
    fx.sites.flaky!.failFeedFromPage = null;
    const p3 = await shopifyConnector.fetchPage(ctx, p2.cursor);
    expect(p3.products).toHaveLength(100);
    expect(p3.done).toBe(true);
  });

  it('records a null currency (with a note) when none is known — it does not assume USD', async () => {
    const ctx = testContext(fixtureFetcher(fx), fx.origin('source'), { siteCurrency: null });
    const batch = await shopifyConnector.fetchPage(ctx, null);
    expect(batch.products[0]!.variants[0]!.currency).toBeNull();
    expect(batch.products[0]!.quality.notes.join(' ')).toMatch(/currency/);
  });

  it('refreshes specific products by URL', async () => {
    const ctx = testContext(fixtureFetcher(fx), fx.origin('source'), { siteCurrency: 'AWG' });
    const target = fx.sites.source!.products[0]!;
    fx.sites.source!.setPrice(target.itemId, 99.5);
    const r = await shopifyConnector.refresh(ctx, [`${fx.origin('source')}/products/${target.handle}`, `${fx.origin('source')}/products/does-not-exist`]);
    expect(r.products).toHaveLength(1);
    expect(r.products[0]!.variants[0]!.price).toBe(99.5);
    expect(r.warnings.join(' ')).toMatch(/404|delisted/);
  });
});

describe('WooCommerce Store API connector', () => {
  it('converts minor units, keeps the API currency, and reads explicit low-stock claims', async () => {
    const ctx = testContext(fixtureFetcher(fx), fx.origin('woo'));
    const batch = await woocommerceConnector.fetchPage(ctx, null);
    expect(batch.done).toBe(true);
    expect(batch.progress.estimatedTotal).toBe(fx.sites.woo!.products.length);
    const heineken = batch.products.find((p) => p.title.includes('Heineken'))!;
    expect(heineken.variants[0]).toMatchObject({ quantity: 3, quantitySource: 'public_claim', availability: 'low_quantity_claim', currency: 'USD' });
    expect(heineken.variants[0]!.price).toBe(fx.sites.woo!.find(5)!.price);
    const oos = batch.products.find((p) => p.title.includes('Fanta') || p.title.includes('Heineken') === false && p.variants[0]!.availability === 'out_of_stock');
    expect(oos?.variants[0]!.quantity ?? null).toBeNull();
    expect(heineken.brand).toBeNull(); // structured brand absent: matching must infer it from the title
  });

  it('expands variable products into variants via the variation query', async () => {
    const ctx = testContext(fixtureFetcher(fx), fx.origin('woo'));
    const batch = await woocommerceConnector.fetchPage(ctx, null);
    const variable = batch.products.find((p) => p.variants.length > 1)!;
    expect(variable.variants.map((v) => v.title)).toEqual(['12 x 355ml', '24 x 355ml']);
    expect(variable.variants[1]!.price).toBeGreaterThan(variable.variants[0]!.price!);
  });

  it('refreshes by slug', async () => {
    const ctx = testContext(fixtureFetcher(fx), fx.origin('woo'));
    const p = fx.sites.woo!.products[2]!;
    const r = await woocommerceConnector.refresh(ctx, [`${fx.origin('woo')}/product/${p.handle}/`]);
    expect(r.products).toHaveLength(1);
  });
});

describe('page connectors (sitemap discovery + extraction)', () => {
  it('discovers product URLs from a sitemap index, skipping page sitemaps', async () => {
    const ctx = testContext(fixtureFetcher(fx), fx.origin('jsonld'));
    const d = await structuredDataConnector.discover(ctx);
    expect(d.urls).toHaveLength(fx.sites.jsonld!.products.length);
    expect(d.urls.every((u) => u.url.includes('/p/'))).toBe(true);
    expect(d.estimatedTotal).toBe(d.urls.length);
  });

  it('extracts JSON-LD with GTIN, brand, availability (incl. limited) and currency; missing values stay null', async () => {
    const ctx = testContext(fixtureFetcher(fx), fx.origin('jsonld'));
    const site = fx.sites.jsonld!;
    const withGtin = site.products.find((p) => p.gtin)!;
    const b = await structuredDataConnector.extractPage(ctx, `${fx.origin('jsonld')}/p/${withGtin.handle}`);
    const prod = b.products[0]!;
    expect(prod.method).toBe('json_ld');
    expect(prod.variants[0]!.gtin).toBe(withGtin.gtin);
    expect(isValidGtin(prod.variants[0]!.gtin)).toBe(true);
    expect(prod.variants[0]).toMatchObject({ price: withGtin.price, currency: 'AWG' });
    expect(prod.brand).not.toBeNull();
    expect(prod.quality.score).toBeGreaterThan(0.8);
    expect(b.evidence[0]!.snippet).toContain('"@type":"Product"');

    const limited = site.products.find((p) => p.limited)!;
    const l = await structuredDataConnector.extractPage(ctx, `${fx.origin('jsonld')}/p/${limited.handle}`);
    expect(l.products[0]!.variants[0]!.availability).toBe('limited');
    expect(l.products[0]!.variants[0]!.quantity).toBeNull();

    const oos = site.products.find((p) => !p.available)!;
    const o = await structuredDataConnector.extractPage(ctx, `${fx.origin('jsonld')}/p/${oos.handle}`);
    expect(o.products[0]!.variants[0]!.availability).toBe('out_of_stock');

    const noGtin = site.products.find((p) => !p.gtin)!;
    const n = await structuredDataConnector.extractPage(ctx, `${fx.origin('jsonld')}/p/${noGtin.handle}`);
    expect(n.products[0]!.variants[0]!.gtin).toBeNull();
  });

  it('reads an explicit "Only N left" statement as a PUBLIC CLAIM, not as inventory', async () => {
    const ctx = testContext(fixtureFetcher(fx), fx.origin('html'));
    const claimed = fx.sites.html!.products.find((p) => p.claimedLeft !== null)!;
    const b = await htmlGenericConnector.extractPage(ctx, `${fx.origin('html')}/item/${claimed.handle}`);
    const v = b.products[0]!.variants[0]!;
    expect(b.products[0]!.method).toBe('html_heuristic');
    expect(v).toMatchObject({ quantity: claimed.claimedLeft, quantitySource: 'public_claim', availability: 'low_quantity_claim', currency: 'USD' });
    expect(b.products[0]!.quality.notes.join(' ')).toMatch(/heuristics/);
  });

  it('structured-only connector does not guess from layout', async () => {
    const ctx = testContext(fixtureFetcher(fx), fx.origin('html'));
    const p = fx.sites.html!.products[0]!;
    const b = await structuredDataConnector.extractPage(ctx, `${fx.origin('html')}/item/${p.handle}`);
    expect(b.products).toEqual([]);
  });

  it('extracts sale prices with compare-at and out-of-stock pages from plain HTML', async () => {
    const ctx = testContext(fixtureFetcher(fx), fx.origin('html'));
    const oos = fx.sites.html!.products[0]!;
    fx.sites.html!.setAvailability(oos.itemId, false);
    const b = await htmlGenericConnector.extractPage(ctx, `${fx.origin('html')}/item/${oos.handle}`);
    expect(b.products[0]!.variants[0]!.availability).toBe('out_of_stock');
    fx.sites.html!.setAvailability(oos.itemId, true);
  });

  it('a 404 page returns no products with a warning (delisting signal), not an error', async () => {
    const ctx = testContext(fixtureFetcher(fx), fx.origin('jsonld'));
    const b = await structuredDataConnector.extractPage(ctx, `${fx.origin('jsonld')}/p/nonexistent`);
    expect(b.products).toEqual([]);
    expect(b.warnings.join(' ')).toMatch(/404/);
  });

  it('stops with an access-denied error when a challenge page is served', async () => {
    const ctx = testContext(fixtureFetcher(fx), fx.origin('challenge'));
    await expect(structuredDataConnector.extractPage(ctx, `${fx.origin('challenge')}/p/x`)).rejects.toThrow();
  });
});
