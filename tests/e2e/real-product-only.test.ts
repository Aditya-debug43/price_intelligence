import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.ts';
import { evidence, exchangeRates, offers, priceObservations, sites } from '@ci/database';
import { addSite, ensureFxRates, fetchPolicyFrom, provenanceFor, startScan, updateSite } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';

/**
 * There is one product: a real customer's. This file proves that the demonstration/fixture/simulator machinery is gone from the product and
 * that nothing fictional can enter a customer's workspace, at every layer:
 *   1. a workspace starts empty;  2. no address that is local or private can be added — there is no exception and no setting for one;
 *   3. the database has no notion of demo or fixture data;  4. the API has no demo, developer or simulator surface;
 *   5. the production source contains no such code, imports nothing from the test tree, and the only loopback seam is test-only.
 * (The fictional websites the tests collect from are served under ordinary-looking public hostnames; see tests/support/fixtures.)
 */
let h: Harness;
let t: Tenant;
let app: FastifyInstance;
const PASSWORD = 'Correct-Horse-9-Battery';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

beforeAll(async () => {
  h = await createHarness();
  t = await h.newTenant('Real');
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
}, 120_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('1. a new workspace starts genuinely empty', () => {
  it('has no websites, products, observations, offers, alerts, reports or connections — only default settings', async () => {
    const db = h.db.worker;
    const count = async (table: string) => Number((await db.execute(sql.raw(`select count(*)::int as n from ${table} where org_id = '${t.orgId}'`))).rows[0]!['n']);
    for (const table of ['sites', 'products', 'variants', 'price_observations', 'stock_observations', 'offers', 'marketing_activities', 'alerts', 'reports', 'integration_connections', 'product_matches', 'scan_runs', 'insights']) {
      expect(await count(table), table).toBe(0);
    }
    expect(await count('org_settings')).toBe(1);
  });
});

describe('2. local, private and internal addresses can never be added', () => {
  const bad = ['http://127.0.0.1', 'http://127.0.0.1:4101', 'http://localhost', 'http://[::1]/', 'http://10.1.2.3', 'http://192.168.0.5', 'http://169.254.169.254/latest', 'http://printer.local', 'http://intranet.internal'];
  it('refuses every one of them, with no setting that changes that', async () => {
    for (const url of bad) {
      await expect(t.tx((tx) => addSite(h.svc, tx, t.orgId, t.userId, { url, role: 'competitor' })), url).rejects.toThrow();
    }
    expect(await h.db.worker.select().from(sites).where(eq(sites.orgId, t.orgId))).toHaveLength(0);
  });

  it('a website cannot be re-pointed at a different host: its data belongs to the website it came from', async () => {
    const s = await t.tx((tx) => addSite(h.svc, tx, t.orgId, t.userId, { url: 'https://shop.example.test', role: 'source' }));
    // loopback, another public host, anything: a different hostname is a different website
    for (const url of ['http://127.0.0.1:4101', 'https://another-shop.example.test']) {
      await expect(t.tx((tx) => updateSite(h.svc, tx, t.orgId, t.userId, s.id, { url })), url).rejects.toThrow(/remove this one and add the new address/);
    }
    // the same website may change its scheme
    const same = await t.tx((tx) => updateSite(h.svc, tx, t.orgId, t.userId, s.id, { url: 'http://shop.example.test' }));
    expect(same.hostname).toBe('shop.example.test');
    expect(same.url).toBe('http://shop.example.test/');
  });

  it('collected data stays with the website it was collected from, even if someone tries to re-point the site', async () => {
    const siteId = await t.addFixtureSite('html', 'competitor');
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    const countProducts = async () => Number((await h.db.worker.execute(sql`select count(*)::int as n from products where site_id = ${siteId}`)).rows[0]!['n']);
    const before = await countProducts();
    expect(before).toBeGreaterThan(0);
    await expect(t.tx((tx) => updateSite(h.svc, tx, t.orgId, t.userId, siteId, { url: 'https://amazon-lookalike.example.test' }))).rejects.toThrow(/remove this one/);
    const [row] = await h.db.worker.select().from(sites).where(eq(sites.id, siteId));
    expect(row!.hostname).toBe('rival-html.test');
    expect(await countProducts()).toBe(before);
  });

  it('the production fetch policy never allows loopback, and configuration has no switch that could', () => {
    expect(fetchPolicyFrom(h.svc.config).allowLoopback).toBe(false);
    const cfg = h.svc.config as unknown as Record<string, unknown>;
    for (const k of ['ALLOW_LOCAL_FIXTURES', 'DEMO_AUTO_CONSENT', 'SCHEDULER_MODE']) expect(cfg[k], k).toBeUndefined();
  });

  it('only accepts the standard web ports, at add time and when a website is edited', async () => {
    await expect(t.tx((tx) => addSite(h.svc, tx, t.orgId, t.userId, { url: 'https://rival-one.example.test:8080', role: 'competitor' }))).rejects.toThrow(/ports 80 and 443/);
    const ok = await t.tx((tx) => addSite(h.svc, tx, t.orgId, t.userId, { url: 'https://rival-one.example.test:443', role: 'competitor' }));
    expect(ok.hostname).toBe('rival-one.example.test');
    const s = await t.tx((tx) => addSite(h.svc, tx, t.orgId, t.userId, { url: 'http://rival-two.example.test:80/', role: 'competitor' }));
    await expect(t.tx((tx) => updateSite(h.svc, tx, t.orgId, t.userId, s.id, { url: 'https://rival-two.example.test:9090' }))).rejects.toThrow(/ports 80 and 443/);
  });
});

describe('3. the database has no notion of demo or fixture data', () => {
  it('has none of the removed columns', async () => {
    const cols = (await h.db.worker.execute(sql`
      select table_name || '.' || column_name as c from information_schema.columns
      where table_schema = 'public' and (column_name in ('is_fixture', 'is_simulated', 'contains_fixture') or (table_name = 'organizations' and column_name = 'mode'))`)).rows.map((r) => String(r['c']));
    expect(cols).toEqual([]);
  });

  it('has none of the removed guards, and no row anywhere is labelled as fixture or simulated', async () => {
    const triggers = (await h.db.worker.execute(sql`select tgname from pg_trigger where tgname in ('organizations_mode_immutable', 'sites_fixture_only_in_demo')`)).rows;
    expect(triggers).toHaveLength(0);
    const labelled = (await h.db.worker.execute(sql`
      select (select count(*) from evidence where provenance = 'fixture')
           + (select count(*) from price_observations where provenance = 'fixture')
           + (select count(*) from stock_observations where provenance = 'fixture' or quantity_source = 'simulated')
           + (select count(*) from offers where provenance = 'fixture')
           + (select count(*) from marketing_activities where provenance = 'fixture') as n`)).rows[0]!['n'];
    expect(Number(labelled)).toBe(0);
  });
});

describe('4. the API has no demo, developer or simulator surface', () => {
  let owner: ApiClient;
  let orgId: string;
  beforeAll(async () => {
    owner = new ApiClient(app);
    expect((await owner.post('/api/v1/auth/register', { email: `real-${Date.now()}@example.test`, password: PASSWORD, displayName: 'Real Owner' })).status).toBe(201);
    const r = await owner.post('/api/v1/orgs', { name: 'Real Product Shop', mode: 'demo' });
    expect(r.status).toBe(201);
    orgId = r.body.organization.id;
    expect(r.body.organization.mode).toBeUndefined();
  });

  it('advertises no demo, fixture, developer-clock or simulator capability', async () => {
    const meta = (await owner.get('/api/v1/meta')).body as Record<string, unknown>;
    for (const k of ['schedulerMode', 'devTools', 'allowLocalFixtures']) expect(meta[k], k).toBeUndefined();
    const integrations = (await owner.get(`/api/v1/orgs/${orgId}/integrations`)).body as Record<string, unknown>;
    expect(integrations['devInventoryAvailable']).toBeUndefined();
  });

  it('has no developer routes: an email outbox, a scheduler clock or a quantity simulator', async () => {
    expect((await owner.get(`/api/v1/orgs/${orgId}/dev/outbox`)).status).toBe(404);
    expect((await owner.post(`/api/v1/orgs/${orgId}/dev/scheduler/tick`, { now: '2026-10-15T11:20:00.000Z' })).status).toBe(404);
    expect((await owner.post(`/api/v1/orgs/${orgId}/integrations/dev-inventory`, {})).status).toBe(404);
    expect((await owner.post(`/api/v1/orgs/${orgId}/integrations/dev-inventory/simulate`, {})).status).toBe(404);
  });

  it('an empty workspace shows empty data everywhere — no sample products, prices, insights or reports', async () => {
    for (const p of ['sites', 'products', 'alerts', 'offers', 'reports', 'comparison', 'marketing', 'stock']) {
      const r = await owner.get(`/api/v1/orgs/${orgId}/${p}`);
      expect(r.status, p).toBe(200);
      const body = r.body as Record<string, unknown>;
      const lists = Object.values(body).filter(Array.isArray) as unknown[][];
      expect(lists.every((l) => l.length === 0), p).toBe(true);
    }
  });
});

describe('5. provenance never claims fiction', () => {
  it('labels authorised and official sources apart from public pages', () => {
    expect(provenanceFor({ quantitySource: 'authorised_inventory' })).toBe('authorised_api');
    expect(provenanceFor({ official: true })).toBe('official_api');
    expect(provenanceFor({ quantitySource: 'public_claim' })).toBe('public_web');
    expect(provenanceFor()).toBe('public_web');
  });

  it('data collected over the (imitated) network is a public-web observation; the AWG peg is a configured value, not a market rate', async () => {
    const siteId = await t.addFixtureSite('jsonld', 'competitor');
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    const ev = await h.db.worker.select().from(evidence).where(eq(evidence.orgId, t.orgId));
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => e.provenance === 'public_web')).toBe(true);
    const prices = await h.db.worker.select().from(priceObservations).where(eq(priceObservations.orgId, t.orgId));
    expect(prices.length).toBeGreaterThan(0);
    expect(prices.every((p) => p.provenance === 'public_web')).toBe(true);
    const found = await h.db.worker.select().from(offers).where(eq(offers.orgId, t.orgId));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((o) => o.provenance === 'public_web')).toBe(true);
    await ensureFxRates(h.svc);
    const pegs = await h.db.worker.select().from(exchangeRates).where(eq(exchangeRates.isFixed, true));
    expect(pegs.length).toBeGreaterThan(0);
    expect(pegs.every((r) => r.provenance === 'configuration')).toBe(true);
  });
});

describe('6. the production source contains no demo machinery', () => {
  const PRODUCTION_DIRS = ['apps/api/src', 'apps/worker/src', 'apps/web/src', 'packages/core/src', 'packages/shared/src', 'packages/database/src', 'packages/connectors/src', 'packages/services/src', 'scripts'];
  const files = (dir: string): string[] =>
    fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : files(rel);
      return /\.(ts|tsx|css|json)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [rel] : [];
    });
  const sources = PRODUCTION_DIRS.flatMap(files).map((rel) => ({ rel, text: fs.readFileSync(path.join(repoRoot, rel), 'utf8') }));

  it('scans a meaningful amount of code', () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it('mentions none of the removed concepts (the only exception is the one-off upgrade tool for pre-0008 databases)', () => {
    const forbidden = /ALLOW_LOCAL_FIXTURES|DEMO_AUTO_CONSENT|SCHEDULER_MODE|isFixture|is_fixture|startFixtureServer|createDevInventory|simulateQuantity|dev-inventory|DevInventoryProvider|WorkspaceModeError|getOrgMode|loopbackAllowed|containsFixture|FixturePill|demo-banner/;
    const hits = sources.filter((s) => s.rel !== 'scripts/purge-demo-workspaces.ts' && forbidden.test(s.text)).map((s) => s.rel);
    expect(hits).toEqual([]);
  });

  it('imports nothing from the test tree', () => {
    const hits = sources.filter((s) => /from '(?:\.\.?\/)+(?:tests|test)\//.test(s.text) || /tests\/support/.test(s.text)).map((s) => s.rel);
    expect(hits).toEqual([]);
  });

  it('never enables loopback outside tests: `allowLoopback: true` appears in no production source', () => {
    const hits = sources.filter((s) => /allowLoopback\s*:\s*true/.test(s.text)).map((s) => s.rel);
    expect(hits).toEqual([]);
  });

  it('the fictional-site servers live only under tests/', () => {
    expect(fs.existsSync(path.join(repoRoot, 'packages/connectors/src/fixtures'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, 'tests/support/fixtures/server.ts'))).toBe(true);
    for (const script of ['demo-fixtures.ts', 'demo-setup.ts', 'fixtures-serve.ts', 'bootstrap-dev.ts']) expect(fs.existsSync(path.join(repoRoot, 'scripts', script)), script).toBe(false);
  });
});
