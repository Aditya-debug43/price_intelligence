import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { extractText, getDocumentProxy } from 'unpdf';
import { evidence, priceObservations, products, sites as sitesTable, stockObservations, variants, withTenant } from '@ci/database';
import { buildApp } from '../../apps/api/src/app.ts';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp } from '../support/auth.ts';

/**
 * THE LIVE PATH, END TO END. Every other end-to-end test runs in a *demo* workspace. This one runs in a real (live) workspace whose websites
 * are ordinary public hostnames: they pass the public-host policy — no loopback exception, no fixture flag — and only the final network
 * hop is imitated (requests to each hostname are served by a local fictional site). So it exercises exactly the code a real customer
 * triggers, through the real HTTP API, except the internet itself.
 *
 * What this does NOT prove: that any real website behaves like these imitations. No real website was contacted.
 */
const PASSWORD = 'Correct-Horse-9-Battery';
const HOSTS: Record<string, string> = {
  'mine.test': 'source',
  'rival-woo.test': 'woo',
  'rival-ld.test': 'jsonld',
  'rival-html.test': 'html',
  'rival-robots.test': 'blocked',
  'rival-down.test': 'failing',
};
const NAME: Record<string, string> = { source: 'Mine (own shop)', woo: 'Rival Woo', jsonld: 'Rival JSON-LD', html: 'Rival HTML', blocked: 'Rival Robots', failing: 'Rival Down' };

let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let orgId: string;
const sites: Record<string, string> = {};
const base = (o = orgId) => `/api/v1/orgs/${o}`;
const db = () => h.db.worker;

const scanRuns = async () => (await owner.get(`${base()}/scans`)).body.scans as { id: string; siteId: string; status: string; isComplete: boolean; productsSaved: number }[];
const runOf = async (key: string) => (await scanRuns()).find((r) => r.siteId === sites[key])!;
async function recollect(...keys: string[]) {
  for (const k of keys) expect([200, 202]).toContain((await owner.post(`${base()}/sites/${sites[k]}/scans`, { kind: 'discovery' })).status);
  await h.queue.drain();
}

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
}, 120_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('1. a new customer signs up and gets an empty live workspace', () => {
  it('registers, creates a workspace, and any attempt to ask for another kind of workspace is ignored', async () => {
    await signUp(owner, h, { email: `live-${Date.now()}@example.test`, password: PASSWORD, displayName: 'Live Owner' });
    const r = await owner.post('/api/v1/orgs', { name: 'Live Journey Shop', mode: 'demo' });
    expect(r.status).toBe(201);
    expect(r.body.organization.mode).toBeUndefined();
    orgId = r.body.organization.id;
  });

  it('starts empty: no websites, no products, nothing invented, and the next step is the customer\'s own website', async () => {
    expect((await owner.get(`${base()}/sites`)).body.sites).toEqual([]);
    expect((await owner.get(`${base()}/products`)).body.total).toBe(0);
    expect((await owner.get(`${base()}/alerts`)).body.total).toBe(0);
    const journey = (await owner.get(`${base()}/journey`)).body;
    expect(JSON.stringify(journey)).toMatch(/own_site/);
  });
});

describe('2. invalid and unsafe URLs are refused with a reason', () => {
  it('rejects bad schemes, private/loopback/metadata addresses, odd ports and embedded credentials', async () => {
    for (const url of ['javascript:alert(1)', 'ftp://mine.test', 'http://localhost', 'http://127.0.0.1', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5', 'http://mine.test:8080', 'http://user:pass@mine.test', 'not a url', '']) {
      const r = await owner.post(`${base()}/sites`, { url, role: 'competitor' });
      expect(r.status, url).toBe(400);
      expect(r.body.error.message, url).toBeTruthy();
    }
  });
});

describe('3. the customer enters their own website and up to five competitors', () => {
  it('adds one source and five competitors on public hostnames; a sixth competitor and a duplicate are refused', async () => {
    for (const [host, key] of Object.entries(HOSTS)) {
      const r = await owner.post(`${base()}/sites`, { url: `http://${host}`, role: key === 'source' ? 'source' : 'competitor', name: NAME[key] });
      expect(r.status, host).toBe(201);
      expect(r.body.site).toMatchObject({ consentStatus: 'pending' });
      sites[key] = r.body.site.id;
    }
    expect((await owner.post(`${base()}/sites`, { url: 'http://rival-woo.test', role: 'competitor' })).status).toBe(409);
    const sixth = await owner.post(`${base()}/sites`, { url: 'http://sixth.test', role: 'competitor' });
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.message).toMatch(/up to 5 competitors/);
  });

  it('every website shows an honest status: nothing is "collected" that has not been', async () => {
    const list = (await owner.get(`${base()}/sites`)).body.sites as { name: string; status: { state: string }; productCount: number }[];
    expect(list).toHaveLength(6);
    expect(list.every((s) => s.productCount === 0 && !['collected', 'collecting'].includes(s.status.state))).toBe(true);
  });
});

describe('4. capability profiling and consent come before collection', () => {
  it('profiles every website in the background and reports what it found, in plain words', async () => {
    for (const k of Object.keys(sites)) expect((await owner.post(`${base()}/sites/${sites[k]}/profile`)).status).toBe(202);
    await h.queue.drain();
    expect((await owner.get(`${base()}/sites/${sites.source}/profile`)).body.profile.status).toBe('full');
    expect((await owner.get(`${base()}/sites/${sites.blocked}/profile`)).body.profile.status).toBe('blocked');
    expect((await owner.get(`${base()}/sites/${sites.failing}/profile`)).body.profile.status).toBe('failed');
  });

  it('refuses to collect without a recorded attestation, and records who confirmed what', async () => {
    const early = await owner.post(`${base()}/sites/${sites.woo}/scans`, { kind: 'discovery' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('consent_required');
    expect((await owner.post(`${base()}/sites/${sites.woo}/consent`, { status: 'confirmed' })).status).toBe(400);
    for (const k of Object.keys(sites)) {
      const r = await owner.post(`${base()}/sites/${sites[k]}/consent`, { status: 'confirmed', attest: true, note: 'journey test' });
      expect(r.status).toBe(200);
    }
  });
});

describe('5. collection through the live fetch policy', () => {
  it('collects every consented website; a blocked and an unreachable competitor are reported as exactly that', async () => {
    await recollect(...Object.keys(sites));
    expect(await runOf('source')).toMatchObject({ status: 'succeeded', isComplete: true });
    expect(await runOf('woo')).toMatchObject({ status: 'succeeded', isComplete: true });
    expect(await runOf('jsonld')).toMatchObject({ status: 'succeeded', isComplete: true });
    expect(await runOf('blocked')).toMatchObject({ status: 'blocked', productsSaved: 0 });
    expect(await runOf('failing')).toMatchObject({ status: 'failed', productsSaved: 0 });
    expect(['succeeded', 'partial']).toContain((await runOf('html')).status);
  });

  it('explains each outcome without ever calling a failure an empty catalogue', async () => {
    const blocked = (await owner.get(`${base()}/scans/${(await runOf('blocked')).id}`)).body;
    expect(blocked.explanation.summary).toMatch(/does not allow automated access/);
    expect(blocked.explanation.nextStep).toBeTruthy();
    const failing = (await owner.get(`${base()}/scans/${(await runOf('failing')).id}`)).body;
    expect(failing.explanation.summary).toMatch(/failure, not an empty catalogue/);
    const ok = (await owner.get(`${base()}/scans/${(await runOf('woo')).id}`)).body;
    expect(ok.explanation.completeness).toBe('complete');
  });

  it('the websites list shows the unified status for each, with product counts from real stored rows', async () => {
    const list = (await owner.get(`${base()}/sites`)).body.sites as { id: string; status: { state: string }; productCount: number }[];
    const by = (k: string) => list.find((s) => s.id === sites[k])!;
    expect(by('source')).toMatchObject({ productCount: 32, status: { state: 'collected' } });
    expect(by('woo').status.state).toBe('collected');
    expect(by('blocked')).toMatchObject({ productCount: 0, status: { state: 'access_denied' } });
    expect(by('failing')).toMatchObject({ productCount: 0, status: { state: 'failed' } });
  });
});

describe('6. nothing here is labelled or stored as fictional — it all took the live path', () => {
  it('every stored page copy, price and stock reading is public-web provenance, never a fixture', async () => {
    const ev = await db().select().from(evidence).where(eq(evidence.orgId, orgId));
    const prices = await db().select().from(priceObservations).where(eq(priceObservations.orgId, orgId));
    const stocks = await db().select().from(stockObservations).where(eq(stockObservations.orgId, orgId));
    expect(ev.length).toBeGreaterThan(20);
    expect(prices.length).toBeGreaterThan(50);
    for (const row of [...ev, ...prices, ...stocks]) {
      expect(row.provenance).toBe('public_web');
    }
    expect(ev.every((e) => /^http:\/\/(mine|rival-[a-z]+)\.test\//.test(e.url))).toBe(true); // the public hostname, never 127.0.0.1
  });

  it('the products API agrees', async () => {
    const list = (await owner.get(`${base()}/products?pageSize=50`)).body;
    expect(list.total).toBeGreaterThan(60);
    expect(list.rows.every((r: { provenance?: string }) => r.provenance === undefined || r.provenance === 'public_web')).toBe(true);
  });

  it('the loopback policy is in force for the workspace’s fetcher, even though fictional sites are listening on this machine', async () => {
    const fetcher = h.svc.makeFetcher();
    await expect(fetcher.fetch(`http://127.0.0.1:${h.fixtures.sites.woo!.port}/robots.txt`, { kind: 'text' })).rejects.toThrow();
    await fetcher.close();
  });
});

describe('7. matching, review and the comparison', () => {
  it('finds candidate matches across the collected competitors, and a person can review them', async () => {
    expect((await owner.post(`${base()}/matches/run`)).status).toBe(202);
    await h.queue.drain();
    const all = (await owner.get(`${base()}/matches?pageSize=500`)).body;
    expect(all.total).toBeGreaterThan(30);
    expect(all.rows.every((m: { competitorSite: string }) => !/Robots|Down/.test(m.competitorSite))).toBe(true); // nothing is matched against sites that were never collected
    const review = (await owner.get(`${base()}/matches?status=needs_review&pageSize=3`)).body.rows;
    if (review.length) expect((await owner.post(`${base()}/matches/${review[0].id}/decision`, { decision: 'accept', note: 'checked' })).status).toBe(200);
    // the customer confirms the groups they trust; only confirmed pairs are compared
    for (const matchClass of ['identical', 'different_pack']) expect((await owner.post(`${base()}/matches/bulk`, { matchClass, minConfidence: 0.5 })).status).toBe(200);
  });

  it('the matrix has real prices from collected sites and says "not available — <why>" for the two that could not be collected', async () => {
    const cmp = (await owner.get(`${base()}/comparison?pageSize=100`)).body;
    expect(cmp.total).toBeGreaterThan(10);
    const facet = (name: string) => cmp.facets.competitors.find((c: { name: string }) => c.name === name);
    expect(facet('Rival Robots').status.state).toBe('access_denied');
    expect(facet('Rival Down').status.state).toBe('failed');
    expect(facet('Rival Woo').status.state).toBe('collected');
    const cell = cmp.rows[0].cells[0];
    expect(cell).toMatchObject({ url: expect.stringMatching(/^http:\/\/rival-/), price: { stale: false, observedAt: expect.any(String) } });
    expect(cmp.rows.some((r: { cells: { siteName: string }[] }) => r.cells.some((c) => /Robots|Down/.test(c.siteName)))).toBe(false);
  });

  it('every price links to evidence that says what was fetched, from where, when, and with what fingerprint', async () => {
    const cmp = (await owner.get(`${base()}/comparison?pageSize=5`)).body;
    const p = (await owner.get(`${base()}/products?q=${encodeURIComponent(cmp.rows[0].title.split(' ')[0])}&siteId=${sites.source}&pageSize=3`)).body.rows[0];
    const d = (await owner.get(`${base()}/products/${p.productId}`)).body;
    expect(d.evidence.length).toBeGreaterThan(0);
    const ev = (await owner.get(`${base()}/evidence/${d.evidence[0].id}`)).body.evidence;
    expect(ev).toMatchObject({ url: expect.stringMatching(/^http:\/\/(mine|rival-[a-z]+)\.test\//), contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) , provenance: 'public_web' });
  });
});

describe('8. prices change, stock changes, promotions expire — and each is recorded from real observations', () => {
  it('a competitor price change is a new observation, and the comparison follows it', async () => {
    const item = h.fixtures.sites.woo!.products.find((x) => x.available && x.itemId < 1000)!;
    const [prod] = await db().select().from(products).where(and(eq(products.siteId, sites.woo!), eq(products.title, item.title)));
    expect(prod, item.title).toBeTruthy();
    const [v] = await db().select().from(variants).where(eq(variants.productId, prod!.id));
    const before = await db().select().from(priceObservations).where(eq(priceObservations.variantId, v!.id));
    h.advance(3_600_000);
    h.fixtures.sites.woo!.setPrice(item.itemId, Math.round(item.price * 1.5 * 100) / 100);
    await recollect('woo');
    const after = await db().select().from(priceObservations).where(eq(priceObservations.variantId, v!.id));
    expect(after.length).toBe(before.length + 1);
    // each fictional site applies its own price factor, so check the change as a ratio: +50% on the previous observation
    expect(after.at(-1)!.price! / before.at(-1)!.price!).toBeCloseTo(1.5, 1);
    expect(before.every((o) => after.some((a) => a.id === o.id))).toBe(true); // history only grows
    h.fixtures.sites.woo!.setPrice(item.itemId, item.price);
  });

  it('own-site stock: going out of stock raises ONE alert (with its page), a repeat scan raises none, and restocking resolves it', async () => {
    const item = h.fixtures.sites.source!.products.find((x) => x.available && x.itemId < 1000)!;
    h.advance(3_600_000);
    h.fixtures.sites.source!.setAvailability(item.itemId, false);
    await recollect('source');
    await recollect('source');
    const open = (await owner.get(`${base()}/alerts?status=open&type=out_of_stock`)).body.rows as { id: string; title: string; evidence: { url: string } | null; data: Record<string, unknown> }[];
    const mine = open.filter((a) => a.title.includes(item.title));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.evidence?.url).toMatch(/^http:\/\/mine\.test\//);
    expect(mine[0]!.data['quantity']).toBeNull(); // public availability only: no invented number
    const stock = (await owner.get(`${base()}/stock`)).body;
    expect(stock.mode).toBe('public');
    expect(stock.rows.every((r: { quantity: number | null }) => r.quantity === null)).toBe(true);

    h.advance(3_600_000);
    h.fixtures.sites.source!.setAvailability(item.itemId, true);
    await recollect('source');
    const resolved = (await owner.get(`${base()}/alerts?status=resolved&type=out_of_stock`)).body.rows as { id: string; resolution: { kind: string } }[];
    expect(resolved.find((a) => a.id === mine[0]!.id)!.resolution.kind).toBe('automatic');
  });

  it('a flyer offer is extracted with its validity, and expires when that date passes (it is not left "active")', async () => {
    const flyers = (await owner.get(`${base()}/offers?kind=flyer&status=active`)).body.offers as { id: string; validTo: string | null; sourceUrl: string; provenance: string }[];
    expect(flyers.length).toBeGreaterThan(2);
    expect(flyers.every((o) => o.validTo !== null && /^http:\/\/rival-ld\.test\/.*\.pdf$/.test(o.sourceUrl) && o.provenance === 'public_web')).toBe(true);
    h.advance(10 * 86_400_000); // past the flyer's validity, inside the 14-day login
    await recollect('woo');
    const active = (await owner.get(`${base()}/offers?kind=flyer&status=active&days=90`)).body.offers;
    const expired = (await owner.get(`${base()}/offers?kind=flyer&status=expired&days=90`)).body.offers;
    expect(expired.length).toBeGreaterThan(0);
    expect(active.length).toBe(0);
  });
});

describe('9. the report, from the same saved snapshot to the dashboard, PDF, CSV and Excel', () => {
  let reportId: string;
  it('is labelled PARTIAL because two competitors could not be collected, and names them — and is not labelled as fixture data', async () => {
    const r = await owner.post(`${base()}/reports`, {});
    expect(r.status).toBe(202);
    await h.queue.drain();
    reportId = (await owner.get(`${base()}/reports/latest`)).body.report.id;
    const rep = (await owner.get(`${base()}/reports/${reportId}`)).body.report;
    expect(rep).toMatchObject({ status: 'partial', isPartial: true });
    expect(rep.data.warnings.join(' ')).toMatch(/Rival Robots/);
    expect(rep.data.warnings.join(' ')).toMatch(/Rival Down/);
    expect(rep.data.warnings.join(' ')).not.toMatch(/FIXTURE/i);
    expect(rep.data.headline).toMatch(/^Partial report/);
  });

  it('every export is produced from that snapshot and carries the same truths', async () => {
    const pdf = await owner.get(`${base()}/reports/${reportId}/export?format=pdf`);
    expect(pdf.status).toBe(200);
    const doc = await getDocumentProxy(new Uint8Array(pdf.raw));
    const { text } = await extractText(doc, { mergePages: true });
    expect(text).toMatch(/PARTIAL REPORT/);
    expect(text).not.toMatch(/FIXTURE DATA/);
    const csv = await owner.get(`${base()}/reports/${reportId}/export?format=csv&dataset=comparison`);
    expect(csv.status).toBe(200);
    expect(String(csv.raw)).not.toMatch(/FIXTURE/);
    expect((await owner.get(`${base()}/reports/${reportId}/export?format=xlsx`)).status).toBe(200);
  });

  it('history works: a second report can be listed and compared with the first', async () => {
    h.advance(3_600_000);
    expect((await owner.post(`${base()}/reports`, {})).status).toBe(202);
    await h.queue.drain();
    const list = (await owner.get(`${base()}/reports`)).body.reports as { id: string }[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect((await owner.get(`${base()}/reports/compare?a=${list[1]!.id}&b=${list[0]!.id}`)).status).toBe(200);
  });
});

describe('10. missing credentials are shown as missing, never as connected', () => {
  it('Shopify, YouTube, Instagram and Facebook are "not set up" and say exactly what is needed', async () => {
    const i = (await owner.get(`${base()}/integrations`)).body;
    expect(i.shopify).toMatchObject({ configured: false });
    expect(i.shopify.missing).toEqual(expect.arrayContaining(['SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_REDIRECT_URI']));
    expect(i.connections).toEqual([]);
    expect(i.social.providers.map((p: { state: string }) => p.state)).toEqual(['not_configured', 'not_configured', 'not_configured']);
    expect(i.social.providers.every((p: { requirements: string[] }) => p.requirements.length > 0)).toBe(true);
  });

  it('actions that cannot work say so with a reason instead of pretending to start', async () => {
    const sync = await owner.post(`${base()}/social/sync`, {});
    expect(sync.status).toBe(409);
    expect(sync.body.error.code).toBe('no_social_accounts');
    expect((await owner.post(`${base()}/integrations/shopify/start`, { shop: 'x.myshopify.com' })).status).toBe(501);
  });
});

describe('11. sign-in failures and other customers', () => {
  it('a wrong password and an unknown address look identical, and neither reveals whether the account exists', async () => {
    const a = await new ApiClient(app).post('/api/v1/auth/login', { email: 'nobody-here@example.test', password: PASSWORD });
    const b = await new ApiClient(app).post('/api/v1/auth/login', { email: (await owner.get('/api/v1/auth/me')).body.user.email, password: 'Wrong-Password-123456' });
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('another customer cannot see, change or guess any of this workspace\'s data — at the API or at the database', async () => {
    const stranger = new ApiClient(app);
    await signUp(stranger, h, { email: `stranger-${Date.now()}@example.test`, password: PASSWORD, displayName: 'Stranger' });
    const otherOrg = (await stranger.post('/api/v1/orgs', { name: 'Someone Else' })).body.organization.id as string;
    const reportId = (await owner.get(`${base()}/reports/latest`)).body.report.id as string;
    const evId = (await db().select().from(evidence).where(eq(evidence.orgId, orgId)).limit(1))[0]!.id;
    const alertId = ((await owner.get(`${base()}/alerts?status=all`)).body.rows as { id: string }[])[0]!.id;
    for (const p of ['', '/sites', `/sites/${sites.woo}`, '/products', '/comparison', '/matches', '/offers', '/stock', '/alerts', '/reports', `/reports/${reportId}`, `/reports/${reportId}/export?format=pdf`, `/evidence/${evId}`, '/integrations', '/members', '/settings']) {
      expect((await stranger.get(`${base()}${p}`)).status, p).toBe(404);
    }
    expect((await stranger.post(`${base()}/alerts/${alertId}/resolve`, {})).status).toBe(404);
    expect((await stranger.post(`${base()}/sites/${sites.woo}/scans`, { kind: 'discovery' })).status).toBe(404);
    // database level: with the other customer's context, none of these rows exist
    const visible = await withTenant(h.db.app, otherOrg, async (tx) => ({ sites: (await tx.select().from(sitesTable)).length, evidence: (await tx.select().from(evidence)).length, products: (await tx.select().from(products)).length }));
    expect(visible).toEqual({ sites: 0, evidence: 0, products: 0 });
  });
});
