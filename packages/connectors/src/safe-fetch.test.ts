import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { AccessDeniedError, DomainLimiter, FetchError, SafeFetcher, assertSafeUrl, makeSafeLookup, registrableDomain, sameSiteHost, type TransportResponse } from './safe-fetch.ts';

const bodyOf = (s: string | Buffer): AsyncIterable<Uint8Array> => (async function* () { yield Buffer.from(s); })();
const resp = (status: number, body: string | Buffer, headers: Record<string, string> = {}): TransportResponse => ({ status, headers: { 'content-type': 'text/html', ...headers }, body: bodyOf(body) });

/** Fetcher with a scripted transport: never touches the network. Records the URLs that would have been requested. */
function scripted(routes: Record<string, TransportResponse | ((n: number) => TransportResponse)>, over: ConstructorParameters<typeof SafeFetcher>[0] = {}) {
  const hits: Record<string, number> = {};
  const requested: string[] = [];
  const fetcher = new SafeFetcher(
    { maxRetries: 1, ...over },
    {
      limiter: new DomainLimiter({ delayMs: 0, maxConcurrency: 4 }, Date.now, async () => {}),
      transport: async (url) => {
        const key = url.toString();
        requested.push(key);
        hits[key] = (hits[key] ?? 0) + 1;
        const r = routes[key] ?? routes[url.origin + url.pathname];
        if (!r) return resp(404, 'nf');
        return typeof r === 'function' ? r(hits[key]!) : { ...r, body: r.body ? bodyOf(Buffer.concat(await collect(r.body))) : null };
      },
    },
  );
  return { fetcher, requested, hits };
}
async function collect(it: AsyncIterable<Uint8Array>) {
  const out: Buffer[] = [];
  for await (const c of it) out.push(Buffer.from(c));
  return out;
}
const robotsOk = () => ({ 'https://shop.example.com/robots.txt': resp(200, 'User-agent: *\nDisallow: /cart\n', { 'content-type': 'text/plain' }) });

describe('SSRF guard: static URL checks', () => {
  const bad = [
    'http://127.0.0.1/', 'http://localhost/', 'http://[::1]/', 'http://10.0.0.5/admin', 'http://169.254.169.254/latest/meta-data/',
    'http://192.168.1.1/', 'http://0.0.0.0/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://127.1/', 'http://[::ffff:127.0.0.1]/',
    'http://metadata.google.internal/computeMetadata/v1/', 'http://db.internal/', 'file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/',
    'https://user:pass@example.com/', 'https://example.com:22/', 'http://example.com:8080/', 'javascript:alert(1)',
  ];
  it.each(bad)('rejects %s', (u) => {
    expect(() => assertSafeUrl(u, { allowLoopback: false })).toThrow(FetchError);
  });
  // Re-audit (2026-10-15): spellings that must not slip past the string checks.
  const spellings = [
    'http://LOCALHOST/', 'http://localhost./', 'http://127.0.0.1./', 'http://foo.localhost/', 'http://0177.0.0.1/', 'http://0x7f000001/', 'http://017700000001/',
    'http://[0:0:0:0:0:ffff:7f00:1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[::]/', 'http://[fd00:ec2::254]/', 'http://100.100.100.200/',
    'http://169.254.170.2/', 'http://metadata.google.internal./', 'http://instance-data/', 'http://[64:ff9b::7f00:1]/', 'http://127.0.0.1%2509.example.com/', 'http://user@127.0.0.1/',
  ];
  it.each(spellings)('rejects the spelling %s', (u) => {
    expect(() => assertSafeUrl(u, { allowLoopback: false })).toThrow(FetchError);
  });
  it('allows ordinary public URLs on 80/443', () => {
    expect(assertSafeUrl('https://shop.example.com/products/x', { allowLoopback: false }).hostname).toBe('shop.example.com');
    expect(assertSafeUrl('http://shop.example.com:80/', { allowLoopback: false })).toBeTruthy();
  });
  it('allows loopback only when fixtures are explicitly enabled', () => {
    expect(() => assertSafeUrl('http://127.0.0.1:4011/', { allowLoopback: false })).toThrow();
    expect(assertSafeUrl('http://127.0.0.1:4011/', { allowLoopback: true })).toBeTruthy();
    // even with fixtures enabled, private LAN and metadata addresses stay blocked
    expect(() => assertSafeUrl('http://169.254.169.254/', { allowLoopback: true })).toThrow();
    expect(() => assertSafeUrl('http://10.0.0.1:4011/', { allowLoopback: true })).toThrow();
  });
});

describe('SSRF guard: DNS resolution at connect time (anti-rebinding)', () => {
  const run = (resolver: (h: string) => Promise<{ address: string; family: number }[]>, allowLoopback = false, all = false) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address?: unknown }>((resolve) => {
      makeSafeLookup({ allowLoopback }, resolver)('example.test', { all } as never, (err, address) => resolve({ err, address }));
    });
  it('rejects a name that resolves to a private address', async () => {
    const r = await run(async () => [{ address: '10.1.2.3', family: 4 }]);
    expect(r.err?.code).toBe('ESSRF');
  });
  it('rejects when ANY resolved address is internal (mixed public+private records)', async () => {
    const r = await run(async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    expect(r.err?.code).toBe('ESSRF');
  });
  it('rejects metadata and IPv6 unique-local answers', async () => {
    expect((await run(async () => [{ address: '169.254.169.254', family: 4 }])).err?.code).toBe('ESSRF');
    expect((await run(async () => [{ address: 'fd00:ec2::254', family: 6 }])).err?.code).toBe('ESSRF');
  });
  it('rejects IPv4-mapped and NAT64 answers that embed an internal address, and any internal address among several', async () => {
    expect((await run(async () => [{ address: '::ffff:127.0.0.1', family: 6 }])).err?.code).toBe('ESSRF');
    expect((await run(async () => [{ address: '::ffff:7f00:1', family: 6 }])).err?.code).toBe('ESSRF');
    expect((await run(async () => [{ address: '64:ff9b::a9fe:a9fe', family: 6 }])).err?.code).toBe('ESSRF');
    expect((await run(async () => [{ address: '2002:a00:1::1', family: 6 }])).err?.code).toBe('ESSRF');
    expect((await run(async () => [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }])).err?.code).toBe('ESSRF');
    expect((await run(async () => [])).err).toBeTruthy(); // no answer at all is a failure, never "allowed"
  });
  it('accepts public answers in both callback shapes', async () => {
    const pub = async () => [{ address: '93.184.216.34', family: 4 }];
    expect((await run(pub)).address).toBe('93.184.216.34');
    expect((await run(pub, false, true)).address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
  it('propagates resolver failures', async () => {
    const r = await run(async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); });
    expect(r.err?.code).toBe('ENOTFOUND');
  });
});

describe('SafeFetcher behaviour (scripted transport, no network)', () => {
  it('revalidates every redirect hop: a redirect into the metadata service is refused before any request', async () => {
    const { fetcher, requested } = scripted({
      ...robotsOk(),
      'https://shop.example.com/': resp(302, '', { location: 'http://169.254.169.254/latest/meta-data/' }),
    });
    await expect(fetcher.fetch('https://shop.example.com/', { kind: 'html', allowCrossHostRedirect: true })).rejects.toMatchObject({ code: 'ssrf' });
    expect(requested.some((u) => u.includes('169.254'))).toBe(false);
  });
  it('refuses a redirect to an internal address written in another form, before any request is made', async () => {
    for (const target of ['http://2130706433/', 'http://0x7f.1/', 'http://[::ffff:7f00:1]/', 'http://169.254.169.254.:80/', 'https://127.0.0.1:443/admin', 'http://localhost./']) {
      const { fetcher, requested } = scripted({ ...robotsOk(), 'https://shop.example.com/': resp(302, '', { location: target }) });
      await expect(fetcher.fetch('https://shop.example.com/', { kind: 'html', allowCrossHostRedirect: true }), target).rejects.toMatchObject({ code: 'ssrf' });
      expect(requested.filter((u) => !u.includes('shop.example.com')), target).toEqual([]);
    }
  });
  it('refuses redirects to other sites unless explicitly allowed, and to non-http schemes', async () => {
    const a = scripted({ ...robotsOk(), 'https://shop.example.com/': resp(301, '', { location: 'https://other.org/' }) });
    await expect(a.fetcher.fetch('https://shop.example.com/', { kind: 'html' })).rejects.toMatchObject({ code: 'redirect' });
    const b = scripted({ ...robotsOk(), 'https://shop.example.com/': resp(302, '', { location: 'file:///etc/passwd' }) });
    await expect(b.fetcher.fetch('https://shop.example.com/', { kind: 'html', allowCrossHostRedirect: true })).rejects.toMatchObject({ code: 'ssrf' });
  });
  it('follows same-site redirects (www canonicalisation) and records the chain', async () => {
    const { fetcher } = scripted({
      ...robotsOk(),
      'https://www.shop.example.com/robots.txt': resp(200, 'User-agent: *\nDisallow:\n', { 'content-type': 'text/plain' }),
      'https://shop.example.com/': resp(301, '', { location: 'https://www.shop.example.com/' }),
      'https://www.shop.example.com/': resp(200, '<html>ok</html>'),
    });
    const r = await fetcher.fetch('https://shop.example.com/', { kind: 'html' });
    expect(r.url).toBe('https://www.shop.example.com/');
    expect(r.redirects).toEqual(['https://www.shop.example.com/']);
  });
  it('stops after too many redirects', async () => {
    const { fetcher } = scripted({ ...robotsOk(), 'https://shop.example.com/': resp(302, '', { location: '/' }) }, { maxRedirects: 3 });
    await expect(fetcher.fetch('https://shop.example.com/', { kind: 'html' })).rejects.toMatchObject({ code: 'redirect' });
  });
  it('obeys robots.txt and never requests a disallowed path', async () => {
    const { fetcher, requested } = scripted({ ...robotsOk(), 'https://shop.example.com/cart': resp(200, 'cart') });
    await expect(fetcher.fetch('https://shop.example.com/cart', { kind: 'html' })).rejects.toMatchObject({ code: 'robots' });
    expect(requested).not.toContain('https://shop.example.com/cart');
  });
  it('a rule written for "/shop/" also stops "/shop": normalising a link (dropping its trailing slash) can never turn a forbidden page into an allowed one', async () => {
    const closed = { 'https://shop.example.com/robots.txt': resp(200, 'User-agent: *\nDisallow: /shop/\n', { 'content-type': 'text/plain' }), 'https://shop.example.com/shop': resp(200, 'x'), 'https://shop.example.com/shop/': resp(200, 'x'), 'https://shop.example.com/other': resp(200, 'ok') };
    const { fetcher, requested } = scripted(closed);
    await expect(fetcher.fetch('https://shop.example.com/shop', { kind: 'html' })).rejects.toMatchObject({ code: 'robots' });
    await expect(fetcher.fetch('https://shop.example.com/shop/', { kind: 'html' })).rejects.toMatchObject({ code: 'robots' });
    expect(requested.filter((r) => r.includes('.com/shop'))).toEqual([]);
    expect((await fetcher.fetch('https://shop.example.com/other', { kind: 'html' })).status).toBe(200); // unrelated pages are unaffected
    const verdict = await fetcher.isAllowed('https://shop.example.com/shop');
    expect(verdict.allowed).toBe(false);
    expect(verdict.rule).toMatch(/trailing slash/);
  });
  it('treats a 403 robots.txt as closed (an access gate), and an unreadable one (5xx) as "not now" — nothing is fetched either way', async () => {
    for (const [status, code] of [[500, 'temporarily_unavailable'], [403, 'robots']] as const) {
      const { fetcher, requested } = scripted({ 'https://shop.example.com/robots.txt': resp(status, 'x'), 'https://shop.example.com/': resp(200, 'ok') });
      await expect(fetcher.fetch('https://shop.example.com/', { kind: 'html' })).rejects.toMatchObject({ code });
      expect(requested).not.toContain('https://shop.example.com/');
    }
  });
  it('treats a missing robots.txt (404) as no restrictions', async () => {
    const { fetcher } = scripted({ 'https://shop.example.com/robots.txt': resp(404, 'nf'), 'https://shop.example.com/': resp(200, '<p>hi</p>') });
    expect((await fetcher.fetch('https://shop.example.com/', { kind: 'html' })).status).toBe(200);
  });
  it('rejects oversized bodies (streamed) and oversized declared content-length', async () => {
    const big = 'x'.repeat(2000);
    const a = scripted({ ...robotsOk(), 'https://shop.example.com/big': resp(200, big) });
    await expect(a.fetcher.fetch('https://shop.example.com/big', { kind: 'html', maxBytes: 1000 })).rejects.toMatchObject({ code: 'too_large' });
    const b = scripted({ ...robotsOk(), 'https://shop.example.com/decl': resp(200, 'tiny', { 'content-length': '999999999' }) });
    await expect(b.fetcher.fetch('https://shop.example.com/decl', { kind: 'html' })).rejects.toMatchObject({ code: 'too_large' });
  });
  it('rejects unexpected content types', async () => {
    const { fetcher } = scripted({ ...robotsOk(), 'https://shop.example.com/img': resp(200, 'GIF89a', { 'content-type': 'image/gif' }) });
    await expect(fetcher.fetch('https://shop.example.com/img', { kind: 'html' })).rejects.toMatchObject({ code: 'content_type' });
  });
  it('stops hitting a host after repeated access denials and never retries a denial', async () => {
    const { fetcher, hits } = scripted({ ...robotsOk(), 'https://shop.example.com/p/1': resp(403, 'denied'), 'https://shop.example.com/p/2': resp(403, 'denied'), 'https://shop.example.com/p/3': resp(403, 'denied'), 'https://shop.example.com/p/4': resp(200, 'ok') });
    const r1 = await fetcher.fetch('https://shop.example.com/p/1', { kind: 'html' });
    expect(r1.status).toBe(403);
    await fetcher.fetch('https://shop.example.com/p/2', { kind: 'html' });
    await expect(fetcher.fetch('https://shop.example.com/p/3', { kind: 'html' })).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(fetcher.fetch('https://shop.example.com/p/4', { kind: 'html' })).rejects.toBeInstanceOf(AccessDeniedError);
    expect(hits['https://shop.example.com/p/1']).toBe(1); // no retry of a 403
    expect(hits['https://shop.example.com/p/4']).toBeUndefined(); // blocked host is not contacted again
  });
  it('retries 5xx and 429 a bounded number of times, honouring Retry-After', async () => {
    const { fetcher, hits } = scripted({ ...robotsOk(), 'https://shop.example.com/flaky': (n) => (n < 2 ? resp(503, 'busy', { 'retry-after': '0' }) : resp(200, 'ok')), 'https://shop.example.com/down': resp(500, 'x') });
    expect((await fetcher.fetch('https://shop.example.com/flaky', { kind: 'html' })).status).toBe(200);
    const r = await fetcher.fetch('https://shop.example.com/down', { kind: 'html' });
    expect(r.status).toBe(500);
    expect(hits['https://shop.example.com/down']).toBe(2); // 1 try + 1 retry (maxRetries: 1)
  });
  it('enforces a hard request budget', async () => {
    const { fetcher } = scripted({ ...robotsOk(), 'https://shop.example.com/a': resp(200, 'a'), 'https://shop.example.com/b': resp(200, 'b') });
    fetcher.requestBudget = 2; // robots + one page
    await fetcher.fetch('https://shop.example.com/a', { kind: 'html' });
    await expect(fetcher.fetch('https://shop.example.com/b', { kind: 'html' })).rejects.toMatchObject({ code: 'budget' });
  });
  it('decompresses gzipped sitemaps within a size limit (zip-bomb protection)', async () => {
    const xml = '<urlset>' + '<url><loc>https://shop.example.com/p/1</loc></url>'.repeat(10) + '</urlset>';
    const ok = scripted({ ...robotsOk(), 'https://shop.example.com/s.xml.gz': resp(200, gzipSync(xml), { 'content-type': 'application/gzip' }) });
    expect((await ok.fetcher.fetch('https://shop.example.com/s.xml.gz', { kind: 'xml' })).text()).toContain('<urlset>');
    const bomb = gzipSync(Buffer.alloc(200 * 1024 * 1024, 'a'));
    const bad = scripted({ ...robotsOk(), 'https://shop.example.com/bomb.xml.gz': resp(200, bomb, { 'content-type': 'application/gzip' }) }, { maxJsonBytes: 1024 * 1024 });
    await expect(bad.fetcher.fetch('https://shop.example.com/bomb.xml.gz', { kind: 'xml', maxBytes: 1024 * 1024 })).rejects.toMatchObject({ code: 'too_large' });
  });
  it('identifies itself honestly with the configured user agent', async () => {
    let seen = '';
    const fetcher = new SafeFetcher({ userAgent: 'CompetitorIntelBot/9.9 (+https://x.test/bot)', maxRetries: 0 }, {
      limiter: new DomainLimiter({ delayMs: 0, maxConcurrency: 1 }, Date.now, async () => {}),
      transport: async (url, init) => { seen = init.headers['user-agent'] ?? ''; return url.pathname === '/robots.txt' ? resp(404, 'nf') : resp(200, 'ok'); },
    });
    await fetcher.fetch('https://shop.example.com/', { kind: 'html' });
    expect(seen).toBe('CompetitorIntelBot/9.9 (+https://x.test/bot)');
  });
});

describe('DomainLimiter', () => {
  it('spaces request starts by the crawl delay and caps concurrency', async () => {
    let now = 0;
    const waits: number[] = [];
    const lim = new DomainLimiter({ delayMs: 0, maxConcurrency: 1 }, () => now, async (ms) => { waits.push(ms); now += ms; });
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((i) => lim.run('a.com', 1500, async () => { order.push(i); })));
    expect(order).toEqual([1, 2, 3]);
    expect(waits).toEqual([1500, 1500]);
    expect(lim.requestCount('a.com')).toBe(3);
  });
  it('tracks hosts independently and blocks after N denials', () => {
    const lim = new DomainLimiter();
    expect(lim.noteDenial('a.com', 2)).toBe(false);
    expect(lim.noteDenial('a.com', 2)).toBe(true);
    expect(lim.isBlocked('a.com')).toBe(true);
    expect(lim.isBlocked('b.com')).toBe(false);
    lim.noteSuccess('b.com');
  });
});

describe('site identity helpers', () => {
  it('compares registrable domains, including multi-part suffixes', () => {
    expect(registrableDomain('www.shop.example.com')).toBe('example.com');
    expect(registrableDomain('shop.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('doit.com.aw')).toBe('doit.com.aw');
    expect(sameSiteHost('www.example.com', 'shop.example.com')).toBe(true);
    expect(sameSiteHost('example.com', 'evil-example.com')).toBe(false);
    expect(sameSiteHost('1.2.3.4', '1.2.3.5')).toBe(false);
  });
});

describe('sitemap compression is decided by content, not by file name (live regression)', () => {
  it('reads a plain-XML document served under a ".xml.gz" name', async () => {
    const xml = '<urlset><url><loc>https://shop.example.com/p/1</loc></url></urlset>';
    const { fetcher } = scripted({ ...robotsOk(), 'https://shop.example.com/map.xml.gz': resp(200, xml, { 'content-type': 'application/x-gzip' }) });
    const r = await fetcher.fetch('https://shop.example.com/map.xml.gz', { kind: 'xml' });
    expect(r.text()).toBe(xml);
  });
});
