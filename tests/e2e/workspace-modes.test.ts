import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.ts';
import { evidence, exchangeRates, offers, organizations, priceObservations, sites } from '@ci/database';
import { addSite, createDevInventory, ensureFxRates, getOrgMode, integrationOverview, loopbackAllowed, provenanceFor, simulateQuantity, startScan, updateSite } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';

/**
 * Live vs demo workspaces. A live workspace is a real customer's and only ever holds real information; fictional fixture websites,
 * the inventory simulator and the developer clock exist only in demo workspaces. Enforced in the services, in the API and — for the
 * rules that matter most — by database triggers, so no code path can put demo data into a live workspace.
 */
let h: Harness;
let live: Tenant;
let demo: Tenant;
let app: FastifyInstance;
const PASSWORD = 'Correct-Horse-9-Battery';

beforeAll(async () => {
  h = await createHarness({ extraEnv: { SCHEDULER_MODE: 'dev' } }); // the server is configured to ALLOW fixtures and the dev clock…
  live = await h.newTenant('Live', { mode: 'live' }); // …yet a live workspace must still refuse them
  demo = await h.newTenant('Demo', { mode: 'demo' });
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
}, 120_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('a live workspace never accepts fixture or local websites', () => {
  it('reports its mode', async () => {
    expect(await getOrgMode(h.db.worker, live.orgId)).toBe('live');
    expect(await getOrgMode(h.db.worker, demo.orgId)).toBe('demo');
  });

  it('refuses loopback/fixture addresses even though the server allows fixtures; the demo workspace accepts them', async () => {
    const url = h.fixtures.origin('woo');
    await expect(live.tx((tx) => addSite(h.svc, tx, live.orgId, live.userId, { url, role: 'competitor' }))).rejects.toThrow(/cannot be added|blocked for security/);
    const ok = await demo.tx((tx) => addSite(h.svc, tx, demo.orgId, demo.userId, { url, role: 'competitor' }));
    expect(ok.isFixture).toBe(true);
    expect(await h.db.worker.select().from(sites).where(eq(sites.orgId, live.orgId))).toHaveLength(0);
  });

  it('refuses a fixture address when an existing site is re-pointed at it', async () => {
    const s = await live.tx((tx) => addSite(h.svc, tx, live.orgId, live.userId, { url: 'https://shop.example.test', role: 'source' }));
    expect(s.isFixture).toBe(false);
    await expect(live.tx((tx) => updateSite(h.svc, tx, live.orgId, live.userId, s.id, { url: h.fixtures.origin('woo') }))).rejects.toThrow(/cannot be added|blocked for security/);
  });

  it('only accepts the standard web ports for real websites — at add time, not later', async () => {
    await expect(live.tx((tx) => addSite(h.svc, tx, live.orgId, live.userId, { url: 'https://rival-one.example.test:8080', role: 'competitor' }))).rejects.toThrow(/ports 80 and 443/);
    const ok = await live.tx((tx) => addSite(h.svc, tx, live.orgId, live.userId, { url: 'https://rival-one.example.test:443', role: 'competitor' }));
    expect(ok.hostname).toBe('rival-one.example.test');
    const s = await live.tx((tx) => addSite(h.svc, tx, live.orgId, live.userId, { url: 'http://rival-two.example.test:80/', role: 'competitor' }));
    await expect(live.tx((tx) => updateSite(h.svc, tx, live.orgId, live.userId, s.id, { url: 'https://rival-two.example.test:9090' }))).rejects.toThrow(/ports 80 and 443/);
  });

  it('decides per website whether loopback may be fetched: only fixtures, only in demo workspaces, only when the server allows them', () => {
    const base = { allowLocalFixtures: true, mode: 'demo' as const, isFixture: true };
    expect(loopbackAllowed(base)).toBe(true);
    expect(loopbackAllowed({ ...base, mode: 'live' })).toBe(false);
    expect(loopbackAllowed({ ...base, isFixture: false })).toBe(false);
    expect(loopbackAllowed({ ...base, allowLocalFixtures: false })).toBe(false);
  });
});

describe('the inventory simulator and the developer clock are demo-only', () => {
  it('the simulator invents quantities, so a live workspace is refused (service level) and is not even offered', async () => {
    await expect(live.tx((tx) => createDevInventory(h.svc, tx, live.orgId, live.userId))).rejects.toThrow(/only available in demo workspaces/);
    await expect(live.tx((tx) => simulateQuantity(h.svc, tx, live.orgId, '00000000-0000-4000-8000-000000000000', { sku: 'X', locationName: 'x', quantity: 1 }))).rejects.toThrow(/only available in demo workspaces/);
    expect((await live.tx((tx) => integrationOverview(h.svc, tx, live.orgId))).devInventoryAvailable).toBe(false);
    expect((await demo.tx((tx) => integrationOverview(h.svc, tx, demo.orgId))).devInventoryAvailable).toBe(true);
  });

  it('the API answers 403 for the simulator and the scheduler clock in a live workspace, and allows them in a demo one', async () => {
    const owner = new ApiClient(app);
    const email = `modes-${Date.now()}@example.test`;
    await owner.post('/api/v1/auth/register', { email, password: PASSWORD, displayName: 'Mode Tester' });
    const userId = (await owner.get('/api/v1/auth/me')).body.user.id as string;
    const liveOrg = (await owner.post('/api/v1/orgs', { name: 'Live Co' })).body.organization.id as string;
    const { createOrganization } = await import('@ci/services');
    const demoOrg = (await createOrganization(h.db.app, userId, 'Demo Co', { mode: 'demo' })).id;

    const tickLive = await owner.post(`/api/v1/orgs/${liveOrg}/dev/scheduler/tick`, {});
    expect(tickLive.status).toBe(403);
    expect(tickLive.body.error.code).toBe('wrong_workspace_mode');
    expect((await owner.post(`/api/v1/orgs/${liveOrg}/integrations/dev-inventory`, {})).status).toBe(403);

    expect((await owner.post(`/api/v1/orgs/${demoOrg}/dev/scheduler/tick`, {})).status).toBe(202);
  });
});

/** Drizzle wraps Postgres errors; the trigger's own message is on `cause`. */
async function dbError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message;
  }
  return '(no error)';
}

describe('database-level guarantees', () => {
  it('a fixture website cannot be inserted into a live workspace, whatever code tries it', async () => {
    const msg = await dbError(h.db.worker.insert(sites).values({ orgId: live.orgId, url: 'https://sneaky.example.test/', origin: 'https://sneaky.example.test', hostname: 'sneaky.example.test', name: 'Sneaky', role: 'competitor', isFixture: true }));
    expect(msg).toMatch(/fixture websites can only exist in demo workspaces/);
    const row = await h.db.worker.select().from(sites).where(eq(sites.hostname, 'sneaky.example.test'));
    expect(row).toHaveLength(0);
  });

  it('an existing site cannot be flipped to a fixture inside a live workspace', async () => {
    const [s] = await h.db.worker.select().from(sites).where(eq(sites.orgId, live.orgId));
    expect(await dbError(h.db.worker.update(sites).set({ isFixture: true }).where(eq(sites.id, s!.id)))).toMatch(/fixture websites can only exist in demo workspaces/);
  });

  it('a workspace can never change between live and demo', async () => {
    expect(await dbError(h.db.worker.update(organizations).set({ mode: 'demo' }).where(eq(organizations.id, live.orgId)))).toMatch(/cannot change between live and demo/);
    expect(await dbError(h.db.worker.update(organizations).set({ mode: 'live' }).where(eq(organizations.id, demo.orgId)))).toMatch(/cannot change between live and demo/);
    expect(await getOrgMode(h.db.worker, live.orgId)).toBe('live');
    expect(await getOrgMode(h.db.worker, demo.orgId)).toBe('demo');
  });

  it('a live workspace refuses to start collecting from a (hypothetical) fixture site because none can exist', async () => {
    const [s] = await h.db.worker.select().from(sites).where(eq(sites.orgId, live.orgId));
    // consent is still pending, so a scan is refused before anything is fetched — and nothing in a live workspace is a fixture.
    await expect(live.tx((tx) => startScan(h.svc, tx, live.orgId, s!.id, { kind: 'discovery', trigger: 'manual' }))).rejects.toThrow(/permission|consent/i);
    expect((await h.db.worker.select().from(sites).where(eq(sites.orgId, live.orgId))).every((x) => !x.isFixture)).toBe(true);
  });
});

describe('provenance labels', () => {
  it('fixtures and simulated quantities are always labelled; authorised and official sources are distinguished from public pages', () => {
    expect(provenanceFor({ isFixture: true })).toBe('fixture');
    expect(provenanceFor({ isFixture: false, quantitySource: 'simulated' })).toBe('fixture');
    expect(provenanceFor({ isFixture: false, quantitySource: 'authorised_inventory' })).toBe('authorised_api');
    expect(provenanceFor({ isFixture: false, official: true })).toBe('official_api');
    expect(provenanceFor({ isFixture: false, quantitySource: 'public_claim' })).toBe('public_web');
    expect(provenanceFor({ isFixture: false })).toBe('public_web');
  });
});

describe('provenance is stored with every fact', () => {
  it('a fixture collection labels its evidence, prices and offers as fixture; the AWG peg is a configured value, not a market rate', async () => {
    const siteId = await demo.addFixtureSite('jsonld', 'competitor');
    await demo.tx((tx) => startScan(h.svc, tx, demo.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    const ev = await h.db.worker.select().from(evidence).where(eq(evidence.orgId, demo.orgId));
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => e.provenance === 'fixture')).toBe(true);
    const prices = await h.db.worker.select().from(priceObservations).where(eq(priceObservations.orgId, demo.orgId));
    expect(prices.length).toBeGreaterThan(0);
    expect(prices.every((p) => p.provenance === 'fixture' && p.isFixture)).toBe(true);
    const found = await h.db.worker.select().from(offers).where(eq(offers.orgId, demo.orgId));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((o) => o.provenance === 'fixture')).toBe(true);
    await ensureFxRates(h.svc);
    const pegs = await h.db.worker.select().from(exchangeRates).where(eq(exchangeRates.isFixed, true));
    expect(pegs.length).toBeGreaterThan(0);
    expect(pegs.every((r) => r.provenance === 'configuration')).toBe(true);
  });
});
