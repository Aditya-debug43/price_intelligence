import * as cheerio from 'cheerio';
import { canonicalizeUrl, UNTRUSTED_PREAMBLE, validateLlmExtraction, wrapUntrusted } from '@ci/core';
import type { ConnectorId, SiteProfileData } from '@ci/shared';
import { AccessDeniedError, FetchError } from './safe-fetch.ts';
import { detectChallenge, detectLoginWall } from './challenge.ts';
import { httpFailure, isTransientCode } from './feed-errors.ts';
import { buildQuality, extractFromHtml, visibleText, EXTRACT_VERSION } from './extract.ts';
import { extractListingPage } from './listing.ts';
import { discoverFromSitemaps, looksLikeProductUrl } from './sitemap.ts';
import type { ConnectorBatch, ConnectorContext, EvidenceDoc, ExtractedProduct, PageConnector } from './types.ts';

/**
 * URL-frontier connectors. Discovery uses sitemaps (or, failing that, navigation links); extraction runs the
 * cascade JSON-LD → microdata → Open Graph, then (per connector) layout heuristics, a rendered browser DOM, or an
 * evidence-validated LLM fallback. These connectors are stateless: the scan runner owns the resumable crawl queue.
 */

export type PageStrategy = 'structured' | 'heuristic' | 'browser' | 'llm';

async function discoverSitemapRoots(ctx: ConnectorContext): Promise<string[]> {
  const roots: string[] = [];
  const p = ctx.profile;
  if (p) {
    roots.push(...p.catalogue.sitemaps.filter((s) => s.kind === 'index' || s.kind === 'products').map((s) => s.url));
    roots.push(...p.access.robots.sitemaps);
  }
  if (!roots.length) roots.push(`${ctx.site.origin}/sitemap.xml`);
  return [...new Set(roots)];
}

async function discoverFromLinks(ctx: ConnectorContext, warnings: string[]): Promise<{ url: string; lastmod: string | null }[]> {
  const found = new Map<string, string | null>();
  const home = await ctx.fetcher.fetch(`${ctx.site.origin}/`, { kind: 'html' });
  const $ = cheerio.load(home.text());
  const internal = (href: string | undefined) => {
    if (!href) return null;
    try {
      const u = new URL(href, `${ctx.site.origin}/`);
      return u.hostname === ctx.site.hostname ? canonicalizeUrl(u.toString()) : null;
    } catch {
      return null;
    }
  };
  const categories = new Set<string>();
  $('a[href]').each((_, el) => {
    const u = internal($(el).attr('href'));
    if (!u) return;
    if (/\/(product|products|item|p)\//i.test(u)) found.set(u, null);
    else if (/\/(collections?|categor(y|ies)|shop|departments?|aisle)\b/i.test(u)) categories.add(u);
  });
  for (const cat of [...categories].slice(0, 15)) {
    for (let page = 1; page <= 3; page++) {
      try {
        const res = await ctx.fetcher.fetch(page === 1 ? cat : `${cat}${cat.includes('?') ? '&' : '?'}page=${page}`, { kind: 'html' });
        if (res.status !== 200) break;
        const $c = cheerio.load(res.text());
        let added = 0;
        $c('a[href]').each((_, el) => {
          const u = internal($c(el).attr('href'));
          if (u && looksLikeProductUrl(u) && /\/(product|products|item|p)\//i.test(u) && !found.has(u)) {
            found.set(u, null);
            added++;
          }
        });
        if (!added) break;
      } catch (e) {
        warnings.push(`Category page ${cat}: ${(e as Error).message}`);
        break;
      }
    }
  }
  warnings.push('No sitemap was usable, so products were discovered through navigation links; coverage may be incomplete.');
  return [...found.entries()].map(([url, lastmod]) => ({ url, lastmod }));
}

function makeDocument(res: { url: string; fetchedAt: Date; status: number; contentType: string; contentHash: string; body: Buffer }, snippet: string, keep: boolean): EvidenceDoc {
  return { url: res.url, fetchedAt: res.fetchedAt, httpStatus: res.status, contentType: res.contentType, contentHash: res.contentHash, bytes: res.body.length, snippet, body: keep ? res.body : undefined };
}

async function llmExtract(ctx: ConnectorContext, url: string, html: string): Promise<ExtractedProduct | null> {
  const llm = ctx.llm;
  if (!llm?.available) return null;
  const text = visibleText(html, 8000);
  let raw: string;
  try {
    raw = await llm.complete({
      system: `${UNTRUSTED_PREAMBLE}\nExtract the single main product on the page as JSON: {"title":string,"price":number|null,"currency":string(ISO 4217)|null,"compareAtPrice":number|null,"availability":"in_stock"|"out_of_stock"|"unknown","brand":string|null,"sku":string|null}. Use null when the page does not state a value. Never guess.`,
      user: wrapUntrusted(`URL: ${url}\n\n${text}`),
      maxTokens: 400,
    });
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
  const check = validateLlmExtraction(parsed, text);
  if (!check.ok || !check.product) {
    ctx.log('LLM extraction rejected', { url, problems: check.problems });
    return null;
  }
  const p = check.product;
  const variants = [
    {
      variantKey: 'default', sku: p.sku ?? null, gtin: null, title: null, options: {}, price: p.price, compareAtPrice: p.compareAtPrice ?? null,
      currency: p.currency ?? ctx.siteCurrency, shippingCost: null, availability: p.availability, quantity: null, quantitySource: null, url: canonicalizeUrl(url),
    },
  ];
  return {
    url: canonicalizeUrl(url), externalId: null, title: p.title, brand: p.brand ?? null, manufacturer: null, model: null, mpn: null,
    description: null, category: null, imageUrl: null, attrs: { llmProvider: llm.id }, variants, method: 'llm_fallback', methodVersion: EXTRACT_VERSION,
    observedAt: ctx.now(), evidenceIndex: 0,
    quality: buildQuality({ title: p.title, brand: p.brand ?? null, imageUrl: null, variants, notes: ['AI-assisted extraction; every value was verified against the page text'] }),
  };
}

export function makePageConnector(def: { id: ConnectorId; label: string; strategy: PageStrategy; applicability: (p: SiteProfileData) => { score: number; reason: string } }): PageConnector {
  const version = '1.0';
  return {
    id: def.id,
    version,
    label: def.label,
    kind: 'pages',
    applicability: def.applicability,

    async discover(ctx) {
      const warnings: string[] = [];
      let urls: { url: string; lastmod: string | null }[] = [];
      let estimated: number | null = null;
      try {
        const roots = await discoverSitemapRoots(ctx);
        const d = await discoverFromSitemaps(ctx.fetcher, roots, { maxSitemaps: 40, maxUrls: 100_000, productOnly: true });
        urls = d.urls;
        warnings.push(...d.warnings);
        // A sitemap file that could not be read (or was left unread) means the list of pages may be missing some: never a complete enumeration.
        estimated = d.truncated || d.incomplete ? null : d.urls.length;
        if (d.incomplete && !d.truncated) warnings.push('Some sitemap files could not be read, so the list of pages may be incomplete.');
      } catch (e) {
        if (e instanceof AccessDeniedError) throw e;
        // The website is busy or asked us to slow down: that is not "no sitemap" and must not send the run to a more request-hungry method.
        if (isTransientCode((e as { code?: unknown }).code)) throw e;
        warnings.push(`Sitemap discovery failed: ${(e as Error).message}`);
      }
      if (urls.length === 0) {
        urls = await discoverFromLinks(ctx, warnings);
        estimated = null;
      }
      return { urls, warnings, estimatedTotal: estimated };
    },

    async extractPage(ctx, url): Promise<ConnectorBatch> {
      const warnings: string[] = [];
      const res = await ctx.fetcher.fetch(url, { kind: 'html' });
      const empty: ConnectorBatch = { products: [], evidence: [], cursor: null, progress: { estimatedTotal: null, discovered: 0 }, warnings };
      if (res.status === 404 || res.status === 410) {
        warnings.push(`${url} returned HTTP ${res.status}`);
        return { ...empty, evidence: [makeDocument(res, `HTTP ${res.status}`, false)] };
      }
      const html = res.text();
      const challenge = detectChallenge(html, res.headers, res.status);
      if (challenge.detected) throw new AccessDeniedError(`${challenge.kind} detected; automated collection stopped`, url);
      if (res.status === 401 || res.status === 403) throw new AccessDeniedError(`HTTP ${res.status} on ${url}`, url);
      // A throttled or briefly unavailable page is an error to retry, not an empty page that would be counted as read.
      if (res.status === 408 || res.status === 429 || res.status >= 500) throw httpFailure(res, `The page ${url}`);
      if (res.status < 200 || res.status >= 300) {
        warnings.push(`${url} returned HTTP ${res.status}`);
        return empty;
      }
      if (detectLoginWall(res.url, html)) throw new AccessDeniedError('A login is required to view this page', url);

      const opts = { siteCurrency: ctx.siteCurrency, now: ctx.now(), evidenceIndex: 0 };
      let ex = extractFromHtml(html, res.url, { ...opts, structuredOnly: def.strategy === 'structured' });

      if (ex.products.length === 0 && def.strategy === 'browser' && ctx.browser?.available) {
        const rendered = await ctx.browser.render(url, { timeoutMs: 25_000 });
        if (rendered) {
          ex = extractFromHtml(rendered.html, rendered.finalUrl, { ...opts, structuredOnly: false });
          for (const p of ex.products) {
            p.method = 'browser_rendered';
            p.methodVersion = version;
          }
        }
      }
      if (ex.products.length === 0 && def.strategy === 'llm') {
        const p = await llmExtract(ctx, url, html);
        if (p) ex = { products: [p], snippet: 'AI-assisted extraction (validated against page text)', structuredFound: false };
      }
      const evidence = [makeDocument(res, ex.snippet, ex.products.length > 0)];
      return { products: ex.products, evidence, cursor: null, progress: { estimatedTotal: null, discovered: ex.products.length }, warnings };
    },
  };
}

const STRUCTURED_METHODS = new Set(['json_ld', 'microdata', 'opengraph']);
/** Share of sampled product pages whose price came from STRUCTURED data (not layout heuristics). */
const structuredCoverage = (p: SiteProfileData) =>
  p.sampledProducts.length ? p.sampledProducts.filter((s) => s.price !== null && s.method !== null && STRUCTURED_METHODS.has(s.method)).length / p.sampledProducts.length : 0;

export const structuredDataConnector = makePageConnector({
  id: 'sitemap-structured-data',
  label: 'Sitemap + structured product data (JSON-LD / microdata)',
  strategy: 'structured',
  applicability: (p) =>
    structuredCoverage(p) >= 0.6 && p.catalogue.sitemaps.some((s) => (s.urlCount ?? 0) > 0)
      ? { score: 0.8, reason: 'Product pages publish schema.org structured data and a sitemap lists them' }
      : structuredCoverage(p) >= 0.6
        ? { score: 0.6, reason: 'Product pages publish structured data; products are found by following links' }
        : { score: 0.1, reason: 'Sampled product pages do not reliably include structured data' },
});

export const htmlGenericConnector = makePageConnector({
  id: 'html-generic',
  label: 'Server-rendered HTML heuristics',
  strategy: 'heuristic',
  applicability: (p) =>
    p.rendering.requiresJavaScript
      ? { score: 0.05, reason: 'Pages are rendered with JavaScript; plain HTML contains no product data' }
      : p.sampledProducts.some((s) => s.price !== null && s.method !== 'listing_card')
        ? { score: 0.5, reason: 'Prices were located in the server-rendered HTML of sampled pages' }
        : { score: 0.15, reason: 'Layout heuristics might work but prices were not located in sampled pages' },
});

/**
 * Collects a shop that has no feed, sitemap or structured data by reading its product listing pages — the grids every shop shows — and
 * following the site's own "next page" and category links until they run out. The page frontier is the resumable crawl queue; the
 * run is complete only when that queue ran dry within the request budget.
 */
export const listingConnector: PageConnector = {
  id: 'listing-crawl',
  version: '1.0',
  label: 'Product listing pages (pagination and categories)',
  kind: 'pages',
  refreshByDiscovery: true,
  applicability: (p) =>
    p.rendering.requiresJavaScript
      ? { score: 0, reason: 'Pages are rendered with JavaScript; plain HTML contains no product cards' }
      : p.catalogue.listing?.found
        ? p.catalogue.sitemaps.some((s) => (s.urlCount ?? 0) > 0) || p.sampledProducts.some((s) => s.method !== 'listing_card' && s.price !== null)
          ? { score: 0.4, reason: 'Product cards with prices are shown on listing pages (an alternative to reading each product page)' }
          : { score: 0.55, reason: 'Product cards with prices are shown on listing pages; products are read from them, following the site’s pagination and category links' }
        : { score: 0, reason: 'No product listing pages were recognised' },

  async discover(ctx) {
    const seeds = new Set<string>([canonicalizeUrl(`${ctx.site.origin}/`)]);
    const listing = ctx.profile?.catalogue.listing;
    if (listing?.pageUrl) seeds.add(canonicalizeUrl(listing.pageUrl));
    // the page the customer pointed at is where their shop starts, even when the home page is only a landing page
    const entry = ctx.profile?.site.entryPath;
    if (entry) seeds.add(canonicalizeUrl(`${ctx.site.origin}${entry}`));
    return {
      urls: [...seeds].map((url) => ({ url, kind: 'listing' as const, priority: 80 })),
      warnings: ['No feed or sitemap was usable, so products are read from the shop’s listing pages by following its own pagination and category links.'],
      estimatedTotal: listing?.totalHint ?? null,
      crawlsToCompletion: true,
    };
  },

  async extractPage(ctx, url): Promise<ConnectorBatch> {
    const warnings: string[] = [];
    const res = await ctx.fetcher.fetch(url, { kind: 'html' });
    const empty: ConnectorBatch = { products: [], evidence: [], cursor: null, progress: { estimatedTotal: null, discovered: 0 }, warnings };
    if (res.status === 404 || res.status === 410) return { ...empty, warnings: [`${url} returned HTTP ${res.status}`], evidence: [makeDocument(res, `HTTP ${res.status}`, false)] };
    const html = res.text();
    const challenge = detectChallenge(html, res.headers, res.status);
    if (challenge.detected) throw new AccessDeniedError(`${challenge.kind} detected; automated collection stopped`, url);
    if (res.status === 401 || res.status === 403) throw new AccessDeniedError(`HTTP ${res.status} on ${url}`, url);
    if (res.status < 200 || res.status >= 300) return { ...empty, warnings: [`${url} returned HTTP ${res.status}`] };
    if (detectLoginWall(res.url, html)) throw new AccessDeniedError('A login is required to view this page', url);

    // a start page must show a real grid to count as a listing; any page followed from a listing (a category, a later page) may hold fewer
    const found = ctx.profile?.catalogue.listing?.pageUrl;
    const isStart = new URL(url).pathname === '/' || (!!found && url === canonicalizeUrl(found));
    const page = extractListingPage(html, res.url, { minCards: isStart ? 3 : 1 });
    const now = ctx.now();
    const products: ExtractedProduct[] = page.cards.map((card) => {
      const currency = card.currency ?? ctx.siteCurrency;
      const variants = [
        {
          variantKey: 'default', sku: null, gtin: null, title: null, options: {}, price: card.amount, compareAtPrice: card.compareAt, currency,
          shippingCost: null, availability: card.availability, quantity: null, quantitySource: null, url: card.url,
        },
      ];
      return {
        url: card.url, externalId: null, title: card.title, brand: null, manufacturer: null, model: null, mpn: null, description: null, category: null,
        imageUrl: card.imageUrl, attrs: { listingPage: res.url, ...(card.ambiguousSymbol && !currency ? { ambiguousSymbol: card.ambiguousSymbol } : {}) }, variants,
        method: 'listing_card', methodVersion: '1.0', observedAt: now, evidenceIndex: 0,
        quality: buildQuality({ title: card.title, brand: null, imageUrl: card.imageUrl, variants, notes: ['Read from a listing page (no product page was opened): name, price and availability only'] }),
      };
    });
    const isSeed = isStart;
    const discovered: NonNullable<ConnectorBatch['discoveredUrls']> = [];
    if (products.length || isSeed) {
      for (const n of page.next) discovered.push({ url: n, kind: 'listing', priority: 70 });
      // category pages are followed from pages that show products and from the start pages; a page with nothing on it is a dead end
      for (const cat of page.categories) discovered.push({ url: cat, kind: 'listing', priority: 50 });
    }
    return {
      products,
      evidence: [makeDocument(res, products.length ? `${products.length} product cards read from the listing page` : 'No product cards on this page', products.length > 0)],
      cursor: null,
      progress: { estimatedTotal: page.totalHint, discovered: products.length },
      warnings,
      discoveredUrls: discovered,
    };
  },
};

export const browserConnector = makePageConnector({
  id: 'browser-rendered',
  label: 'Headless browser rendering',
  strategy: 'browser',
  applicability: (p) =>
    p.rendering.requiresJavaScript ? { score: 0.55, reason: 'The site needs JavaScript rendering to show products (requires browser rendering to be enabled)' } : { score: 0, reason: 'Rendering is not needed' },
});

export const llmFallbackConnector = makePageConnector({
  id: 'llm-fallback',
  label: 'Evidence-validated AI extraction (fallback)',
  strategy: 'llm',
  applicability: () => ({ score: 0.05, reason: 'Last-resort fallback when no structured extraction works (requires an AI provider)' }),
});

export function isRobotsOrAccessError(e: unknown): boolean {
  return e instanceof AccessDeniedError || (e instanceof FetchError && e.code === 'robots');
}
