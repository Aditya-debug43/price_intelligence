import * as cheerio from 'cheerio';
import { canonicalizeUrl, normalizeSiteUrl, parseQuantity, PROMO_KEYWORDS, UrlValidationError } from '@ci/core';
import type {
  CapabilityStatus,
  FieldCapability,
  FieldKey,
  PlatformId,
  ProfileLimitation,
  PublicApiProbe,
  SampledProduct,
  SiteProfileData,
} from '@ci/shared';
import { AccessDeniedError, FetchError, type SafeFetcher } from './safe-fetch.ts';
import { detectChallenge, detectLoginWall } from './challenge.ts';
import { extractFromHtml, looksJavaScriptRendered, titleOf } from './extract.ts';
import { discoverFromSitemaps } from './sitemap.ts';
import { extractListingPage } from './listing.ts';
import { rankConnectors, type Capabilities } from './registry.ts';

export const PROFILER_VERSION = '1.0';

export interface ProfilerOptions {
  fetcher: SafeFetcher;
  capabilities: Capabilities;
  defaultCrawlDelayMs: number;
  defaultMaxRequests: number;
  maxSampleProducts?: number;
  now?: () => Date;
}

// ─────────────────────────────────────────────────────────── platform fingerprint

export function detectPlatform(html: string, headers: Record<string, string>): { id: PlatformId; confidence: number; evidence: string[] } {
  const h = html.slice(0, 400_000);
  const ev: string[] = [];
  const score: Partial<Record<PlatformId, number>> = {};
  const add = (id: PlatformId, pts: number, why: string) => {
    score[id] = (score[id] ?? 0) + pts;
    ev.push(`${id}: ${why}`);
  };
  if (/cdn\.shopify\.com|myshopify\.com/i.test(h)) add('shopify', 0.5, 'Shopify CDN assets');
  if (/Shopify\.(theme|shop|currency)|window\.Shopify/.test(h)) add('shopify', 0.4, 'Shopify JavaScript object');
  if (headers['x-shopid'] || headers['x-shopify-stage'] || /shopify/i.test(headers['powered-by'] ?? '')) add('shopify', 0.4, 'Shopify response headers');
  if (/\/wp-content\/plugins\/woocommerce|woocommerce(-|_)(page|js|no-js)|class="[^"]*woocommerce/i.test(h)) add('woocommerce', 0.6, 'WooCommerce markup/assets');
  if (/<meta name="generator" content="WooCommerce/i.test(h)) add('woocommerce', 0.3, 'WooCommerce generator tag');
  if (/rel=["']https:\/\/api\.w\.org\/|\/wp-json\//i.test(h) || /wp-json/.test(headers['link'] ?? '')) add('woocommerce', 0.15, 'WordPress REST API advertised');
  if (/Mage\.Cookies|mage\/cookies|\/static\/version\d+\/frontend\/|Magento_/i.test(h)) add('magento', 0.7, 'Magento assets');
  if (/cdn\d+\.bigcommerce\.com|bigcommerce/i.test(h)) add('bigcommerce', 0.7, 'BigCommerce assets');
  if (/prestashop/i.test(h) || /prestashop/i.test(headers['x-powered-by'] ?? '')) add('prestashop', 0.7, 'PrestaShop markers');
  if (/static\.wixstatic\.com|wix\.com|X-Wix/i.test(h + JSON.stringify(headers))) add('wix', 0.7, 'Wix assets');
  if (/static1\.squarespace\.com|squarespace-cdn/i.test(h)) add('squarespace', 0.7, 'Squarespace assets');
  if (/catalog\/view\/theme|route=product\/product/i.test(h)) add('opencart', 0.6, 'OpenCart URL patterns');
  if (/freshop(\.com|\.ncrcloud\.com|_sitemap|-store|\.js)|data-freshop|class="[^"]*freshop/i.test(h)) add('freshop', 0.7, 'Freshop online-grocery storefront assets');
  const best = (Object.entries(score) as [PlatformId, number][]).sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 0.5) return { id: 'unknown', confidence: 0, evidence: ['No known e-commerce platform signature found'] };
  return { id: best[0], confidence: Math.min(1, Math.round(best[1] * 100) / 100), evidence: ev.filter((e) => e.startsWith(best[0])).map((e) => e.replace(/^[a-z]+: /, '')) };
}

// ─────────────────────────────────────────────────────────── homepage signals

export function findSocialLinks($: cheerio.CheerioAPI): SiteProfileData['social'] {
  const out: SiteProfileData['social'] = { facebook: null, instagram: null, youtube: null, other: [] };
  const hrefs = new Set<string>();
  $('a[href]').each((_, el) => void hrefs.add($(el).attr('href') ?? ''));
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    for (const m of raw.matchAll(/"https?:\\?\/\\?\/[^"]+"/g)) hrefs.add(m[0].replace(/^"|"$/g, '').replace(/\\\//g, '/'));
  });
  for (const href of hrefs) {
    let u: URL;
    try {
      u = new URL(href);
    } catch {
      continue;
    }
    const host = u.hostname.replace(/^www\.|^m\./, '');
    const segs = u.pathname.split('/').filter(Boolean);
    if (/^(facebook\.com|fb\.com)$/.test(host) && !out.facebook) {
      if (segs.length && !/^(sharer|share|plugins|tr|dialog|login|policies|groups\/?$|events)/i.test(segs[0]!)) out.facebook = `https://www.facebook.com/${segs[0]}`;
    } else if (host === 'instagram.com' && !out.instagram) {
      if (segs.length && !/^(p|reel|explore|accounts|share|stories)$/i.test(segs[0]!)) out.instagram = `https://www.instagram.com/${segs[0]}`;
    } else if ((host === 'youtube.com' || host === 'youtu.be') && !out.youtube) {
      if (segs[0] && (segs[0].startsWith('@') || ['channel', 'c', 'user'].includes(segs[0]))) out.youtube = `https://www.youtube.com/${segs.slice(0, 2).join('/')}`;
    } else if (/(tiktok|twitter|x|linkedin|pinterest|whatsapp|wa)\.(com|me)$/.test(host) && out.other.length < 6) {
      out.other.push(`${u.origin}${u.pathname}`.replace(/\/$/, ''));
    }
  }
  return out;
}

export function findPromotions($: cheerio.CheerioAPI, origin: string): SiteProfileData['promotions'] {
  const banners = new Set<string>();
  const sel = '[class*="announcement"], [id*="announcement"], [class*="promo"], [class*="topbar"], [class*="top-bar"], [class*="marquee"], [class*="ticker"], [class*="notice"], [class*="banner"], [role="alert"]';
  $(sel).each((_, el) => {
    const t = $(el).clone().find('script,style,noscript').remove().end().text().replace(/\s+/g, ' ').trim();
    if (t.length >= 8 && t.length <= 220 && PROMO_KEYWORDS.test(t)) banners.add(t);
  });
  const sale = new Set<string>();
  const flyers = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    let abs: string;
    try {
      abs = canonicalizeUrl(href, `${origin}/`);
    } catch {
      return;
    }
    if (new URL(abs).hostname.replace(/^www\./, '') !== new URL(origin).hostname.replace(/^www\./, '')) return;
    const hay = `${abs} ${text}`;
    if (/\.pdf(\?|$)/i.test(abs) && /(flyer|circular|specials?|weekly|ad|folleto|ofertas|catalog|brochure|aanbieding)/i.test(hay)) flyers.add(abs);
    else if (/(flyer|weekly[- ]ad|circular|folleto)/i.test(hay) && /\.pdf/i.test(abs)) flyers.add(abs);
    else if (/\/(sale|sales|offers?|deals?|specials?|clearance|promo(tions?)?|outlet|ofertas|aanbiedingen)(\/|$|\?)/i.test(new URL(abs).pathname + '/')) sale.add(abs);
  });
  const coupons = new Set<string>();
  const body = $('body').text().replace(/\s+/g, ' ');
  for (const m of body.matchAll(/(?:use\s+)?(?:code|coupon)[:\s]+["“']?([A-Z0-9][A-Z0-9_-]{3,19})["”']?/g)) coupons.add(m[1]!);
  return { bannerTexts: [...banners].slice(0, 8), saleLinks: [...sale].slice(0, 8), flyerLinks: [...flyers].slice(0, 8), couponMentions: [...coupons].slice(0, 5) };
}

function detectCurrencyFromHtml(html: string): string[] {
  const out = new Set<string>();
  const shopify = html.match(/Shopify\.currency\s*=\s*\{[^}]*"active"\s*:\s*"([A-Z]{3})"/);
  if (shopify) out.add(shopify[1]!);
  for (const m of html.matchAll(/<meta[^>]+(?:property|name|itemprop)=["'](?:og:price:currency|product:price:currency|priceCurrency)["'][^>]+content=["']([A-Za-z]{3})["']/gi)) out.add(m[1]!.toUpperCase());
  for (const m of html.matchAll(/<meta[^>]+content=["']([A-Za-z]{3})["'][^>]+(?:property|name|itemprop)=["'](?:og:price:currency|product:price:currency|priceCurrency)["']/gi)) out.add(m[1]!.toUpperCase());
  return [...out];
}

// ─────────────────────────────────────────────────────────── field capability matrix

const FIELDS: FieldKey[] = [
  'title', 'price', 'compare_at_price', 'currency', 'availability', 'brand', 'sku', 'gtin', 'description', 'category', 'image', 'variants', 'size_or_weight', 'shipping_cost', 'stock_quantity',
];

function emptyFields(): Record<FieldKey, FieldCapability> {
  return Object.fromEntries(FIELDS.map((f) => [f, { availability: 'unknown', coverage: null, source: null } as FieldCapability])) as Record<FieldKey, FieldCapability>;
}

const level = (coverage: number): FieldCapability['availability'] => (coverage >= 0.8 ? 'available' : coverage > 0 ? 'partial' : 'missing');

function setCoverage(fields: Record<FieldKey, FieldCapability>, key: FieldKey, hits: number, total: number, source: string, note?: string) {
  const coverage = total === 0 ? 0 : Math.round((hits / total) * 100) / 100;
  fields[key] = { availability: level(coverage), coverage, source, note };
}

// ─────────────────────────────────────────────────────────── main

function blankProfile(requestedUrl: string): SiteProfileData {
  return {
    status: 'failed',
    summary: '',
    site: { requestedUrl, finalUrl: null, origin: null, canonicalHost: null, title: null, httpStatus: null, reachable: false, responseTimeMs: null, redirectChain: [] },
    platform: { id: 'unknown', confidence: 0, evidence: [] },
    access: { robots: { fetched: false, httpStatus: null, allowsHome: false, disallowsAll: false, crawlDelaySeconds: null, sitemaps: [], note: null }, loginRequired: false, challengeDetected: false, challengeKind: null, barriers: [] },
    catalogue: { sitemaps: [], productUrlSample: [], estimatedProducts: null, estimateBasis: 'Not measured', publicApis: [] },
    fields: emptyFields(),
    currency: { detected: null, candidates: [], evidence: [], conflicting: false },
    rendering: { requiresJavaScript: false, evidence: 'Not assessed' },
    promotions: { bannerTexts: [], saleLinks: [], flyerLinks: [], couponMentions: [] },
    social: { facebook: null, instagram: null, youtube: null, other: [] },
    strategy: { recommended: [], primary: null, reason: 'No collection strategy could be selected' },
    effort: { requestsEstimate: null, minutesEstimate: null, crawlDelayMs: 0, maxRequestsPerRun: 0, notes: '' },
    sampledProducts: [],
    limitations: [],
    conflicts: [],
    requestsMade: 0,
    durationMs: 0,
  };
}

function finishWith(p: SiteProfileData, status: CapabilityStatus, summary: string, started: number, fetcher: SafeFetcher, reqStart: number): SiteProfileData {
  p.status = status;
  p.summary = summary;
  p.durationMs = Date.now() - started;
  p.requestsMade = fetcher.requestsMade - reqStart;
  return p;
}

export async function profileSite(inputUrl: string, opts: ProfilerOptions): Promise<SiteProfileData> {
  const { fetcher } = opts;
  const started = Date.now();
  const reqStart = fetcher.requestsMade;
  const profile = blankProfile(inputUrl);
  const limit = (code: string, severity: ProfileLimitation['severity'], message: string) => profile.limitations.push({ code, severity, message });

  let site;
  try {
    site = normalizeSiteUrl(inputUrl);
  } catch (e) {
    const msg = e instanceof UrlValidationError ? e.message : 'The URL is not valid';
    limit('invalid_url', 'blocking', `This address cannot be used: ${msg}.`);
    return finishWith(profile, 'failed', `This address cannot be used: ${msg}.`, started, fetcher, reqStart);
  }
  profile.site.origin = site.origin;
  profile.site.canonicalHost = site.hostname;
  profile.site.entryPath = site.entryPath;

  // ── 1. robots.txt
  let robots;
  try {
    robots = await fetcher.robots(site.origin);
  } catch (e) {
    if (e instanceof FetchError && e.code === 'ssrf') {
      limit('unsafe_address', 'blocking', 'This address points to a private or internal network and cannot be analysed for security reasons.');
      return finishWith(profile, 'blocked', 'This address cannot be analysed: it points to a private or internal network.', started, fetcher, reqStart);
    }
    limit('unreachable', 'blocking', `The site could not be reached: ${(e as Error).message}`);
    return finishWith(profile, 'failed', 'The website could not be reached. This is a technical problem, not an empty catalogue — try again later.', started, fetcher, reqStart);
  }
  const home = await fetcher.isAllowed(`${site.origin}/`);
  profile.access.robots = {
    fetched: robots.fetched,
    httpStatus: robots.httpStatus,
    allowsHome: home.allowed,
    disallowsAll: !home.allowed,
    crawlDelaySeconds: robots.crawlDelaySeconds,
    sitemaps: robots.parsed.sitemaps,
    note: robots.note,
  };
  const crawlDelayMs = Math.max(opts.defaultCrawlDelayMs, (robots.crawlDelaySeconds ?? 0) * 1000);
  fetcher.setHostDelay(site.hostname, crawlDelayMs);
  profile.effort.crawlDelayMs = crawlDelayMs;
  profile.effort.maxRequestsPerRun = opts.defaultMaxRequests;
  if (robots.crawlDelaySeconds) limit('crawl_delay', 'info', `The site asks crawlers to wait ${robots.crawlDelaySeconds} s between requests; this is applied.`);

  if (!home.allowed && !robots.fetched && (robots.httpStatus === null || robots.httpStatus >= 500)) {
    // A temporary server error is NOT a deliberate "no": report a technical failure, not a block.
    limit('robots_unavailable', 'blocking', robots.note ?? 'robots.txt could not be retrieved right now.');
    return finishWith(profile, 'failed', 'The website’s server is not responding properly right now (robots.txt could not be read). This is a temporary technical problem, not an empty catalogue — try again later.', started, fetcher, reqStart);
  }
  if (!home.allowed) {
    profile.access.barriers.push(robots.note ?? `robots.txt disallows automated access (${home.rule ?? 'rule'})`);
    limit('robots_disallow', 'blocking', robots.note ?? 'The site’s robots.txt does not permit automated collection, so we do not access it.');
    return finishWith(profile, 'blocked', 'The website’s robots.txt does not permit automated collection. Nothing was collected; competitor analysis for this site is unavailable unless the owner changes it.', started, fetcher, reqStart);
  }

  // the page the customer pointed at, when it is not the home page: robots.txt applies to it exactly as to any other page
  const entryUrl = site.entryPath ? `${site.origin}${site.entryPath}` : null;
  if (entryUrl) {
    const entry = await fetcher.isAllowed(entryUrl);
    profile.access.robots.entryAllowed = entry.allowed;
    if (!entry.allowed) {
      const rule = entry.rule ? ` (rule: ${entry.rule})` : '';
      profile.access.barriers.push(`robots.txt does not permit automated access to ${site.entryPath}`);
      limit('robots_disallow', 'blocking', `The website's robots.txt does not permit automated reading of the page you gave (${site.entryPath})${rule}, so it is not collected.`);
      return finishWith(profile, 'blocked', `The website's robots.txt does not permit automated reading of the page you gave (${site.entryPath}). We respect that and do not collect it; nothing was collected from this website. If the shop is also reachable from another address that robots.txt allows, add that address instead.`, started, fetcher, reqStart);
    }
  }

  // ── 2. homepage
  let html: string;
  let headers: Record<string, string>;
  try {
    const res = await fetcher.fetch(`${site.origin}/`, { kind: 'html', allowCrossHostRedirect: true });
    profile.site.httpStatus = res.status;
    profile.site.finalUrl = res.url;
    profile.site.responseTimeMs = res.durationMs;
    profile.site.redirectChain = res.redirects;
    profile.site.reachable = res.status < 500;
    headers = res.headers;
    html = res.text();
    try {
      profile.site.origin = new URL(res.url).origin;
      profile.site.canonicalHost = new URL(res.url).hostname;
    } catch {
      /* keep requested origin */
    }
    const ch = detectChallenge(html, headers, res.status);
    if (ch.detected) {
      profile.access.challengeDetected = true;
      profile.access.challengeKind = ch.kind;
      profile.access.barriers.push(`${ch.kind} is protecting the site`);
      limit('bot_protection', 'blocking', `The site is protected by ${ch.kind}. We do not try to get around bot protection, so automated collection is not possible.`);
      return finishWith(profile, 'blocked', `The website uses ${ch.kind} to stop automated visitors. We respect that and do not collect from it.`, started, fetcher, reqStart);
    }
    if (res.status === 401 || res.status === 403) {
      profile.access.barriers.push(`The server refused access (HTTP ${res.status})`);
      limit('access_denied', 'blocking', `The website refused access (HTTP ${res.status}) to automated visitors, so collection cannot proceed.`);
      return finishWith(profile, 'blocked', `The website refused access (HTTP ${res.status}). Collection is not possible under the permitted access conditions.`, started, fetcher, reqStart);
    }
    if (res.status === 429) {
      limit('rate_limited', 'blocking', 'The website is rate-limiting automated visitors right now.');
      return finishWith(profile, 'failed', 'The website is temporarily rate-limiting requests. Try again later.', started, fetcher, reqStart);
    }
    if (res.status >= 400) {
      limit('http_error', 'blocking', `The homepage returned HTTP ${res.status}.`);
      return finishWith(profile, 'failed', `The website’s homepage returned an error (HTTP ${res.status}). This is a technical problem, not an empty catalogue.`, started, fetcher, reqStart);
    }
    if (detectLoginWall(res.url, html)) {
      profile.access.loginRequired = true;
      profile.access.barriers.push('A login or password is required to view the shop');
      limit('login_required', 'blocking', 'The shop requires a login or password. We never log in to other businesses’ sites.');
      return finishWith(profile, 'blocked', 'The shop is behind a login or password page. Collection is not possible.', started, fetcher, reqStart);
    }
  } catch (e) {
    if (e instanceof AccessDeniedError) {
      profile.access.barriers.push(e.message);
      limit('access_denied', 'blocking', e.message);
      return finishWith(profile, 'blocked', 'The website denied access to automated visitors.', started, fetcher, reqStart);
    }
    if (e instanceof FetchError && (e.code === 'robots' || e.code === 'ssrf')) {
      limit(e.code === 'robots' ? 'robots_disallow' : 'unsafe_address', 'blocking', e.message);
      return finishWith(profile, 'blocked', e.code === 'robots' ? 'robots.txt does not permit automated collection.' : 'This address cannot be analysed for security reasons.', started, fetcher, reqStart);
    }
    limit('unreachable', 'blocking', `The homepage could not be loaded: ${(e as Error).message}`);
    return finishWith(profile, 'failed', 'The website could not be loaded (timeout or network error). This is a technical problem, not an empty catalogue.', started, fetcher, reqStart);
  }

  const $ = cheerio.load(html);
  profile.site.title = titleOf(html);
  profile.platform = detectPlatform(html, headers);
  profile.social = findSocialLinks($);
  profile.promotions = findPromotions($, profile.site.origin!);
  const js = looksJavaScriptRendered(html);
  profile.rendering = { requiresJavaScript: js.rendered, evidence: js.evidence };

  const origin = profile.site.origin!;
  // the page the customer pointed at is where the shop starts: read it too (it is allowed — checked above)
  let entryPage: { html: string; url: string } | null = null;
  if (entryUrl) {
    try {
      const r = await fetcher.fetch(entryUrl, { kind: 'html', allowCrossHostRedirect: false });
      if (r.status === 200 && !detectChallenge(r.text(), r.headers, r.status).detected && !detectLoginWall(r.url, r.text())) entryPage = { html: r.text(), url: r.url };
    } catch (e) {
      if (e instanceof AccessDeniedError) {
        profile.access.barriers.push(e.message);
        limit('access_denied', 'blocking', e.message);
      }
      /* an entry page that cannot be read leaves the home page as the starting point */
    }
  }
  const currencyEvidence: { code: string; source: string }[] = detectCurrencyFromHtml(html).map((c) => ({ code: c, source: 'homepage metadata' }));

  // ── 3. public catalogue APIs
  const apis: PublicApiProbe[] = [];
  const fields = emptyFields();
  let apiProduct: { title?: boolean; brand?: boolean; sku?: boolean; compare?: boolean; image?: boolean; variants?: boolean; category?: boolean; stockClaim?: boolean } = {};
  let apiTotal: number | null = null;
  if (profile.platform.id === 'shopify') {
    const probe: PublicApiProbe = { kind: 'shopify_products_json', url: `${origin}/products.json`, usable: false, total: null, notes: '' };
    try {
      const r = await fetcher.fetch(`${origin}/products.json?limit=5`, { kind: 'json' });
      if (r.status === 200) {
        const data = r.json<{ products?: { title?: string; vendor?: string; product_type?: string; images?: unknown[]; variants?: { sku?: string; price?: string; compare_at_price?: string | null; available?: boolean }[] }[] }>();
        if (Array.isArray(data.products)) {
          probe.usable = true;
          probe.notes = data.products.length ? 'The public product feed responds and lists products with prices and availability.' : 'The product feed responds but is empty.';
          const ps = data.products;
          apiProduct = {
            title: ps.every((p) => p.title),
            brand: ps.some((p) => p.vendor),
            sku: ps.some((p) => p.variants?.some((v) => v.sku)),
            compare: ps.some((p) => p.variants?.some((v) => v.compare_at_price)),
            image: ps.some((p) => (p.images?.length ?? 0) > 0),
            variants: ps.some((p) => (p.variants?.length ?? 0) > 1),
            category: ps.some((p) => p.product_type),
          };
        } else probe.notes = 'The feed did not return a product list.';
      } else probe.notes = `The product feed returned HTTP ${r.status}; the store has disabled it or restricted it.`;
    } catch (e) {
      probe.notes = `Product feed could not be read: ${(e as Error).message}`;
    }
    apis.push(probe);
  }
  if (profile.platform.id === 'woocommerce' || /wp-json/i.test(html + (headers['link'] ?? ''))) {
    const probe: PublicApiProbe = { kind: 'woocommerce_store_api', url: `${origin}/wp-json/wc/store/v1/products`, usable: false, total: null, notes: '' };
    try {
      const r = await fetcher.fetch(`${origin}/wp-json/wc/store/v1/products?per_page=5`, { kind: 'json' });
      if (r.status === 200) {
        const list = r.json<{ name?: string; sku?: string; brands?: unknown[]; prices?: { currency_code?: string; regular_price?: string; price?: string }[] | { currency_code?: string; regular_price?: string; price?: string }; images?: unknown[]; categories?: unknown[]; low_stock_remaining?: number | null; type?: string }[]>();
        if (Array.isArray(list)) {
          probe.usable = true;
          const total = Number(r.headers['x-wp-total'] ?? NaN);
          probe.total = Number.isFinite(total) ? total : null;
          apiTotal = probe.total;
          probe.notes = 'The public WooCommerce Store API responds with prices, availability and the catalogue size.';
          for (const p of list) {
            const pr = (Array.isArray(p.prices) ? p.prices[0] : p.prices) as { currency_code?: string } | undefined;
            if (pr?.currency_code) currencyEvidence.push({ code: pr.currency_code.toUpperCase(), source: 'WooCommerce Store API' });
          }
          apiProduct = {
            title: list.every((p) => p.name),
            brand: list.some((p) => (p.brands?.length ?? 0) > 0),
            sku: list.some((p) => p.sku),
            compare: list.some((p) => { const pr = (Array.isArray(p.prices) ? p.prices[0] : p.prices); return !!pr && pr.regular_price !== pr.price; }),
            image: list.some((p) => (p.images?.length ?? 0) > 0),
            variants: list.some((p) => p.type === 'variable'),
            category: list.some((p) => (p.categories?.length ?? 0) > 0),
            stockClaim: list.some((p) => 'low_stock_remaining' in p),
          };
        }
      } else probe.notes = `The Store API returned HTTP ${r.status}; it is disabled or restricted on this site.`;
    } catch (e) {
      probe.notes = `The Store API could not be read: ${(e as Error).message}`;
    }
    apis.push(probe);
  }
  profile.catalogue.publicApis = apis;
  const apiUsable = apis.find((a) => a.usable) ?? null;

  // ── 4. sitemaps + product URL sample
  let sitemapUrlsFound = 0;
  try {
    const roots = [...new Set([...robots.parsed.sitemaps, `${origin}/sitemap.xml`, ...(profile.platform.id === 'woocommerce' ? [`${origin}/wp-sitemap.xml`] : [])])];
    const d = await discoverFromSitemaps(fetcher, roots.slice(0, 4), { maxSitemaps: 6, maxUrls: 3000, productOnly: true });
    profile.catalogue.sitemaps = d.sitemaps;
    if (profile.platform.id === 'unknown' && d.sitemaps.some((s) => /freshop/i.test(s.url))) {
      profile.platform = { id: 'freshop', confidence: 0.8, evidence: ['A Freshop product sitemap is listed in robots.txt / sitemap files'] };
    }
    sitemapUrlsFound = d.urls.length;
    const pick = (arr: { url: string }[], n: number) => {
      if (arr.length <= n) return arr.map((a) => a.url);
      const idx = Array.from({ length: n }, (_, i) => Math.floor((i * (arr.length - 1)) / (n - 1 || 1)));
      return [...new Set(idx)].map((i) => arr[i]!.url);
    };
    profile.catalogue.productUrlSample = pick(d.urls, Math.max(3, opts.maxSampleProducts ?? 3));
    const productSitemaps = d.sitemaps.filter((s) => s.kind === 'products' || (s.kind === 'other' && (s.urlCount ?? 0) > 0));
    const counted = d.sitemaps.filter((s) => s.kind !== 'index' && !s.failed && s.urlCount !== null && s.kind !== 'collections' && s.kind !== 'pages');
    const totalFromSitemaps = counted.reduce((a, s) => a + (s.urlCount ?? 0), 0);
    if (!apiTotal && totalFromSitemaps > 0) {
      profile.catalogue.estimatedProducts = d.truncated ? Math.max(totalFromSitemaps, sitemapUrlsFound) : totalFromSitemaps;
      profile.catalogue.estimateBasis = `Sum of ${counted.length} product sitemap(s)${d.truncated ? ' (lower bound; sitemap reading was capped)' : ''}`;
    }
    if (d.warnings.length && !d.sitemaps.some((s) => !s.failed)) limit('no_sitemap', 'info', 'No usable sitemap was found, so products must be discovered by following links (less complete).');
    void productSitemaps;
  } catch (e) {
    if (e instanceof AccessDeniedError) {
      limit('access_denied', 'blocking', e.message);
      return finishWith(profile, 'blocked', 'The website denied access during analysis.', started, fetcher, reqStart);
    }
    limit('no_sitemap', 'info', `Sitemaps could not be read: ${(e as Error).message}`);
  }
  if (apiTotal !== null) {
    profile.catalogue.estimatedProducts = apiTotal;
    profile.catalogue.estimateBasis = 'Catalogue size reported by the WooCommerce Store API';
  }

  // Sample candidates: sitemap sample, else product-looking homepage links.
  let sampleUrls = profile.catalogue.productUrlSample.slice(0, opts.maxSampleProducts ?? 3);
  if (sampleUrls.length === 0) {
    const links = new Set<string>();
    $('a[href]').each((_, el) => {
      try {
        const u = canonicalizeUrl($(el).attr('href') ?? '', `${origin}/`);
        if (new URL(u).hostname === new URL(origin).hostname && /\/(products?|item|p|shop)\/[^/]+/i.test(u)) links.add(u);
      } catch {
        /* ignore */
      }
    });
    if (entryPage) {
      const $e = cheerio.load(entryPage.html);
      $e('a[href]').each((_, el) => {
        try {
          const u = canonicalizeUrl($e(el).attr('href') ?? '', entryPage!.url);
          if (new URL(u).hostname === new URL(origin).hostname && /\/(products?|item|p|shop)\/[^/]+/i.test(u)) links.add(u);
        } catch {
          /* ignore */
        }
      });
    }
    sampleUrls = [...links].slice(0, opts.maxSampleProducts ?? 3);
    profile.catalogue.productUrlSample = [...links].slice(0, 10);
  }

  // ── 5. sample product pages
  const samples: SampledProduct[] = [];
  let structuredCount = 0;
  let gtinCount = 0;
  let brandCount = 0;
  let skuCount = 0;
  let availCount = 0;
  let shipCount = 0;
  let sizeCount = 0;
  let compareCount = 0;
  let imageCount = 0;
  let descCount = 0;
  let catCount = 0;
  let claimCount = 0;
  let sampleChecked = 0;
  let sampleLowText = 0;
  // pages the site's robots.txt told us not to read: a shop whose product pages are all disallowed is blocked, not "empty"
  let robotsRefused = 0;
  const refusedPaths = new Set<string>();
  for (const u of sampleUrls) {
    try {
      const r = await fetcher.fetch(u, { kind: 'html' });
      sampleChecked++;
      const ch = detectChallenge(r.text(), r.headers, r.status);
      if (ch.detected) {
        profile.access.challengeDetected = true;
        profile.access.challengeKind = ch.kind;
        profile.access.barriers.push(`${ch.kind} appears on product pages`);
        limit('bot_protection', 'blocking', `Product pages are protected by ${ch.kind}; we do not bypass it.`);
        break;
      }
      if (r.status !== 200) continue;
      const ex = extractFromHtml(r.text(), r.url, { siteCurrency: null, now: new Date(), structuredOnly: false });
      for (const c of detectCurrencyFromHtml(r.text())) currencyEvidence.push({ code: c, source: 'product page metadata' });
      const lt = looksJavaScriptRendered(r.text());
      if (lt.rendered) sampleLowText++;
      const p = ex.products[0];
      if (!p) {
        samples.push({ url: u, title: null, price: null, currency: null, availability: null, gtin: null, brand: null, method: null });
        continue;
      }
      const v = p.variants[0]!;
      samples.push({ url: u, title: p.title, price: v.price, currency: v.currency, availability: v.availability, gtin: v.gtin, brand: p.brand, method: p.method });
      if (v.currency) currencyEvidence.push({ code: v.currency, source: `${p.method} on product pages` });
      if (ex.structuredFound) structuredCount++;
      if (v.gtin) gtinCount++;
      if (p.brand) brandCount++;
      if (v.sku) skuCount++;
      if (v.availability !== 'unknown') availCount++;
      if (v.shippingCost !== null) shipCount++;
      if (v.compareAtPrice !== null) compareCount++;
      if (p.imageUrl) imageCount++;
      if (p.description) descCount++;
      if (p.category) catCount++;
      if (v.quantity !== null) claimCount++;
      if (parseQuantity(p.title, p.description).kind !== 'unknown') sizeCount++;
    } catch (e) {
      if (e instanceof AccessDeniedError) {
        profile.access.barriers.push(e.message);
        limit('access_denied', 'blocking', e.message);
        break;
      }
      if (e instanceof FetchError && e.code === 'robots') {
        robotsRefused++;
        try {
          refusedPaths.add(new URL(u).pathname.split('/').slice(0, 2).join('/') || '/');
        } catch {
          /* ignore */
        }
        continue;
      }
      limit('sample_failed', 'info', `A sample product page could not be read (${(e as Error).message}).`);
    }
  }

  // ── 5b. product listing pages: the grids of products every shop shows. Found by structure, not by site-specific rules.
  if (!apiUsable && withPriceCount(samples) === 0 && !profile.rendering.requiresJavaScript) {
    try {
      // the page the customer pointed at is looked at first, then the home page
      const starts = [...(entryPage ? [{ html: entryPage.html, url: entryPage.url, listingUrl: entryPage.url }] : []), { html, url: profile.site.finalUrl ?? `${origin}/`, listingUrl: `${origin}/` }];
      let page = extractListingPage(starts[0]!.html, starts[0]!.url);
      let pageUrl = starts[0]!.listingUrl;
      for (const start of starts.slice(1)) {
        if (page.cards.length >= 3) break;
        const alt = extractListingPage(start.html, start.url);
        if (alt.cards.length >= 3 || alt.categories.length > page.categories.length) {
          page = alt;
          pageUrl = start.listingUrl;
        }
      }
      if (page.cards.length < 3) {
        // the start page may be a landing page: look at a couple of its category links (two extra requests at most)
        for (const cat of page.categories.slice(0, 2)) {
          try {
            const r = await fetcher.fetch(cat, { kind: 'html' });
            if (r.status !== 200) continue;
            const p2 = extractListingPage(r.text(), r.url);
            if (p2.cards.length >= 3) {
              page = p2;
              pageUrl = r.url;
              break;
            }
          } catch (e) {
            if (e instanceof FetchError && e.code === 'robots') {
              robotsRefused++;
              try {
                refusedPaths.add(new URL(cat).pathname.split('/').slice(0, 2).join('/') || '/');
              } catch {
                /* ignore */
              }
            } else if (e instanceof AccessDeniedError) throw e;
          }
        }
      }
      if (page.cards.length >= 3) {
        profile.catalogue.listing = {
          found: true,
          pageUrl: pageUrl === `${origin}/` ? null : pageUrl,
          cardsOnPage: page.cards.length,
          hasPagination: page.next.length > 0,
          categoryLinks: page.categories.length,
          totalHint: page.totalHint,
        };
        for (const card of page.cards.slice(0, 3)) {
          samples.push({ url: card.url, title: card.title, price: card.amount, currency: card.currency, availability: card.availability, gtin: null, brand: null, method: 'listing_card' });
          if (card.currency) currencyEvidence.push({ code: card.currency, source: 'prices on the listing page' });
          if (card.availability !== 'unknown') availCount++;
          if (card.imageUrl) imageCount++;
          if (card.compareAt !== null) compareCount++;
          if (parseQuantity(card.title, null).kind !== 'unknown') sizeCount++;
        }
        if (!profile.catalogue.estimatedProducts && page.totalHint) {
          profile.catalogue.estimatedProducts = page.totalHint;
          profile.catalogue.estimateBasis = 'The listing page reports its size';
        }
      }
    } catch (e) {
      if (e instanceof AccessDeniedError) {
        profile.access.barriers.push(e.message);
        limit('access_denied', 'blocking', e.message);
      }
    }
  }
  profile.sampledProducts = samples;
  const withPrice = samples.filter((s) => s.price !== null).length;
  const n = samples.length;
  const catalogueRefusedByRobots = robotsRefused > 0 && withPrice === 0 && !apiUsable;

  // ── 6. currency
  const codes = [...new Set(currencyEvidence.map((c) => c.code))];
  profile.currency = {
    detected: codes.length === 1 ? codes[0]! : codes.length > 1 ? (mostCommon(currencyEvidence.map((c) => c.code)) ?? null) : null,
    candidates: codes,
    evidence: [...new Set(currencyEvidence.map((c) => `${c.code} (${c.source})`))],
    conflicting: codes.length > 1,
  };
  if (codes.length > 1) {
    profile.conflicts.push(`Different currencies were found on this site (${codes.join(', ')}). Prices will be treated per currency; please confirm the main currency.`);
    limit('currency_conflict', 'warning', `Several currencies appear on this site (${codes.join(', ')}). Review the detected currency before relying on price comparisons.`);
  }
  if (!profile.currency.detected) limit('currency_unknown', 'warning', 'The currency of the prices could not be determined, so prices cannot be converted for comparison until you confirm it.');

  // ── 7. fields matrix
  if (apiUsable) {
    const src = apiUsable.kind === 'shopify_products_json' ? 'Shopify product feed' : 'WooCommerce Store API';
    fields.title = { availability: 'available', coverage: 1, source: src };
    fields.price = { availability: 'available', coverage: 1, source: src };
    fields.availability = { availability: 'available', coverage: 1, source: src, note: 'Available / unavailable only — not a unit count' };
    fields.compare_at_price = { availability: apiProduct.compare ? 'partial' : 'missing', coverage: null, source: src };
    fields.brand = { availability: apiProduct.brand ? 'partial' : 'missing', coverage: null, source: src, note: apiUsable.kind === 'shopify_products_json' ? 'The “vendor” field is sometimes the store name rather than the brand' : undefined };
    fields.sku = { availability: apiProduct.sku ? 'partial' : 'missing', coverage: null, source: src };
    fields.gtin = { availability: 'missing', coverage: 0, source: src, note: 'Barcodes are not published in this feed; matching relies on names, brands and sizes' };
    fields.image = { availability: apiProduct.image ? 'available' : 'missing', coverage: null, source: src };
    fields.variants = { availability: 'available', coverage: null, source: src };
    fields.category = { availability: apiProduct.category ? 'partial' : 'missing', coverage: null, source: src };
    fields.description = { availability: 'available', coverage: null, source: src };
    fields.stock_quantity = {
      availability: apiProduct.stockClaim ? 'partial' : 'missing',
      coverage: null,
      source: src,
      note: apiProduct.stockClaim ? 'Quantity is published only when stock is low (explicit public claim)' : 'Quantities are not public; they need an authorised inventory connection (own shop only)',
    };
    fields.shipping_cost = { availability: 'missing', coverage: 0, source: null, note: 'Shipping cost is not published in product data' };
  } else if (n > 0) {
    const src = 'sampled product pages';
    setCoverage(fields, 'title', samples.filter((s) => s.title).length, n, src);
    setCoverage(fields, 'price', withPrice, n, src);
    setCoverage(fields, 'availability', availCount, n, src);
    setCoverage(fields, 'brand', brandCount, n, src);
    setCoverage(fields, 'sku', skuCount, n, src);
    setCoverage(fields, 'gtin', gtinCount, n, src);
    setCoverage(fields, 'compare_at_price', compareCount, n, src, 'Present only on items currently on sale');
    setCoverage(fields, 'image', imageCount, n, src);
    setCoverage(fields, 'description', descCount, n, src);
    setCoverage(fields, 'category', catCount, n, src);
    setCoverage(fields, 'size_or_weight', sizeCount, n, src, 'Parsed from titles and descriptions');
    setCoverage(fields, 'shipping_cost', shipCount, n, src);
    setCoverage(fields, 'stock_quantity', claimCount, n, src, 'Only explicit “only N left” statements count');
    fields.variants = { availability: 'unknown', coverage: null, source: src };
  }
  fields.currency = profile.currency.detected
    ? { availability: profile.currency.conflicting ? 'partial' : 'available', coverage: null, source: profile.currency.evidence.join('; ') }
    : { availability: 'missing', coverage: 0, source: null };
  if (apiUsable) {
    const ps = samples.filter((s) => s.title);
    if (ps.length) fields.size_or_weight = { availability: level(sizeCount / Math.max(n, 1)), coverage: null, source: 'product titles', note: 'Parsed from titles' };
    else fields.size_or_weight = { availability: 'unknown', coverage: null, source: null, note: 'Parsed from titles when products are collected' };
  }
  profile.fields = fields;

  // ── 8. rendering assessment
  if (n > 0 && withPrice === 0 && sampleLowText === sampleChecked && sampleChecked > 0) {
    profile.rendering = { requiresJavaScript: true, evidence: 'Sampled product pages contain no server-rendered product data' };
  }
  if (profile.platform.id === 'freshop') {
    limit('freshop_storefront', 'warning', 'Products are served by a Freshop online-grocery storefront. Its product data is loaded by JavaScript from the vendor’s own service, so plain page requests contain no prices. Collecting it would need browser rendering or access arranged with the store/vendor — we do not reverse-engineer private APIs.');
  }
  if (profile.rendering.requiresJavaScript && !opts.capabilities.browserEnabled) {
    limit('js_required', 'warning', 'Products appear only after the page is rendered with JavaScript. Headless-browser rendering is not enabled, so product data is unavailable.');
  }

  // ── 9. strategy + effort
  const ranked = rankConnectors(profile, opts.capabilities).filter((r) => r.score >= 0.3);
  profile.strategy = {
    recommended: ranked.map((r) => r.id),
    primary: ranked[0]?.id ?? null,
    reason: ranked[0]?.reason ?? 'No reliable collection method was found for this site',
  };
  if (apiUsable) {
    const pageSize = apiUsable.kind === 'shopify_products_json' ? 250 : 100;
    const total = profile.catalogue.estimatedProducts;
    profile.effort.requestsEstimate = total ? Math.ceil(total / pageSize) + 2 : null;
    profile.effort.notes = 'A machine-readable feed lets the whole catalogue be refreshed in a handful of requests.';
  } else if (profile.catalogue.estimatedProducts) {
    profile.effort.requestsEstimate = profile.catalogue.estimatedProducts + profile.catalogue.sitemaps.length;
    profile.effort.notes = 'Each product page is one request; large catalogues are refreshed on a rolling basis within the request budget.';
  }
  if (profile.effort.requestsEstimate !== null) {
    profile.effort.minutesEstimate = Math.max(1, Math.round((profile.effort.requestsEstimate * (crawlDelayMs + (profile.site.responseTimeMs ?? 500))) / 60_000));
  }
  if (profile.effort.requestsEstimate && profile.effort.requestsEstimate > opts.defaultMaxRequests) {
    limit('rolling_refresh', 'info', `Refreshing this catalogue needs about ${profile.effort.requestsEstimate} requests, above the per-run budget of ${opts.defaultMaxRequests}. Products are refreshed on a rolling basis; each report states how fresh each price is.`);
  }

  // ── 10. limitations (plain language)
  if (fields.gtin.availability === 'missing') limit('no_gtin', 'info', 'Barcodes (GTIN/EAN/UPC) are not published, so product matching relies on brand, name and size — more matches will need review.');
  if (fields.stock_quantity.availability !== 'available') limit('no_stock_quantity', 'info', 'Stock quantities are not public. For your own shop, an authorised inventory connection can provide exact counts; for competitors only availability is shown.');
  if (fields.brand.availability === 'missing') limit('no_brand', 'info', 'Brands are not published, which makes product matching less certain.');
  if (!apiUsable && n > 0 && structuredCount < n) limit('weak_structured_data', 'info', 'Some product pages publish no structured data, so layout-based extraction (lower confidence) is used.');
  if (n < 2 && !apiUsable) limit('few_samples', 'info', 'Fewer than two product pages could be sampled, so field coverage is a rough indication only.');
  if (profile.promotions.flyerLinks.length) limit('flyers_found', 'info', `${profile.promotions.flyerLinks.length} promotional flyer PDF link(s) were found; text-based flyers can be read automatically.`);

  // ── 11. status + summary
  const canEnumerate = !!apiUsable || sitemapUrlsFound > 0 || profile.catalogue.productUrlSample.length > 0 || !!profile.catalogue.listing?.found;
  const hasPrices = !!apiUsable || withPrice > 0;
  let status: CapabilityStatus;
  let summary: string;
  const platformLabel = profile.platform.id === 'unknown' ? 'a custom or unrecognised platform' : profile.platform.id;
  if (profile.access.challengeDetected) {
    status = 'blocked';
    summary = `Product pages are protected by ${profile.access.challengeKind}. We do not bypass bot protection, so product collection is not possible.`;
  } else if (catalogueRefusedByRobots) {
    status = 'blocked';
    const where = [...refusedPaths].slice(0, 3).join(', ');
    limit('robots_disallow', 'blocking', `The website's robots.txt does not permit automated reading of its product pages${where ? ` (${where})` : ''}, so they are not collected.`);
    summary = `The website's robots.txt does not permit automated reading of its product pages${where ? ` (${where})` : ''}. We respect that and do not collect them; nothing was collected from this website.`;
  } else if (!hasPrices) {
    status = 'limited';
    summary = profile.rendering.requiresJavaScript
      ? 'This shop builds its pages with JavaScript, so prices are not visible to a plain request. Only promotions, social links and general site information could be gathered.'
      : 'We could reach the website (' + platformLabel + ') but could not find product prices on the sampled pages. Only general information, promotions and social links are available.';
  } else if (apiUsable && profile.currency.detected && !profile.currency.conflicting) {
    status = 'full';
    summary = `Full access: a public product feed on ${platformLabel} exposes prices and availability for the whole catalogue${profile.catalogue.estimatedProducts ? ` (about ${profile.catalogue.estimatedProducts} products)` : ''}. Exact stock counts are not public.`;
  } else if (!apiUsable && n > 0 && withPrice === n && structuredCount === n && canEnumerate && profile.currency.detected && !profile.currency.conflicting && availCount / n >= 0.5) {
    status = 'full';
    summary = `Full access: product pages publish structured prices and availability${profile.catalogue.estimatedProducts ? ` and about ${profile.catalogue.estimatedProducts} products are listed in sitemaps` : ''}.`;
  } else if (!apiUsable && profile.catalogue.listing?.found && withPrice > 0 && structuredCount < n) {
    status = 'partial';
    summary = `Partial access: this shop has no product feed or structured product data, so its listing pages are read (names, prices and availability), following its own pagination and category links${profile.catalogue.listing.totalHint ? ` (it lists about ${profile.catalogue.listing.totalHint} products)` : ''}. Brands, barcodes and descriptions are not read from listings${profile.currency.detected ? '' : ', and the currency needs your confirmation'}.`;
  } else {
    status = 'partial';
    const gaps = [!profile.currency.detected && 'currency', fields.availability.availability !== 'available' && 'availability', !canEnumerate && 'a complete product list'].filter(Boolean);
    summary = `Partial access: prices can be collected${gaps.length ? `, but ${gaps.join(' and ')} could not be determined reliably` : ' with some gaps'}. Results will be flagged where fields are missing.`;
  }
  return finishWith(profile, status, summary, started, fetcher, reqStart);
}

const withPriceCount = (samples: { price: number | null }[]) => samples.filter((s) => s.price !== null).length;

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
