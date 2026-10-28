import { describe, expect, it } from 'vitest';
import { MAX_SOURCE_URL_LENGTH, safeSourceUrl, sourceLink } from '@ci/shared';
import { productPageLink } from '@ci/services';

/**
 * Directive 11: the address behind a "view on the shop" link is a stored record, and a damaged or hostile record must never
 * become a link. These pin what counts as a safe product-page address.
 */
describe('safeSourceUrl', () => {
  it('keeps ordinary product pages exactly as stored, query and variant included', () => {
    for (const url of [
      'https://groceriestogoaruba.com/products/24-poland-spring-100-natural-spring-water',
      'https://shop.lingandsons.com/products/poland-spring-24pk?variant=41234567890123',
      'http://rival-wc.test/product/heinz-ketchup/',
      'https://quickmartaruba.com/product/poland-spring-24-pack/',
      'https://shop.example.aw/?p=1234', // plain-permalink WordPress: the page is in the query
      'https://example.com/p/caf%C3%A9',
    ]) {
      const safe = safeSourceUrl(url);
      expect(safe, url).toBe(url);
    }
    expect(safeSourceUrl('  https://a.test/products/x  ')).toBe('https://a.test/products/x');
    expect(safeSourceUrl('https://example.com/p/café')).toBe('https://example.com/p/caf%C3%A9'); // encoded by the URL parser, not rejected
  });

  it('refuses anything that is not an ordinary web page address', () => {
    const nul = String.fromCharCode(0);
    for (const bad of [
      null, undefined, 42, {}, [], '', '   ',
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'ftp://a.test/x', 'mailto:a@b.test', 'blob:https://a.test/1', 'vbscript:x',
      '/products/relative', '//a.test/products/x', 'products/x', 'not a url', 'https://', 'http://',
      'https://user:pass@a.test/products/x', 'https://user@a.test/products/x',
      'https://a.test/products/with space', 'https://a.test/products/x\ny', 'https://a.test/\tproducts', `https://a.test/products/x${nul}`,
      'https://a.test', 'https://a.test/', 'https://www.a.test/#top', // the front page is not a product
      `https://a.test/${'x'.repeat(MAX_SOURCE_URL_LENGTH)}`,
    ]) {
      expect(safeSourceUrl(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('names the website the link opens, without a leading www', () => {
    expect(sourceLink('https://www.Shop.Example.com/products/x')).toEqual({ href: 'https://www.shop.example.com/products/x', host: 'shop.example.com' });
    expect(sourceLink('https://shop.lingandsons.com/products/x')!.host).toBe('shop.lingandsons.com');
  });
});

describe('productPageLink (the server side of the same rule)', () => {
  it('accepts a page on the product’s own website, with or without www', () => {
    expect(productPageLink('https://shop.lingandsons.com/products/x?variant=9', 'shop.lingandsons.com')).toBe('https://shop.lingandsons.com/products/x?variant=9');
    expect(productPageLink('https://www.quickmartaruba.com/product/x/', 'quickmartaruba.com')).toBe('https://www.quickmartaruba.com/product/x/');
    expect(productPageLink('https://quickmartaruba.com/product/x/', 'www.quickmartaruba.com')).toBe('https://quickmartaruba.com/product/x/');
  });

  it('never links one website’s product to another website’s page', () => {
    expect(productPageLink('https://quickmartaruba.com/product/x/', 'shop.lingandsons.com')).toBeNull();
    expect(productPageLink('https://shop.lingandsons.com.evil.test/products/x', 'shop.lingandsons.com')).toBeNull();
    expect(productPageLink('https://evil.test/shop.lingandsons.com/products/x', 'shop.lingandsons.com')).toBeNull();
  });

  it('gives no link when the address or the website is unknown', () => {
    expect(productPageLink(null, 'a.test')).toBeNull();
    expect(productPageLink('', 'a.test')).toBeNull();
    expect(productPageLink('https://a.test/products/x', null)).toBeNull();
    expect(productPageLink('javascript:alert(1)', 'a.test')).toBeNull();
  });
});
