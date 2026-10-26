import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { findStorefrontLink } from './profiler.ts';

const find = (html: string, pageUrl = 'https://www.example-market.test/', host = 'www.example-market.test') => findStorefrontLink(cheerio.load(html), pageUrl, host);

describe('findStorefrontLink — where a website says its own online store is', () => {
  it('reads the menu link of a real information website that sends customers to its shop on a sibling host', () => {
    // the shape of the menu on www.lingandsons.com, which lists no products itself
    const html = '<nav><a href="/latest-news-announcements/" title="Deals" >Deals</a> <a href="https://shop.lingandsons.com/" title="" >Online Shopping</a> <a href="/customer-service/">Customer Service</a></nav>';
    expect(find(html, 'https://www.lingandsons.com/', 'www.lingandsons.com')).toEqual({ url: 'https://shop.lingandsons.com/', label: 'Online Shopping', host: 'shop.lingandsons.com' });
  });

  it.each(['Online Shopping', 'Shop online', 'Order online', 'Visit our online store', 'Our shop', 'Webshop', 'Shop now', 'Shop', 'Store'])('accepts the menu wording “%s”', (label) => {
    expect(find(`<a href="https://shop.example-market.test/">${label}</a>`)?.host).toBe('shop.example-market.test');
  });

  it('keeps the path the link points to and drops the query and fragment', () => {
    expect(find('<a href="https://shop.example-market.test/collections/all?ref=menu#top">Shop online</a>')?.url).toBe('https://shop.example-market.test/collections/all');
  });

  it('takes the first matching link in the page (menus come before footers)', () => {
    const html = '<a href="https://shop.example-market.test/">Online Shopping</a><footer><a href="https://order.example-market.test/">Order online</a></footer>';
    expect(find(html)?.host).toBe('shop.example-market.test');
  });

  it('never suggests another company, a marketplace or a delivery app — only the same company domain', () => {
    expect(find('<a href="https://www.ubereats.com/store/some-market">Order online</a>')).toBeNull();
    expect(find('<a href="https://orders.delivery-app.test/shop">Shop online</a>')).toBeNull();
    expect(find('<a href="https://example-market.myshopify.com/">Online Shopping</a>')).toBeNull();
  });

  it('ignores links that stay on this website (including the bare-domain twin of www), social links and non-web links', () => {
    expect(find('<a href="/shop">Shop</a>')).toBeNull();
    expect(find('<a href="https://www.example-market.test/shop/">Shop</a>')).toBeNull();
    expect(find('<a href="https://example-market.test/">Online Shopping</a>')).toBeNull();
    expect(find('<a href="https://www.facebook.com/example">Shop</a>')).toBeNull();
    expect(find('<a href="mailto:shop@example-market.test">Shop</a><a href="tel:+2975212370">Order online</a><a href="javascript:void(0)">Shop now</a>')).toBeNull();
  });

  it('needs the whole label to name a shop: “Store locations”, “Shop hours” and long sentences do not count', () => {
    expect(find('<a href="https://stores.example-market.test/">Store locations</a>')).toBeNull();
    expect(find('<a href="https://hours.example-market.test/">Shop hours</a>')).toBeNull();
    expect(find('<a href="https://shop.example-market.test/">Read about how our online shop came to be</a>')).toBeNull();
    expect(find('<a href="https://shop.example-market.test/"></a>')).toBeNull();
  });

  it('works from a relative link on a page that was reached through a redirect', () => {
    expect(find('<a href="//shop.example-market.test/">Online Shopping</a>', 'https://www.example-market.test/home')?.url).toBe('https://shop.example-market.test/');
  });
});
