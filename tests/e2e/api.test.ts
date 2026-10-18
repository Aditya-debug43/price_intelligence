import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { buildApp } from '../../apps/api/src/app.ts';
import { evidence, integrationConnections, productMatches } from '@ci/database';
import { encryptSecret } from '@ci/core';
import { createOrganization } from '@ci/services';
import type { FastifyInstance } from 'fastify';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp } from '../support/auth.ts';
import { createTestInventory, setTestQuantity } from '../support/inventory.ts';

let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let orgId: string; // the workspace the tests below use; its websites are the fictional test sites
let liveOrgId: string; // a workspace created through the public API, which is always LIVE
const sites: Record<string, string> = {};
const SECRET = 'shopify-test-secret';
const PASSWORD = 'Correct-Horse-9-Battery';
const base = () => `/api/v1/orgs/${orgId}`;

beforeAll(async () => {
  h = await createHarness({ extraEnv: { SHOPIFY_CLIENT_ID: 'cid', SHOPIFY_CLIENT_SECRET: SECRET, SHOPIFY_REDIRECT_URI: 'http://localhost:4000/api/v1/integrations/shopify/callback', SCHEDULER_MODE: 'dev' } });
  // the API process only ever holds the RLS-enforced connection
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
}, 120_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('platform basics', () => {
  it('serves health and public metadata with hardened headers', async () => {
    const c = new ApiClient(app);
    const r = await c.get('/api/v1/health');
    expect(r.status).toBe(200);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    const meta = (await c.get('/api/v1/meta')).body;
    expect(meta).toMatchObject({ aiProvider: 'none', shopifyConfigured: true, version: '0.1.0' });
    expect(meta).not.toHaveProperty('schedulerMode');
    expect(JSON.stringify(meta)).not.toMatch(/secret|password|token/i);
  });

  it('returns JSON 404s for unknown API routes', async () => {
    const r = await new ApiClient(app).get('/api/v1/nope');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
  });
});

describe('registration, login and sessions', () => {
  it('rejects weak or malformed registrations with field-level errors', async () => {
    const c = new ApiClient(app);
    const weak = await c.post('/api/v1/auth/register', { email: 'a@example.test', password: 'short', displayName: 'A' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('validation');
    expect(weak.body.error.details.map((d: { path: string }) => d.path)).toContain('password');
    expect((await c.post('/api/v1/auth/register', { email: 'not-an-email', password: PASSWORD, displayName: 'A' })).status).toBe(400);
    expect((await c.post('/api/v1/auth/register', { email: 'b@example.test', password: 'password12345', displayName: 'B' })).body.error.message).toMatch(/too easy/);
  });

  it('registers (not signed in until the emailed link is used), signs in via an HttpOnly cookie, and never returns the password hash', async () => {
    const email = `owner-${Date.now()}@example.test`;
    const r = await owner.post('/api/v1/auth/register', { email, password: PASSWORD, displayName: 'Olivia Owner' });
    expect(r.status).toBe(201);
    expect(JSON.stringify(r.body)).not.toMatch(/passwordHash|scrypt/);
    expect(owner.cookies.has('ci_session')).toBe(false); // registering does not sign anyone in
    expect((await owner.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(403); // …and an unverified account cannot sign in
    await h.queue.drain();
    expect((await owner.post('/api/v1/auth/verify-email', { token: h.mail.tokenIn(email, 'verify-email') })).status).toBe(200);
    expect((await owner.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(200);
    expect(owner.cookies.has('ci_session')).toBe(true);
    const raw = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-requested-with': 'ci-web' }, payload: { email, password: PASSWORD } })).headers['set-cookie'] as string;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Path=\//);
    const me = await owner.get('/api/v1/auth/me');
    expect(me.body.user.email).toBe(email);
    // registering the same address again answers exactly like a first registration (no account enumeration)
    const dup = await new ApiClient(app).post('/api/v1/auth/register', { email, password: PASSWORD, displayName: 'Dup' });
    expect(dup.status).toBe(201);
    expect(dup.body).toEqual(r.body);
  });

  it('requires the anti-CSRF header and a same-site Origin for state-changing requests', async () => {
    const noHeader = new ApiClient(app, { csrf: false });
    noHeader.cookies = new Map(owner.cookies);
    expect((await noHeader.post('/api/v1/orgs', { name: 'Evil Co' })).status).toBe(403);
    const cross = await owner.post('/api/v1/orgs', { name: 'Evil Co' }, { origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe('csrf');
  });

  it('answers wrong passwords generically, locks out repeated failures, and rate-limits login', async () => {
    const email = `lock-${Date.now()}@example.test`;
    await signUp(new ApiClient(app), h, { email, password: PASSWORD, displayName: 'Lock' });
    const c = new ApiClient(app);
    const bad = await c.post('/api/v1/auth/login', { email, password: 'Wrong-Password-1' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe('Email or password is incorrect.');
    const unknown = await c.post('/api/v1/auth/login', { email: 'nobody@example.test', password: 'Wrong-Password-1' });
    expect(unknown.body.error.message).toBe(bad.body.error.message); // no account enumeration
    for (let i = 0; i < 7; i++) await c.post('/api/v1/auth/login', { email, password: 'Wrong-Password-1' });
    const locked = await c.post('/api/v1/auth/login', { email, password: PASSWORD });
    expect([429]).toContain(locked.status); // correct password still refused while locked
  });

  it('logs out by deleting the server-side session', async () => {
    const email = `out-${Date.now()}@example.test`;
    const c = new ApiClient(app);
    await signUp(c, h, { email, password: PASSWORD, displayName: 'Out' });
    const stolen = new Map(c.cookies);
    expect((await c.post('/api/v1/auth/logout')).status).toBe(200);
    expect((await c.get('/api/v1/auth/me')).status).toBe(401);
    const replay = new ApiClient(app);
    replay.cookies = stolen;
    expect((await replay.get('/api/v1/auth/me')).status).toBe(401); // the old token is dead server-side
  });

  it('password reset: no enumeration, single-use token delivered by email, sessions revoked', async () => {
    const email = `reset-${Date.now()}@example.test`;
    const c = new ApiClient(app);
    await signUp(c, h, { email, password: PASSWORD, displayName: 'Rita' });
    const same = [await c.post('/api/v1/auth/forgot-password', { email }), await c.post('/api/v1/auth/forgot-password', { email: 'ghost@example.test' })];
    expect(same[0]!.body).toEqual(same[1]!.body);
    expect(same[0]!.status).toBe(same[1]!.status);
    await h.queue.drain();
    expect(h.mail.inboxOf('ghost@example.test')).toHaveLength(0); // nothing is sent to an address that has no account
    const token = h.mail.tokenIn(email, 'reset-password')!;
    expect((await c.post('/api/v1/auth/reset-password', { token, password: 'New-Strong-Pass-77' })).status).toBe(200);
    expect((await c.post('/api/v1/auth/reset-password', { token, password: 'Another-Strong-Pass-8' })).status).toBe(400); // single use
    expect((await c.get('/api/v1/auth/me')).status).toBe(401); // old sessions revoked
    expect((await new ApiClient(app).post('/api/v1/auth/login', { email, password: 'New-Strong-Pass-77' })).status).toBe(200);
  });
});

describe('brute-force protection', () => {
  it('the per-IP rate limiter stops credential stuffing altogether (production-default limit)', async () => {
    const strict = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false });
    const c = new ApiClient(strict);
    let limited = 0;
    for (let i = 0; i < 20; i++) if ((await c.post('/api/v1/auth/login', { email: `x${i}@example.test`, password: 'Wrong-Password-1' })).status === 429) limited++;
    expect(limited).toBeGreaterThanOrEqual(8);
    const r = await c.post('/api/v1/auth/login', { email: 'x@example.test', password: 'Wrong-Password-1' });
    expect(r.body.error.code).toBe('rate_limited');
    await strict.close();
  });
});

describe('workspace setup', () => {
  it('creates an empty workspace with sensible defaults (America/Aruba, 09:00, threshold 5); there is only one kind of workspace', async () => {
    const r = await owner.post('/api/v1/orgs', { name: 'Groceries To Go' });
    expect(r.status).toBe(201);
    expect(r.body.organization.mode).toBeUndefined();
    liveOrgId = r.body.organization.id;
    const me = (await owner.get('/api/v1/auth/me')).body;
    expect(me.memberships.find((m: { orgId: string }) => m.orgId === liveOrgId).mode).toBeUndefined();
    orgId = (await createOrganization(h.db.app, me.user.id, 'Collection Org')).id; // a second workspace for the collection tests below
    expect((await owner.get(`/api/v1/orgs/${orgId}`)).body.organization.mode).toBeUndefined();
    const s = (await owner.get(`/api/v1/orgs/${liveOrgId}/settings`)).body.settings;
    expect(s).toMatchObject({ timezone: 'America/Aruba', reportReadyTime: '09:00', lowStockThreshold: 5, reportingCurrency: 'USD', snapshotRetentionDays: 90, historyRetentionDays: 365 });
  });

  it('validates and saves settings (timezone, currency, time, threshold, notifications)', async () => {
    expect((await owner.put(`${base()}/settings`, { timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await owner.put(`${base()}/settings`, { reportReadyTime: '25:61' })).status).toBe(400);
    expect((await owner.put(`${base()}/settings`, { lowStockThreshold: -1 })).status).toBe(400);
    const ok = await owner.put(`${base()}/settings`, { reportingCurrency: 'awg', lowStockThreshold: 7, alertPrefs: { inApp: true, email: true, dailySummaryEmail: true, recipients: ['team@example.test'] } });
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toMatchObject({ reportingCurrency: 'AWG', lowStockThreshold: 7 });
    await owner.put(`${base()}/settings`, { reportingCurrency: 'USD', lowStockThreshold: 5, alertPrefs: { inApp: true, email: true, dailySummaryEmail: true, recipients: [] } });
  });

  it('adds the source and up to five competitors; unsafe or duplicate URLs are rejected', async () => {
    const add = (url: string, role: string) => owner.post(`${base()}/sites`, { url, role });
    for (const u of ['http://169.254.169.254/', 'http://10.1.1.1', 'ftp://shop.example.test', 'not a url', 'http://localhost.internal']) {
      const r = await add(u, 'competitor');
      expect(r.status, u).toBe(400);
    }
    for (const [key, role] of [['source', 'source'], ['woo', 'competitor'], ['jsonld', 'competitor'], ['html', 'competitor'], ['blocked', 'competitor'], ['failing', 'competitor']] as const) {
      const r = await add(h.fixtures.origin(key), role);
      expect(r.status, key).toBe(201);
      sites[key] = r.body.site.id;
      expect(r.body.site).toMatchObject({ consentStatus: 'pending' });
    }
    expect((await add(h.fixtures.origin('woo'), 'competitor')).status).toBe(409);
    const sixth = await add(h.fixtures.origin('challenge'), 'competitor');
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.message).toMatch(/up to 5 competitors/);
  });

  it('lists websites with consent text and lets a site be edited and renamed', async () => {
    const l = (await owner.get(`${base()}/sites`)).body;
    expect(l.sites).toHaveLength(6);
    expect(l.consentText.competitor).toMatch(/robots\.txt/);
    expect(l.limits).toEqual({ maxCompetitors: 5, minCompetitors: 3 });
    const r = await owner.patch(`${base()}/sites/${sites.woo}`, { name: 'Fixture Mart (edited)', currency: 'usd' });
    expect(r.body.site).toMatchObject({ name: 'Fixture Mart (edited)', currency: 'USD', currencySource: 'user' });
    await owner.patch(`${base()}/sites/${sites.woo}`, { name: 'Fixture Mart (WooCommerce, USD)' });
  });
});

describe('profiling, consent and collection', () => {
  it('profiles each site in the background and returns a plain-language capability report', async () => {
    for (const k of Object.keys(sites)) expect((await owner.post(`${base()}/sites/${sites[k]}/profile`)).status).toBe(202);
    await h.queue.drain();
    const src = (await owner.get(`${base()}/sites/${sites.source}/profile`)).body.profile;
    expect(src).toMatchObject({ status: 'full' });
    expect(src.data.fields.price.availability).toBe('available');
    expect(src.data.limitations.length).toBeGreaterThan(0);
    expect((await owner.get(`${base()}/sites/${sites.blocked}/profile`)).body.profile.status).toBe('blocked');
    expect((await owner.get(`${base()}/sites/${sites.failing}/profile`)).body.profile.status).toBe('failed');
    expect((await owner.get(`${base()}/sites/${sites.source}/profiles`)).body.profiles).toHaveLength(1);
  });

  it('refuses to collect until consent is recorded with an explicit attestation', async () => {
    const early = await owner.post(`${base()}/sites/${sites.source}/scans`, { kind: 'discovery' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('consent_required');
    expect((await owner.post(`${base()}/sites/${sites.source}/consent`, { status: 'confirmed' })).status).toBe(400);
    for (const k of Object.keys(sites)) {
      const r = await owner.post(`${base()}/sites/${sites[k]}/consent`, { status: 'confirmed', attest: true, note: 'owner approval on file' });
      expect(r.status).toBe(200);
      expect(r.body.site.consentNote).toMatch(/\[v1\]/);
    }
  });

  it('starts collection, exposes run progress and then the products', async () => {
    for (const k of Object.keys(sites)) expect([202, 200]).toContain((await owner.post(`${base()}/sites/${sites[k]}/scans`, { kind: 'discovery' })).status);
    // starting again while one is queued is idempotent
    const again = await owner.post(`${base()}/sites/${sites.source}/scans`, { kind: 'discovery' });
    expect(again.body.alreadyRunning).toBe(true);
    await h.queue.drain();
    const runs = (await owner.get(`${base()}/scans`)).body.scans;
    expect(runs.find((r: { siteId: string }) => r.siteId === sites.source)).toMatchObject({ status: 'succeeded', isComplete: true });
    expect(runs.find((r: { siteId: string }) => r.siteId === sites.blocked)).toMatchObject({ status: 'blocked' });
    expect(runs.find((r: { siteId: string }) => r.siteId === sites.failing)).toMatchObject({ status: 'failed' });
    const detail = (await owner.get(`${base()}/scans/${runs.find((r: { siteId: string }) => r.siteId === sites.jsonld).id}`)).body;
    expect(detail.queue.done).toBeGreaterThan(20);
    const list = (await owner.get(`${base()}/sites`)).body.sites;
    expect(list.find((s: { id: string }) => s.id === sites.source).productCount).toBe(32);
    expect(list.find((s: { id: string }) => s.id === sites.blocked).productCount).toBe(0);
  });

  it('supports a small live refresh (sample) across consented sites', async () => {
    const r = await owner.post(`${base()}/refresh`, { limit: 4 });
    expect(r.status).toBe(202);
    expect(r.body.started.length).toBeGreaterThanOrEqual(4);
    await h.queue.drain();
    const sample = (await owner.get(`${base()}/scans?siteId=${sites.source}`)).body.scans[0];
    expect(sample).toMatchObject({ kind: 'sample', isComplete: false });
  });
});

describe('intelligence endpoints', () => {
  it('runs matching in the background and lists matches with confidence and reasons; reviews persist', async () => {
    expect((await owner.post(`${base()}/matches/run`)).status).toBe(202);
    await h.queue.drain();
    const all = (await owner.get(`${base()}/matches?pageSize=500`)).body;
    expect(all.total).toBeGreaterThan(40);
    expect(all.rows[0]).toMatchObject({ confidence: expect.any(Number), reasons: expect.any(Array) });
    const review = (await owner.get(`${base()}/matches?status=needs_review&pageSize=5`)).body;
    expect(review.rows.length).toBeGreaterThan(0);
    const m = review.rows[0];
    const accepted = await owner.post(`${base()}/matches/${m.id}/decision`, { decision: 'accept', note: 'checked the label' });
    expect(accepted.body.match).toMatchObject({ status: 'accepted', decidedBy: expect.any(String) });
    expect((await owner.post(`${base()}/matches/${m.id}/decision`, { decision: 'reclassify' })).status).toBe(400);
    expect((await owner.get(`${base()}/matches?minConfidence=0.9&class=identical`)).body.rows.every((r: { confidence: number }) => r.confidence >= 0.9)).toBe(true);
  });

  it('serves the comparison matrix with server-side filtering and sorting', async () => {
    const all = (await owner.get(`${base()}/comparison?pageSize=100`)).body;
    expect(all.reportingCurrency).toBe('USD');
    expect(all.total).toBeGreaterThan(15);
    expect(all.facets.competitors).toHaveLength(5);
    expect(all.fx.some((f: { source: string }) => /Central Bank of Aruba/.test(f.source))).toBe(true);
    const cell = all.rows[0].cells[0];
    expect(cell).toMatchObject({ url: expect.stringMatching(/^http/), price: { observedAt: expect.any(String), stale: false } });

    const byGap = (await owner.get(`${base()}/comparison?sort=gap&dir=desc&pageSize=5&matchClass=identical`)).body;
    const gaps = byGap.rows.map((r: { cells: { diffPct: number | null }[] }) => Math.max(...r.cells.map((c) => Math.abs(c.diffPct ?? 0))));
    expect(gaps).toEqual([...gaps].sort((a, b) => b - a));
    const q = (await owner.get(`${base()}/comparison?q=ketchup`)).body;
    expect(q.rows.length).toBeGreaterThan(0);
    expect(q.rows.every((r: { title: string }) => /ketchup/i.test(r.title))).toBe(true);
    const cat = (await owner.get(`${base()}/comparison?category=${encodeURIComponent('Beverages > Soda')}`)).body;
    expect(cat.rows.every((r: { category: string }) => r.category === 'Beverages > Soda')).toBe(true);
    const site = (await owner.get(`${base()}/comparison?siteId=${sites.woo}`)).body;
    expect(site.rows.every((r: { cells: { siteId: string }[] }) => r.cells.every((c) => c.siteId === sites.woo))).toBe(true);
    expect((await owner.get(`${base()}/comparison?freshness=stale`)).body.total).toBe(0);
    expect((await owner.get(`${base()}/comparison?sort=bogus`)).status).toBe(400);
  });

  it('serves offers, own stock, marketing and assortment views with honest labelling', async () => {
    const offers = (await owner.get(`${base()}/offers`)).body;
    expect(offers.offers.some((o: { kind: string; verification: string }) => o.kind === 'sale_price' && o.verification === 'unverified')).toBe(true);
    expect(offers.offers.some((o: { kind: string }) => o.kind === 'flyer')).toBe(true);
    expect((await owner.get(`${base()}/offers?kind=flyer`)).body.offers.every((o: { kind: string }) => o.kind === 'flyer')).toBe(true);

    const stock = (await owner.get(`${base()}/stock`)).body;
    expect(stock).toMatchObject({ mode: 'public', threshold: 5, connection: null });
    expect(stock.explanation).toMatch(/nothing is estimated/);
    expect(stock.rows.every((r: { quantity: number | null; quantitySource: string | null }) => r.quantity === null && r.quantitySource === null)).toBe(true);

    const mk = (await owner.get(`${base()}/marketing`)).body;
    expect(mk.activity.length).toBeGreaterThan(0);
    expect(mk.activity.every((m: { paidStatus: string }) => m.paidStatus === 'not_determined')).toBe(true);
    const as = (await owner.get(`${base()}/assortment?side=competitor&pageSize=5`)).body;
    expect(as.note).toMatch(/not that none exists/);
  });

  it('lists products with filters, shows product detail with history, matches, offers and evidence', async () => {
    const list = (await owner.get(`${base()}/products?siteId=${sites.source}&q=heinz&pageSize=10`)).body;
    expect(list.rows.length).toBeGreaterThanOrEqual(2);
    expect(list.rows[0]).toMatchObject({ stale: false });
    const pid = list.rows.find((r: { title: string }) => r.title === 'Heinz Tomato Ketchup 397g').productId;
    const d = (await owner.get(`${base()}/products/${pid}`)).body;
    expect(d.product.title).toBe('Heinz Tomato Ketchup 397g');
    expect(d.variants).toHaveLength(1);
    expect(d.priceHistory.length).toBeGreaterThanOrEqual(1);
    expect(d.matches.length).toBeGreaterThan(0);
    expect(d.matches[0].other).toMatchObject({ siteName: expect.any(String), price: expect.any(Number) });
    expect(d.evidence.length).toBeGreaterThan(0);
    expect(d.evidence[0]).toMatchObject({ contentHash: expect.stringMatching(/^[0-9a-f]{64}$/), provenance: 'public_web' });
    expect((await owner.get(`${base()}/products?matched=no&siteId=${sites.source}`)).status).toBe(200);
    expect((await owner.get(`${base()}/products/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });

  it('serves raw evidence snapshots only as inert plain-text attachments', async () => {
    const [ev] = await h.db.worker.select().from(evidence).where(and(eq(evidence.orgId, orgId)));
    const withSnap = (await h.db.worker.select().from(evidence).where(eq(evidence.orgId, orgId))).find((e) => e.snapshotRef)!;
    expect(ev).toBeTruthy();
    const r = await owner.get(`${base()}/evidence/${withSnap.id}/snapshot`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment/);
    expect(String(r.headers['content-security-policy'])).toMatch(/sandbox/);
    expect((await owner.get(`${base()}/evidence/${withSnap.id}`)).body.evidence.snapshotAvailable).toBe(true);
  });

  it('shows the dashboard and the data-quality view built from real stored data', async () => {
    const d = (await owner.get(`${base()}/dashboard`)).body;
    expect(d.coverage).toHaveLength(6);
    expect(d.freshness.newest).toBeTruthy();
    expect(d.nextReport).toMatchObject({ timezone: 'America/Aruba', enabled: true });
    expect(d.latestReport).toBeNull(); // no report yet — the UI must show an empty state, not invented KPIs
    const q = (await owner.get(`${base()}/quality`)).body;
    expect(q.extraction.some((e: { method: string }) => e.method === 'json_ld')).toBe(true);
    expect(q.recentProblems.some((p: { status: string }) => p.status === 'blocked')).toBe(true);
  });
});

describe('reports, exports and alerts through the API', () => {
  let reportId: string;
  it('generates a report asynchronously, then serves it from the saved snapshot', async () => {
    const r = await owner.post(`${base()}/reports`, {});
    expect(r.status).toBe(202);
    reportId = r.body.report.id;
    expect((await owner.get(`${base()}/reports/${reportId}`)).body.report.status).toBe('generating');
    await h.queue.drain();
    const done = (await owner.get(`${base()}/reports/${reportId}`)).body.report;
    expect(done.status).toBe('partial');
    expect(done.data.kpis.matchedProducts).toBeGreaterThan(15);
    expect((await owner.get(`${base()}/reports`)).body.reports[0]).toMatchObject({ id: reportId, isPartial: true });
    expect((await owner.get(`${base()}/reports/latest`)).body.report.id).toBe(reportId);
    const dash = (await owner.get(`${base()}/dashboard`)).body;
    expect(dash.latestReport).toMatchObject({ id: reportId, isPartial: true });
    expect((await owner.get(`${base()}/insights`)).body.insights.length).toBeGreaterThan(3);
  });

  it('downloads PDF, CSV and Excel with correct headers and consistent content', async () => {
    const pdf = await owner.get(`${base()}/reports/${reportId}/export?format=pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(String(pdf.headers['content-disposition'])).toMatch(/attachment; filename="report-.*partial\.pdf"/);
    expect(pdf.raw.subarray(0, 4).toString()).toBe('%PDF');
    const csv = await owner.get(`${base()}/reports/${reportId}/export?format=csv&dataset=offers`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.raw.toString('utf8')).toContain('Website,Role,Kind');
    const xlsx = await owner.get(`${base()}/reports/${reportId}/export?format=xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.raw as never);
    expect(wb.getWorksheet('Price comparison')!.rowCount).toBeGreaterThan(20);
    expect((await owner.get(`${base()}/reports/${reportId}/export?format=docx`)).status).toBe(400);
  });

  it('compares two saved reports', async () => {
    const second = await owner.post(`${base()}/reports`, {});
    await h.queue.drain();
    const c = (await owner.get(`${base()}/reports/compare?a=${reportId}&b=${second.body.report.id}`)).body.comparison;
    expect(c.kpiDelta.length).toBeGreaterThan(5);
    expect(c.notes.join(' ')).toMatch(/partial/);
  });

  it('lists, acknowledges and configures alerts', async () => {
    const list = (await owner.get(`${base()}/alerts`)).body;
    expect(list.total).toBeGreaterThan(0);
    const open = (await owner.get(`${base()}/alerts?status=open`)).body.rows;
    expect((await owner.post(`${base()}/alerts/${open[0].id}/ack`)).status).toBe(200);
    expect((await owner.get(`${base()}/alerts?status=acknowledged`)).body.rows.some((a: { id: string }) => a.id === open[0].id)).toBe(true);
    expect((await owner.post(`${base()}/alerts/00000000-0000-4000-8000-000000000000/ack`)).status).toBe(404);
    expect((await owner.get(`${base()}/alert-rules`)).body.rules.map((r: { type: string }) => r.type).sort()).toEqual(['collection_failure', 'low_stock', 'out_of_stock', 'restocked']);
    const upd = await owner.put(`${base()}/alert-rules`, { type: 'low_stock', enabled: true, channelInApp: true, channelEmail: false });
    expect(upd.body.rule).toMatchObject({ channelEmail: false });
    expect((await owner.put(`${base()}/alert-rules`, { type: 'report_ready', enabled: true })).status).toBe(400);
    expect((await owner.post(`${base()}/alerts/ack-all`)).body.acknowledged).toBeGreaterThanOrEqual(0);
  });

  it('per-product low-stock thresholds are validated and saved', async () => {
    const v = (await owner.get(`${base()}/stock?includeInStock=true`)).body.rows[0];
    expect((await owner.put(`${base()}/variants/${v.variantId}/threshold`, { threshold: 12 })).status).toBe(200);
    expect((await owner.put(`${base()}/variants/${v.variantId}/threshold`, { threshold: -3 })).status).toBe(400);
    expect((await owner.put(`${base()}/variants/${v.variantId}/threshold`, { threshold: null })).status).toBe(200);
  });
});

describe('integrations through the API', () => {
  it('reports Shopify and social status honestly, including what is missing', async () => {
    const i = (await owner.get(`${base()}/integrations`)).body;
    expect(i.shopify).toMatchObject({ readOnly: true, scopes: 'read_products,read_inventory,read_locations' });
    expect(i.shopify).toMatchObject({ configured: true, missing: [] });
    expect(i.social.providers.map((p: { provider: string; state: string }) => [p.provider, p.state])).toEqual([['youtube', 'not_configured'], ['instagram', 'not_configured'], ['facebook', 'not_configured']]);
    expect(i.social.providers.every((p: { requirements: string[]; limits: string[] }) => p.requirements.length && p.limits.length)).toBe(true);
    expect(i.social.accounts.some((a: { platform: string; confirmed: boolean }) => a.platform === 'facebook' && !a.confirmed)).toBe(true);
  });

  it('requires an owner-confirmed account mapping and says "not configured" instead of faking sync results', async () => {
    const acct = (await owner.get(`${base()}/integrations`)).body.social.accounts[0];
    expect((await owner.patch(`${base()}/social-accounts/${acct.id}`, { confirmed: true })).body.account.confirmed).toBe(true);
    expect((await owner.post(`${base()}/social/sync`)).status).toBe(202);
    await h.queue.drain();
    const after = (await owner.get(`${base()}/integrations`)).body.social.accounts.find((a: { id: string }) => a.id === acct.id);
    expect(after.lastSyncStatus).toBe('not_configured');
    expect(after.lastSyncMessage).toMatch(/not (connected|configured)|No .* key/i);
    const manual = await owner.post(`${base()}/social-accounts`, { siteId: sites.woo, platform: 'youtube', handle: '@mystore' });
    expect(manual.status).toBe(201);
    expect(manual.body.account).toMatchObject({ confirmed: true, discoveredFrom: 'manual' });
  });

  it('Shopify start needs a valid myshopify domain; the callback rejects unsigned or replayed requests', async () => {
    const bad = await owner.post(`${base()}/integrations/shopify/start`, { shop: 'evil.com/x' });
    expect([400, 501]).toContain(bad.status);
    const cb = await owner.get(`/api/v1/integrations/shopify/callback?shop=demo.myshopify.com&code=abc&state=nope&hmac=deadbeef`);
    expect(cb.status).toBe(302);
    expect(String(cb.headers.location)).toContain('error=');
  });

  it('webhooks require a valid HMAC; an uninstall webhook revokes the connection and wipes tokens', async () => {
    const [conn] = await h.db.worker
      .insert(integrationConnections)
      .values({ orgId, provider: 'shopify', status: 'connected', shopDomain: 'demo.myshopify.com', accessTokenEnc: encryptSecret('shpat_x', h.svc.keyRing!), refreshTokenEnc: encryptSecret('shprt_x', h.svc.keyRing!) })
      .returning();
    const body = JSON.stringify({ id: 1 });
    const headers = { 'content-type': 'application/json', 'x-shopify-topic': 'app/uninstalled', 'x-shopify-shop-domain': 'demo.myshopify.com' };
    const unsigned = await app.inject({ method: 'POST', url: '/api/v1/webhooks/shopify', headers: { ...headers, 'x-shopify-hmac-sha256': 'bogus' }, payload: body });
    expect(unsigned.statusCode).toBe(401);
    const sig = createHmac('sha256', SECRET).update(body).digest('base64');
    const ok = await app.inject({ method: 'POST', url: '/api/v1/webhooks/shopify', headers: { ...headers, 'x-shopify-hmac-sha256': sig }, payload: body });
    expect(ok.statusCode).toBe(200);
    await h.queue.drain();
    const [after] = await h.db.worker.select().from(integrationConnections).where(eq(integrationConnections.id, conn!.id));
    expect(after).toMatchObject({ status: 'revoked', accessTokenEnc: null, refreshTokenEnc: null });
  });

  it('a connected inventory is reported as authorised, with an honest sync health', async () => {
    const me = (await owner.get('/api/v1/auth/me')).body.user.id as string;
    const created = { body: await createTestInventory(h.svc, h.db.worker, orgId, me) };
    const sku = h.fixtures.sites.source!.find(1)!.sku;
    const r = { body: await setTestQuantity(h.svc, h.db.worker, orgId, created.body.connectionId, { sku, quantity: 3 }) };
    expect(r.body.alerts).toBe(1);
    const stock = (await owner.get(`${base()}/stock`)).body;
    expect(stock.mode).toBe('authorised');
    expect(stock.explanation).toMatch(/authorised/i);
    expect(stock.explanation).not.toMatch(/SIMULATED/i);
    expect(stock.rows.find((x: { quantity: number | null }) => x.quantity === 3)).toMatchObject({ quantitySource: 'authorised_inventory', state: 'low_stock' });
    // the connection's sync health is reported honestly, so the page can refuse to look green when the data may be stale or the sync failed
    expect(stock.connection.syncHealth).toBe(stock.connection.lastSyncAt ? 'ok' : 'never');
    await h.db.worker.update(integrationConnections).set({ lastError: 'token expired (test)' }).where(eq(integrationConnections.id, created.body.connectionId));
    expect((await owner.get(`${base()}/stock`)).body.connection).toMatchObject({ syncHealth: 'failed', lastError: 'token expired (test)' });
    expect((await owner.delete(`${base()}/integrations/${created.body.connectionId}`)).status).toBe(200);
  });
});

describe('roles', () => {
  let staff: ApiClient;
  it('staff can read, review matches and acknowledge alerts but cannot change configuration', async () => {
    staff = new ApiClient(app);
    const email = `staff-${Date.now()}@example.test`;
    await signUp(staff, h, { email, password: PASSWORD, displayName: 'Sam Staff' });
    expect((await owner.post(`${base()}/members`, { email, role: 'staff' })).status).toBe(201);
    expect((await owner.post(`${base()}/members`, { email, role: 'staff' })).status).toBe(409);
    expect((await staff.get(`${base()}/dashboard`)).status).toBe(200);
    expect((await staff.get(`${base()}/comparison`)).status).toBe(200);
    for (const [method, url, body] of [
      ['POST', `${base()}/sites`, { url: 'https://shop.example.test', role: 'competitor' }],
      ['PUT', `${base()}/settings`, { lowStockThreshold: 1 }],
      ['PATCH', `${base()}/sites/${sites.woo}`, { name: 'x' }],
      ['DELETE', `${base()}/sites/${sites.woo}`, undefined],
      ['POST', `${base()}/sites/${sites.woo}/consent`, { status: 'revoked' }],
      ['POST', `${base()}/sites/${sites.woo}/scans`, {}],
      ['PUT', `${base()}/alert-rules`, { type: 'low_stock', enabled: false }],
    ] as const) {
      const r = await staff.request(method, url, body);
      expect(r.status, `${method} ${url}`).toBe(403);
    }
    const review = (await owner.get(`${base()}/matches?status=needs_review&pageSize=1`)).body.rows[0];
    expect((await staff.post(`${base()}/matches/${review.id}/decision`, { decision: 'reject' })).status).toBe(200);
    expect((await staff.post(`${base()}/alerts/ack-all`)).status).toBe(200);
    expect((await staff.post(`${base()}/reports`, {})).status).toBe(202);
  });

  it('staff cannot promote themselves; the last owner cannot be removed', async () => {
    const members = (await owner.get(`${base()}/members`)).body.members;
    const sam = members.find((m: { displayName: string }) => m.displayName === 'Sam Staff');
    const olivia = members.find((m: { displayName: string }) => m.displayName === 'Olivia Owner');
    expect((await staff.patch(`${base()}/members/${sam.userId}`, { role: 'owner' })).status).toBe(403);
    expect((await owner.delete(`${base()}/members/${olivia.userId}`)).status).toBe(409);
    expect((await owner.patch(`${base()}/members/${olivia.userId}`, { role: 'staff' })).status).toBe(409);
  });
});

describe('tenant isolation through the API', () => {
  it('another signed-in user gets 404 for EVERY resource of this workspace, and cannot cross-reference ids', async () => {
    const intruder = new ApiClient(app);
    await signUp(intruder, h, { email: `intruder-${Date.now()}@example.test`, password: PASSWORD, displayName: 'Mallory' });
    const mine = await intruder.post('/api/v1/orgs', { name: 'Mallory Mart' });
    const myOrg = mine.body.organization.id;
    const reportId = (await owner.get(`${base()}/reports/latest`)).body.report.id;
    const paths = ['', '/settings', '/members', '/sites', `/sites/${sites.source}`, `/sites/${sites.source}/profile`, '/scans', '/products', '/matches', '/comparison', '/offers', '/stock', '/marketing', '/assortment', '/insights', '/dashboard', '/quality', '/reports', `/reports/${reportId}`, `/reports/${reportId}/export?format=pdf`, '/alerts', '/alert-rules', '/integrations'];
    for (const p of paths) {
      const r = await intruder.get(`${base()}${p}`);
      expect(r.status, `GET ${p}`).toBe(404);
    }
    for (const [m, p] of [['POST', '/sites'], ['PUT', '/settings'], ['POST', '/reports'], ['POST', '/matches/run'], ['POST', '/refresh']] as const) expect((await intruder.request(m, `${base()}${p}`, {})).status, `${m} ${p}`).toBe(404);
    // ids from another workspace used inside the intruder's OWN workspace path resolve to nothing
    const own = `/api/v1/orgs/${myOrg}`;
    for (const p of [`/sites/${sites.source}`, `/sites/${sites.source}/profile`, `/reports/${reportId}`, `/reports/${reportId}/export?format=csv`]) expect((await intruder.get(`${own}${p}`)).status, `own-path ${p}`).toBe(404);
    expect((await intruder.get(`${own}/products`)).body.total).toBe(0);
    expect((await intruder.get(`${own}/comparison`)).body.total).toBe(0);
    expect((await intruder.get(`${own}/sites`)).body.sites).toHaveLength(0);
    const someMatch = (await h.db.worker.select().from(productMatches).where(eq(productMatches.orgId, orgId)).limit(1))[0]!;
    expect((await intruder.post(`${own}/matches/${someMatch.id}/decision`, { decision: 'reject' })).status).toBe(404);
    const someEvidence = (await h.db.worker.select().from(evidence).where(eq(evidence.orgId, orgId)).limit(1))[0]!;
    expect((await intruder.get(`${own}/evidence/${someEvidence.id}`)).status).toBe(404);
    expect((await intruder.put(`${own}/settings`, { lowStockThreshold: 1 })).status).toBe(200); // her own workspace is fine
    expect((await owner.get(`${base()}/settings`)).body.settings.lowStockThreshold).toBe(5); // and ours is untouched
  });

  it('unauthenticated callers get 401 on organisation routes', async () => {
    const anon = new ApiClient(app);
    for (const p of ['', '/settings', '/sites', '/dashboard']) expect((await anon.get(`${base()}${p}`)).status).toBe(401);
    expect((await anon.get('/api/v1/auth/me')).status).toBe(401);
    expect((await anon.get('/api/v1/orgs')).status).toBe(401);
  });

  it('malformed organisation ids are treated as not found, not as errors', async () => {
    expect((await owner.get('/api/v1/orgs/not-a-uuid/sites')).status).toBe(404);
    expect((await owner.get("/api/v1/orgs/' or 1=1 --/sites")).status).toBe(404);
  });
});

