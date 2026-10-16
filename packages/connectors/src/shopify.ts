import * as cheerio from 'cheerio';
import { canonicalizeUrl, parseMachinePrice } from '@ci/core';
import type { Availability, SiteProfileData } from '@ci/shared';
import { buildQuality } from './extract.ts';
import type { ConnectorBatch, ConnectorContext, EvidenceDoc, ExtractedProduct, ExtractedVariant, FeedConnector } from './types.ts';

/**
 * Shopify storefront catalogue: GET /products.json?limit=250&page=N
 *
 * This is the storefront's public product feed (not the Admin API). Many stores expose it; some disable it.
 * It reveals availability as a boolean only — never inventory quantities — so quantities stay null here.
 * Exact quantities require the owner-authorised Admin API integration (see inventory.ts).
 */
const VERSION = '1.0';
const PAGE_SIZE = 250;

interface ShopifyVariant {
  id: number;
  title?: string;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  sku?: string | null;
  barcode?: string | null;
  price?: string | number | null;
  compare_at_price?: string | number | null;
  available?: boolean;
}

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  body_html?: string | null;
  vendor?: string | null;
  product_type?: string | null;
  tags?: string[] | string;
  variants?: ShopifyVariant[];
  options?: { name: string; position: number; values: string[] }[];
  images?: { src: string }[];
  image?: { src: string } | null;
}

function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  const t = cheerio.load(`<div>${html}</div>`)('div').text().replace(/\s+/g, ' ').trim();
  return t || null;
}

export function mapShopifyProduct(sp: ShopifyProduct, ctx: Pick<ConnectorContext, 'site' | 'siteCurrency' | 'now'>, evidenceIndex: number): ExtractedProduct | null {
  if (!sp?.title || !sp.handle) return null;
  const url = canonicalizeUrl(`/products/${sp.handle}`, ctx.site.origin);
  const optionNames = (sp.options ?? []).sort((a, b) => a.position - b.position).map((o) => o.name);
  const variants: ExtractedVariant[] = (sp.variants ?? []).map((v) => {
    const options: Record<string, string> = {};
    [v.option1, v.option2, v.option3].forEach((val, i) => {
      if (val && val !== 'Default Title') options[optionNames[i] ?? `option${i + 1}`] = val;
    });
    const availability: Availability = v.available === true ? 'in_stock' : v.available === false ? 'out_of_stock' : 'unknown';
    const price = parseMachinePrice(v.price);
    const compareAt = parseMachinePrice(v.compare_at_price);
    return {
      variantKey: String(v.id),
      sku: v.sku?.trim() || null,
      gtin: v.barcode?.trim() || null,
      title: v.title && v.title !== 'Default Title' ? v.title : null,
      options,
      price,
      // A compare-at price only counts when it is genuinely above the selling price.
      compareAtPrice: compareAt !== null && price !== null && compareAt > price ? compareAt : null,
      currency: ctx.siteCurrency,
      shippingCost: null,
      availability,
      quantity: null,
      quantitySource: null,
      url: variants_url(url, v.id),
    };
  });
  const base = {
    title: sp.title,
    brand: sp.vendor?.trim() || null,
    imageUrl: sp.image?.src ?? sp.images?.[0]?.src ?? null,
    variants,
  };
  const notes = ctx.siteCurrency ? [] : ['The feed carries no currency code and none could be detected for the site'];
  return {
    url,
    externalId: String(sp.id),
    title: sp.title,
    brand: base.brand,
    manufacturer: null,
    model: null,
    mpn: null,
    description: htmlToText(sp.body_html),
    category: sp.product_type?.trim() || null,
    imageUrl: base.imageUrl,
    attrs: { handle: sp.handle, tags: Array.isArray(sp.tags) ? sp.tags : typeof sp.tags === 'string' ? sp.tags.split(',').map((t) => t.trim()) : [] },
    variants,
    method: 'shopify_products_json',
    methodVersion: VERSION,
    observedAt: ctx.now(),
    evidenceIndex,
    quality: buildQuality({ ...base, notes }),
  };
}

const variants_url = (productUrl: string, id: number) => `${productUrl}?variant=${id}`;

function evidenceFor(res: { url: string; fetchedAt: Date; status: number; contentType: string; contentHash: string; body: Buffer }, snippet: string, keepBody: boolean): EvidenceDoc {
  return { url: res.url, fetchedAt: res.fetchedAt, httpStatus: res.status, contentType: res.contentType, contentHash: res.contentHash, bytes: res.body.length, snippet, body: keepBody ? res.body : undefined };
}

export const shopifyConnector: FeedConnector = {
  id: 'shopify-products-json',
  version: VERSION,
  label: 'Shopify storefront product feed',
  kind: 'feed',

  applicability(profile: SiteProfileData) {
    const api = profile.catalogue.publicApis.find((a) => a.kind === 'shopify_products_json');
    if (api?.usable) return { score: 0.95, reason: 'The Shopify product feed (/products.json) is publicly available' };
    if (profile.platform.id === 'shopify') return { score: 0.1, reason: 'Shopify site, but the public product feed is unavailable' };
    return { score: 0, reason: 'Not a Shopify store' };
  },

  async fetchPage(ctx, cursor) {
    const page = Number(cursor?.['page'] ?? 1);
    const url = `${ctx.site.origin}/products.json?limit=${PAGE_SIZE}&page=${page}`;
    const res = await ctx.fetcher.fetch(url, { kind: 'json' });
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      throw Object.assign(new Error(`The Shopify product feed returned HTTP ${res.status}`), { code: 'feed_unavailable' });
    }
    if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`Shopify feed returned HTTP ${res.status}`), { code: 'http_error' });
    let data: { products?: ShopifyProduct[] };
    try {
      data = res.json();
    } catch {
      throw Object.assign(new Error('The Shopify feed did not return valid JSON'), { code: 'invalid_response' });
    }
    const list = data.products ?? [];
    const products = list.map((p) => mapShopifyProduct(p, ctx, 0)).filter((p): p is ExtractedProduct => p !== null);
    const warnings: string[] = [];
    if (list.length > products.length) warnings.push(`${list.length - products.length} feed entries lacked a title or handle and were skipped`);
    const done = list.length < PAGE_SIZE;
    return {
      products: ctx.limits.maxProducts ? products.slice(0, ctx.limits.maxProducts) : products,
      evidence: [evidenceFor(res, `Shopify products.json page ${page}: ${list.length} products`, false)],
      cursor: done ? null : { page: page + 1 },
      progress: { estimatedTotal: ctx.profile?.catalogue.estimatedProducts ?? null, discovered: list.length },
      warnings,
      done,
    };
  },

  async refresh(ctx, urls): Promise<ConnectorBatch> {
    const products: ExtractedProduct[] = [];
    const evidence: EvidenceDoc[] = [];
    const warnings: string[] = [];
    for (const u of urls) {
      const handle = new URL(u).pathname.match(/\/products\/([^/]+)/)?.[1];
      if (!handle) {
        warnings.push(`Not a Shopify product URL: ${u}`);
        continue;
      }
      try {
        const res = await ctx.fetcher.fetch(`${ctx.site.origin}/products/${handle}.json`, { kind: 'json' });
        if (res.status === 404) {
          warnings.push(`Product ${handle} returned 404 (may be delisted)`);
          continue;
        }
        if (res.status < 200 || res.status >= 300) {
          warnings.push(`Product ${handle} returned HTTP ${res.status}`);
          continue;
        }
        const data = res.json<{ product?: ShopifyProduct }>();
        const mapped = data.product ? mapShopifyProduct(data.product, ctx, evidence.length) : null;
        if (mapped) {
          products.push(mapped);
          evidence.push(evidenceFor(res, `Shopify product ${handle}`, false));
        }
      } catch (e) {
        warnings.push(`Product ${handle}: ${(e as Error).message}`);
      }
    }
    return { products, evidence, cursor: null, progress: { estimatedTotal: null, discovered: products.length }, warnings };
  },
};
