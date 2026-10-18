import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PlaywrightRenderer, browserConnector, extractFromHtml, profileSite, rankConnectors } from '@ci/connectors';
import { loopbackFetcher, testContext } from '../support/net.ts';

/**
 * Real headless-browser test. It needs a Chromium-family browser on the machine; when none is found the whole file is skipped
 * (so CI without a browser stays green) and the renderer stays "implemented, not verified" for that environment.
 * Set BROWSER_EXECUTABLE_PATH to point at a specific browser.
 */
const CANDIDATES = [
  process.env.BROWSER_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
const executablePath = CANDIDATES.find((p): p is string => !!p && existsSync(p));

/** A page that builds its product (JSON-LD and visible text) only after JavaScript runs. */
const productScript = (name: string, price: string) => `
  document.addEventListener('DOMContentLoaded', function () {
    var ld = document.createElement('script');
    ld.type = 'application/ld+json';
    ld.text = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: '${name}', sku: 'JS-${price}',
      offers: { '@type': 'Offer', price: '${price}', priceCurrency: 'USD', availability: 'https://schema.org/InStock' } });
    document.head.appendChild(ld);
    document.getElementById('app').innerHTML = '<h1>${name}</h1><p>USD ${price}</p>';
  });`;

describe.skipIf(!executablePath)('headless browser rendering (system Chromium-family browser)', () => {
  let server: http.Server;
  let origin = '';
  const hits: string[] = [];
  let upgrades = 0;
  let renderer: PlaywrightRenderer;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0]!;
      hits.push(path);
      const html = (body: string) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
      };
      // Like a real single-page app: an empty root, an external bundle, and the content built by script.
      const shell = (script: string) => `<!doctype html><html><head><title>Shop</title></head><body><div id="app"></div><script src="/app.js"></script><script>${script}</script></body></html>`;
      if (path === '/app.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        return void res.end('/* application bundle */');
      }
      if (path === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return void res.end(['User-agent: *', 'Disallow: /private/', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n'));
      }
      if (path === '/sitemap.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        return void res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/p/js-product</loc></url><url><loc>${origin}/p/js-two</loc></url></urlset>`);
      }
      if (path === '/') return html(shell(''));
      if (path === '/p/js-product' || path === '/private/p') return html(shell(productScript('Rendered Orange Juice 1L', '3.25')));
      if (path === '/p/js-two') return html(shell(productScript('Rendered Apple Juice 2L', '4.10')));
      if (path === '/ws-probe')
        return html(`<!doctype html><html><head><title>ws</title></head><body><script>
          try { var w = new WebSocket('ws://' + location.host + '/socket'); w.onopen = function () { document.title = 'opened'; }; w.onerror = function () { document.title = 'ws-failed'; }; w.onclose = function () { if (document.title === 'ws') document.title = 'ws-closed'; }; } catch (e) { document.title = 'ws-threw'; }
        </script></body></html>`);
      if (path === '/probe')
        return html(`<!doctype html><html><head><title>pending</title></head><body><script>
          Promise.allSettled([fetch('http://169.254.169.254/latest/meta-data/'), fetch('http://10.255.255.1/secret')])
            .then(function (r) { document.title = r.every(function (x) { return x.status === 'rejected'; }) ? 'blocked' : 'reached'; });
        </script></body></html>`);
      res.writeHead(404).end('not found');
    });
    server.on('upgrade', (_req, socket) => {
      upgrades++;
      socket.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    renderer = new PlaywrightRenderer(loopbackFetcher(), { executablePath, allowLoopback: true });
    expect(await renderer.init(), `could not launch ${executablePath}`).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await renderer?.close();
    server.closeAllConnections(); // the browser keeps connections alive; drop them so nothing outlives the test
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('renders JavaScript-built content that the plain HTML does not contain', async () => {
    const url = `${origin}/p/js-product`;
    const plain = await (await fetch(url)).text();
    const opts = { siteCurrency: null, now: new Date('2026-10-14T12:00:00Z') };
    expect(extractFromHtml(plain, url, { ...opts, structuredOnly: true }).products).toHaveLength(0); // what the HTML connectors see

    const rendered = await renderer.render(url, { timeoutMs: 20_000 });
    expect(rendered).not.toBeNull();
    const ex = extractFromHtml(rendered!.html, rendered!.finalUrl, { ...opts, structuredOnly: false });
    expect(ex.products).toHaveLength(1);
    expect(ex.products[0]).toMatchObject({ title: 'Rendered Orange Juice 1L' });
    expect(ex.products[0]!.variants[0]).toMatchObject({ price: 3.25, currency: 'USD', availability: 'in_stock' });
  }, 60_000);

  it('end to end: the profiler flags a JavaScript-only site and the browser connector collects it (and does nothing without a browser)', async () => {
    const fetcher = loopbackFetcher();
    const p = await profileSite(origin, { fetcher, capabilities: { browserEnabled: true, aiEnabled: false }, defaultCrawlDelayMs: 0, defaultMaxRequests: 100 });
    expect(p.rendering.requiresJavaScript).toBe(true);
    expect(rankConnectors(p, { browserEnabled: true, aiEnabled: false })[0]!.id).toBe('browser-rendered');
    expect(rankConnectors(p, { browserEnabled: false, aiEnabled: false }).map((r) => r.id)).not.toContain('browser-rendered');

    const ctx = testContext(fetcher, origin, { browser: renderer }, p);
    const found = await browserConnector.discover(ctx);
    expect(found.urls.map((u) => new URL(u.url).pathname).sort()).toEqual(['/p/js-product', '/p/js-two']);
    const batch = await browserConnector.extractPage(ctx, found.urls[1]!.url);
    expect(batch.products).toHaveLength(1);
    expect(batch.products[0]).toMatchObject({ method: 'browser_rendered', title: expect.stringMatching(/^Rendered (Orange|Apple) Juice/) });
    expect(batch.products[0]!.variants[0]!.price).not.toBeNull();

    const none = await browserConnector.extractPage(testContext(fetcher, origin, { browser: null }, p), found.urls[0]!.url);
    expect(none.products).toEqual([]); // no renderer, no products: nothing is invented
  }, 90_000);

  it('obeys robots.txt: a disallowed page is never navigated to', async () => {
    const before = hits.filter((h) => h === '/private/p').length;
    expect(await renderer.render(`${origin}/private/p`, { timeoutMs: 10_000 })).toBeNull();
    expect(hits.filter((h) => h === '/private/p').length).toBe(before);
  }, 30_000);

  it('screens every sub-request the page makes: private and metadata addresses are blocked', async () => {
    const rendered = await renderer.render(`${origin}/probe`, { timeoutMs: 20_000 });
    expect(rendered).not.toBeNull();
    expect(rendered!.html).toContain('<title>blocked</title>');
  }, 60_000);

  it('a page cannot open WebSocket connections through the browser (they bypass request screening, so none are allowed)', async () => {
    const before = upgrades;
    const rendered = await renderer.render(`${origin}/ws-probe`, { timeoutMs: 15_000 });
    expect(rendered).not.toBeNull();
    await new Promise((r) => setTimeout(r, 500));
    expect(upgrades).toBe(before); // the socket never reached the server
    expect(rendered!.html).not.toContain('<title>opened</title>');
  }, 60_000);

  it('does not render a loopback page at all when loopback is not allowed (production policy)', async () => {
    const strict = new PlaywrightRenderer(loopbackFetcher({ allowLoopback: false }), { executablePath, allowLoopback: false });
    expect(await strict.init()).toBe(true);
    try {
      expect(await strict.render(`${origin}/p/js-product`, { timeoutMs: 10_000 })).toBeNull();
    } finally {
      await strict.close();
    }
  }, 60_000);
});
