import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.ts';
import { createOrganization, generateReport, runMatching, runProfile, startScan } from '@ci/services';
import type { ReportData } from '@ci/shared';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp } from '../support/auth.ts';

/**
 * Controls must do what they say, and the app must say plainly when it cannot: an action with nothing to act on answers 409 with the
 * reason (never a 202 that did nothing), a report with no data says it has no findings, and the guided journey is computed from what
 * really exists.
 */
let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let liveOrg: string;
let demoOrg: string;
let userId: string;
const PASSWORD = 'Correct-Horse-9-Battery';
const live = () => `/api/v1/orgs/${liveOrg}`;
const demo = () => `/api/v1/orgs/${demoOrg}`;

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
  await signUp(owner, h, { email: `honest-${Date.now()}@example.test`, password: PASSWORD, displayName: 'Honest Owner' });
  userId = (await owner.get('/api/v1/auth/me')).body.user.id as string;
  liveOrg = (await owner.post('/api/v1/orgs', { name: 'Honest Live Co' })).body.organization.id as string;
  demoOrg = (await createOrganization(h.db.app, userId, 'Honest Co')).id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('actions with nothing to act on say so instead of pretending to work', () => {
  it('an empty workspace refuses refresh, reports, matching and social sync with the reason', async () => {
    const refresh = await owner.post(`${live()}/refresh`, {});
    expect(refresh.status).toBe(409);
    expect(refresh.body.error).toMatchObject({ code: 'nothing_to_refresh' });
    expect(refresh.body.error.message).toMatch(/no websites to refresh/);

    const report = await owner.post(`${live()}/reports`, {});
    expect(report.status).toBe(409);
    expect(report.body.error.code).toBe('nothing_to_report');

    const match = await owner.post(`${live()}/matches/run`, {});
    expect(match.status).toBe(409);
    expect(match.body.error.code).toBe('nothing_to_match');

    const social = await owner.post(`${live()}/social/sync`, {});
    expect(social.status).toBe(409);
    expect(social.body.error.code).toBe('no_social_accounts');
  });

  it('with websites but no permission recorded, refresh says permission is the reason and lists what was skipped', async () => {
    await owner.post(`${live()}/sites`, { url: 'https://my-shop.example.test', role: 'source' });
    await owner.post(`${live()}/sites`, { url: 'https://rival-a.example.test', role: 'competitor' });
    const refresh = await owner.post(`${live()}/refresh`, {});
    expect(refresh.status).toBe(409);
    expect(refresh.body.error.message).toMatch(/collection rules have not been confirmed/);
    expect(refresh.body.error.details).toHaveLength(2);
    expect(refresh.body.error.details[0]).toMatchObject({ reason: 'Collection rules not confirmed' });
    // …and still nothing to report on, even though websites exist: nothing has been collected.
    const report = await owner.post(`${live()}/reports`, {});
    expect(report.status).toBe(409);
    expect(report.body.error.message).toMatch(/Nothing has been collected yet/);
  });
});

describe('a report with no data has no findings — it never says "nothing changed"', () => {
  it('headline states the absence plainly, for no source and for no collected products', async () => {
    const t = await h.newTenant('NoData');
    const empty = await generateReport(h.svc, h.db.worker, t.orgId, { kind: 'manual', deadlineAt: null, createdBy: t.userId });
    expect((empty.data as ReportData).headline).toMatch(/no findings: no website of yours has been added yet/);
    expect((empty.data as ReportData).headline).not.toMatch(/No significant changes/);

    const withSites = await owner.post(`${live()}/sites`, { url: 'https://rival-b.example.test', role: 'competitor' });
    expect(withSites.status).toBe(201);
    const r = await generateReport(h.svc, h.db.worker, liveOrg, { kind: 'manual', deadlineAt: null, createdBy: userId });
    expect((r.data as ReportData).headline).toMatch(/no findings: no products have been collected from any website yet/);
    expect((r.data as ReportData).headline).not.toMatch(/No significant changes/);
    expect((r.data as ReportData).kpis.matchedProducts).toBe(0);
  });
});

describe('every website carries one honest status', () => {
  it('lists the collection state with a plain next step', async () => {
    const sites = (await owner.get(`${live()}/sites`)).body.sites as { name: string; status: { state: string; label: string; nextAction: string | null } }[];
    expect(sites.length).toBe(3);
    for (const s of sites) {
      expect(s.status.state).toBe('not_profiled');
      expect(s.status.label).toBe('Not checked yet');
      expect(s.status.nextAction).toBe('Check this website');
    }
  });
});

describe('the guided journey is computed from what really exists', () => {
  const step = (j: { steps: { id: string; state: string }[] }, id: string) => j.steps.find((s) => s.id === id)!.state;

  it('starts at "add your own website" in an empty workspace', async () => {
    const mine = new ApiClient(app); // a fresh user and an empty workspace
    await signUp(mine, h, { email: `journey-${Date.now()}@example.test`, password: PASSWORD, displayName: 'J' });
    const org = (await mine.post('/api/v1/orgs', { name: 'Empty Co' })).body.organization.id as string;
    const j = (await mine.get(`/api/v1/orgs/${org}/journey`)).body;
    expect(step(j, 'workspace')).toBe('done');
    expect(step(j, 'own_site')).toBe('current');
    expect(step(j, 'competitors')).toBe('todo');
    expect(step(j, 'report')).toBe('todo');
    expect(step(j, 'alerts')).toBe('optional');
    expect(j.complete).toBe(false);
    expect(j.next.id).toBe('own_site');
    expect(j.next.action.to).toBe('setup');
  });

  it('advances only as real things happen: sites → checked → permission → collected → matched → reported', async () => {
    const add = async (key: string, role: string) => (await owner.post(`${demo()}/sites`, { url: h.fixtures.origin(key), role })).body.site.id as string;
    const src = await add('source', 'source');
    const c1 = await add('woo', 'competitor');
    const c2 = await add('jsonld', 'competitor');
    const c3 = await add('html', 'competitor');

    let j = (await owner.get(`${demo()}/journey`)).body;
    expect(step(j, 'own_site')).toBe('done');
    expect(step(j, 'competitors')).toBe('done');
    expect(step(j, 'capabilities')).toBe('current'); // added, but nobody has looked at them yet

    for (const id of [src, c1, c2, c3]) await runProfile(h.svc, demoOrg, id);
    j = (await owner.get(`${demo()}/journey`)).body;
    expect(step(j, 'capabilities')).toBe('done');
    expect(step(j, 'permissions')).toBe('current');
    expect(j.next.action).toMatchObject({ label: 'Confirm collection rules', to: 'websites' });

    for (const id of [src, c1, c2, c3]) expect((await owner.post(`${demo()}/sites/${id}/consent`, { status: 'confirmed', attest: true })).status).toBe(200);
    j = (await owner.get(`${demo()}/journey`)).body;
    expect(step(j, 'permissions')).toBe('done');
    expect(step(j, 'collection')).toBe('current');

    for (const id of [src, c1, c2, c3]) await startScan(h.svc, h.db.worker, demoOrg, id, { kind: 'discovery', trigger: 'manual' });
    await h.queue.drain();
    j = (await owner.get(`${demo()}/journey`)).body;
    expect(step(j, 'collection')).toBe('done');
    expect(step(j, 'report')).toBe('todo'); // matching has not run yet, so nothing to show

    await runMatching(h.svc, h.db.worker, demoOrg);
    j = (await owner.get(`${demo()}/journey`)).body;
    // matches exist; some may wait for review, which is the honest "current" step; otherwise the report is next
    expect(['matches', 'report']).toContain(j.next.id);

    const gen = await owner.post(`${demo()}/reports`, {});
    expect(gen.status).toBe(202);
    await h.queue.drain();
    j = (await owner.get(`${demo()}/journey`)).body;
    expect(step(j, 'report')).toBe('done');
  });
});
