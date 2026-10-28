import { XMLParser } from 'fast-xml-parser';
import { canonicalizeUrl } from '@ci/core';
import type { SitemapSummary } from '@ci/shared';
import { httpFailure, isTransientCode } from './feed-errors.ts';
import type { SafeFetcher } from './safe-fetch.ts';

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, trimValues: true, parseTagValue: false });

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

export interface ParsedSitemap {
  kind: 'index' | 'urlset' | 'unknown';
  entries: SitemapEntry[];
}

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export function parseSitemap(xml: string): ParsedSitemap {
  const trimmed = xml.trim();
  if (!trimmed.startsWith('<')) {
    // Plain-text sitemap: one URL per line.
    const urls = trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https?:\/\//i.test(l));
    return { kind: urls.length ? 'urlset' : 'unknown', entries: urls.map((loc) => ({ loc, lastmod: null })) };
  }
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { kind: 'unknown', entries: [] };
  }
  const idx = doc['sitemapindex'] as { sitemap?: unknown } | undefined;
  if (idx) {
    return {
      kind: 'index',
      entries: arr(idx.sitemap as { loc?: string; lastmod?: string }[] | undefined)
        .map((s) => ({ loc: String(s?.loc ?? ''), lastmod: s?.lastmod ? String(s.lastmod) : null }))
        .filter((e) => e.loc),
    };
  }
  const set = doc['urlset'] as { url?: unknown } | undefined;
  if (set) {
    return {
      kind: 'urlset',
      entries: arr(set.url as { loc?: string; lastmod?: string }[] | undefined)
        .map((u) => ({ loc: String(u?.loc ?? ''), lastmod: u?.lastmod ? String(u.lastmod) : null }))
        .filter((e) => e.loc),
    };
  }
  return { kind: 'unknown', entries: [] };
}

export function classifySitemapUrl(url: string): SitemapSummary['kind'] {
  let name = url.toLowerCase();
  try {
    name = new URL(url).pathname.split('/').pop() ?? name;
  } catch {
    /* use the raw string */
  }
  // "sitemap" itself contains "item"; strip it so it cannot cause false product matches.
  name = name.replace(/sitemap/g, ' ');
  // WooCommerce publishes its category pages as "product_cat-sitemap.xml": a list of category pages, not of products.
  if (/collection|categor|product[_-]?cat\b|brand|tag/.test(name)) return 'collections';
  if (/page|blog|post|article|news|image|video/.test(name)) return 'pages';
  if (/product|catalog|sku|item|shop/.test(name)) return 'products';
  return 'other';
}

const PRODUCT_PATH = /\/(products?|p|item|items|producto|productos|product-page|shop)\/[^/]+/i;
const NON_PRODUCT = /\/(blog|blogs|news|article|articles|category|categories|collections?|tag|tags|cart|checkout|account|login|register|contact|about|faq|policies|pages?|search|wp-content|wp-admin|feed|cdn)(\/|$)/i;
const FILE_EXT = /\.(jpe?g|png|gif|webp|svg|css|js|pdf|zip|xml|mp4)$/i;
/** Site utility pages that a generic URL heuristic must never mistake for products (e.g. /sitemap.html, /privacy). */
const UTILITY_PAGE = /\/(sitemap|privacy|privacy-policy|terms|terms-and-conditions|conditions|search|faq|help|support|login|signin|register|careers|stores?|store-locator|locations?|newsletter|gift-cards?|shipping|returns|refund)(\.html?|\.php|\/|$)/i;

export function looksLikeProductUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (FILE_EXT.test(u.pathname)) return false;
    if (PRODUCT_PATH.test(u.pathname) || /[?&](p|product|product_id)=\d+/.test(u.search)) return true;
    if (NON_PRODUCT.test(u.pathname) || UTILITY_PAGE.test(u.pathname) || u.pathname === '/') return false;
    // Generic deeper paths ("/my-product-name") are plausible product pages; the extractor decides.
    return u.pathname.split('/').filter(Boolean).length >= 1;
  } catch {
    return false;
  }
}

export interface DiscoveredUrls {
  urls: { url: string; lastmod: string | null }[];
  sitemaps: SitemapSummary[];
  warnings: string[];
  truncated: boolean;
  /** A sitemap file could not be read, or was left unread: the list of pages may be missing some. */
  incomplete: boolean;
}

/** Walks sitemap indexes (product sitemaps first) and collects candidate product URLs within the given limits. */
export async function discoverFromSitemaps(
  fetcher: SafeFetcher,
  roots: string[],
  opts: { maxSitemaps: number; maxUrls: number; productOnly: boolean },
): Promise<DiscoveredUrls> {
  const summaries: SitemapSummary[] = [];
  const warnings: string[] = [];
  const seenSitemaps = new Set<string>();
  const urls = new Map<string, string | null>();
  let queue: string[] = [...roots];
  let fetched = 0;
  let truncated = false;

  while (queue.length && fetched < opts.maxSitemaps) {
    const next = queue.shift()!;
    if (seenSitemaps.has(next)) continue;
    seenSitemaps.add(next);
    fetched++;
    let parsed: ParsedSitemap;
    try {
      const res = await fetcher.fetch(next, { kind: 'xml', maxBytes: 25 * 1024 * 1024 });
      // Busy or asking us to slow down: a retryable error for the whole collection, not a sitemap that does not exist.
      if (res.status === 408 || res.status === 429 || res.status >= 500) throw httpFailure(res, `The sitemap ${next}`);
      if (res.status < 200 || res.status >= 300) {
        summaries.push({ url: next, kind: classifySitemapUrl(next), urlCount: null, failed: true });
        warnings.push(`Sitemap ${next} returned HTTP ${res.status}`);
        continue;
      }
      parsed = parseSitemap(res.text());
    } catch (e) {
      if (isTransientCode((e as { code?: unknown }).code)) throw e;
      summaries.push({ url: next, kind: classifySitemapUrl(next), urlCount: null, failed: true });
      warnings.push(`Sitemap ${next} could not be read: ${(e as Error).message}`);
      continue;
    }
    if (parsed.kind === 'index') {
      summaries.push({ url: next, kind: 'index', urlCount: parsed.entries.length });
      const kids = parsed.entries.map((e) => e.loc);
      const productKids = kids.filter((k) => classifySitemapUrl(k) === 'products');
      const ordered = opts.productOnly && productKids.length ? productKids : kids;
      queue = [...ordered, ...queue];
    } else if (parsed.kind === 'urlset') {
      const kind = classifySitemapUrl(next);
      summaries.push({ url: next, kind, urlCount: parsed.entries.length });
      if (opts.productOnly && (kind === 'collections' || kind === 'pages')) continue;
      for (const e of parsed.entries) {
        if (!looksLikeProductUrl(e.loc)) continue;
        const canonical = (() => {
          try {
            return canonicalizeUrl(e.loc);
          } catch {
            return null;
          }
        })();
        if (!canonical || urls.has(canonical)) continue;
        if (urls.size >= opts.maxUrls) {
          truncated = true;
          break;
        }
        urls.set(canonical, e.lastmod);
      }
    } else {
      summaries.push({ url: next, kind: classifySitemapUrl(next), urlCount: null, failed: true });
      warnings.push(`Sitemap ${next} is not a recognisable sitemap`);
    }
  }
  if (queue.length) warnings.push(`Sitemap limit reached; ${queue.length} sitemap file(s) were not read`);
  const incomplete = summaries.some((s) => s.failed) || queue.length > 0;
  return { urls: [...urls.entries()].map(([url, lastmod]) => ({ url, lastmod })), sitemaps: summaries, warnings, truncated, incomplete };
}
