import { describe, expect, it } from 'vitest';
import { extractListingPage } from './listing.ts';

/** Synthetic pages in the layouts shops commonly use. No real website's content is reproduced. */
const grid = (items: string, extra = '') => `<!doctype html><html><body><header><nav class="main-nav"><a href="/">Home</a><a href="/cart">Cart</a><a href="/account">Account</a></nav></header>${extra}${items}</body></html>`;

const podPage = `<html><body>
<aside class="side_categories"><ul class="nav"><li><a href="/catalogue/category/all_1/index.html">All</a><ul>
  <li><a href="/catalogue/category/travel_2/index.html">Travel</a></li><li><a href="/catalogue/category/mystery_3/index.html">Mystery</a></li></ul></li></ul></aside>
<section><ol class="row">
 ${([['A Quiet Orchard', '12.50', 'In stock'], ['Salt and Smoke', '7.99', 'In stock'], ['The Long Corridor', '30.00', 'Out of stock'], ['Maps of Nowhere', '8.25', 'In stock']] as [string, string, string][])
   .map(([t, p, s], i) => `<li class="col-xs-6"><article class="product_pod"><div class="image_container"><a href="/catalogue/item-${i}/index.html"><img src="/media/${i}.jpg" alt="${t}"></a></div><h3><a href="/catalogue/item-${i}/index.html" title="${t}">${t.slice(0, 12)}...</a></h3><div class="product_price"><p class="price_color">£${p}</p><p class="instock availability">${s}</p></div></article></li>`).join('\n')}
</ol>
<ul class="pager"><li class="current">Page 1 of 3</li><li class="next"><a href="/catalogue/page-2.html">next</a></li></ul>
<p class="form-horizontal"><strong>96</strong> results - showing 1 to 4.</p></section></body></html>`;

const wooPage = grid(`<ul class="products columns-4">${([['Alpha Jar 500g', '4.00', '3.20'], ['Beta Tin 250g', '2.50', null], ['Gamma Box 1kg', '9.99', null]] as [string, string, string | null][])
  .map(([t, reg, sale], i) => `<li class="product type-product"><a class="woocommerce-LoopProduct-link" href="/product/p${i}/"><img data-src="/img/${i}.png" alt=""><h2 class="woocommerce-loop-product__title">${t}</h2><span class="price">${sale ? `<del><span class="amount">$${reg}</span></del> <ins><span class="amount">$${sale}</span></ins>` : `<span class="amount">$${reg}</span>`}</span></a><a href="?add-to-cart=${i}" class="button">Add to cart</a></li>`).join('')}</ul><nav class="woocommerce-pagination"><ul class="page-numbers"><li><span class="current">1</span></li><li><a class="page-numbers" href="/shop/page/2/">2</a></li><li><a class="next page-numbers" href="/shop/page/2/">Next →</a></li></ul></nav>`);

const divCards = grid(`<div class="catalog">${([['Delta Lamp', '12,50 €'], ['Epsilon Chair', '89,00 €'], ['Zeta Table', '1.249,90 €'], ['Eta Shelf', '45,00 €']] as [string, string][])
  .map(([t, p], i) => `<div class="card"><a href="/p/${i}"><img src="/i/${i}.jpg"></a><div class="card-body"><a class="card-title" href="/p/${i}">${t}</a><div class="cost">${p}</div></div></div>`).join('')}</div>`);

describe('listing pages', () => {
  it('reads prices written with the Aruban florin sign (ƒ6.80) and with "Afl", as the currency AWG', () => {
    const cards = (prices: string[]) => grid(`<div class="catalog">${prices.map((p, i) => `<div class="card"><a href="/p/${i}"><img src="/i/${i}.jpg"></a><div class="card-body"><a class="card-title" href="/p/${i}">Item ${i} 12 ct</a><div class="cost">${p}</div></div></div>`).join('')}</div>`);
    for (const prices of [['ƒ6.80', 'ƒ4.95', 'ƒ8.29', 'ƒ15.95'], ['Afl 6.80', 'Afl 4.95', 'Afl 8.29', 'Afl 15.95']]) {
      const r = extractListingPage(cards(prices), 'https://shop.example/shop/dairy');
      expect(r.cards.map((c) => [c.amount, c.currency])).toEqual([[6.8, 'AWG'], [4.95, 'AWG'], [8.29, 'AWG'], [15.95, 'AWG']]);
    }
  });

  it('reads a grid of product cards: title from the heading’s title, price with its currency, link, image, availability', () => {
    const r = extractListingPage(podPage, 'https://shop.example/catalogue/index.html');
    expect(r.cards).toHaveLength(4);
    expect(r.cards[0]).toMatchObject({ title: 'A Quiet Orchard', amount: 12.5, currency: 'GBP', url: 'https://shop.example/catalogue/item-0/index.html', availability: 'in_stock' });
    expect(r.cards[2]).toMatchObject({ title: 'The Long Corridor', amount: 30, availability: 'out_of_stock' });
    expect(r.cards[0]!.imageUrl).toBe('https://shop.example/media/0.jpg');
  });

  it('follows the site’s own pagination and category navigation; the size hint comes from the page', () => {
    const r = extractListingPage(podPage, 'https://shop.example/catalogue/index.html');
    expect(r.next).toEqual(['https://shop.example/catalogue/page-2.html']);
    expect(r.categories).toEqual(expect.arrayContaining(['https://shop.example/catalogue/category/travel_2/index.html', 'https://shop.example/catalogue/category/mystery_3/index.html']));
    expect(r.categories.every((u) => !u.includes('/item-'))).toBe(true); // a product is not a category
    expect(r.totalHint).toBe(96);
  });

  it('WooCommerce-style cards: the sale price is the price, the struck-through one is the compare-at price; the add-to-cart link is not the product', () => {
    const r = extractListingPage(wooPage, 'https://shop.example/shop/');
    expect(r.cards).toHaveLength(3);
    expect(r.cards[0]).toMatchObject({ title: 'Alpha Jar 500g', amount: 3.2, compareAt: 4, ambiguousSymbol: '$', currency: null, url: 'https://shop.example/product/p0' });
    expect(r.cards[1]).toMatchObject({ amount: 2.5, compareAt: null });
    expect(r.cards.every((c) => !c.url.includes('add-to-cart'))).toBe(true);
    expect(r.next).toContain('https://shop.example/shop/page/2');
  });

  it('plain div cards and European number formats (12,50 € and 1.249,90 €)', () => {
    const r = extractListingPage(divCards, 'https://shop.example/c/');
    expect(r.cards.map((c) => [c.title, c.amount, c.currency])).toEqual([
      ['Delta Lamp', 12.5, 'EUR'],
      ['Epsilon Chair', 89, 'EUR'],
      ['Zeta Table', 1249.9, 'EUR'],
      ['Eta Shelf', 45, 'EUR'],
    ]);
  });

  it('a card with no readable price is skipped — never priced at zero', () => {
    const html = grid(`<ul class="products">${['One', 'Two', 'Three', 'Four'].map((t, i) => `<li class="product"><a href="/p/${i}"><h3>${t}</h3></a>${i === 2 ? '<span class="price">Call us</span>' : `<span class="price">$${i + 5}.00</span>`}</li>`).join('')}</ul>`);
    const r = extractListingPage(html, 'https://shop.example/x/');
    expect(r.cards.map((c) => c.title)).toEqual(['One', 'Two', 'Four']);
    expect(r.cards.every((c) => c.amount > 0)).toBe(true);
  });

  it('a page that is not a listing yields nothing: a product page with one price, a page that only mentions prices, an empty page', () => {
    expect(extractListingPage('<html><body><h1>Widget</h1><p class="price">$9.99</p><a href="/cart">Cart</a></body></html>', 'https://shop.example/p/1').cards).toEqual([]);
    expect(extractListingPage('<html><body><p>Delivery from $5.00, free over $50.00, returns $0.00.</p></body></html>', 'https://shop.example/help').cards).toEqual([]);
    expect(extractListingPage('<html><body></body></html>', 'https://shop.example/').cards).toEqual([]);
  });

  it('never follows or returns links to other websites, and ignores cart/account/login links', () => {
    const html = grid(`<ul class="products">${[0, 1, 2, 3].map((i) => `<li class="product"><a href="https://elsewhere.example/p/${i}"><h3>Off site ${i}</h3></a><span class="price">$${i + 1}.00</span></li>`).join('')}</ul>`);
    expect(extractListingPage(html, 'https://shop.example/x/').cards).toEqual([]);
    const r = extractListingPage(podPage, 'https://shop.example/catalogue/index.html');
    expect([...r.categories, ...r.next].every((u) => new URL(u).hostname === 'shop.example')).toBe(true);
    expect(r.categories.some((u) => /cart|account/.test(u))).toBe(false);
  });

  it('the same product linked twice on a page is returned once', () => {
    const html = grid(`<ul class="products">${[0, 1, 2, 2].map((i) => `<li class="product"><a href="/p/${i}"><h3>Item ${i}</h3></a><span class="price">$${i + 3}.00</span></li>`).join('')}</ul>`);
    expect(extractListingPage(html, 'https://shop.example/x/').cards.map((c) => c.title)).toEqual(['Item 0', 'Item 1', 'Item 2']);
  });
});
