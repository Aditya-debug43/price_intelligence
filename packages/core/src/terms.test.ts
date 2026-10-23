import { describe, expect, it } from 'vitest';
import { combineTermsReviews, leadingClause, reviewTermsText } from './terms.ts';

/** Wordings taken from the public terms pages of the websites this product was audited against (read 2026-10-23), plus neutral text. */
const QUICKMART =
  'You agree not to reproduce, duplicate, copy, sell, resell or exploit any portion of the Service, use of the Service, or access to the Service or any contact on the website through which the service is provided, without express written permission by us. ' +
  'SECTION 12 - PROHIBITED USES In addition to other prohibitions as set forth in the Terms of Service, you are prohibited from using the site or its content: (a) for any unlawful purpose; (b) to solicit others to perform or participate in any unlawful acts; (h) to upload or transmit viruses; (i) to spam, phish, pharm, pretext, spider, crawl, or scrape; (j) for any obscene or immoral purpose. We reserve the right to terminate your use.';
const SUPER_FOOD =
  'You agree, further, not to use or attempt to use any engine, software, tool, agent or other device or mechanism (including without limitation browsers, spiders, robots, avatars or intelligent agents) to navigate or search this Site other than the search engine and search agents available from shop.example.test on this Site and other than generally available third party web browsers (e.g., Chrome or Microsoft Explorer).';
const FOODSTORE =
  'The User may not access, display, use, download, and/or otherwise copy or distribute Content obtained on the website for marketing and other purposes without the consent of the Provider. Copyright and Intellectual Property Rights Provider provides certain information at the Website.';
const LING =
  'We are not providing you with any implied or express licenses or rights by making services available to you and you will have no rights to make any commercial uses of our web site or service without our prior written consent. (c) collect or harvest any data about other users;';
const BENIGN =
  'We use cookies to remember your basket. Orders are delivered within two days. Our robots.txt file tells search engines which pages to index. Bots that help customers by answering questions are labelled as such. Refunds are issued to the original payment method.';

describe('terms-of-use screening', () => {
  it('finds a clause that forbids crawling and scraping, inside a list of prohibited uses', () => {
    const r = reviewTermsText('https://quickmart.example/terms', QUICKMART);
    expect(r.level).toBe('prohibits_automation');
    const a = r.clauses.find((c) => c.kind === 'automation')!;
    expect(a.text).toMatch(/prohibited from using the site/);
    expect(a.text).toMatch(/spider, crawl, or scrape/);
    expect(r.clauses.some((c) => c.kind === 'copying' && /reproduce, duplicate, copy/.test(c.text))).toBe(true);
  });

  it('finds "agree… not to use… spiders, robots… to navigate this Site"', () => {
    const r = reviewTermsText('https://shop.example/terms', SUPER_FOOD);
    expect(r.level).toBe('prohibits_automation');
    expect(r.clauses[0]!.text).toMatch(/spiders, robots/);
  });

  it('treats a ban on copying or commercial use without consent as a restriction, not as a ban on automation', () => {
    for (const text of [FOODSTORE, LING]) {
      const r = reviewTermsText('https://x.example/terms', text);
      expect(r.level, text.slice(0, 40)).toBe('restricts_copying');
      expect(r.clauses.every((c) => c.kind === 'copying')).toBe(true);
    }
  });

  it('quotes the list item that matters, not the start of a long list (Ling & Sons’ commercial-use item)', () => {
    const list =
      'You explicitly agree, in using this web site or any service provided, that you shall not: (a) provide any Content or perform any conduct that may be unlawful, illegal or threatening; (b) provide any Content that infringes the rights of others; ' +
      '(d) provide or use this web site and any Content or service in any commercial manner or in any manner that would involve junk mail or spam without our prior written consent; (e) provide any Content that may give rise to our liability.';
    const r = reviewTermsText('https://x.example/terms-of-use', list);
    expect(r.level).toBe('restricts_copying');
    expect(r.clauses[0]!.text).toMatch(/commercial manner/);
    expect(r.clauses[0]!.text).toMatch(/shall not/); // the lead-in is kept so the quote still says what is forbidden
    expect(r.clauses[0]!.text).not.toMatch(/unlawful/);
  });

  it('does not flag ordinary text that merely mentions robots.txt or helpful bots', () => {
    expect(reviewTermsText('https://x.example/terms', BENIGN)).toMatchObject({ level: 'none_found', clauses: [] });
  });

  it('combines pages: the strictest wins, and no readable page is "not_found" — never permission', () => {
    const when = '2026-10-23T10:00:00.000Z';
    const q = reviewTermsText('https://a.example/t', QUICKMART);
    const l = reviewTermsText('https://a.example/u', LING);
    const n = reviewTermsText('https://a.example/v', BENIGN);
    expect(combineTermsReviews([n, l, q], when, false).level).toBe('prohibits_automation');
    expect(combineTermsReviews([n, l], when, false).level).toBe('restricts_copying');
    expect(combineTermsReviews([n], when, false).level).toBe('none_found');
    expect(combineTermsReviews([], when, false)).toMatchObject({ level: 'not_found', pages: [] });
  });

  it('quotes the automation clause first', () => {
    const review = combineTermsReviews([reviewTermsText('https://a.example/l', LING), reviewTermsText('https://a.example/q', QUICKMART)], '2026-10-23T10:00:00.000Z', false);
    expect(leadingClause(review)).toMatchObject({ kind: 'automation', url: 'https://a.example/q' });
    expect(leadingClause({ pages: [] })).toBeNull();
  });
});
