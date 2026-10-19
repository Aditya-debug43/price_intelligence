import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { canonicalizeUrl, parsePrice } from '@ci/core';
import type { Availability } from '@ci/shared';

/**
 * Product listing pages: a page that shows many products as a repeating grid or list of "cards" (image, name, price, link), as category
 * pages of nearly every shop do. This is how a website without a feed, sitemap or structured data can still be collected honestly: read what
 * every visitor sees, follow the site's own "next page" and category links, and stop when they run out.
 *
 * Nothing here is specific to one website. A card is found by structure: several sibling elements that each hold a link and one price.
 * Anything that cannot be read with confidence is left out rather than guessed (no price → the card is skipped, not priced at zero).
 */

export interface ListingCard {
  title: string;
  /** The product's own page (canonical). */
  url: string;
  amount: number;
  currency: string | null;
  /** "$" and similar symbols that do not identify a currency by themselves. */
  ambiguousSymbol: string | null;
  compareAt: number | null;
  imageUrl: string | null;
  availability: Availability;
}

export interface ListingPage {
  cards: ListingCard[];
  /** Links to the following pages of the same listing (pagination). */
  next: string[];
  /** Links to other listings (categories) found in navigation areas. */
  categories: string[];
  /** The number of products the page says the listing has ("1,000 results"), if it says so. */
  totalHint: number | null;
}

/** A grid needs this many cards to be recognised on an arbitrary page. A page we already know is a later page of a listing may hold fewer (the last one often does). */
const MIN_CARDS = 3;
const NON_CATALOGUE = /\/(cart|basket|checkout|account|my-account|login|signin|sign-in|register|wishlist|compare|contact|about|blog|news|policy|policies|privacy|terms|faq|help|search|track|returns?|shipping|gift-?cards?|careers|stores?|locations?)(\/|\.html?|$|\?)/i;
const PRICE_SYMBOL = /[£€₹¥₩₺₽₱₫ƒ]|\$|\b(?:USD|EUR|GBP|AWG|ANG|CAD|AUD|NZD|INR|AED|CHF|SEK|NOK|DKK|JPY|CNY|MXN|BRL|COP)\b|\b(?:Afl|NAf|Rs|kr|zł)\.?/i;

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The visible text of an element in reading order, with a space between neighbouring elements ("£12.50" next to "In stock", "Pantry" next to "28 results" do not run together). */
function spacedText($: cheerio.CheerioAPI, el: Element | AnyNode): string {
  const copy = $(el).clone();
  copy.find('*').each((_, e) => {
    $(e).append(' ').prepend(' ');
  });
  return collapse(copy.text());
}

/** Whether an element's visible text is, on its own, a price ("£51.77", "US$ 4.99", "12,50 €", "Afl. 1.299,50"). */
function priceOf(text: string): { amount: number; currency: string | null; ambiguousSymbol: string | null } | null {
  const t = collapse(text);
  if (!t || t.length > 40 || !/\d/.test(t)) return null;
  // two amounts in one element ("$4.00 $3.20") is a wrapper around a was/now pair, not a price
  if ((t.match(/\d[\d.,\s]*\d|\d/g) ?? []).length > 1) return null;
  const hasSymbol = PRICE_SYMBOL.test(t);
  // A bare number is a price only when written like one (two decimals); otherwise "3 left" or "Page 2" would be taken for prices.
  if (!hasSymbol && !/^\d{1,3}(?:[.,\s]\d{3})*[.,]\d{2}$/.test(t)) return null;
  const p = parsePrice(t);
  if (p.amount === null || p.ambiguous) return null;
  // Text that is mostly words with a number in it ("Save 20% on 3 items") is not a price.
  const words = t.replace(PRICE_SYMBOL, '').replace(/[\d.,\s]/g, '');
  if (words.length > 6) return null;
  return { amount: p.amount, currency: p.currency, ambiguousSymbol: p.ambiguousSymbol };
}

const INLINE = new Set(['span', 'strong', 'b', 'em', 'i', 'small', 'bdi', 'bdo', 'sup', 'sub', 'ins', 'del', 's', 'strike', 'p', 'div', 'a', 'meta']);
const signature = ($: cheerio.CheerioAPI, el: Element): string => {
  const cls = ($(el).attr('class') ?? '').split(/\s+/).filter((c) => c && !/^(odd|even|first|last|active|selected|col-\S+|\d+)$/.test(c)).slice(0, 4).sort();
  return `${el.tagName}.${cls.join('.')}`;
};

/** Reads the product cards, pagination, category links and size hint of one listing page. */
export function extractListingPage(html: string, pageUrl: string, opts: { minCards?: number } = {}): ListingPage {
  const minCards = Math.max(1, opts.minCards ?? MIN_CARDS);
  const $ = cheerio.load(html);
  $('script, style, noscript, template, svg').remove();
  const host = new URL(pageUrl).hostname;
  const abs = (href: string | undefined): string | null => {
    if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href.trim())) return null;
    try {
      const u = new URL(href.trim(), pageUrl);
      if (!/^https?:$/.test(u.protocol) || u.hostname !== host) return null;
      return canonicalizeUrl(u.toString());
    } catch {
      return null;
    }
  };

  // 1. price nodes: the innermost elements whose own text is a price
  const priceNodes: { el: Element; price: NonNullable<ReturnType<typeof priceOf>> }[] = [];
  $('body *').each((_, node) => {
    const el = node as Element;
    if (!INLINE.has(el.tagName)) return;
    if ($(el).children().filter((__, c) => (c as Element).tagName !== undefined && !INLINE.has((c as Element).tagName)).length) return;
    const p = priceOf($(el).text());
    if (!p) return;
    // keep only the innermost element carrying this price text
    if ($(el).children().toArray().some((c) => priceOf($(c).text()) !== null && collapse($(c).text()) === collapse($(el).text()))) return;
    priceNodes.push({ el, price: p });
  });
  if (priceNodes.length < minCards) return { cards: [], next: nextLinks($, abs, pageUrl), categories: categoryLinks($, abs, []), totalHint: sizeHint($) };

  // 2. the card container: the nearest ancestor of a price that repeats as a sibling group
  const groups = new Map<string, { parent: Element; sig: string; cards: Set<Element> }>();
  for (const { el } of priceNodes) {
    let cur: Element | null = el;
    for (let depth = 0; depth < 7 && cur; depth++) {
      const parent: Element | null = cur.parent && (cur.parent as Element).tagName ? (cur.parent as Element) : null;
      if (!parent || parent.tagName === 'body' || parent.tagName === 'html') break;
      const sig = signature($, cur);
      const same = $(parent).children().toArray().filter((c) => (c as Element).tagName === cur!.tagName && signature($, c as Element) === sig) as Element[];
      if (same.length >= minCards && $(cur).find('a[href]').length > 0 && priceCount($, cur, priceNodes) <= 2) {
        const key = `${(parent as unknown as { startIndex?: number }).startIndex ?? parent.tagName}|${sig}|${$(parent).parents().length}`;
        const g = groups.get(key) ?? { parent, sig, cards: new Set<Element>() };
        g.cards.add(cur);
        groups.set(key, g);
        break;
      }
      cur = parent;
    }
  }
  const best = [...groups.values()].sort((a, b) => b.cards.size - a.cards.size)[0];
  if (!best || best.cards.size < minCards) return { cards: [], next: nextLinks($, abs, pageUrl), categories: categoryLinks($, abs, []), totalHint: sizeHint($) };

  // 3. read each card
  const seen = new Set<string>();
  const cards: ListingCard[] = [];
  for (const card of best.cards) {
    const prices = priceNodes.filter((p) => $(card).find(p.el).length > 0 || p.el === card);
    if (!prices.length) continue;
    // A struck-through (or "was"/"regular") price is the compare-at price; one marked "sale"/"special"/"current", or inside <ins>, is the price.
    const isOld = (el: Element) => {
      for (let n: Element | null = el; n && n !== card; n = (n.parent as Element | null) ?? null) {
        const cls = $(n).attr('class') ?? '';
        if (n.tagName === 'ins' || /\b(sale|special|current|now)\b|special-price|price-current/i.test(cls)) return false;
        if (n.tagName === 'del' || n.tagName === 's' || n.tagName === 'strike' || /\b(old|was|regular|strike|compare)\b|old-price|was-price|price-old/i.test(cls)) return true;
      }
      return false;
    };
    const current = prices.find((p) => !isOld(p.el)) ?? prices[0]!;
    const old = prices.find((p) => p !== current && isOld(p.el));
    const link = productLink($, card, abs);
    if (!link) continue;
    const url = link.url;
    if (seen.has(url)) continue;
    const title = link.title || collapse($(card).find('img[alt]').first().attr('alt') ?? '');
    if (!title) continue;
    seen.add(url);
    // text nodes joined with spaces, so "£12.50" next to "In stock" does not run together
    const text = spacedText($, card).toLowerCase();
    const availability: Availability = /out of stock|sold out|unavailable|currently unavailable|not available/.test(text) ? 'out_of_stock' : /\bin stock\b|available now|add to (cart|basket)|buy now/.test(text) ? 'in_stock' : 'unknown';
    const img = $(card).find('img').first();
    const rawImg = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') || (img.attr('srcset') ?? '').split(/\s+/)[0];
    cards.push({
      title: title.slice(0, 300),
      url,
      amount: current.price.amount,
      currency: current.price.currency,
      ambiguousSymbol: current.price.ambiguousSymbol,
      compareAt: old && old.price.amount > current.price.amount ? old.price.amount : null,
      imageUrl: rawImg ? abs(rawImg) : null,
      availability,
    });
  }
  if (cards.length < minCards) return { cards: [], next: nextLinks($, abs, pageUrl), categories: categoryLinks($, abs, []), totalHint: sizeHint($) };

  return { cards, next: nextLinks($, abs, pageUrl), categories: categoryLinks($, abs, cards.map((c) => c.url)), totalHint: sizeHint($) };
}

function priceCount($: cheerio.CheerioAPI, card: Element, nodes: { el: Element }[]): number {
  return nodes.filter((n) => $(card).find(n.el).length > 0 || n.el === card).length;
}

/** The link to the product: the heading's link, else a link with a title, else the link with the most text. */
function productLink($: cheerio.CheerioAPI, card: Element, abs: (h: string | undefined) => string | null): { url: string; title: string } | null {
  const candidates: { url: string; title: string; score: number }[] = [];
  $(card).find('a[href]').each((_, a) => {
    const url = abs($(a).attr('href'));
    if (!url || NON_CATALOGUE.test(new URL(url).pathname)) return;
    const heading = $(a).closest('h1,h2,h3,h4,h5,h6').length > 0 || $(a).find('h1,h2,h3,h4,h5,h6').length > 0;
    const title = collapse($(a).attr('title') || $(a).find('h1,h2,h3,h4,h5,h6').first().text() || $(a).text() || $(a).find('img[alt]').first().attr('alt') || '');
    candidates.push({ url, title, score: (heading ? 100 : 0) + ($(a).attr('title') ? 50 : 0) + Math.min(title.length, 80) });
  });
  const best = candidates.sort((a, b) => b.score - a.score)[0];
  if (!best) return null;
  // The visible heading is often shortened ("A Quiet Orch..."); the link's title attribute usually carries the whole name.
  const heading = collapse($(card).find('h1,h2,h3,h4,h5,h6').first().text());
  const options = [best.title, heading, ...$(card).find('a[title]').toArray().map((a) => collapse($(a).attr('title') ?? ''))].filter(Boolean);
  const truncated = (s: string) => /(\.{2,}|…)$/.test(s);
  const whole = options.filter((s) => !truncated(s)).sort((a, b) => b.length - a.length)[0];
  return { url: best.url, title: whole ?? options.sort((a, b) => b.length - a.length)[0] ?? best.title };
}

const NEXT_TEXT = /^(next|next page|›|»|>|→|older|more|siguiente|volgende|suivant|weiter|próxima)\b/i;
function nextLinks($: cheerio.CheerioAPI, abs: (h: string | undefined) => string | null, pageUrl: string): string[] {
  const out = new Set<string>();
  const add = (h: string | undefined) => {
    const u = abs(h);
    if (u && u !== canonicalizeUrl(pageUrl)) out.add(u);
  };
  $('link[rel~="next"], a[rel~="next"]').each((_, e) => add($(e).attr('href')));
  $('li.next a, .next a, a.next, a.next-page, a.pagination-next, [class*="pagination"] a, [class*="pager"] a, [class*="paging"] a, nav[aria-label*="agination" i] a').each((_, e) => {
    const a = $(e);
    const label = collapse(a.text()) || (a.attr('aria-label') ?? '') || (a.attr('title') ?? '');
    if (NEXT_TEXT.test(label) || /\bnext\b/i.test(a.attr('aria-label') ?? '') || /\bnext\b/i.test(a.attr('class') ?? '') || /\bnext\b/i.test(a.parent().attr('class') ?? '')) add(a.attr('href'));
  });
  return [...out].slice(0, 3);
}

function categoryLinks($: cheerio.CheerioAPI, abs: (h: string | undefined) => string | null, productUrls: string[]): string[] {
  const product = new Set(productUrls);
  const out = new Set<string>();
  $('aside a[href], nav a[href], [class*="categor"] a[href], [class*="sidebar"] a[href], [class*="side_"] a[href], [class*="menu"] a[href], [class*="nav"] a[href], [role="navigation"] a[href]').each((_, e) => {
    const u = abs($(e).attr('href'));
    if (!u || product.has(u)) return;
    const path = new URL(u).pathname;
    if (path === '/' || NON_CATALOGUE.test(path)) return;
    out.add(u);
  });
  return [...out].slice(0, 80);
}

/** "Showing 1–20 of 1,000 results" / "1000 products" → 1000. */
function sizeHint($: cheerio.CheerioAPI): number | null {
  const text = spacedText($, $('body').get(0)!).slice(0, 20_000);
  const m = text.match(/\bof\s+([\d,.]{1,9})\s+(?:results|products|items)\b/i) ?? text.match(/\b([\d,.]{1,9})\s+(?:results|products)\b/i);
  if (!m) return null;
  const n = Number(m[1]!.replace(/[,.]/g, ''));
  return Number.isFinite(n) && n > 0 && n < 5_000_000 ? n : null;
}

export type { AnyNode };
