import * as cheerio from 'cheerio';
import type { Availability, ExtractionMethod } from '@ci/shared';
import { canonicalizeUrl, detectCurrency, isValidGtin, normalizeText, parseMachinePrice, parsePrice } from '@ci/core';
import type { ExtractedProduct, ExtractedVariant, ExtractionQuality } from './types.ts';

/**
 * Page-level extraction cascade: JSON-LD → microdata → Open Graph → HTML heuristics.
 * The method that produced a result is recorded with it, together with a quality score.
 */

export const EXTRACT_VERSION = '1.0';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = <T>(v: T | T[] | null | undefined): T[] => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
};

/** Element text with whitespace between sibling elements (cheerio's .text() glues them together: "3.39Only 4 left"). */
export function spacedText($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>): string {
  const clone = el.clone();
  clone.find('*').each((_, n) => {
    $(n).prepend(' ').append(' ');
  });
  return clone.text().replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────── availability

export function mapAvailability(raw: string | null | undefined): Availability {
  if (!raw) return 'unknown';
  const v = raw.toLowerCase().replace(/^https?:\/\/schema\.org\//, '').replace(/[\s_-]/g, '');
  if (/outofstock|soldout|discontinued|unavailable|nostock/.test(v)) return 'out_of_stock';
  if (/limitedavailability|lowstock|fewleft/.test(v)) return 'limited';
  if (/instock|instoreonly|onlineonly|available|inventoryavailable/.test(v)) return v.includes('notavailable') ? 'out_of_stock' : 'in_stock';
  // PreOrder / BackOrder / PreSale: the item is not in stock now; do not claim it is.
  return 'unknown';
}

/** Explicit public quantity claims ("Only 3 left"). Returns null when none is stated; never estimates. */
export function extractQuantityClaim(text: string): number | null {
  const t = text.replace(/\s+/g, ' ');
  const patterns = [
    /\bonly\s+(\d{1,4})\s+(?:items?\s+|units?\s+|pieces?\s+)?(?:left|remaining|remain|in\s+stock|available)\b/i,
    /\b(\d{1,4})\s+(?:items?\s+|units?\s+)?(?:left\s+in\s+stock|remaining\s+in\s+stock|in\s+stock\s+only)\b/i,
    /\b(\d{1,4})\s+(?:items?|units?)\s+left\b/i,
    /\bhurry,?\s+only\s+(\d{1,4})\b/i,
    /\bsolo\s+quedan\s+(\d{1,4})\b/i,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 0 && n < 10_000) return n;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────── JSON-LD

export function parseJsonLd($: cheerio.CheerioAPI): Obj[] {
  const nodes: Obj[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw.trim()) return;
    const parsed = tryParseJson(raw);
    if (parsed !== undefined) collectNodes(parsed, nodes, 0);
  });
  return nodes;
}

function tryParseJson(raw: string): unknown {
  // eslint-disable-next-line no-control-regex
  const attempts = [raw, raw.replace(/^\uFEFF/, '').replace(/[\u0000-\u001f]+/g, ' '), raw.replace(/,\s*([}\]])/g, '$1')];
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {
      /* try next repair */
    }
  }
  return undefined;
}

function collectNodes(data: unknown, out: Obj[], depth: number) {
  if (depth > 6) return;
  if (Array.isArray(data)) {
    for (const d of data) collectNodes(d, out, depth + 1);
    return;
  }
  if (!isObj(data)) return;
  if (data['@type']) out.push(data);
  for (const key of ['@graph', 'mainEntity', 'itemListElement', 'item', 'hasVariant']) {
    if (data[key]) collectNodes(data[key], out, depth + 1);
  }
}

const typesOf = (n: Obj): string[] => asArray(n['@type']).map((t) => String(t).replace(/^.*[/#]/, ''));

function brandName(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (isObj(v)) return str(v['name']);
  if (Array.isArray(v)) return brandName(v[0]);
  return null;
}

function firstImage(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return firstImage(v[0]);
  if (isObj(v)) return str(v['url']) ?? str(v['contentUrl']);
  return null;
}

function gtinOf(n: Obj): string | null {
  for (const k of ['gtin', 'gtin14', 'gtin13', 'gtin12', 'gtin8', 'isbn']) {
    const v = str(n[k]);
    if (v && isValidGtin(v)) return v.replace(/[\s-]/g, '');
  }
  return null;
}

function priceOf(offer: Obj): { price: number | null; currency: string | null; compareAt: number | null; ambiguous: boolean } {
  let price = parseMachinePrice(offer['price']);
  let currency = str(offer['priceCurrency'])?.toUpperCase() ?? null;
  let compareAt: number | null = null;
  let ambiguous = false;
  const specs = asArray(offer['priceSpecification']).filter(isObj);
  for (const s of specs) {
    const type = String(s['priceType'] ?? '').toLowerCase();
    const sp = parseMachinePrice(s['price']);
    if (/list|strikethrough|msrp|srp/.test(type)) compareAt = sp ?? compareAt;
    else if (price === null) price = sp;
    currency = currency ?? str(s['priceCurrency'])?.toUpperCase() ?? null;
  }
  if (price === null && typeof offer['price'] === 'string' && offer['price'].trim()) {
    const p = parsePrice(offer['price']);
    ambiguous = p.ambiguous;
    price = p.amount;
    currency = currency ?? p.currency;
  }
  if (price === null && offer['lowPrice'] !== undefined && offer['lowPrice'] === offer['highPrice']) price = parseMachinePrice(offer['lowPrice']);
  if (!currency && isObj(offer)) currency = str(offer['currency'])?.toUpperCase() ?? null;
  return { price, currency, compareAt, ambiguous };
}

function shippingOf(offer: Obj): number | null {
  const sd = asArray(offer['shippingDetails']).filter(isObj)[0];
  if (!sd) return null;
  const rate = sd['shippingRate'];
  if (isObj(rate)) return parseMachinePrice(rate['value']); // free shipping is explicit 0; absence stays null
  return null;
}

interface RawVariant {
  key: string;
  sku: string | null;
  gtin: string | null;
  title: string | null;
  price: number | null;
  compareAt: number | null;
  currency: string | null;
  shipping: number | null;
  availability: Availability;
  url: string | null;
  notes: string[];
}

function offersToVariants(node: Obj, fallbackName: string | null): RawVariant[] {
  const out: RawVariant[] = [];
  const offerNodes: Obj[] = [];
  for (const o of asArray(node['offers']).filter(isObj)) {
    const t = typesOf(o);
    if (t.includes('AggregateOffer') && o['offers']) offerNodes.push(...asArray(o['offers']).filter(isObj));
    else offerNodes.push(o);
  }
  const notes: string[] = [];
  for (const [i, o] of offerNodes.entries()) {
    const p = priceOf(o);
    if (p.ambiguous) notes.push('A price string was ambiguous and was ignored');
    if (typesOf(o).includes('AggregateOffer') && p.price === null && o['lowPrice'] !== undefined && o['lowPrice'] !== o['highPrice']) notes.push('Only a price range was published');
    out.push({
      key: str(o['sku']) ?? str(node['sku']) ?? (offerNodes.length > 1 ? `offer-${i}` : 'default'),
      sku: str(o['sku']) ?? str(node['sku']),
      gtin: gtinOf(o) ?? gtinOf(node),
      title: offerNodes.length > 1 ? (str(o['name']) ?? fallbackName) : null,
      price: p.price,
      compareAt: p.compareAt,
      currency: p.currency,
      shipping: shippingOf(o),
      availability: mapAvailability(str(o['availability'])),
      url: str(o['url']),
      notes,
    });
  }
  // AggregateOffer without sub-offers, e.g. { lowPrice, highPrice }
  if (out.length === 0) {
    for (const o of asArray(node['offers']).filter(isObj)) {
      const p = priceOf(o);
      out.push({
        key: str(node['sku']) ?? 'default',
        sku: str(node['sku']),
        gtin: gtinOf(node),
        title: null,
        price: p.price,
        compareAt: p.compareAt,
        currency: p.currency,
        shipping: null,
        availability: mapAvailability(str(o['availability'])),
        url: null,
        notes: o['lowPrice'] !== o['highPrice'] && o['lowPrice'] !== undefined ? ['Only a price range was published'] : [],
      });
    }
  }
  // De-duplicate identical keys (some sites repeat the same offer).
  const seen = new Set<string>();
  return out.filter((v) => {
    const k = `${v.key}|${v.price}|${v.availability}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ─────────────────────────────────────────────────────────── quality

export function buildQuality(p: {
  title: string;
  brand: string | null;
  imageUrl: string | null;
  variants: ExtractedVariant[];
  notes?: string[];
}): ExtractionQuality {
  const v = p.variants[0];
  const missing: string[] = [];
  let score = 0;
  if (p.title) score += 0.2;
  if (v?.price != null) score += 0.3;
  else missing.push('price');
  if (v?.currency) score += 0.15;
  else missing.push('currency');
  if (v && v.availability !== 'unknown') score += 0.15;
  else missing.push('availability');
  if (v?.gtin || v?.sku) score += 0.1;
  else missing.push('identifier');
  if (p.brand) score += 0.05;
  else missing.push('brand');
  if (p.imageUrl) score += 0.05;
  return { score: Math.round(score * 100) / 100, missingFields: missing, notes: p.notes ?? [] };
}

interface PageContext {
  pageUrl: string;
  siteCurrency: string | null;
  observedAt: Date;
  evidenceIndex: number;
}

function resolveUrl(u: string | null, base: string): string | null {
  if (!u) return null;
  try {
    return new URL(u, base).toString();
  } catch {
    return null;
  }
}

function finalize(
  partial: {
    title: string;
    externalId?: string | null;
    brand: string | null;
    manufacturer?: string | null;
    model?: string | null;
    mpn?: string | null;
    description: string | null;
    category: string | null;
    imageUrl: string | null;
    variants: RawVariant[];
    attrs?: Record<string, unknown>;
    url?: string | null;
  },
  method: ExtractionMethod,
  ctx: PageContext,
  extraNotes: string[] = [],
): ExtractedProduct {
  const url = canonicalizeUrl(resolveUrl(partial.url ?? null, ctx.pageUrl) ?? ctx.pageUrl);
  const variants: ExtractedVariant[] = partial.variants.map((v, i) => ({
    variantKey: v.key || `v${i}`,
    sku: v.sku,
    gtin: v.gtin,
    title: v.title,
    options: {},
    price: v.price,
    compareAtPrice: v.compareAt !== null && v.price !== null && v.compareAt > v.price ? v.compareAt : null,
    currency: v.currency ?? ctx.siteCurrency,
    shippingCost: v.shipping,
    availability: v.availability,
    quantity: null,
    quantitySource: null,
    url: canonicalizeUrl(resolveUrl(v.url, ctx.pageUrl) ?? url),
  }));
  if (variants.length === 0) {
    variants.push({
      variantKey: 'default', sku: null, gtin: null, title: null, options: {}, price: null, compareAtPrice: null,
      currency: ctx.siteCurrency, shippingCost: null, availability: 'unknown', quantity: null, quantitySource: null, url,
    });
  }
  const notes = [...extraNotes, ...partial.variants.flatMap((v) => v.notes)];
  return {
    url,
    externalId: partial.externalId ?? null,
    title: partial.title,
    brand: partial.brand,
    manufacturer: partial.manufacturer ?? null,
    model: partial.model ?? null,
    mpn: partial.mpn ?? null,
    description: partial.description ? partial.description.replace(/\s+/g, ' ').slice(0, 2000) : null,
    category: partial.category,
    imageUrl: resolveUrl(partial.imageUrl, ctx.pageUrl),
    attrs: partial.attrs ?? {},
    variants,
    method,
    methodVersion: EXTRACT_VERSION,
    observedAt: ctx.observedAt,
    evidenceIndex: ctx.evidenceIndex,
    quality: buildQuality({ title: partial.title, brand: partial.brand, imageUrl: partial.imageUrl, variants, notes }),
  };
}

function categoryOf(node: Obj): string | null {
  const c = node['category'];
  if (typeof c === 'string') return c.replace(/\s*[>/]\s*/g, ' > ').trim() || null;
  if (Array.isArray(c)) return str(c[0]);
  if (isObj(c)) return str(c['name']);
  return null;
}

function productFromJsonLd(node: Obj, ctx: PageContext, parent?: Obj): ExtractedProduct | null {
  const name = str(node['name']) ?? (parent ? str(parent['name']) : null);
  if (!name) return null;
  let variants: RawVariant[] = [];
  const hasVariant = asArray(node['hasVariant']).filter(isObj);
  if (typesOf(node).includes('ProductGroup') && hasVariant.length) {
    for (const [i, hv] of hasVariant.entries()) {
      const vs = offersToVariants(hv, str(hv['name']));
      const v = vs[0];
      if (!v) continue;
      variants.push({ ...v, key: str(hv['sku']) ?? v.key ?? `v${i}`, title: str(hv['name']) ?? v.title, sku: str(hv['sku']) ?? v.sku, gtin: gtinOf(hv) ?? v.gtin, url: str(hv['url']) ?? v.url });
    }
  } else {
    variants = offersToVariants(node, name);
  }
  return finalize(
    {
      title: name,
      externalId: str(node['productID']) ?? str(node['@id']),
      brand: brandName(node['brand']) ?? (parent ? brandName(parent['brand']) : null),
      manufacturer: brandName(node['manufacturer']),
      model: str(node['model']),
      mpn: str(node['mpn']),
      description: str(node['description']),
      category: categoryOf(node) ?? (parent ? categoryOf(parent) : null),
      imageUrl: firstImage(node['image']),
      variants,
      url: str(node['url']),
    },
    'json_ld',
    ctx,
  );
}

// ─────────────────────────────────────────────────────────── microdata / Open Graph / heuristics

function productFromMicrodata($: cheerio.CheerioAPI, ctx: PageContext): ExtractedProduct | null {
  const scope = $('[itemscope][itemtype*="schema.org/Product"]').first();
  if (!scope.length) return null;
  const prop = (name: string, root = scope) => {
    const el = root.find(`[itemprop="${name}"]`).first();
    if (!el.length) return null;
    const v = el.attr('content') ?? el.attr('href') ?? el.attr('src') ?? el.text();
    return v ? v.replace(/\s+/g, ' ').trim() || null : null;
  };
  const title = prop('name');
  if (!title) return null;
  const offers = scope.find('[itemprop="offers"]').first();
  const root = offers.length ? offers : scope;
  const priceRaw = prop('price', root) ?? prop('lowPrice', root);
  const p = parseMachinePrice(priceRaw) ?? parsePrice(priceRaw).amount;
  const availability = mapAvailability(prop('availability', root));
  return finalize(
    {
      title,
      brand: scope.find('[itemprop="brand"] [itemprop="name"]').first().text().trim() || prop('brand'),
      description: prop('description'),
      category: prop('category'),
      imageUrl: prop('image'),
      variants: [
        {
          key: prop('sku') ?? 'default', sku: prop('sku'), gtin: ['gtin13', 'gtin12', 'gtin14', 'gtin8', 'gtin'].map((k) => prop(k)).find((g) => g && isValidGtin(g)) ?? null,
          title: null, price: p, compareAt: null, currency: prop('priceCurrency', root)?.toUpperCase() ?? null, shipping: null,
          availability, url: null, notes: [],
        },
      ],
      mpn: prop('mpn'),
      url: prop('url'),
    },
    'microdata',
    ctx,
  );
}

function productFromOpenGraph($: cheerio.CheerioAPI, ctx: PageContext): ExtractedProduct | null {
  const meta = (p: string) => $(`meta[property="${p}"], meta[name="${p}"]`).first().attr('content')?.trim() || null;
  const amount = meta('product:price:amount') ?? meta('og:price:amount');
  const type = meta('og:type');
  if (!amount && !(type && /product/i.test(type))) return null;
  const title = meta('og:title');
  if (!title) return null;
  const price = parseMachinePrice(amount) ?? parsePrice(amount).amount;
  return finalize(
    {
      title,
      brand: meta('product:brand') ?? meta('og:brand'),
      description: meta('og:description'),
      category: meta('product:category'),
      imageUrl: meta('og:image'),
      variants: [
        {
          key: 'default', sku: meta('product:retailer_item_id'), gtin: null, title: null, price,
          compareAt: parseMachinePrice(meta('product:original_price:amount')),
          currency: (meta('product:price:currency') ?? meta('og:price:currency'))?.toUpperCase() ?? null,
          shipping: null, availability: mapAvailability(meta('product:availability') ?? meta('og:availability')), url: null, notes: [],
        },
      ],
      url: meta('og:url'),
    },
    'opengraph',
    ctx,
    ['Extracted from Open Graph tags only'],
  );
}

const PRICE_SELECTORS = [
  '[itemprop="price"]', '.woocommerce-Price-amount', 'p.price ins .amount', '.product-price', '.price--current', '.current-price',
  '.price-item--sale', '.price-item--regular', '.price__current', '[data-price]', '.price', '.Price', '#price',
];
const COMPARE_SELECTORS = ['del .amount', 'del', 's.price', '.price del', '.compare-at-price', '.price--compare', '.price-item--regular', '.was-price', '.old-price'];

function productFromHeuristics($: cheerio.CheerioAPI, ctx: PageContext): ExtractedProduct | null {
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim() || $('meta[property="og:title"]').attr('content')?.trim() || '';
  if (!title) return null;
  const hasCart = /add to (cart|basket|bag)|buy now|añadir al carrito|toevoegen aan|out of stock|sold out|agotado|uitverkocht/i.test($.root().text());
  let priceText: string | null = null;
  for (const sel of PRICE_SELECTORS) {
    const el = $(sel).first();
    const v = el.attr('content') ?? el.attr('data-price') ?? el.text();
    if (v && /\d/.test(v)) {
      priceText = v.replace(/\s+/g, ' ').trim();
      break;
    }
  }
  if (!priceText || !hasCart) return null; // without a price AND a purchase control this is not confidently a product page
  const parsed = parsePrice(priceText);
  if (parsed.amount === null) return null;
  let compareAt: number | null = null;
  for (const sel of COMPARE_SELECTORS) {
    const t = $(sel).first().text();
    if (t && /\d/.test(t)) {
      const c = parsePrice(t).amount;
      if (c !== null && c > parsed.amount) {
        compareAt = c;
        break;
      }
    }
  }
  const body = $('main').text() || $('body').text();
  const stockText = body.toLowerCase();
  const availability: Availability = /out of stock|sold out|agotado|uitverkocht|currently unavailable/.test(stockText)
    ? 'out_of_stock'
    : /in stock|add to cart|add to basket|en stock|op voorraad/.test(stockText)
      ? 'in_stock'
      : 'unknown';
  const scope = $('h1').first().closest('[itemtype*="Product"], main, article, .product, #product, [class*="product"]');
  const claim = extractQuantityClaim((scope.length ? spacedText($, scope) : spacedText($, $('body'))).slice(0, 20_000));
  const notes = ['Price located by page-layout heuristics; verify against the product page'];
  const product = finalize(
    {
      title,
      brand: $('meta[property="product:brand"]').attr('content') ?? null,
      description: $('meta[name="description"]').attr('content') ?? null,
      category: $('.breadcrumb a, .breadcrumbs a, nav[aria-label*="readcrumb"] a').last().text().trim() || null,
      imageUrl: $('meta[property="og:image"]').attr('content') ?? null,
      variants: [
        {
          key: 'default', sku: $('[itemprop="sku"]').first().text().trim() || $('.sku').first().text().trim() || null, gtin: null, title: null,
          price: parsed.amount, compareAt, currency: parsed.currency ?? ctx.siteCurrency, shipping: null, availability, url: null, notes: [],
        },
      ],
      url: $('link[rel="canonical"]').attr('href') ?? null,
    },
    'html_heuristic',
    ctx,
    notes,
  );
  if (claim !== null && availability !== 'out_of_stock') {
    const v = product.variants[0]!;
    v.quantity = claim;
    v.quantitySource = 'public_claim';
    v.availability = 'low_quantity_claim';
  }
  if (parsed.ambiguousSymbol && !parsed.currency && !ctx.siteCurrency) {
    product.quality.notes.push(`Price shown with an ambiguous "${parsed.ambiguousSymbol}" symbol; currency unknown`);
  }
  return product;
}

// ─────────────────────────────────────────────────────────── entry point

export interface PageExtraction {
  products: ExtractedProduct[];
  snippet: string;
  structuredFound: boolean;
}

export interface ExtractOptions {
  siteCurrency: string | null;
  now: Date;
  evidenceIndex?: number;
  /** Restrict to structured data (JSON-LD, microdata, Open Graph) — no layout heuristics. */
  structuredOnly?: boolean;
}

export function extractFromHtml(html: string, pageUrl: string, opts: ExtractOptions): PageExtraction {
  const $ = cheerio.load(html);
  const ctx: PageContext = { pageUrl, siteCurrency: opts.siteCurrency, observedAt: opts.now, evidenceIndex: opts.evidenceIndex ?? 0 };

  // JSON-LD
  const nodes = parseJsonLd($);
  const productNodes = nodes.filter((n) => typesOf(n).some((t) => t === 'Product' || t === 'ProductGroup'));
  const groupChildren = new Set<Obj>();
  for (const n of productNodes) for (const hv of asArray(n['hasVariant']).filter(isObj)) groupChildren.add(hv);
  const topLevel = productNodes.filter((n) => !groupChildren.has(n));
  const products: ExtractedProduct[] = [];
  for (const n of topLevel) {
    const p = productFromJsonLd(n, ctx);
    if (p) products.push(p);
  }
  if (products.length) {
    const first = topLevel[0]!;
    const snippet = JSON.stringify(first).slice(0, 1200);
    enrichFromPage($, products, ctx);
    return { products, snippet, structuredFound: true };
  }

  const micro = productFromMicrodata($, ctx);
  if (micro) {
    enrichFromPage($, [micro], ctx);
    return { products: [micro], snippet: $('[itemscope][itemtype*="schema.org/Product"]').first().text().replace(/\s+/g, ' ').slice(0, 600), structuredFound: true };
  }
  const og = productFromOpenGraph($, ctx);
  if (og) return { products: [og], snippet: `og:title=${og.title}; price=${og.variants[0]?.price}`, structuredFound: true };

  if (opts.structuredOnly) return { products: [], snippet: '', structuredFound: false };
  const h = productFromHeuristics($, ctx);
  if (h) return { products: [h], snippet: `h1="${h.title}"; price="${h.variants[0]?.price}"`, structuredFound: false };
  return { products: [], snippet: '', structuredFound: false };
}

/** Adds explicit public quantity claims and fills gaps that structured data leaves (never overrides stated values). */
function enrichFromPage($: cheerio.CheerioAPI, products: ExtractedProduct[], _ctx: PageContext) {
  if (products.length !== 1) return;
  const p = products[0]!;
  if (p.variants.length !== 1) return;
  const v = p.variants[0]!;
  if (v.availability === 'out_of_stock') return;
  const scope = $('[itemtype*="Product"]').first();
  const text = (scope.length ? spacedText($, scope) : spacedText($, $('main'))).slice(0, 20_000);
  const claim = extractQuantityClaim(text);
  if (claim !== null) {
    v.quantity = claim;
    v.quantitySource = 'public_claim';
    if (v.availability !== 'limited') v.availability = 'low_quantity_claim';
  }
}

/** Heuristic: does this HTML look like a client-rendered shell with no server-side content? */
export function looksJavaScriptRendered(html: string): { rendered: boolean; evidence: string } {
  const $ = cheerio.load(html);
  const bodyText = $('body').clone().find('script,style,noscript').remove().end().text().replace(/\s+/g, ' ').trim();
  const hasRoot = $('#root, #app, #__next, #__nuxt, [data-reactroot], app-root').length > 0;
  const scripts = $('script[src]').length;
  const noscript = $('noscript').text().toLowerCase();
  const framework = /id="__next(_error__)?"|\/_next\/static\/|__NEXT_DATA__/.test(html)
    ? 'Next.js'
    : /__NUXT__|\/_nuxt\//.test(html)
      ? 'Nuxt'
      : /ng-version=|<app-root/.test(html)
        ? 'Angular'
        : /data-reactroot|id="root"/.test(html)
          ? 'React'
          : null;
  if (bodyText.length < 120 && scripts > 0 && framework) return { rendered: true, evidence: `Almost no server-rendered text; the page is a ${framework} application that builds its content in the browser` };
  if (bodyText.length < 60 && scripts > 0) return { rendered: true, evidence: 'Almost no server-rendered text; the page content is built by JavaScript' };
  if (bodyText.length < 200 && hasRoot && scripts > 0) return { rendered: true, evidence: 'Almost no server-rendered text and a JavaScript application root was found' };
  if (bodyText.length < 120 && /enable javascript|requires javascript/.test(noscript + bodyText.toLowerCase())) return { rendered: true, evidence: 'The page asks for JavaScript to display content' };
  return { rendered: false, evidence: `${bodyText.length} characters of server-rendered text` };
}

export function visibleText(html: string, max = 16_000): string {
  const $ = cheerio.load(html);
  $('script,style,noscript,svg,iframe').remove();
  return spacedText($, $('body')).slice(0, max);
}

export function titleOf(html: string): string | null {
  const $ = cheerio.load(html);
  return $('meta[property="og:site_name"]').attr('content')?.trim() || $('title').first().text().replace(/\s+/g, ' ').trim() || null;
}

export function normalizeForCompare(s: string): string {
  return normalizeText(s);
}

export { detectCurrency };
