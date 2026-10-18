import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.ts';
import { createOrganization, runMatching, startScan } from '@ci/services';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';

/**
 * Match review: a person can see why a pair was proposed with the evidence side by side, search for the right competitor product,
 * choose it, and that decision is stored as evidence, supersedes the wrong suggestion, and survives every later matching run.
 */
let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let org: string;
const PASSWORD = 'Correct-Horse-9-Battery';
const base = () => `/api/v1/orgs/${org}`;

interface ReviewRow { id: string; sourceVariantId: string; competitorVariantId: string; sourceTitle: string; competitorTitle: string; competitorSite: string; status: string; method: string; matchClass: string; confidence: number }

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
  await owner.post('/api/v1/auth/register', { email: `review-${Date.now()}@example.test`, password: PASSWORD, displayName: 'Reviewer' });
  const me = (await owner.get('/api/v1/auth/me')).body;
  org = (await createOrganization(h.db.app, me.user.id, 'Match Review')).id;
  for (const [key, role] of [['source', 'source'], ['woo', 'competitor'], ['jsonld', 'competitor']] as const) {
    const id = (await owner.post(`${base()}/sites`, { url: h.fixtures.origin(key), role, name: h.fixtures.sites[key]!.spec.label })).body.site.id as string;
    await owner.post(`${base()}/sites/${id}/consent`, { status: 'confirmed', attest: true });
    await startScan(h.svc, h.db.worker, org, id, { kind: 'discovery', trigger: 'manual' });
  }
  await h.queue.drain();
  await runMatching(h.svc, h.db.worker, org);
}, 180_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

const list = async (status: string) => (await owner.get(`${base()}/matches?status=${status}&pageSize=200`)).body.rows as ReviewRow[];

describe('reviewing a proposed match', () => {
  let target: ReviewRow;

  it('each proposal carries the evidence needed to judge it, side by side', async () => {
    const review = await list('needs_review');
    expect(review.length).toBeGreaterThan(0);
    target = review[0]!;
    const row = (await owner.get(`${base()}/matches?status=needs_review&pageSize=1`)).body.rows[0];
    for (const k of ['sourceVariantId', 'competitorVariantId', 'competitorSiteId', 'sourceAvailability', 'competitorAvailability', 'sourceObservedAt', 'competitorObservedAt', 'sourceUrl', 'competitorUrl', 'reasons', 'confidence', 'method']) {
      expect(row, k).toHaveProperty(k);
    }
    expect(row.reasons.length).toBeGreaterThan(0);
  });

  it('can search the competitor’s catalogue for the right product, best suggestion first, with the matcher’s reasons', async () => {
    const r = await owner.get(`${base()}/matches/candidates?sourceVariantId=${target.sourceVariantId}&siteId=${await siteIdOf(target.competitorSite)}&limit=10`);
    expect(r.status).toBe(200);
    const cands = r.body.candidates as { variantId: string; title: string; siteName: string; url: string; suggestion: { confidence: number; reasons: string[] } | null; observedAt: string | null }[];
    expect(cands.length).toBeGreaterThan(1);
    expect(cands.every((c) => c.siteName === target.competitorSite)).toBe(true);
    expect(cands.every((c) => c.url.startsWith('http'))).toBe(true);
    const ranks = cands.map((c) => c.suggestion?.confidence ?? 0);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a)); // best suggestion first
    expect(cands.some((c) => (c.suggestion?.reasons.length ?? 0) > 0)).toBe(true);

    const filtered = (await owner.get(`${base()}/matches/candidates?sourceVariantId=${target.sourceVariantId}&q=zzzz-no-such-product`)).body.candidates;
    expect(filtered).toEqual([]);
  });

  it('choosing a different product stores a manual, accepted match and rejects the suggestion it corrects', async () => {
    const siteId = await siteIdOf(target.competitorSite);
    const cands = (await owner.get(`${base()}/matches/candidates?sourceVariantId=${target.sourceVariantId}&siteId=${siteId}&limit=10`)).body.candidates as { variantId: string }[];
    const chosen = cands.find((c) => c.variantId !== target.competitorVariantId)!;
    const r = await owner.post(`${base()}/matches/manual`, { sourceVariantId: target.sourceVariantId, competitorVariantId: chosen.variantId, matchClass: 'identical', replaceMatchId: target.id, note: 'Checked the pack label' });
    expect(r.status).toBe(201);
    expect(r.body.match).toMatchObject({ status: 'accepted', method: 'manual', confidence: 1, matchClass: 'identical', decisionNote: 'Checked the pack label' });
    expect(r.body.superseded).toBeGreaterThanOrEqual(1);

    expect((await list('rejected')).some((m) => m.id === target.id)).toBe(true);
    expect((await list('needs_review')).some((m) => m.id === target.id)).toBe(false);
    const accepted = await list('accepted');
    expect(accepted.find((m) => m.competitorVariantId === chosen.variantId)).toMatchObject({ method: 'manual', status: 'accepted' });
    chosenVariant = chosen.variantId;
  });

  let chosenVariant = '';

  it('survives the next matching run, and the rejected suggestion is not proposed again', async () => {
    const run = await runMatching(h.svc, h.db.worker, org);
    expect(run.preservedManual).toBeGreaterThanOrEqual(2);
    const accepted = await list('accepted');
    expect(accepted.find((m) => m.competitorVariantId === chosenVariant)).toMatchObject({ method: 'manual', confidence: 1 });
    expect((await list('rejected')).some((m) => m.id === target.id)).toBe(true);
    expect((await list('needs_review')).some((m) => m.sourceVariantId === target.sourceVariantId && m.competitorVariantId === target.competitorVariantId)).toBe(false);
  });

  it('the price comparison uses the person’s choice', async () => {
    const cmp = (await owner.get(`${base()}/comparison?pageSize=500`)).body;
    const row = cmp.rows.find((r: { sourceVariantId: string }) => r.sourceVariantId === target.sourceVariantId);
    const cell = row.cells.find((c: { variantId: string }) => c.variantId === chosenVariant);
    expect(cell).toMatchObject({ matchStatus: 'accepted', matchClass: 'identical', confidence: 1 });
    expect(row.cells.some((c: { variantId: string }) => c.variantId === target.competitorVariantId)).toBe(false);
  });

  it('refuses nonsense and other workspaces’ products', async () => {
    const cands = (await owner.get(`${base()}/matches/candidates?sourceVariantId=${target.sourceVariantId}&limit=5`)).body.candidates as { variantId: string }[];
    // pairing two of your own products, or a competitor product as "yours", is rejected
    const bad = await owner.post(`${base()}/matches/manual`, { sourceVariantId: cands[0]!.variantId, competitorVariantId: cands[1]!.variantId, matchClass: 'identical' });
    expect(bad.status).toBe(400);
    expect((await owner.post(`${base()}/matches/manual`, { sourceVariantId: target.sourceVariantId, competitorVariantId: target.sourceVariantId, matchClass: 'not_comparable' })).status).toBe(400); // class must be a positive one

    const stranger = new ApiClient(app);
    await stranger.post('/api/v1/auth/register', { email: `stranger-${Date.now()}@example.test`, password: PASSWORD, displayName: 'S' });
    const strangerOrg = (await stranger.post('/api/v1/orgs', { name: 'Stranger Co' })).body.organization.id as string;
    // ids from another workspace, used inside the stranger's own workspace, resolve to nothing
    const foreign = await stranger.post(`/api/v1/orgs/${strangerOrg}/matches/manual`, { sourceVariantId: target.sourceVariantId, competitorVariantId: chosenVariant, matchClass: 'identical' });
    expect(foreign.status).toBe(404);
    expect((await stranger.get(`/api/v1/orgs/${strangerOrg}/matches/candidates?sourceVariantId=${target.sourceVariantId}`)).status).toBe(404);
    // …and the stranger cannot even address this workspace
    expect((await stranger.post(`${base()}/matches/manual`, { sourceVariantId: target.sourceVariantId, competitorVariantId: chosenVariant, matchClass: 'identical' })).status).toBe(404);
  });
});

async function siteIdOf(name: string): Promise<string> {
  const sites = (await owner.get(`${base()}/sites`)).body.sites as { id: string; name: string }[];
  return sites.find((s) => s.name === name)!.id;
}
