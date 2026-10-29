import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { buildApp } from '../../apps/api/src/app.ts';
import { matchEvents, matchRuns, productMatches, variants } from '@ci/database';
import { createOrganization, runMatching, startScan } from '@ci/services';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp } from '../support/auth.ts';

/**
 * The review queue by PRODUCT PAIR: a product with several variants is one item, the variant pairs behind it can be opened, and "these are different
 * products" is one recorded decision per variant pair that still waits — never touching what a person already decided.
 */
let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let org: string;
let userId: string;
const base = () => `/api/v1/orgs/${org}`;
const db = () => h.db.worker;
interface Row { id: string; status: string; relationship: string; sourceProductId: string; competitorProductId: string; groupSize?: number; sourceVariantId: string }
const list = async (query: string) => (await owner.get(`${base()}/matches?${query}`)).body as { rows: Row[]; total: number };

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
  await signUp(owner, h, { email: `pp-${Date.now()}@example.test`, password: 'Correct-Horse-9-Battery', displayName: 'Reviewer' });
  userId = (await owner.get('/api/v1/auth/me')).body.user.id;
  org = (await createOrganization(h.db.app, userId, 'Product pairs')).id;
  for (const [key, role] of [['source', 'source'], ['woo', 'competitor'], ['jsonld', 'competitor']] as const) {
    const id = (await owner.post(`${base()}/sites`, { url: h.fixtures.origin(key), role, name: h.fixtures.sites[key]!.spec.label })).body.site.id as string;
    await owner.post(`${base()}/sites/${id}/consent`, { status: 'confirmed', attest: true });
    await startScan(h.svc, h.db.worker, org, id, { kind: 'discovery', trigger: 'manual' });
  }
  await h.queue.drain();
  await db().delete(productMatches).where(eq(productMatches.orgId, org));
  await db().delete(matchRuns).where(eq(matchRuns.orgId, org));
  expect((await owner.put(`${base()}/settings`, { matchingEngine: 'v2' })).status).toBe(200);
  await runMatching(h.svc, db(), org);
}, 180_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('review by product pair', () => {
  let pair: { sp: string; cp: string };
  let otherId: string;
  let accepted: Row;

  it('counts and lists each product pair once, with the number of variant pairs behind it', async () => {
    const all = await list('bucket=review&pageSize=300');
    expect(all.total).toBeGreaterThan(3);
    // build a real group: a second variant of one of your products, suggested against the same competitor product as the first
    const first = all.rows[0]!;
    const [m0] = await db().select().from(productMatches).where(eq(productMatches.id, first.id));
    const [v0] = await db().select().from(variants).where(eq(variants.id, m0!.sourceVariantId));
    const [v1] = await db().insert(variants).values({ ...v0!, id: undefined as unknown as string, variantKey: `${v0!.variantKey}-second`, title: `${v0!.title ?? ''} second`.trim() }).returning();
    const { id: _id, ...rest } = m0!;
    void _id;
    await db().insert(productMatches).values({ ...rest, sourceVariantId: v1!.id });
    pair = { sp: first.sourceProductId, cp: first.competitorProductId };

    const grouped = await list('bucket=review&group=product&pageSize=300');
    const ungrouped = await list('bucket=review&pageSize=300');
    expect(ungrouped.total).toBe(all.total + 1);
    expect(grouped.total).toBeLessThan(ungrouped.total);
    const row = grouped.rows.find((r) => r.sourceProductId === pair.sp && r.competitorProductId === pair.cp)!;
    expect(row.groupSize).toBeGreaterThanOrEqual(2);
    expect(grouped.rows.filter((r) => r.sourceProductId === pair.sp && r.competitorProductId === pair.cp)).toHaveLength(1);
    // the groups account for every waiting suggestion
    expect(grouped.rows.reduce((n, r) => n + (r.groupSize ?? 1), 0)).toBe(ungrouped.total);
    const s = (await owner.get(`${base()}/matches/summary`)).body;
    expect(s.counts.awaiting).toBe(ungrouped.total);
    expect(s.counts.awaitingProductPairs).toBe(grouped.total);
  });

  it('opens the variant pairs behind a group', async () => {
    const members = await list(`bucket=review&sourceProductId=${pair.sp}&competitorProductId=${pair.cp}&pageSize=50`);
    expect(members.total).toBeGreaterThanOrEqual(2);
    expect(members.rows.every((r) => r.sourceProductId === pair.sp && r.competitorProductId === pair.cp)).toBe(true);
  });

  it('rejects every waiting variant pair of one product pair with ordinary recorded decisions, and nothing else', async () => {
    const ungrouped = await list('bucket=review&pageSize=300');
    const elsewhere = ungrouped.rows.filter((r) => !(r.sourceProductId === pair.sp && r.competitorProductId === pair.cp));
    accepted = elsewhere[0]!;
    otherId = elsewhere[1]!.id;
    expect((await owner.post(`${base()}/matches/${accepted.id}/decision`, { decision: 'accept' })).status).toBe(200);
    const waitingBefore = (await list(`bucket=review&sourceProductId=${pair.sp}&competitorProductId=${pair.cp}&pageSize=50`)).rows.map((r) => r.id);
    expect(waitingBefore.length).toBeGreaterThanOrEqual(2);
    const r = await owner.post(`${base()}/matches/product-pair/reject`, { sourceProductId: pair.sp, competitorProductId: pair.cp, note: 'different products' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ rejected: waitingBefore.length });
    const after = await db().select().from(productMatches).where(inArray(productMatches.id, waitingBefore));
    expect(after.every((m) => m.status === 'rejected' && m.relationship === 'non_match' && m.decidedBy === userId)).toBe(true);
    const events = await db().select().from(matchEvents).where(and(eq(matchEvents.orgId, org), inArray(matchEvents.matchId, waitingBefore), eq(matchEvents.kind, 'decided')));
    expect(events).toHaveLength(waitingBefore.length);
    // an accepted decision elsewhere and another waiting suggestion are untouched
    const [acc] = await db().select().from(productMatches).where(eq(productMatches.id, accepted.id));
    expect(acc!.status).toBe('accepted');
    const [other] = await db().select().from(productMatches).where(eq(productMatches.id, otherId));
    expect(other!.status).toBe('needs_review');
    // the product pair has left the queue; a second call finds nothing waiting
    expect((await list(`bucket=review&group=product&pageSize=300`)).rows.some((x) => x.sourceProductId === pair.sp && x.competitorProductId === pair.cp)).toBe(false);
    expect((await owner.post(`${base()}/matches/product-pair/reject`, { sourceProductId: pair.sp, competitorProductId: pair.cp })).body).toEqual({ rejected: 0 });
  });

  it('keeps the rejection and the accepted decision when matching runs again', async () => {
    await runMatching(h.svc, db(), org);
    const [acc] = await db().select().from(productMatches).where(eq(productMatches.id, accepted.id));
    expect(acc!.status).toBe('accepted');
    const rejected = await list(`bucket=rejected&sourceProductId=${pair.sp}&competitorProductId=${pair.cp}&pageSize=50`);
    expect(rejected.total).toBeGreaterThanOrEqual(2);
    expect((await list(`bucket=review&sourceProductId=${pair.sp}&competitorProductId=${pair.cp}&pageSize=50`)).total).toBe(0);
  });
});
