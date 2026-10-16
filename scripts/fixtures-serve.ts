/**
 * Starts the local FIXTURE websites on stable ports so they can be added in the UI like any competitor:
 *
 *   source     http://127.0.0.1:4101   Shopify-style feed, AWG   (your own shop in the demo)
 *   woo        http://127.0.0.1:4102   WooCommerce Store API, USD
 *   jsonld     http://127.0.0.1:4103   JSON-LD pages + sitemap index + weekly flyer PDF, AWG
 *   html       http://127.0.0.1:4104   plain HTML, no structured data, USD
 *   blocked    http://127.0.0.1:4105   robots.txt disallows everything      → Blocked
 *   challenge  http://127.0.0.1:4106   bot-protection challenge             → Blocked
 *   failing    http://127.0.0.1:4107   HTTP 500                             → Failed
 *   jsrender   http://127.0.0.1:4108   JavaScript-only shell               → Limited
 *   login      http://127.0.0.1:4109   login required                       → Blocked
 *   flaky      http://127.0.0.1:4110   feed breaks mid-catalogue            → Partial
 *
 * A control endpoint on :4100 changes the fixtures while the demo is running (price moves, stock changes, delistings),
 * so history, alerts and "what changed" can be shown live:
 *   curl -X POST localhost:4100/mutate -d '{"site":"woo","item":0,"price":0.99}'
 *   curl -X POST localhost:4100/mutate -d '{"site":"source","item":0,"available":false}'
 *   curl -X POST localhost:4100/mutate -d '{"site":"jsonld","item":3,"remove":true}'
 *   curl localhost:4100/state
 *
 * Everything served here is FICTIONAL test data. The platform flags it as fixture data everywhere.
 */
import http from 'node:http';
import { startFixtureServer } from '@ci/connectors';

const BASE = Number(process.env.FIXTURE_BASE_PORT ?? 4101);
const CONTROL = Number(process.env.FIXTURE_CONTROL_PORT ?? 4100);

export async function serveFixtures() {
  const fx = await startFixtureServer({ basePort: BASE });
  const control = http.createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
    };
    if (req.method === 'GET' && req.url === '/state') {
      return json(200, Object.fromEntries(Object.entries(fx.sites).map(([k, s]) => [k, { origin: s.origin, label: s.spec.label, products: s.products.filter((p) => !p.removed).length, mode: s.mode }])));
    }
    if (req.method === 'POST' && req.url === '/mutate') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const m = JSON.parse(body) as { site: string; item: number; price?: number; available?: boolean; remove?: boolean; restore?: boolean; claimedLeft?: number | null; mode?: 'ok' | 'http500' | 'http403' };
          const site = fx.sites[m.site];
          if (!site) return json(404, { error: `unknown site ${m.site}` });
          if (m.mode) site.mode = m.mode;
          if (m.item !== undefined) {
            if (m.price !== undefined) site.setPrice(m.item, m.price);
            if (m.available !== undefined) site.setAvailability(m.item, m.available);
            if (m.remove) site.remove(m.item);
            if (m.restore) site.restore(m.item);
            if (m.claimedLeft !== undefined) site.setClaimedLeft(m.item, m.claimedLeft);
          }
          return json(200, { ok: true, product: site.find(m.item) ?? null });
        } catch (e) {
          return json(400, { error: (e as Error).message });
        }
      });
      return;
    }
    json(404, { error: 'GET /state or POST /mutate' });
  });
  await new Promise<void>((resolve) => control.listen(CONTROL, '127.0.0.1', resolve));
  return {
    fx,
    async close() {
      await new Promise<void>((r) => control.close(() => r()));
      await fx.close();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]!.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('fixtures-serve.ts')) {
  const s = await serveFixtures();
  console.log('\nFIXTURE SITES (fictional data)');
  for (const [k, site] of Object.entries(s.fx.sites)) console.log(`  ${k.padEnd(10)} ${site.origin.padEnd(26)} ${site.spec.label}`);
  console.log(`\nControl endpoint: http://127.0.0.1:${CONTROL}/state   (POST /mutate to change prices/stock live)`);
  console.log('Add them in the app with ALLOW_LOCAL_FIXTURES=true. Press Ctrl+C to stop.\n');
  const stop = async () => {
    await s.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => {}, 1 << 30);
}
