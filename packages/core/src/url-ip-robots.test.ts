import { describe, expect, it } from 'vitest';
import { canonicalizeUrl, normalizeSiteUrl, redactUrlForLog, UrlValidationError } from './url.ts';
import { forbiddenAddressReason, forbiddenHostnameReason, isForbiddenAddress } from './ip.ts';
import { parseRobots, robotsAllows, robotsCrawlDelay, robotsDecision, robotsDisallowsAll, robotsFromStatus } from './robots.ts';

describe('normalizeSiteUrl', () => {
  it('adds https to bare hosts and reduces to origin', () => {
    const n = normalizeSiteUrl('Shop.Example.com/products/x?y=1#z');
    expect(n.origin).toBe('https://shop.example.com');
    expect(n.hostname).toBe('shop.example.com');
  });
  it('keeps the page the customer pointed at as the entry path (path and query only), and none for a bare address', () => {
    expect(normalizeSiteUrl('Shop.Example.com/products/x?y=1#z').entryPath).toBe('/products/x?y=1');
    expect(normalizeSiteUrl('https://shop.example.com/en/store/?utm_source=a&lang=en').entryPath).toBe('/en/store?lang=en');
    expect(normalizeSiteUrl('shop.example.com').entryPath).toBeNull();
    expect(normalizeSiteUrl('https://shop.example.com/').entryPath).toBeNull();
    expect(normalizeSiteUrl('https://shop.example.com/?utm_campaign=x#top').entryPath).toBeNull();
    expect(normalizeSiteUrl(`https://shop.example.com/${'a'.repeat(600)}`).entryPath).toBeNull(); // too long to be a shop section: the website is still accepted
  });
  it.each(['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://example.com'])(
    'rejects unsafe protocol %s',
    (u) => {
      expect(() => normalizeSiteUrl(u)).toThrow(UrlValidationError);
    },
  );
  it('rejects embedded credentials and single-label hosts', () => {
    expect(() => normalizeSiteUrl('https://user:pw@example.com')).toThrow(/credentials/);
    expect(() => normalizeSiteUrl('http://intranet')).toThrow(/fully-qualified/);
  });
  it('rejects empty and over-long input', () => {
    expect(() => normalizeSiteUrl('   ')).toThrow();
    expect(() => normalizeSiteUrl('https://a.com/' + 'x'.repeat(3000))).toThrow(/too long/);
  });
});

describe('canonicalizeUrl', () => {
  it('drops tracking params, fragments, trailing slash and sorts params', () => {
    expect(canonicalizeUrl('https://Shop.com/p/item/?utm_source=a&b=2&a=1#frag')).toBe('https://shop.com/p/item?a=1&b=2');
  });
  it('resolves relative URLs against a base', () => {
    expect(canonicalizeUrl('/products/x', 'https://shop.com/collections/all')).toBe('https://shop.com/products/x');
  });
});

describe('redactUrlForLog', () => {
  it('masks sensitive query params and credentials', () => {
    const r = redactUrlForLog('https://u:p@x.com/a?token=abc&q=1');
    expect(r).not.toContain('abc');
    expect(r).not.toContain('u:p');
    expect(r).toContain('q=1');
  });
});

describe('SSRF address classification', () => {
  const blocked = [
    '127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '100.100.100.200', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '::ffff:169.254.169.254', '64:ff9b::7f00:1', '2002:7f00:1::1', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
  ];
  it.each(blocked)('blocks %s', (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true);
  });

  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4009:81f::200e', '::ffff:8.8.8.8'];
  it.each(allowed)('allows public address %s', (ip) => {
    expect(forbiddenAddressReason(ip)).toBeNull();
  });

  it('judges NAT64 / DNS64 addresses by the IPv4 address they embed (regression: IPv6-only networks)', () => {
    // 64:ff9b::17e3:2620 is how a DNS64 resolver presents the public IPv4 host 23.227.38.32
    expect(isForbiddenAddress('64:ff9b::17e3:2620')).toBe(false);
    expect(isForbiddenAddress('64:ff9b::babd:1e6')).toBe(false);
    // …but NAT64 must never become a path to internal addresses
    expect(isForbiddenAddress('64:ff9b::a00:1')).toBe(true); // 10.0.0.1
    expect(isForbiddenAddress('64:ff9b::7f00:1')).toBe(true); // 127.0.0.1
    expect(isForbiddenAddress('64:ff9b::a9fe:a9fe')).toBe(true); // 169.254.169.254 (cloud metadata)
    expect(isForbiddenAddress('64:ff9b::c0a8:101')).toBe(true); // 192.168.1.1
    expect(isForbiddenAddress('2002:1700:0001::1')).toBe(false); // 6to4 embedding public 23.0.0.1
    expect(isForbiddenAddress('2002:a00:1::1')).toBe(true); // 6to4 embedding 10.0.0.1
  });

  it('rejects scoped and malformed addresses', () => {
    expect(isForbiddenAddress('fe80::1%eth0')).toBe(true);
    expect(isForbiddenAddress('not-an-ip')).toBe(true);
    expect(isForbiddenAddress('1.2.3')).toBe(true);
  });

  it('screens reserved hostnames', () => {
    expect(forbiddenHostnameReason('localhost')).toBeTruthy();
    expect(forbiddenHostnameReason('foo.localhost')).toBeTruthy();
    expect(forbiddenHostnameReason('metadata.google.internal')).toBeTruthy();
    expect(forbiddenHostnameReason('db.internal')).toBeTruthy();
    expect(forbiddenHostnameReason('printer.local')).toBeTruthy();
    expect(forbiddenHostnameReason('169.254.169.254')).toBeTruthy();
    expect(forbiddenHostnameReason('www.example.com')).toBeNull();
  });
});

describe('robots.txt', () => {
  const text = `
User-agent: *
Disallow: /cart
Disallow: /checkout
Disallow: /*?sort_by=
Allow: /cart/public
Crawl-delay: 2

User-agent: CompetitorIntelBot
Disallow: /private
Allow: /private/ok$

Sitemap: https://shop.com/sitemap.xml
`;
  const robots = parseRobots(text);
  it('collects sitemaps', () => expect(robots.sitemaps).toEqual(['https://shop.com/sitemap.xml']));

  it('applies the most specific user-agent group', () => {
    expect(robotsAllows(robots, 'CompetitorIntelBot/1.0', '/cart')).toBe(true); // our group has no /cart rule
    expect(robotsAllows(robots, 'CompetitorIntelBot/1.0', '/private/data')).toBe(false);
    expect(robotsAllows(robots, 'CompetitorIntelBot/1.0', '/private/ok')).toBe(true);
    expect(robotsAllows(robots, 'OtherBot', '/cart')).toBe(false);
  });
  it('longest match wins and Allow beats Disallow on ties', () => {
    expect(robotsAllows(robots, 'OtherBot', '/cart/public')).toBe(true);
    expect(robotsAllows(robots, 'OtherBot', '/cart/other')).toBe(false);
  });
  it('supports wildcards', () => {
    expect(robotsAllows(robots, 'OtherBot', '/collections/all?sort_by=price')).toBe(false);
    expect(robotsAllows(robots, 'OtherBot', '/collections/all')).toBe(true);
  });
  it('reads crawl-delay per group', () => {
    expect(robotsCrawlDelay(robots, 'OtherBot')).toBe(2);
    expect(robotsCrawlDelay(robots, 'CompetitorIntelBot')).toBeNull();
  });
  it('detects total disallow', () => {
    expect(robotsDisallowsAll(parseRobots('User-agent: *\nDisallow: /'), 'x')).toBe(true);
    expect(robotsDisallowsAll(parseRobots('User-agent: *\nDisallow:'), 'x')).toBe(false);
  });
  it('reports the matched rule', () => {
    expect(robotsDecision(robots, 'OtherBot', '/checkout/x').matchedRule).toBe('Disallow: /checkout');
  });
  it('treats unreachable/forbidden robots conservatively', () => {
    expect(robotsFromStatus(200)).toBe('parse');
    expect(robotsFromStatus(404)).toBe('allow_all');
    expect(robotsFromStatus(403)).toBe('disallow_all');
    expect(robotsFromStatus(503)).toBe('disallow_all');
    expect(robotsFromStatus(null)).toBe('disallow_all');
  });
});
