import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PriceView } from '@ci/shared';

// The web app is compiled by its own project (DOM + JSX settings), so this root-level test loads its screen components at run time.
type Component = FunctionComponent<Record<string, unknown>>;
const UI_MODULE: string = '../../apps/web/src/ui.tsx';
let PriceTag: Component;
let SourceLink: Component;
beforeAll(async () => {
  ({ PriceTag, SourceLink } = (await import(/* @vite-ignore */ UI_MODULE)) as { PriceTag: Component; SourceLink: Component });
});

/**
 * Directive 11: what a customer actually gets on the Price Comparison. The markup is rendered exactly as the browser gets it, and
 * checked for a visible link that opens the right page in a new tab, an accessible name that says which website and which
 * product, and an honest "no page link" instead of a link when the stored address cannot be trusted.
 */
const price = {
  amount: 6.99, currency: 'USD', compareAt: null, normalized: 6.99, normalizedCurrency: 'USD', fxRate: 1, fxSource: null, fxAsOf: null,
  observedAt: '2026-10-28T09:00:00.000Z', stale: false, sourceUrl: null, observationId: 'o1',
} as unknown as PriceView;

const tag = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(PriceTag, { site: 'quickmartaruba.com', price, reporting: 'USD', ...props }));
const anchors = (html: string) => [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);

describe('the link on a price card', () => {
  const href = 'https://quickmartaruba.com/product/24-poland-spring-100-natural-spring-water/';

  it('is a real link to the product page, opening in a new tab without handing the page our window', () => {
    const html = tag({ href, product: '24 Poland Spring 100% Natural Spring Water' });
    const [a] = anchors(html);
    expect(anchors(html)).toHaveLength(1);
    expect(a).toContain(`href="${href}"`);
    expect(a).toContain('target="_blank"');
    expect(a).toMatch(/rel="noopener noreferrer"/);
    expect(html).toContain('View on <b>quickmartaruba.com</b>');
  });

  it('names the website and the product for a screen reader, starting with the words on screen', () => {
    const html = tag({ href, product: '24 Poland Spring 100% Natural Spring Water' });
    expect(html).toContain('aria-label="View on quickmartaruba.com: 24 Poland Spring 100% Natural Spring Water (opens quickmartaruba.com in a new tab)"');
  });

  it('shows which website each card opens, so competitors in one row are never confused', () => {
    const a = tag({ site: 'Quickmart', href: 'https://quickmartaruba.com/product/x/' });
    const b = tag({ site: 'Ling & Sons', href: 'https://shop.lingandsons.com/products/x?variant=7' });
    expect(a).toContain('View on <b>quickmartaruba.com</b>');
    expect(b).toContain('View on <b>shop.lingandsons.com</b>');
    expect(b).toContain('href="https://shop.lingandsons.com/products/x?variant=7"');
  });

  it('still links an out-of-stock product when its page address is known', () => {
    const html = tag({ href, availability: 'out_of_stock' });
    expect(html).toContain('out of stock');
    expect(anchors(html)).toHaveLength(1);
  });

  it('says "No page link" — and renders no link — when the address is missing', () => {
    for (const missing of [null, '', '   ']) {
      const html = tag({ href: missing });
      expect(anchors(html), JSON.stringify(missing)).toHaveLength(0);
      expect(html).toContain('No page link');
    }
  });

  it('never turns an unsafe stored address into a link', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'https://user:pw@quickmartaruba.com/product/x/', 'https://quickmartaruba.com/', 'not a url', '/product/relative']) {
      const html = tag({ href: bad });
      expect(anchors(html), bad).toHaveLength(0);
      expect(html, bad).not.toContain('javascript:');
      expect(html).toContain('No page link');
    }
  });

  it('does not add a link row where the caller does not deal with links', () => {
    const html = tag({});
    expect(anchors(html)).toHaveLength(0);
    expect(html).not.toContain('No page link');
  });

  it('does not change the price, the comparison or the freshness shown on the card', () => {
    const plain = tag({ diffPct: 3.2, directlyComparable: true, matchLabel: 'same 92%' });
    const linked = tag({ diffPct: 3.2, directlyComparable: true, matchLabel: 'same 92%', href });
    const strip = (s: string) => s.replace(/<div class="ptag-link">.*?<\/a><\/div>/, '');
    expect(strip(linked)).toBe(plain);
    expect(linked).toContain('6.99');
    expect(linked).toContain('same 92%');
  });
});

describe('SourceLink elsewhere in the app', () => {
  it('uses the caller’s wording but still names the website for assistive technology', () => {
    const html = renderToStaticMarkup(createElement(SourceLink, { href: 'https://shop.lingandsons.com/products/x', product: 'Poland Spring 24pk', text: 'Open page' }));
    expect(html).toContain('Open page');
    expect(html).toContain('aria-label="Open page: Poland Spring 24pk (opens shop.lingandsons.com in a new tab)"');
  });

  it('shows the same honest empty state for an old report that has no address at all', () => {
    const html = renderToStaticMarkup(createElement(SourceLink, { href: undefined }));
    expect(html).toContain('No page link');
    expect(html).not.toContain('<a');
  });
});
