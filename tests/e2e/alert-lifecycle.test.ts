import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { alerts } from '@ci/database';
import { buildApp } from '../../apps/api/src/app.ts';
import { createOrganization, recordCollectionOutcome, startScan } from '@ci/services';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp } from '../support/auth.ts';
import { createTestInventory, setTestQuantity } from '../support/inventory.ts';

/**
 * Alert lifecycle: open → acknowledged → resolved. A condition alert closes by itself when an observation shows the condition has cleared
 * (keeping that observation as evidence), a person can close it with a note, one-off notices cannot be "resolved", and an unrelated
 * workspace can neither see nor touch any of it.
 */
let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let org: string;
let sourceId: string;
const PASSWORD = 'Correct-Horse-9-Battery';
const base = () => `/api/v1/orgs/${org}`;

interface AlertRow {
  id: string; type: string; status: 'open' | 'acknowledged' | 'resolved'; resolvable: boolean; title: string; siteName: string | null; productTitle: string | null; productId: string | null;
  data: Record<string, unknown>; acknowledgedAt: string | null; acknowledgedBy: string | null;
  evidence: { url: string; provenance: string; observedAt: string } | null;
  resolution: null | { at: string; kind: 'automatic' | 'manual'; by: string | null; note: string | null; evidence: { url: string; observedAt: string } | null };
}

const list = async (status: string, type?: string) => (await owner.get(`${base()}/alerts?status=${status}&pageSize=200${type ? `&type=${type}` : ''}`)).body.rows as AlertRow[];

async function scanSource() {
  await startScan(h.svc, h.db.worker, org, sourceId, { kind: 'discovery', trigger: 'manual' });
  await h.queue.drain();
}

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
  await signUp(owner, h, { email: `alerts-${Date.now()}@example.test`, password: PASSWORD, displayName: 'Alert Owner' });
  const me = (await owner.get('/api/v1/auth/me')).body;
  org = (await createOrganization(h.db.app, me.user.id, 'Alert Lifecycle')).id;
  sourceId = (await owner.post(`${base()}/sites`, { url: h.fixtures.origin('source'), role: 'source', name: h.fixtures.sites.source!.spec.label })).body.site.id as string;
  await owner.post(`${base()}/sites/${sourceId}/consent`, { status: 'confirmed', attest: true });
  await scanSource(); // baseline: nothing alerts on the first observation
}, 180_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('a condition that clears resolves its own alert, with evidence', () => {
  let outAlert: AlertRow;

  it('an out-of-stock alert is open and links to the page it was raised from', async () => {
    h.fixtures.sites.source!.setAvailability(0, false);
    await scanSource();
    const open = await list('open', 'out_of_stock');
    expect(open).toHaveLength(1);
    outAlert = open[0]!;
    expect(outAlert).toMatchObject({ status: 'open', resolvable: true, resolution: null, acknowledgedAt: null });
    expect(outAlert.siteName).toBeTruthy();
    expect(outAlert.productTitle).toBeTruthy();
    expect(outAlert.evidence?.url).toMatch(/^http/);
    expect(outAlert.evidence?.provenance).toBe('public_web');
    expect(Number.isNaN(Date.parse(outAlert.evidence!.observedAt))).toBe(false);
    expect(outAlert.data).toMatchObject({ to: 'out_of_stock' });
  });

  it('an unchanged condition neither repeats nor resolves', async () => {
    await scanSource();
    await scanSource();
    expect(await list('open', 'out_of_stock')).toHaveLength(1);
    expect(await list('resolved', 'out_of_stock')).toHaveLength(0);
  });

  it('acknowledging moves it to "acknowledged" but it is still unresolved', async () => {
    expect((await owner.post(`${base()}/alerts/${outAlert.id}/ack`)).status).toBe(200);
    expect(await list('open', 'out_of_stock')).toHaveLength(0);
    const [ack] = await list('acknowledged', 'out_of_stock');
    expect(ack).toMatchObject({ id: outAlert.id, status: 'acknowledged', acknowledgedBy: 'Alert Owner' });
  });

  it('when the item is back in stock the alert resolves automatically, keeping the observation that showed it', async () => {
    h.fixtures.sites.source!.setAvailability(0, true);
    await scanSource();
    const [resolved] = await list('resolved', 'out_of_stock');
    expect(resolved).toMatchObject({ id: outAlert.id, status: 'resolved' });
    expect(resolved!.resolution).toMatchObject({ kind: 'automatic', by: null });
    expect(resolved!.resolution!.evidence?.url).toMatch(/^http/);
    expect(resolved!.resolution!.note).toMatch(/available|stock/i);
    expect(Number.isNaN(Date.parse(resolved!.resolution!.at))).toBe(false);
    // the resolving observation is a later look at the page, not the one that raised the alert
    expect(resolved!.resolution!.evidence!.observedAt).not.toBe(outAlert.evidence!.observedAt);
  });

  it('the "back in stock" notice is a one-off: it cannot be resolved, only acknowledged', async () => {
    const [restocked] = await list('open', 'restocked');
    expect(restocked).toMatchObject({ resolvable: false, status: 'open' });
    const r = await owner.post(`${base()}/alerts/${restocked!.id}/resolve`, {});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('not_resolvable');
  });

  it('a new episode raises a NEW open alert; the resolved one stays resolved', async () => {
    h.fixtures.sites.source!.setAvailability(0, false);
    await scanSource();
    expect(await list('open', 'out_of_stock')).toHaveLength(1);
    expect((await list('resolved', 'out_of_stock')).map((a) => a.id)).toEqual([outAlert.id]);
    h.fixtures.sites.source!.setAvailability(0, true);
    await scanSource();
    expect(await list('open', 'out_of_stock')).toHaveLength(0);
    expect(await list('resolved', 'out_of_stock')).toHaveLength(2);
  });
});

describe('a person can close an alert, and says what was done', () => {
  let connectionId: string;
  let low: AlertRow;
  const sku = () => h.fixtures.sites.source!.find(1)!.sku;
  const setQty = (quantity: number | null) => setTestQuantity(h.svc, h.db.worker, org, connectionId, { sku: sku(), locationName: 'Main warehouse', quantity });

  it('a low-stock alert from an authorised connection has no web page behind it and says so', async () => {
    connectionId = (await createTestInventory(h.svc, h.db.worker, org, (await owner.get('/api/v1/auth/me')).body.user.id)).connectionId;
    await setQty(20);
    await setQty(4);
    const open = (await list('open', 'low_stock')).filter((a) => a.data['quantitySource'] === 'authorised_inventory');
    expect(open).toHaveLength(1);
    low = open[0]!;
    expect(low.evidence).toBeNull(); // no page was involved
    expect(low.data).toMatchObject({ quantity: 4, threshold: 5, basis: 'authorised_quantity' });
    expect(low.data['connectionId']).toBe(connectionId);
  });

  it('closing it records who, when and why, and acknowledges it at the same time', async () => {
    const r = await owner.post(`${base()}/alerts/${low.id}/resolve`, { note: 'Reordered 40 units, arriving Friday' });
    expect(r.status).toBe(200);
    const [done] = (await list('resolved', 'low_stock')).filter((a) => a.id === low.id);
    expect(done!.status).toBe('resolved');
    expect(done!.resolution).toMatchObject({ kind: 'manual', by: 'Alert Owner', note: 'Reordered 40 units, arriving Friday' });
    expect(done!.acknowledgedAt).not.toBeNull();
  });

  it('resolving twice is refused with a reason; an unknown id is a 404; the note is length-limited', async () => {
    const again = await owner.post(`${base()}/alerts/${low.id}/resolve`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_resolved');
    expect((await owner.post(`${base()}/alerts/00000000-0000-4000-8000-000000000000/resolve`, {})).status).toBe(404);
    expect((await owner.post(`${base()}/alerts/${low.id}/resolve`, { note: 'x'.repeat(501) })).status).toBe(400);
  });

  it('a later change of the same item never rewrites a person’s resolution', async () => {
    await setQty(30); // back above the threshold
    const [done] = (await list('resolved', 'low_stock')).filter((a) => a.id === low.id);
    expect(done!.resolution).toMatchObject({ kind: 'manual', note: 'Reordered 40 units, arriving Friday' });
    await setQty(3); // …and low again: a new alert, the old one untouched
    const open = (await list('open', 'low_stock')).filter((a) => a.data['quantitySource'] === 'authorised_inventory');
    expect(open).toHaveLength(1);
    expect(open[0]!.id).not.toBe(low.id);
  });

  it('escalating from low to out of stock closes the low-stock alert and opens an out-of-stock one', async () => {
    const lowNow = (await list('open', 'low_stock')).find((a) => a.data['quantitySource'] === 'authorised_inventory')!;
    await setQty(0);
    expect((await list('resolved', 'low_stock')).find((a) => a.id === lowNow.id)?.resolution).toMatchObject({ kind: 'automatic' });
    const outNow = (await list('open', 'out_of_stock')).filter((a) => a.data['quantitySource'] === 'authorised_inventory');
    expect(outNow).toHaveLength(1);
  });

  it('acknowledge-all leaves resolved alerts exactly as they were', async () => {
    const before = await list('resolved');
    const r = await owner.post(`${base()}/alerts/ack-all`);
    expect(r.status).toBe(200);
    const after = await list('resolved');
    expect(after.map((a) => [a.id, a.acknowledgedAt, a.resolution?.kind])).toEqual(before.map((a) => [a.id, a.acknowledgedAt, a.resolution?.kind]));
    expect(await list('open')).toHaveLength(0);
  });
});

describe('collection and integration problems clear when the problem does', () => {
  it('a website that failed to collect has an open alert until a collection succeeds', async () => {
    const o = { orgId: org, siteId: sourceId, siteName: 'Own site' };
    await recordCollectionOutcome(h.svc, h.db.worker, { ...o, outcome: 'failed', reason: 'The website did not answer.' });
    await recordCollectionOutcome(h.svc, h.db.worker, { ...o, outcome: 'failed', reason: 'The website did not answer.' }); // same episode: no second alert
    const open = await list('open', 'collection_failure');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ resolvable: true, evidence: null });
    await recordCollectionOutcome(h.svc, h.db.worker, { ...o, outcome: 'ok' });
    expect(await list('open', 'collection_failure')).toHaveLength(0);
    const [done] = await list('resolved', 'collection_failure');
    expect(done!.resolution).toMatchObject({ kind: 'automatic' });
    expect(done!.resolution!.note).toMatch(/collection/i);
  });

  it('disconnecting the store closes its sync-problem alert', async () => {
    const me = (await owner.get('/api/v1/auth/me')).body.user.id as string;
    const { connectionId } = await createTestInventory(h.svc, h.db.worker, org, me);
    await h.db.worker.insert(alerts).values({ orgId: org, type: 'integration_issue', severity: 'warning', title: 'Inventory sync problem', body: 'test', data: { connectionId }, dedupeKey: `integration:${connectionId}:test` });
    expect((await list('open', 'integration_issue')).filter((a) => a.data['connectionId'] === connectionId)).toHaveLength(1);
    expect((await owner.delete(`${base()}/integrations/${connectionId}`)).status).toBeLessThan(300);
    expect((await list('resolved', 'integration_issue')).find((a) => a.data['connectionId'] === connectionId)?.resolution?.note).toMatch(/disconnected/i);
  });
});

describe('isolation and counts', () => {
  it('another workspace sees none of these alerts and cannot resolve them', async () => {
    const stranger = new ApiClient(app);
    await signUp(stranger, h, { email: `alerts-stranger-${Date.now()}@example.test`, password: PASSWORD, displayName: 'S' });
    const strangerOrg = (await stranger.post('/api/v1/orgs', { name: 'Stranger Co' })).body.organization.id as string;
    expect((await stranger.get(`/api/v1/orgs/${strangerOrg}/alerts?status=all`)).body.total).toBe(0);
    const any = (await list('resolved'))[0]!;
    expect((await stranger.post(`/api/v1/orgs/${strangerOrg}/alerts/${any.id}/resolve`, {})).status).toBe(404);
    expect((await stranger.post(`${base()}/alerts/${any.id}/resolve`, {})).status).toBe(404); // cannot even address this workspace
  });

  it('the dashboard counts only alerts that still need attention', async () => {
    const [counted] = await h.db.worker.insert(alerts).values({ orgId: org, type: 'out_of_stock', severity: 'critical', title: 'Counted', dedupeKey: `count:${Date.now()}` }).returning({ id: alerts.id });
    const id = counted!.id;
    const unack = async () => (await owner.get(`${base()}/dashboard`)).body.alerts.unacknowledged as number;
    expect(await unack()).toBe(1);
    expect((await owner.post(`${base()}/alerts/${id}/resolve`, {})).status).toBe(200);
    expect(await unack()).toBe(0);
    const [row] = await h.db.worker.select().from(alerts).where(and(eq(alerts.orgId, org), eq(alerts.id, id)));
    expect(row!.resolutionKind).toBe('manual');
  });
});
