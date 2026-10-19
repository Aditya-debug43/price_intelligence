import http from 'node:http';
import type { AddressInfo } from 'node:net';
import PDFDocument from 'pdfkit';
import type { SafeFetcherDeps } from '@ci/connectors';
import { SITE_SPECS, buildCatalogue, MASTER, type FixtureProduct, type SiteSpec } from './catalogue.ts';

/**
 * TEST-ONLY. Fictional websites with deterministic behaviour (Shopify feed, WooCommerce Store API, JSON-LD pages, plain HTML,
 * robots-blocked, bot-challenge, failing, JavaScript-only, login-gated, flaky), used by automated tests to exercise
 * blocked / partial / successful / failed outcomes without touching any real business. All data is fictional.
 *
 * This module lives under tests/ and is imported by no application, worker, script or package: it is not part of any production bundle,
 * and nothing in the product can start it. Each site has an ordinary-looking public hostname ("mine.test", "rival-woo.test"); the product's
 * normal public-host rules apply to those names (no loopback exception exists anywhere in the product), and only the final network
 * hop is replaced — `fixtures.transport` serves each hostname from the matching local listener.
 */

/** The public-looking hostname each fixture site is served under. */
export const FIXTURE_HOSTNAMES: Record<string, string> = {
  source: 'mine.test',
  woo: 'rival-woo.test',
  jsonld: 'rival-ld.test',
  html: 'rival-html.test',
  listing: 'rival-listing.test',
  vendorshop: 'rival-vendor.test',
  homegrid: 'rival-storefront.test',
  catblocked: 'rival-closed.test',
  blocked: 'rival-robots.test',
  challenge: 'rival-challenge.test',
  failing: 'rival-down.test',
  jsrender: 'rival-spa.test',
  login: 'rival-login.test',
  flaky: 'rival-flaky.test',
};
/** What the test DNS stub answers for every fixture hostname: a public (documentation-range-adjacent) address, so the normal host screening passes. */
export const FIXTURE_PUBLIC_ADDRESS = '93.184.216.34';

export type FixtureMode = 'ok' | 'http500' | 'http403';

export interface FixtureSiteHandle {
  key: string;
  spec: SiteSpec;
  /** The real local listening port (the product never sees it). */
  port: number;
  /** The public origin the product uses, e.g. http://mine.test */
  origin: string;
  /** The public hostname — how the platform identifies the site. */
  host: string;
  products: FixtureProduct[];
  mode: FixtureMode;
  /** Shopify-style feed returns HTTP 503 from this page number onward (null = healthy). */
  failFeedFromPage: number | null;
  requests: { method: string; path: string; status: number }[];
  setPrice(itemId: number, price: number, compareAt?: number | null): void;
  setAvailability(itemId: number, available: boolean): void;
  setClaimedLeft(itemId: number, n: number | null): void;
  remove(itemId: number): void;
  restore(itemId: number): void;
  add(p: FixtureProduct): void;
  find(itemId: number): FixtureProduct | undefined;
}

export interface FixtureServer {
  sites: Record<string, FixtureSiteHandle>;
  origin(key: string): string;
  /** Network hop for the product's fetcher: serves each fixture hostname from its local listener. Pass as SafeFetcher's `transport`. */
  transport: NonNullable<SafeFetcherDeps['transport']>;
  /** DNS stub for the product's fetcher: every fixture hostname resolves to a public address. */
  resolver(hostname: string): Promise<{ address: string; family: number }[]>;
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const money = (n: number) => n.toFixed(2);
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fillerProducts(spec: SiteSpec, count: number): FixtureProduct[] {
  return Array.from({ length: count }, (_, i) => ({
    itemId: 1000 + i,
    handle: `filler-item-${i}`,
    title: `Fixture Filler Item ${String(i).padStart(4, '0')}`,
    brand: 'Fixture',
    category: 'Fixture > Filler',
    size: '1 each',
    price: Math.round((1 + (i % 50) * 0.37) * 100) / 100,
    compareAt: null,
    currency: spec.currency,
    available: i % 9 !== 0,
    claimedLeft: null,
    gtin: null,
    sku: `FILL-${i}`,
  }));
}

async function flyerPdf(now: Date, currency: string, products: FixtureProduct[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margin: 40, info: { CreationDate: new Date('2026-01-01T00:00:00Z'), ModDate: new Date('2026-01-01T00:00:00Z') } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const end = new Date(now.getTime() + 6 * 86_400_000);
  const range = `Valid ${MONTH[now.getUTCMonth()]} ${now.getUTCDate()} - ${MONTH[end.getUTCMonth()]} ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
  doc.fontSize(20).text('Fixture Superstore Weekly Specials');
  doc.fontSize(11).text(range).moveDown();
  const cur = currency === 'AWG' ? 'Afl.' : 'US$';
  const pick = products.filter((p) => !p.removed && p.available).slice(0, 6);
  doc.fontSize(12);
  pick.forEach((p, i) => {
    const sale = Math.round(p.price * 0.85 * 100) / 100;
    if (i % 2 === 0) doc.text(`${p.title} ${cur} ${money(sale)}`);
    else doc.text(`${p.title} Was ${money(p.price)} Now ${money(sale)}`);
  });
  doc.moveDown().text('Buy any 2 and save - Limit 4 per customer.');
  doc.text('Prices valid while supplies last.');
  doc.end();
  return done;
}

export async function startFixtureServer(opts: { now?: () => Date } = {}): Promise<FixtureServer> {
  const host = '127.0.0.1';
  const now = opts.now ?? (() => new Date());
  const sites: Record<string, FixtureSiteHandle> = {};
  const servers: http.Server[] = [];

  for (const spec of SITE_SPECS) {
    const handle: FixtureSiteHandle = {
      key: spec.key,
      spec,
      port: 0,
      origin: '',
      host: '',
      products: [...buildCatalogue(spec), ...(spec.kind === 'flaky' ? fillerProducts(spec, 560) : [])],
      mode: 'ok',
      failFeedFromPage: spec.kind === 'flaky' ? 3 : null,
      requests: [],
      setPrice(itemId, price, compareAt) {
        const p = this.find(itemId);
        if (p) {
          p.price = price;
          if (compareAt !== undefined) p.compareAt = compareAt;
        }
      },
      setAvailability(itemId, available) {
        const p = this.find(itemId);
        if (p) p.available = available;
      },
      setClaimedLeft(itemId, n) {
        const p = this.find(itemId);
        if (p) p.claimedLeft = n;
      },
      remove(itemId) {
        const p = this.find(itemId);
        if (p) p.removed = true;
      },
      restore(itemId) {
        const p = this.find(itemId);
        if (p) p.removed = false;
      },
      add(p) {
        this.products.push(p);
      },
      find(itemId) {
        return this.products.find((x) => x.itemId === itemId);
      },
    };
    const server = http.createServer((req, res) => {
      route(handle, req, res, now).catch((e) => {
        res.statusCode = 500;
        res.end(String(e));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, resolve);
    });
    handle.port = (server.address() as AddressInfo).port;
    handle.host = FIXTURE_HOSTNAMES[spec.key] ?? `rival-${spec.key}.test`;
    handle.origin = `http://${handle.host}`;
    servers.push(server);
    sites[spec.key] = handle;
  }

  const byHost = new Map(Object.values(sites).map((s) => [s.host, s]));
  return {
    sites,
    origin: (key) => sites[key]!.origin,
    resolver: async (hostname) => (byHost.has(hostname) ? [{ address: FIXTURE_PUBLIC_ADDRESS, family: 4 }] : []),
    transport: async (url, init) => {
      const site = byHost.get(url.hostname);
      if (!site) throw new Error(`no fixture site answers for ${url.hostname}`);
      const headers = { ...init.headers };
      delete headers['host'];
      const res = await fetch(new URL(url.pathname + url.search, `http://${host}:${site.port}`), { method: init.method, headers, signal: init.signal, redirect: 'manual' });
      const buf = new Uint8Array(await res.arrayBuffer());
      const out: Record<string, string> = {};
      for (const [k, v] of res.headers.entries()) if (!['content-length', 'content-encoding', 'transfer-encoding'].includes(k)) out[k] = v;
      return { status: res.status, headers: out, body: (async function* () { yield buf; })() };
    },
    async close() {
      await Promise.all(servers.map((s) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
    },
  };
}

// ───────────────────────────────────────────────────────────── routing

type Res = http.ServerResponse;

function send(h: FixtureSiteHandle, req: http.IncomingMessage, res: Res, status: number, body: string | Buffer, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}) {
  h.requests.push({ method: req.method ?? 'GET', path: req.url ?? '', status });
  res.writeHead(status, { 'content-type': type, ...headers });
  res.end(body);
}

const live = (h: FixtureSiteHandle) => h.products.filter((p) => !p.removed);

function shell(h: FixtureSiteHandle, title: string, body: string, head = '', extraHeadScripts = ''): string {
  const s = h.spec;
  const social =
    s.kind === 'jsonld' || s.kind === 'shopify' || s.kind === 'woocommerce'
      ? `<footer><a href="https://www.facebook.com/fixture${s.key}">Facebook</a> <a href="https://www.instagram.com/fixture${s.key}/">Instagram</a> <a href="https://www.youtube.com/@fixture${s.key}">YouTube</a> <a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a></footer>`
      : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>${head}${extraHeadScripts}</head><body>${body}${social}</body></html>`;
}

async function route(h: FixtureSiteHandle, req: http.IncomingMessage, res: Res, now: () => Date) {
  const url = new URL(req.url ?? '/', h.origin);
  const path = url.pathname;
  const s = h.spec;

  // Global failure modes (for outcome simulation).
  if (s.kind === 'failing' || h.mode === 'http500') return send(h, req, res, 500, 'Internal Server Error', 'text/plain');
  if (h.mode === 'http403') return send(h, req, res, 403, 'Forbidden', 'text/plain');

  if (path === '/robots.txt') {
    if (s.kind === 'blocked') return send(h, req, res, 200, 'User-agent: *\nDisallow: /\n', 'text/plain');
    if (s.kind === 'catblocked') return send(h, req, res, 200, 'User-agent: *\nDisallow: /shop/\n', 'text/plain');
    const lines = s.kind === 'login' ? ['User-agent: *', 'Disallow: /cart', ''] : ['User-agent: *', 'Disallow: /cart', 'Disallow: /checkout', 'Disallow: /account', 'Disallow: /admin', ''];
    if (s.kind === 'jsonld' || s.kind === 'html' || s.kind === 'shopify') lines.push(`Sitemap: ${h.origin}/sitemap.xml`);
    return send(h, req, res, 200, lines.join('\n'), 'text/plain');
  }

  if (s.kind === 'challenge') {
    return send(h, req, res, 403, '<html><head><title>Just a moment...</title></head><body><div id="cf-chl-widget"></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>Checking your browser before accessing the site.</body></html>', 'text/html', { server: 'cloudflare', 'cf-ray': 'fixture-ray', 'cf-mitigated': 'challenge' });
  }
  if (s.kind === 'login') {
    if (path === '/account/login') return send(h, req, res, 200, '<html><body><form action="/account/login" method="post"><input name="email"><input type="password" name="p"></form>Please log in to view prices</body></html>');
    return send(h, req, res, 302, '', 'text/plain', { location: '/account/login' });
  }
  if (s.kind === 'jsrender') {
    if (path === '/' || path === '/index.html') return send(h, req, res, 200, '<!doctype html><html><head><title>Fixture SPA</title></head><body><div id="root"></div><noscript>Please enable JavaScript to view this site.</noscript><script src="/app.js"></script></body></html>');
    if (path === '/app.js') return send(h, req, res, 200, '/* spa */', 'application/javascript');
    return send(h, req, res, 404, 'Not found', 'text/plain');
  }

  if (s.kind === 'shopify' || s.kind === 'flaky') return shopifyRoutes(h, req, res, url, now);
  if (s.kind === 'woocommerce') return wooRoutes(h, req, res, url);
  if (s.kind === 'jsonld') return jsonldRoutes(h, req, res, url, now);
  if (s.kind === 'html') return htmlRoutes(h, req, res, url);
  if (s.kind === 'listing') return listingRoutes(h, req, res, url);
  if (s.kind === 'homegrid') return homeGridRoutes(h, req, res, url);
  if (s.kind === 'catblocked') return catBlockedRoutes(h, req, res, url);
  return send(h, req, res, 404, 'Not found', 'text/plain');
}

// ───────────────────────────────────────────────────────────── Shopify-style

function shopifyJson(h: FixtureSiteHandle, p: FixtureProduct) {
  return {
    id: 7000000 + p.itemId,
    title: p.title,
    handle: p.handle,
    body_html: `<p>${esc(p.title)} - fixture product</p>`,
    vendor: h.spec.vendorLabel ?? p.brand ?? 'Fixture',
    product_type: p.category.split(' > ').pop() ?? '',
    tags: ['fixture'],
    options: [{ name: 'Title', position: 1, values: ['Default Title'] }],
    images: [{ src: `${h.origin}/img/${p.handle}.jpg` }],
    variants: [
      {
        id: 8000000 + p.itemId,
        title: 'Default Title',
        option1: 'Default Title',
        sku: p.sku,
        price: money(p.price),
        compare_at_price: p.compareAt ? money(p.compareAt) : null,
        available: p.available,
      },
    ],
  };
}

async function shopifyRoutes(h: FixtureSiteHandle, req: http.IncomingMessage, res: Res, url: URL, now: () => Date) {
  const path = url.pathname;
  const s = h.spec;
  if (path === '/') {
    const body = `<header><div class="announcement-bar">Free delivery on orders over ${s.currency === 'AWG' ? 'Afl.' : 'US$'} 150 - Weekend sale: up to 20% off pantry staples</div></header><main><h1>${esc(s.label)}</h1><a href="/collections/sale">Sale</a> <a href="/products/${live(h)[0]?.handle ?? 'x'}">Featured</a></main>`;
    const head = `<link rel="preconnect" href="https://cdn.shopify.com"><script>window.Shopify = window.Shopify || {}; Shopify.shop = "fixture.myshopify.com"; Shopify.currency = {"active":"${s.currency}","rate":"1.0"};</script>`;
    return send(h, req, res, 200, shell(h, s.label, body, head), 'text/html; charset=utf-8', { 'x-shopid': '1234' });
  }
  if (path === '/sitemap.xml') {
    const urls = live(h).map((p) => `<url><loc>${h.origin}/products/${p.handle}</loc><lastmod>2026-10-01</lastmod></url>`).join('');
    return send(h, req, res, 200, `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, 'application/xml');
  }
  if (path === '/products.json') {
    const limit = Math.min(250, Number(url.searchParams.get('limit') ?? 30));
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    if (h.failFeedFromPage !== null && page >= h.failFeedFromPage) return send(h, req, res, 503, 'Service Unavailable', 'text/plain', { 'retry-after': '0' });
    const list = live(h).slice((page - 1) * limit, page * limit);
    return send(h, req, res, 200, JSON.stringify({ products: list.map((p) => shopifyJson(h, p)) }), 'application/json');
  }
  const m = path.match(/^\/products\/([^/]+?)(\.json)?$/);
  if (m) {
    const p = live(h).find((x) => x.handle === m[1]);
    if (!p) return send(h, req, res, 404, 'Not found', 'text/plain');
    if (m[2]) return send(h, req, res, 200, JSON.stringify({ product: shopifyJson(h, p) }), 'application/json');
    return send(h, req, res, 200, productPage(h, p, true));
  }
  void now;
  return send(h, req, res, 404, 'Not found', 'text/plain');
}

// ───────────────────────────────────────────────────────────── WooCommerce Store API

function wooJson(h: FixtureSiteHandle, p: FixtureProduct, variant?: { id: number; label: string; price: number; available: boolean }) {
  const minor = (n: number) => String(Math.round(n * 100));
  const price = variant?.price ?? p.price;
  const regular = p.compareAt ?? price;
  const avail = variant?.available ?? p.available;
  return {
    id: variant?.id ?? 6000 + p.itemId,
    name: variant ? `${p.title} - ${variant.label}` : p.title,
    slug: p.handle,
    parent: variant ? 6000 + p.itemId : 0,
    type: variant ? 'variation' : p.variants ? 'variable' : 'simple',
    permalink: `${h.origin}/product/${p.handle}/`,
    sku: p.sku,
    short_description: `<p>${esc(p.title)}</p>`,
    description: '',
    on_sale: !!p.compareAt,
    prices: { price: minor(price), regular_price: minor(regular), sale_price: p.compareAt ? minor(price) : minor(regular), currency_code: p.currency, currency_minor_unit: 2, price_range: null },
    images: [{ src: `${h.origin}/img/${p.handle}.jpg` }],
    categories: [{ name: p.category.split(' > ').pop() }],
    brands: [],
    is_in_stock: avail,
    is_purchasable: true,
    low_stock_remaining: p.claimedLeft,
    variations: p.variants && !variant ? p.variants.map((v) => ({ id: v.id, attributes: [{ name: 'Pack', value: v.label }] })) : [],
    attributes: [],
  };
}

async function wooRoutes(h: FixtureSiteHandle, req: http.IncomingMessage, res: Res, url: URL) {
  const path = url.pathname;
  const s = h.spec;
  if (path === '/') {
    const body = `<div class="woocommerce"><h1>${esc(s.label)}</h1><div class="top-banner">Deal of the week: save 10% on selected beverages</div></div>`;
    const head = `<meta name="generator" content="WooCommerce 9.3"><link rel="https://api.w.org/" href="${h.origin}/wp-json/"><link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css">`;
    return send(h, req, res, 200, shell(h, s.label, body, head));
  }
  if (path === '/wp-json/wc/store/v1/products') {
    const perPage = Math.min(100, Number(url.searchParams.get('per_page') ?? 10));
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const parent = url.searchParams.get('parent');
    const slug = url.searchParams.get('slug');
    if (url.searchParams.get('type') === 'variation' && parent) {
      const p = live(h).find((x) => String(6000 + x.itemId) === parent);
      const list = (p?.variants ?? []).map((v) => wooJson(h, p!, v));
      return send(h, req, res, 200, JSON.stringify(list), 'application/json');
    }
    let all = live(h);
    if (slug) all = all.filter((p) => p.handle === slug);
    const totalPages = Math.max(1, Math.ceil(all.length / perPage));
    if (page > totalPages) return send(h, req, res, 400, JSON.stringify({ code: 'rest_post_invalid_page_number', message: 'The page number requested is larger than the number of pages available.' }), 'application/json');
    const list = all.slice((page - 1) * perPage, page * perPage).map((p) => wooJson(h, p));
    return send(h, req, res, 200, JSON.stringify(list), 'application/json', { 'x-wp-total': String(all.length), 'x-wp-totalpages': String(totalPages) });
  }
  return send(h, req, res, 404, 'Not found', 'text/plain');
}

// ───────────────────────────────────────────────────────────── JSON-LD static pages

function availabilityUrl(p: FixtureProduct): string {
  if (!p.available) return 'https://schema.org/OutOfStock';
  if (p.limited) return 'https://schema.org/LimitedAvailability';
  return 'https://schema.org/InStock';
}

function productPage(h: FixtureSiteHandle, p: FixtureProduct, withJsonLd: boolean): string {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.title,
    sku: p.sku,
    ...(p.gtin ? { gtin13: p.gtin } : {}),
    ...(p.brand ? { brand: { '@type': 'Brand', name: p.brand } } : {}),
    category: p.category,
    image: `${h.origin}/img/${p.handle}.jpg`,
    description: `${p.title} - fixture product`,
    offers: { '@type': 'Offer', url: `${h.origin}/p/${p.handle}`, price: money(p.price), priceCurrency: p.currency, availability: availabilityUrl(p) },
  };
  const claim = p.claimedLeft !== null && p.available ? `<p class="stock">Only ${p.claimedLeft} left in stock</p>` : '';
  const body = `<main itemscope><h1>${esc(p.title)}</h1><div class="price">${p.currency === 'AWG' ? 'Afl.' : 'US$'} ${money(p.price)}</div>${p.compareAt ? `<del>${money(p.compareAt)}</del>` : ''}${claim}<button>Add to cart</button></main>`;
  return shell(h, p.title, body, withJsonLd ? `<script type="application/ld+json">${JSON.stringify(ld)}</script>` : '');
}

async function jsonldRoutes(h: FixtureSiteHandle, req: http.IncomingMessage, res: Res, url: URL, now: () => Date) {
  const path = url.pathname;
  const s = h.spec;
  if (path === '/') {
    const body = `<header><div class="announcement-bar">Weekly specials in store and online - 10% off dairy this week! Use code FRESH10 on orders over Afl. 100</div></header><main><h1>${esc(s.label)}</h1><a href="/offers">Offers</a> <a href="/flyers/weekly-specials.pdf">Download our weekly flyer (PDF)</a></main>`;
    return send(h, req, res, 200, shell(h, s.label, body));
  }
  if (path === '/sitemap.xml') {
    return send(h, req, res, 200, `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${h.origin}/sitemap-products.xml</loc></sitemap><sitemap><loc>${h.origin}/sitemap-pages.xml</loc></sitemap></sitemapindex>`, 'application/xml');
  }
  if (path === '/sitemap-pages.xml') return send(h, req, res, 200, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${h.origin}/about</loc></url><url><loc>${h.origin}/offers</loc></url></urlset>`, 'application/xml');
  if (path === '/sitemap-products.xml') {
    const urls = live(h).map((p) => `<url><loc>${h.origin}/p/${p.handle}</loc><lastmod>2026-10-0${1 + (p.itemId % 9)}</lastmod></url>`).join('');
    return send(h, req, res, 200, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, 'application/xml');
  }
  if (path === '/flyers/weekly-specials.pdf') {
    const pdf = await flyerPdf(now(), s.currency, h.products);
    return send(h, req, res, 200, pdf, 'application/pdf');
  }
  if (path === '/offers') return send(h, req, res, 200, shell(h, 'Offers', '<h1>Offers</h1><p>Weekend sale: save on selected items.</p>'));
  const m = path.match(/^\/p\/([^/]+)$/);
  if (m) {
    const p = live(h).find((x) => x.handle === m[1]);
    if (!p) return send(h, req, res, 404, 'Not found', 'text/plain');
    return send(h, req, res, 200, productPage(h, p, true));
  }
  return send(h, req, res, 404, 'Not found', 'text/plain');
}

// ───────────────────────────────────────────────────────────── plain HTML (no structured data)

async function htmlRoutes(h: FixtureSiteHandle, req: http.IncomingMessage, res: Res, url: URL) {
  const path = url.pathname;
  const s = h.spec;
  if (path === '/') return send(h, req, res, 200, shell(h, s.label, `<main><h1>${esc(s.label)}</h1><a href="/item/${live(h)[0]?.handle}">Featured</a></main>`));
  if (path === '/sitemap.xml') {
    const urls = live(h).map((p) => `<url><loc>${h.origin}/item/${p.handle}</loc></url>`).join('');
    return send(h, req, res, 200, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, 'application/xml');
  }
  const m = path.match(/^\/item\/([^/]+)$/);
  if (m) {
    const p = live(h).find((x) => x.handle === m[1]);
    if (!p) return send(h, req, res, 404, 'Not found', 'text/plain');
    const stock = !p.available ? '<p class="stock out">Out of stock</p>' : p.claimedLeft !== null ? `<p class="stock">Only ${p.claimedLeft} left in stock</p>` : '<p class="stock">In stock</p>';
    const body = `<div class="product"><h1>${esc(p.title)}</h1><p class="product-price"><span class="price">US$ ${money(p.price)}</span></p>${p.compareAt ? `<del class="was-price">US$ ${money(p.compareAt)}</del>` : ''}${stock}<span class="sku">${p.sku}</span>${p.available ? '<button>Add to cart</button>' : ''}</div>`;
    return send(h, req, res, 200, shell(h, p.title, body));
  }
  return send(h, req, res, 404, 'Not found', 'text/plain');
}

/** A plain shop with no feed, sitemap or structured data: a landing page with category links, paginated category listings, and product pages. */
const CARDS_PER_PAGE = 6;
const categoriesOf = (h: FixtureSiteHandle) => {
  const by = new Map<string, FixtureProduct[]>();
  for (const p of live(h)) {
    const slug = p.category.split(' > ')[0]!.toLowerCase().replace(/[^a-z]+/g, '-');
    by.set(slug, [...(by.get(slug) ?? []), p]);
  }
  return by;
};
const card = (p: FixtureProduct) =>
  `<li class="product-card"><a href="/item/${p.handle}"><img src="/img/${p.handle}.jpg" alt=""></a><h3><a href="/item/${p.handle}" title="${esc(p.title)}">${esc(p.title.slice(0, 18))}...</a></h3><span class="price">£${money(p.price)}</span><p class="avail">${p.available ? 'In stock' : 'Out of stock'}</p></li>`;

async function listingRoutes(h: FixtureSiteHandle, req: http.IncomingMessage, res: Res, url: URL) {
  const path = url.pathname;
  const cats = categoriesOf(h);
  const nav = `<aside class="side-categories"><ul class="nav">${[...cats.keys()].map((k) => `<li><a href="/c/${k}">${k}</a></li>`).join('')}</ul></aside>`;
  if (path === '/') return send(h, req, res, 200, shell(h, h.spec.label, `<main><h1>${esc(h.spec.label)}</h1><p>Welcome. Pick a department.</p>${nav}</main>`));
  const m = path.match(/^\/c\/([a-z-]+)$/);
  if (m) {
    const items = cats.get(m[1]!);
    if (!items) return send(h, req, res, 404, 'Not found', 'text/plain');
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const slice = items.slice((page - 1) * CARDS_PER_PAGE, page * CARDS_PER_PAGE);
    const pages = Math.ceil(items.length / CARDS_PER_PAGE);
    const pager = pages > 1 ? `<ul class="pager"><li class="current">Page ${page} of ${pages}</li>${page < pages ? `<li class="next"><a href="/c/${m[1]}?page=${page + 1}">next</a></li>` : ''}</ul>` : '';
    return send(h, req, res, 200, shell(h, m[1]!, `${nav}<main><ol class="cards">${slice.map(card).join('')}</ol>${pager}</main>`));
  }
  const d = path.match(/^\/item\/([^/]+)$/);
  if (d) {
    const p = live(h).find((x) => x.handle === d[1]);
    if (!p) return send(h, req, res, 404, 'Not found', 'text/plain');
    return send(h, req, res, 200, shell(h, p.title, `<div class="product"><h1>${esc(p.title)}</h1><p class="product-price">£${money(p.price)}</p></div>`));
  }
  return send(h, req, res, 404, 'Not found', 'text/plain');
}

/**
 * A storefront built like a plain bookshop: the home page IS the first page of the whole catalogue, later pages sit under /catalogue/ with a
 * relative "next" link, categories (some very small) have their own pages, and product pages live under /catalogue/<name>/index.html. No feed,
 * no sitemap, no structured data, no category-page link from the home page other than the sidebar.
 */
const GRID_PER_PAGE = 10;
const gridCard = (p: FixtureProduct) =>
  `<li class="col-xs-6"><article class="product_pod"><div class="image_container"><a href="/catalogue/${p.handle}/index.html"><img src="/media/${p.handle}.jpg" alt="${esc(p.title)}"></a></div><h3><a href="/catalogue/${p.handle}/index.html" title="${esc(p.title)}">${esc(p.title.slice(0, 20))}...</a></h3><div class="product_price"><p class="price_color">£${money(p.price)}</p><p class="instock availability">${p.available ? 'In stock' : 'Out of stock'}</p></div></article></li>`;

async function homeGridRoutes(h: FixtureSiteHandle, req: http.IncomingMessage, res: Res, url: URL) {
  const path = url.pathname;
  const all = live(h);
  const cats = categoriesOf(h);
  const nav = `<div class="side_categories"><ul class="nav"><li><a href="/catalogue/category/all/index.html">All</a><ul>${[...cats.keys()].map((k) => `<li><a href="/catalogue/category/${k}/index.html">${k}</a></li>`).join('')}</ul></li></ul></div>`;
  const pages = Math.ceil(all.length / GRID_PER_PAGE);
  const gridPage = (n: number) => {
    const slice = all.slice((n - 1) * GRID_PER_PAGE, n * GRID_PER_PAGE);
    const next = n < pages ? `<li class="next"><a href="${n === 1 ? 'catalogue/' : ''}page-${n + 1}.html">next</a></li>` : '';
    const prev = n > 1 ? `<li class="previous"><a href="${n === 2 ? '../index.html' : `page-${n - 1}.html`}">previous</a></li>` : '';
    return shell(h, h.spec.label, `${nav}<main><form><strong>${all.length}</strong> results - showing ${(n - 1) * GRID_PER_PAGE + 1} to ${(n - 1) * GRID_PER_PAGE + slice.length}.</form><ol class="row">${slice.map(gridCard).join('')}</ol><ul class="pager">${prev}<li class="current">Page ${n} of ${pages}</li>${next}</ul></main>`);
  };
  if (path === '/' || path === '/index.html') return send(h, req, res, 200, gridPage(1));
  const pg = path.match(/^\/catalogue\/page-(\d+)\.html$/);
  if (pg) {
    const n = Number(pg[1]);
    return n >= 1 && n <= pages ? send(h, req, res, 200, gridPage(n)) : send(h, req, res, 404, 'Not found', 'text/plain');
  }
  const cat = path.match(/^\/catalogue\/category\/([a-z-]+)\/index\.html$/);
  if (cat) {
    const items = cat[1] === 'all' ? all : cats.get(cat[1]!);
    if (!items) return send(h, req, res, 404, 'Not found', 'text/plain');
    return send(h, req, res, 200, shell(h, cat[1]!, `${nav}<main><form><strong>${items.length}</strong> results.</form><ol class="row">${items.slice(0, GRID_PER_PAGE).map(gridCard).join('')}</ol></main>`));
  }
  const d = path.match(/^\/catalogue\/([^/]+)\/index\.html$/);
  if (d) {
    const p = all.find((x) => x.handle === d[1]);
    if (!p) return send(h, req, res, 404, 'Not found', 'text/plain');
    return send(h, req, res, 200, shell(h, p.title, `<div class="product_main"><h1>${esc(p.title)}</h1><p class="price_color">£${money(p.price)}</p></div>`));
  }
  return send(h, req, res, 404, 'Not found', 'text/plain');
}

/** The home page is open, but robots.txt forbids everything under /shop/ — where all the products are. */
async function catBlockedRoutes(h: FixtureSiteHandle, req: http.IncomingMessage, res: Res, url: URL) {
  const path = url.pathname;
  if (path === '/') return send(h, req, res, 200, shell(h, h.spec.label, `<main><h1>${esc(h.spec.label)}</h1><nav><ul class="nav"><li><a href="/shop/">Shop</a></li><li><a href="/shop/drinks">Drinks</a></li></ul></nav><a href="/shop/item/${live(h)[0]?.handle}">Featured</a></main>`));
  if (path.startsWith('/shop/')) return send(h, req, res, 200, shell(h, 'Shop', `<ul>${live(h).map(card).join('')}</ul>`));
  return send(h, req, res, 404, 'Not found', 'text/plain');
}

export { MASTER };
