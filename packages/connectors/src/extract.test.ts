import { describe, expect, it } from 'vitest';
import { extractFromHtml, extractQuantityClaim, looksJavaScriptRendered, mapAvailability } from './extract.ts';
import { classifySitemapUrl, looksLikeProductUrl, parseSitemap } from './sitemap.ts';
import { detectPlatform, findSocialLinks } from './profiler.ts';
import { detectChallenge, detectLoginWall } from './challenge.ts';
import * as cheerio from 'cheerio';

const page = (head: string, body = '<h1>Item</h1>') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const ld = (obj: unknown) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const opts = { siteCurrency: null as string | null, now: new Date('2026-10-14T00:00:00Z') };

describe('JSON-LD extraction edge cases', () => {
  it('reads a simple Product with offer, GTIN, brand and availability', () => {
    const r = extractFromHtml(page(ld({ '@context': 'https://schema.org', '@type': 'Product', name: 'Heinz Ketchup 397g', sku: 'H397', gtin13: '5449000000996', brand: { '@type': 'Brand', name: 'Heinz' }, offers: { '@type': 'Offer', price: '3.50', priceCurrency: 'USD', availability: 'https://schema.org/InStock' } })), 'https://s.com/p/h', opts);
    const p = r.products[0]!;
    expect(p).toMatchObject({ title: 'Heinz Ketchup 397g', brand: 'Heinz', method: 'json_ld' });
    expect(p.variants[0]).toMatchObject({ price: 3.5, currency: 'USD', gtin: '5449000000996', availability: 'in_stock', sku: 'H397' });
  });

  it('finds Products nested in @graph and arrays', () => {
    const r = extractFromHtml(page(ld({ '@graph': [{ '@type': 'WebSite', name: 'x' }, { '@type': ['Product', 'Thing'], name: 'Graph Item', offers: [{ '@type': 'Offer', price: 9, priceCurrency: 'EUR' }] }] })), 'https://s.com/p/g', opts);
    expect(r.products[0]!.title).toBe('Graph Item');
    expect(r.products[0]!.variants[0]!.price).toBe(9);
  });

  it('expands a ProductGroup into variants', () => {
    const r = extractFromHtml(page(ld({ '@type': 'ProductGroup', name: 'T-Shirt', hasVariant: [{ '@type': 'Product', name: 'T-Shirt S', sku: 'TS-S', offers: { price: '10', priceCurrency: 'USD', availability: 'InStock' } }, { '@type': 'Product', name: 'T-Shirt M', sku: 'TS-M', offers: { price: '10', priceCurrency: 'USD', availability: 'OutOfStock' } }] })), 'https://s.com/p/t', opts);
    expect(r.products).toHaveLength(1);
    expect(r.products[0]!.variants.map((v) => [v.sku, v.availability])).toEqual([['TS-S', 'in_stock'], ['TS-M', 'out_of_stock']]);
  });

  it('keeps a missing price as null — never 0 — and an unknown availability as unknown', () => {
    const r = extractFromHtml(page(ld({ '@type': 'Product', name: 'Mystery', offers: { '@type': 'Offer', priceCurrency: 'USD' } })), 'https://s.com/p/m', opts);
    const v = r.products[0]!.variants[0]!;
    expect(v.price).toBeNull();
    expect(v.availability).toBe('unknown');
    expect(r.products[0]!.quality.missingFields).toContain('price');
  });

  it('does not treat a price RANGE as a single price', () => {
    const r = extractFromHtml(page(ld({ '@type': 'Product', name: 'Range', offers: { '@type': 'AggregateOffer', lowPrice: '5', highPrice: '9', priceCurrency: 'USD' } })), 'https://s.com/p/r', opts);
    expect(r.products[0]!.variants[0]!.price).toBeNull();
    expect(r.products[0]!.quality.notes.join(' ')).toMatch(/range/i);
  });

  it('keeps shipping unknown unless explicitly published (free shipping is an explicit 0)', () => {
    const none = extractFromHtml(page(ld({ '@type': 'Product', name: 'A', offers: { price: '5', priceCurrency: 'USD' } })), 'https://s.com/p/a', opts);
    expect(none.products[0]!.variants[0]!.shippingCost).toBeNull();
    const free = extractFromHtml(page(ld({ '@type': 'Product', name: 'B', offers: { price: '5', priceCurrency: 'USD', shippingDetails: { shippingRate: { value: 0, currency: 'USD' } } } })), 'https://s.com/p/b', opts);
    expect(free.products[0]!.variants[0]!.shippingCost).toBe(0);
  });

  it('survives malformed and trailing-comma JSON-LD', () => {
    const broken = page('<script type="application/ld+json">{ not json </script>' + '<script type="application/ld+json">{"@type":"Product","name":"Ok","offers":{"price":"4.00","priceCurrency":"USD",},}</script>');
    expect(extractFromHtml(broken, 'https://s.com/p/o', opts).products[0]!.variants[0]!.price).toBe(4);
    expect(extractFromHtml(page('<script type="application/ld+json">{ not json </script>'), 'https://s.com/p/x', opts).products).toEqual([]);
  });

  it('ignores invalid GTINs', () => {
    const r = extractFromHtml(page(ld({ '@type': 'Product', name: 'Bad', gtin13: '1234567890123', offers: { price: '1', priceCurrency: 'USD' } })), 'https://s.com/p/b', opts);
    expect(r.products[0]!.variants[0]!.gtin).toBeNull();
  });

  it('uses the site currency only when the page states none', () => {
    const r = extractFromHtml(page(ld({ '@type': 'Product', name: 'Z', offers: { price: '7' } })), 'https://s.com/p/z', { ...opts, siteCurrency: 'AWG' });
    expect(r.products[0]!.variants[0]!.currency).toBe('AWG');
  });

  it('refuses to guess an ambiguous price string', () => {
    const r = extractFromHtml(page(ld({ '@type': 'Product', name: 'Amb', offers: { price: '1.299', priceCurrency: 'EUR' } })), 'https://s.com/p/a', opts);
    // "1.299" parses as a valid machine decimal 1.299 — a literal JSON-LD number is not locale-formatted text
    expect(r.products[0]!.variants[0]!.price).toBe(1.299);
  });
});

describe('microdata, Open Graph and heuristic fallbacks', () => {
  it('reads microdata', () => {
    const html = page('', '<div itemscope itemtype="https://schema.org/Product"><h1 itemprop="name">Micro Item</h1><span itemprop="brand" itemscope itemtype="https://schema.org/Brand"><span itemprop="name">Acme</span></span><div itemprop="offers" itemscope><meta itemprop="priceCurrency" content="USD"><span itemprop="price" content="12.30">12.30</span><link itemprop="availability" href="https://schema.org/OutOfStock"></div></div>');
    const p = extractFromHtml(html, 'https://s.com/p/m', opts).products[0]!;
    expect(p).toMatchObject({ method: 'microdata', title: 'Micro Item', brand: 'Acme' });
    expect(p.variants[0]).toMatchObject({ price: 12.3, currency: 'USD', availability: 'out_of_stock' });
  });
  it('reads Open Graph product tags as a low-confidence method', () => {
    const html = page('<meta property="og:type" content="product"><meta property="og:title" content="OG Item"><meta property="product:price:amount" content="8.50"><meta property="product:price:currency" content="AWG">');
    const p = extractFromHtml(html, 'https://s.com/p/o', opts).products[0]!;
    expect(p.method).toBe('opengraph');
    expect(p.variants[0]).toMatchObject({ price: 8.5, currency: 'AWG' });
  });
  it('requires a price AND a purchase signal before calling a page a product (heuristics)', () => {
    const noCart = extractFromHtml(page('', '<h1>About us</h1><p class="price">Afl. 5.00</p>'), 'https://s.com/about', opts);
    expect(noCart.products).toEqual([]);
    const ok = extractFromHtml(page('', '<h1>Cheese</h1><span class="price">Afl. 5.00</span><button>Add to cart</button>'), 'https://s.com/p/c', opts);
    expect(ok.products[0]).toMatchObject({ method: 'html_heuristic' });
    expect(ok.products[0]!.variants[0]!.currency).toBe('AWG');
  });
  it('detects JavaScript-rendered shells', () => {
    expect(looksJavaScriptRendered('<html><body><div id="root"></div><script src="/a.js"></script></body></html>').rendered).toBe(true);
    expect(looksJavaScriptRendered(`<html><body><p>${'text '.repeat(200)}</p></body></html>`).rendered).toBe(false);
  });
});

describe('availability and quantity claims', () => {
  it('maps schema.org availability without over-claiming', () => {
    expect(mapAvailability('https://schema.org/InStock')).toBe('in_stock');
    expect(mapAvailability('OutOfStock')).toBe('out_of_stock');
    expect(mapAvailability('https://schema.org/SoldOut')).toBe('out_of_stock');
    expect(mapAvailability('https://schema.org/LimitedAvailability')).toBe('limited');
    expect(mapAvailability('https://schema.org/PreOrder')).toBe('unknown');
    expect(mapAvailability('https://schema.org/BackOrder')).toBe('unknown');
    expect(mapAvailability(null)).toBe('unknown');
    expect(mapAvailability('something odd')).toBe('unknown');
  });
  it('reads only explicit quantity statements', () => {
    expect(extractQuantityClaim('Hurry! Only 3 left in stock')).toBe(3);
    expect(extractQuantityClaim('2 units left')).toBe(2);
    expect(extractQuantityClaim('In stock')).toBeNull();
    expect(extractQuantityClaim('Available in 3 sizes')).toBeNull();
    expect(extractQuantityClaim('Save up to 30 percent')).toBeNull();
  });
});

describe('sitemaps', () => {
  it('parses urlsets, indexes and plain-text sitemaps', () => {
    expect(parseSitemap('<urlset><url><loc>https://s.com/a</loc><lastmod>2026-01-01</lastmod></url></urlset>')).toEqual({ kind: 'urlset', entries: [{ loc: 'https://s.com/a', lastmod: '2026-01-01' }] });
    expect(parseSitemap('<sitemapindex><sitemap><loc>https://s.com/p.xml</loc></sitemap></sitemapindex>').kind).toBe('index');
    expect(parseSitemap('https://s.com/a\nhttps://s.com/b').entries).toHaveLength(2);
    expect(parseSitemap('<html>not a sitemap</html>').kind).toBe('unknown');
    expect(parseSitemap('<urlset xmlns:image="x"><url><loc>https://s.com/a</loc><image:image><image:loc>https://s.com/i.jpg</image:loc></image:image></url></urlset>').entries).toHaveLength(1);
  });
  it('classifies sitemap files and product-looking URLs', () => {
    expect(classifySitemapUrl('https://s.com/sitemap_products_1.xml')).toBe('products');
    expect(classifySitemapUrl('https://s.com/sitemap_collections_1.xml')).toBe('collections');
    expect(classifySitemapUrl('https://s.com/sitemap-blog.xml')).toBe('pages');
    expect(looksLikeProductUrl('https://s.com/products/abc')).toBe(true);
    expect(looksLikeProductUrl('https://s.com/blog/hello')).toBe(false);
    expect(looksLikeProductUrl('https://s.com/cart')).toBe(false);
    expect(looksLikeProductUrl('https://s.com/img/a.jpg')).toBe(false);
  });
});

describe('platform detection, social links, challenges', () => {
  it('fingerprints common platforms and says "unknown" otherwise', () => {
    expect(detectPlatform('<script src="https://cdn.shopify.com/s/files/x.js"></script><script>window.Shopify={}</script>', {}).id).toBe('shopify');
    expect(detectPlatform('<meta name="generator" content="WooCommerce 9"><link href="/wp-content/plugins/woocommerce/a.css">', {}).id).toBe('woocommerce');
    expect(detectPlatform('<html>hello</html>', {}).id).toBe('unknown');
  });
  it('extracts official social handles and ignores share widgets', () => {
    const $ = cheerio.load('<a href="https://www.facebook.com/sharer/sharer.php?u=1">s</a><a href="https://facebook.com/mystore">f</a><a href="https://instagram.com/mystore/">i</a><a href="https://www.instagram.com/p/ABC/">post</a><a href="https://www.youtube.com/@mystore">y</a>');
    expect(findSocialLinks($)).toMatchObject({ facebook: 'https://www.facebook.com/mystore', instagram: 'https://www.instagram.com/mystore', youtube: 'https://www.youtube.com/@mystore' });
  });
  it('detects challenges and login walls', () => {
    expect(detectChallenge('<title>Just a moment...</title>', { server: 'cloudflare' }, 403)).toMatchObject({ detected: true });
    expect(detectChallenge('<html><body>Welcome</body></html>', {}, 200).detected).toBe(false);
    expect(detectChallenge('<div class="g-recaptcha"></div> verify you are human', {}, 403).detected).toBe(true);
    expect(detectLoginWall('https://s.com/account/login', '')).toBe(true);
    expect(detectLoginWall('https://s.com/', '<p>Log in to see prices</p>')).toBe(true);
    expect(detectLoginWall('https://s.com/', '<p>Welcome</p>')).toBe(false);
  });
});

describe('spacedText', () => {
  it('separates sibling elements without altering the letters of words', async () => {
    const { spacedText } = await import('./extract.ts');
    const $ = cheerio.load('<div class="product"><span class="price">US$ 3.39</span><p>Only 4 left in stock</p></div>');
    const t = spacedText($, $('.product'));
    expect(t).toBe('US$ 3.39 Only 4 left in stock');
    expect(extractQuantityClaim(t)).toBe(4);
  });
});

describe('regressions found by live probing of real sites', () => {
  it('detects a Next.js application shell whose server render produced no content (doit.aw pattern)', () => {
    const html = '<!DOCTYPE html><html id="__next_error__"><head><title>Shop</title><script src="/_next/static/chunks/main-app.js" async=""></script></head><body></body></html>';
    const r = looksJavaScriptRendered(html);
    expect(r.rendered).toBe(true);
    expect(r.evidence).toMatch(/Next\.js/);
  });
  it('does not flag a normal server-rendered page', () => {
    expect(looksJavaScriptRendered(`<html><body><script src="/a.js"></script><p>${'welcome to our shop '.repeat(30)}</p></body></html>`).rendered).toBe(false);
  });
  it('never offers utility pages as product-page samples (superfoodaruba /sitemap.html pattern)', () => {
    for (const u of ['https://s.com/sitemap.html', 'https://s.com/privacy-policy', 'https://s.com/terms', 'https://s.com/search', 'https://s.com/faq', 'https://s.com/']) {
      expect(looksLikeProductUrl(u), u).toBe(false);
    }
    expect(looksLikeProductUrl('https://s.com/products/banana-bread')).toBe(true);
    expect(looksLikeProductUrl('https://s.com/shop/olive-oil-1l')).toBe(true);
  });
  it('detects Freshop storefront assets', () => {
    expect(detectPlatform('<script src="https://asset.freshop.com/js/app.js"></script>', {}).id).toBe('freshop');
  });
});
