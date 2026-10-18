import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.ts';
import { createOrganization, startScan } from '@ci/services';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp } from '../support/auth.ts';

/**
 * A customer must be able to see what each collection run did: what was collected, whether that is the whole catalogue, which pages
 * failed and why, and what to do next — for complete, partial, blocked and unreachable websites alike.
 */
let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let org: string;
const sites: Record<string, string> = {};
const runs: Record<string, string> = {};
const base = () => `/api/v1/orgs/${org}`;

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
  await signUp(owner, h, { email: `observe-${Date.now()}@example.test`, password: 'Correct-Horse-9-Battery', displayName: 'Observer' });
  const me = (await owner.get('/api/v1/auth/me')).body;
  org = (await createOrganization(h.db.app, me.user.id, 'Observability')).id;
  for (const [key, role] of [['woo', 'source'], ['flaky', 'competitor'], ['blocked', 'competitor'], ['failing', 'competitor']] as const) {
    const id = (await owner.post(`${base()}/sites`, { url: h.fixtures.origin(key), role })).body.site.id as string;
    sites[key] = id;
    await owner.post(`${base()}/sites/${id}/consent`, { status: 'confirmed', attest: true });
    const run = await startScan(h.svc, h.db.worker, org, id, { kind: 'discovery', trigger: 'manual' });
    runs[key] = run.run.id;
  }
  await h.queue.drain();
}, 180_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

const detail = async (key: string) => (await owner.get(`${base()}/scans/${runs[key]}`)).body;

describe('every collection run explains itself', () => {
  it('a complete collection says so and shows its counters', async () => {
    const d = await detail('woo');
    expect(d.run.status).toBe('succeeded');
    expect(d.explanation).toMatchObject({ completeness: 'complete', reason: null, nextStep: null });
    expect(d.explanation.summary).toMatch(/whole accessible catalogue was collected: \d+ products/);
    expect(d.run.productsSaved).toBeGreaterThan(0);
    expect(d.run.urlsFetched + d.run.requestsMade).toBeGreaterThan(0);
  });

  it('a feed that breaks part-way is reported as partial, with the reason and a way forward — never as complete', async () => {
    const d = await detail('flaky');
    expect(['partial', 'failed']).toContain(d.run.status);
    expect(d.explanation.completeness).not.toBe('complete');
    expect(d.run.isComplete).toBe(false);
    expect(d.explanation.reason).toBeTruthy();
    expect(d.explanation.nextStep).toBeTruthy();
    if (d.run.productsSaved > 0) expect(d.explanation.summary).toMatch(/Partly collected|saved before the failure/);
  });

  it('a website that forbids automated access is "nothing collected" with its reason — not an empty catalogue', async () => {
    const d = await detail('blocked');
    expect(d.run.status).toBe('blocked');
    expect(d.run.productsSaved).toBe(0);
    expect(d.explanation).toMatchObject({ completeness: 'none' });
    expect(d.explanation.summary).toMatch(/does not allow automated access/);
    expect(d.explanation.reason).toMatch(/robots\.txt|refused access/);
    expect(d.explanation.nextStep).toMatch(/product feed|authorised connection/);
  });

  it('a website that is down is a failure with a cause, not an empty catalogue', async () => {
    const d = await detail('failing');
    expect(d.run.status).toBe('failed');
    expect(d.explanation.completeness).toBe('none');
    expect(d.explanation.summary).toMatch(/failure, not an empty catalogue/);
    expect(d.explanation.reason).toMatch(/could not be reached|Try again/);
  });

  it('failed and skipped pages are listed with their reasons (grouped), and the data is tenant-scoped', async () => {
    const d = await detail('flaky');
    expect(Array.isArray(d.failedUrls)).toBe(true);
    expect(Array.isArray(d.failureReasons)).toBe(true);
    expect(d.failedUrls.length).toBeLessThanOrEqual(20);
    for (const f of d.failureReasons) expect(f.count).toBeGreaterThan(0);
    const stranger = new ApiClient(app);
    await signUp(stranger, h, { email: `stranger-${Date.now()}@example.test`, password: 'Correct-Horse-9-Battery', displayName: 'Stranger' });
    expect((await stranger.get(`${base()}/scans/${runs.flaky}`)).status).toBe(404);
  });

  it('each website shows one honest collection status after these runs', async () => {
    const list = (await owner.get(`${base()}/sites`)).body.sites as { id: string; status: { state: string } }[];
    const state = (key: string) => list.find((s) => s.id === sites[key])!.status.state;
    expect(state('woo')).toBe('collected');
    expect(state('blocked')).toBe('access_denied');
    expect(['failed', 'partial']).toContain(state('flaky'));
    expect(['failed', 'not_collected']).toContain(state('failing'));
  });
});
