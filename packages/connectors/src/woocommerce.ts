import * as cheerio from 'cheerio';
import { canonicalizeUrl, fromMinorUnits } from '@ci/core';
import type { Availability, SiteProfileData } from '@ci/shared';
import { httpFailure } from './feed-errors.ts';
import { buildQuality } from './extract.ts';
import type { ConnectorBatch, ConnectorContext, EvidenceDoc, ExtractedProduct, ExtractedVariant, FeedConnector } from './types.ts';

/**
 * WooCommerce Store API (public, unauthenticated): GET /wp-json/wc/store/v1/products
 * Prices are integers in minor units (`currency_minor_unit`). `X-WP-Total` discloses the catalogue size.
 * `low_stock_remaining` is an explicit public quantity claim that WooCommerce publishes only when stock is low.
 */
const VERSION = '1.0';
const PER_PAGE = 100;

interface WooPrices {
  price?: string;
  regular_price?: string;
  sale_price?: string;
  currency_code?: string;
  currency_minor_unit?: number;
}

interface WooProduct {
  id: number;
  name: string;
  slug?: string;
  parent?: number;
  type?: string;
  permalink: string;
  sku?: string;
  short_description?: string;
  description?: string;
  on_sale?: boolean;
  prices?: WooPrices;
  price_html?: string;
  images?: { src: string }[];
  categories?: { name: string }[];
  brands?: { name: string }[];
  is_in_stock?: boolean;
  is_purchasable?: boolean;
  low_stock_remaining?: number | null;
  stock_availability?: { text?: string; class?: string };
  variations?: { id: number; attributes: { name: string; value: string }[] }[];
  attributes?: { name: string; terms?: { name: string }[] }[];
}

const text = (html: string | undefined | null) => {
  if (!html) return null;
  const t = cheerio.load(`<div>${html}</div>`)('div').text().replace(/\s+/g, ' ').trim();
  return t || null;
};

function variantFrom(p: WooProduct, key: string, title: string | null, options: Record<string, string>, ctxCurrency: string | null, url: string): ExtractedVariant {
  const pr = p.prices ?? {};
  const mu = pr.currency_minor_unit ?? 2;
  const price = fromMinorUnits(pr.price, mu);
  const regular = fromMinorUnits(pr.regular_price, mu);
  const low = typeof p.low_stock_remaining === 'number' ? p.low_stock_remaining : null;
  let availability: Availability = p.is_in_stock === true ? 'in_stock' : p.is_in_stock === false ? 'out_of_stock' : 'unknown';
  if (availability === 'in_stock' && low !== null) availability = 'low_quantity_claim';
  return {
    variantKey: key,
    sku: p.sku?.trim() || null,
    gtin: null,
    title,
    options,
    price,
    compareAtPrice: regular !== null && price !== null && regular > price ? regular : null,
    currency: pr.currency_code?.toUpperCase() ?? ctxCurrency,
    shippingCost: null,
    availability,
    quantity: low,
    quantitySource: low !== null ? 'public_claim' : null,
    url,
  };
}

export function mapWooProduct(p: WooProduct, ctx: Pick<ConnectorContext, 'siteCurrency' | 'now'>, evidenceIndex: number, variationProducts: WooProduct[] = []): ExtractedProduct | null {
  if (!p?.name || !p.permalink) return null;
  const url = canonicalizeUrl(p.permalink);
  let variants: ExtractedVariant[];
  const notes: string[] = [];
  if (p.type === 'variable' && variationProducts.length) {
    variants = variationProducts.map((vp) => {
      const attrs: Record<string, string> = {};
      for (const a of p.variations?.find((v) => v.id === vp.id)?.attributes ?? []) attrs[a.name] = a.value;
      return variantFrom(vp, String(vp.id), Object.values(attrs).join(' / ') || null, attrs, ctx.siteCurrency, url);
    });
  } else if (p.type === 'variable') {
    // Variation details were not fetched: don't pretend a single price applies.
    const v = variantFrom(p, String(p.id), null, {}, ctx.siteCurrency, url);
    v.price = null;
    v.compareAtPrice = null;
    variants = [v];
    notes.push('Variable product: variation prices were not retrieved');
  } else {
    variants = [variantFrom(p, String(p.id), null, {}, ctx.siteCurrency, url)];
  }
  const brand = p.brands?.[0]?.name ?? null;
  return {
    url,
    externalId: String(p.id),
    title: cheerio.load(`<i>${p.name}</i>`)('i').text(),
    brand,
    manufacturer: null,
    model: null,
    mpn: null,
    description: text(p.short_description) ?? text(p.description),
    category: p.categories?.[0]?.name ?? null,
    imageUrl: p.images?.[0]?.src ?? null,
    attrs: { type: p.type ?? 'simple', attributes: (p.attributes ?? []).map((a) => ({ name: a.name, values: (a.terms ?? []).map((t) => t.name) })) },
    variants,
    method: 'woocommerce_store_api',
    methodVersion: VERSION,
    observedAt: ctx.now(),
    evidenceIndex,
    quality: buildQuality({ title: p.name, brand, imageUrl: p.images?.[0]?.src ?? null, variants, notes }),
  };
}

function ev(res: { url: string; fetchedAt: Date; status: number; contentType: string; contentHash: string; body: Buffer }, snippet: string): EvidenceDoc {
  return { url: res.url, fetchedAt: res.fetchedAt, httpStatus: res.status, contentType: res.contentType, contentHash: res.contentHash, bytes: res.body.length, snippet };
}

async function fetchVariations(ctx: ConnectorContext, parentId: number): Promise<WooProduct[] | null> {
  try {
    const res = await ctx.fetcher.fetch(`${ctx.site.origin}/wp-json/wc/store/v1/products?type=variation&parent=${parentId}&per_page=${PER_PAGE}`, { kind: 'json' });
    if (res.status !== 200) return null;
    const list = res.json<WooProduct[]>();
    return Array.isArray(list) && list.length ? list : null;
  } catch {
    return null;
  }
}

export const woocommerceConnector: FeedConnector = {
  id: 'woocommerce-store-api',
  version: VERSION,
  label: 'WooCommerce Store API',
  kind: 'feed',

  applicability(profile: SiteProfileData) {
    const api = profile.catalogue.publicApis.find((a) => a.kind === 'woocommerce_store_api');
    if (api?.usable) return { score: 0.95, reason: 'The WooCommerce Store API is publicly available' };
    if (profile.platform.id === 'woocommerce') return { score: 0.1, reason: 'WooCommerce site, but the Store API is unavailable' };
    return { score: 0, reason: 'Not a WooCommerce store' };
  },

  async fetchPage(ctx, cursor) {
    const page = Number(cursor?.['page'] ?? 1);
    const res = await ctx.fetcher.fetch(`${ctx.site.origin}/wp-json/wc/store/v1/products?per_page=${PER_PAGE}&page=${page}`, { kind: 'json' });
    if (res.status === 400 && page > 1) {
      // WooCommerce answers 400 (rest_post_invalid_page_number) once the page number exceeds the total pages.
      return { products: [], evidence: [ev(res, 'Past last page')], cursor: null, progress: { estimatedTotal: null, discovered: 0 }, warnings: [], done: true };
    }
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      throw Object.assign(new Error(`The WooCommerce Store API returned HTTP ${res.status}`), { code: 'feed_unavailable' });
    }
    if (res.status < 200 || res.status >= 300) throw httpFailure(res, 'The WooCommerce Store API');
    let list: WooProduct[];
    try {
      list = res.json<WooProduct[]>();
      if (!Array.isArray(list)) throw new Error('not an array');
    } catch {
      throw Object.assign(new Error('The Store API did not return a product list'), { code: 'invalid_response' });
    }
    const total = Number(res.headers['x-wp-total'] ?? NaN);
    const totalPages = Number(res.headers['x-wp-totalpages'] ?? NaN);
    const warnings: string[] = [];
    const products: ExtractedProduct[] = [];
    for (const wp of list) {
      let vars: WooProduct[] = [];
      if (wp.type === 'variable' && (wp.variations?.length ?? 0) > 0 && (wp.variations?.length ?? 0) <= 30) {
        vars = (await fetchVariations(ctx, wp.id)) ?? [];
        if (!vars.length) warnings.push(`Variations of "${wp.name}" could not be retrieved`);
      }
      const m = mapWooProduct(wp, ctx, 0, vars);
      if (m) products.push(m);
    }
    const done = list.length < PER_PAGE || (Number.isFinite(totalPages) && page >= totalPages);
    return {
      products: ctx.limits.maxProducts ? products.slice(0, ctx.limits.maxProducts) : products,
      evidence: [ev(res, `WooCommerce Store API page ${page}/${Number.isFinite(totalPages) ? totalPages : '?'}: ${list.length} products`)],
      cursor: done ? null : { page: page + 1 },
      progress: { estimatedTotal: Number.isFinite(total) ? total : null, discovered: list.length },
      warnings,
      done,
    };
  },

  async refresh(ctx, urls): Promise<ConnectorBatch> {
    const products: ExtractedProduct[] = [];
    const evidence: EvidenceDoc[] = [];
    const warnings: string[] = [];
    for (const u of urls) {
      const slug = new URL(u).pathname.split('/').filter(Boolean).pop();
      if (!slug) continue;
      try {
        const res = await ctx.fetcher.fetch(`${ctx.site.origin}/wp-json/wc/store/v1/products?slug=${encodeURIComponent(slug)}`, { kind: 'json' });
        if (res.status !== 200) {
          warnings.push(`Product ${slug} returned HTTP ${res.status}`);
          continue;
        }
        const list = res.json<WooProduct[]>();
        const first = list[0];
        if (!first) {
          warnings.push(`Product ${slug} was not found (may be delisted)`);
          continue;
        }
        const mapped = mapWooProduct(first, ctx, evidence.length);
        if (mapped) {
          products.push(mapped);
          evidence.push(ev(res, `WooCommerce product ${slug}`));
        }
      } catch (e) {
        warnings.push(`Product ${slug}: ${(e as Error).message}`);
      }
    }
    return { products, evidence, cursor: null, progress: { estimatedTotal: null, discovered: products.length }, warnings };
  },
};
