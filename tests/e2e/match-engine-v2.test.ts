import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { buildApp } from '../../apps/api/src/app.ts';
import { matchEvents, matchRuns, orgSettings, productMatches, products, variants } from '@ci/database';
import { createOrganization, runMatching, startScan } from '@ci/services';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp } from '../support/auth.ts';

/**
 * Matching engine v2 on the fictional grocery websites of the test harness: what it stores, what it never does (accept anything, change or erase a
 * person's decision, delete a suggestion), what the two comparison views contain, and what the empty states say.
 */
let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let org: string;
let userId: string;
const PASSWORD = 'Correct-Horse-9-Battery';
const base = () => `/api/v1/orgs/${org}`;
const db = () => h.db.worker;

interface Row { id: string; relationship: string; tier: string | null; status: string; matchClass: string; evidence: { items: { kind: string; effect: string }[]; summary: string } | null; engineVersion: string | null; sourceVariantId: string; competitorVariantId: string; needsReevaluation: boolean; supersededAt: string | null; decidedByPerson: boolean }
const list = async (bucket: string, pageSize = 300) => (await owner.get(`${base()}/matches?bucket=${bucket}&pageSize=${pageSize}`)).body.rows as Row[];
const summary = async () => (await owner.get(`${base()}/matches/summary`)).body;
const setEngine = async (engine: 'v1' | 'v2_shadow' | 'v2') => expect((await owner.put(`${base()}/settings`, { matchingEngine: engine })).status).toBe(200);
const prices = async (view: 'prices' | 'substitutes' = 'prices') => (await owner.get(`${base()}/comparison?pageSize=200&view=${view}`)).body;

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
  await signUp(owner, h, { email: `v2-${Date.now()}@example.test`, password: PASSWORD, displayName: 'Reviewer' });
  const me = (await owner.get('/api/v1/auth/me')).body;
  userId = me.user.id;
  org = (await createOrganization(h.db.app, userId, 'Engine V2')).id;
  for (const [key, role] of [['source', 'source'], ['woo', 'competitor'], ['jsonld', 'competitor']] as const) {
    const id = (await owner.post(`${base()}/sites`, { url: h.fixtures.origin(key), role, name: h.fixtures.sites[key]!.spec.label })).body.site.id as string;
    await owner.post(`${base()}/sites/${id}/consent`, { status: 'confirmed', attest: true });
    await startScan(h.svc, h.db.worker, org, id, { kind: 'discovery', trigger: 'manual' });
  }
  await h.queue.drain();
  // collecting a website queues the earlier engine's matching job: start from a workspace that has never been matched
  await db().delete(productMatches).where(eq(productMatches.orgId, org));
  await db().delete(matchRuns).where(eq(matchRuns.orgId, org));
}, 180_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('before anything has run', () => {
  it('says matching has not run — not that everything is reviewed — and compares nothing', async () => {
    const s = await summary();
    expect(s).toMatchObject({ engine: 'v1', state: 'never_run', counts: { awaiting: 0, confirmedSame: 0 } });
    expect((await prices()).total).toBe(0);
    expect((await prices()).matching.state).toBe('never_run');
  });
});

describe('shadow mode', () => {
  it('records what the new engine would do and changes nothing a person can see', async () => {
    await setEngine('v2_shadow');
    const r = await runMatching(h.svc, db(), org);
    expect(r.created).toBe(0);
    expect(await db().select().from(productMatches).where(eq(productMatches.orgId, org))).toHaveLength(0);
    const [run] = await db().select().from(matchRuns).where(eq(matchRuns.orgId, org));
    expect(run).toMatchObject({ engine: 'v2_shadow', error: null });
    expect(run!.finishedAt).not.toBeNull();
    expect(run!.stats).toMatchObject({ sources: expect.any(Number), suggestions: expect.any(Number), ms: expect.any(Number), rssMb: expect.any(Number), persisted: null });
    expect((run!.stats as { suggestions: number }).suggestions).toBeGreaterThan(10);
    const s = await summary();
    expect(s.state).toBe('shadow');
    expect((await prices()).matching.state).toBe('shadow');
  });
});

describe('engine v2 stores suggestions, never decisions', () => {
  let first: Row[];
  let confirmedExact = '';
  it('writes current suggestions with a relationship, an evidence tier and the evidence; nothing is accepted, nothing is "auto"', async () => {
    await setEngine('v2');
    const r = await runMatching(h.svc, db(), org);
    expect(r.created).toBeGreaterThan(10);
    const all = await db().select().from(productMatches).where(eq(productMatches.orgId, org));
    expect(all.length).toBe(r.created);
    expect(all.every((m) => m.status === 'needs_review' && m.decidedBy === null && m.supersededAt === null)).toBe(true);
    expect(all.every((m) => m.relationship !== null && m.tier !== null && m.engineVersion === 'match-v2.8' && m.pairHash)).toBe(true);
    expect(all.every((m) => (m.evidence?.items.length ?? 0) > 1 && (m.evidence?.summary.length ?? 0) > 10)).toBe(true);
    // an older reader that knows only classes sees a class that matches the relationship — and "related" / "insufficient" are invisible to it
    expect(all.filter((m) => m.relationship === 'exact').every((m) => m.matchClass === 'identical')).toBe(true);
    expect(all.filter((m) => m.relationship === 'related' || m.relationship === 'insufficient').every((m) => m.matchClass === 'not_comparable')).toBe(true);
    // one history row per suggestion
    const ev = await db().select().from(matchEvents).where(and(eq(matchEvents.orgId, org), eq(matchEvents.kind, 'suggested')));
    expect(ev.length).toBe(all.length);
    expect(ev[0]!.snapshot).toHaveProperty('source.title');
    first = await list('review');
    expect(first.length).toBeGreaterThan(5);
  });

  it('keeps unconfirmed suggestions out of the price comparison, and says why it is empty', async () => {
    const p = await prices();
    expect(p.total).toBe(0);
    expect(p.matching).toMatchObject({ state: 'none_confirmed', awaiting: expect.any(Number) });
    expect(p.matching.awaiting).toBeGreaterThan(5);
    expect((await prices('substitutes')).total).toBe(0);
    const s = await summary();
    expect(s.state).toBe('none_confirmed');
    expect(s.lastRun.engine).toBe('v2');
  });

  it('a person confirms one pair: it enters the price comparison with its relationship, and is recorded as a labelled example with the evidence', async () => {
    const exact = first.find((m) => m.relationship === 'exact')!;
    expect(exact).toBeTruthy();
    confirmedExact = exact.id;
    const r = await owner.post(`${base()}/matches/${exact.id}/decision`, { decision: 'accept', note: 'same tin' });
    expect(r.body.match).toMatchObject({ status: 'accepted', relationship: 'exact', matchClass: 'identical', decidedBy: userId });
    const p = await prices();
    const row = p.rows.find((x: { sourceVariantId: string }) => x.sourceVariantId === exact.sourceVariantId);
    const cell = row.cells.find((c: { variantId: string }) => c.variantId === exact.competitorVariantId);
    expect(cell).toMatchObject({ relationship: 'exact', matchStatus: 'accepted', directlyComparable: true });
    expect(p.total).toBe(1);
    const [ev] = await db().select().from(matchEvents).where(and(eq(matchEvents.matchId, exact.id), eq(matchEvents.kind, 'decided')));
    expect(ev).toMatchObject({ relationship: 'exact', status: 'accepted', decision: 'accept', actorId: userId, engineVersion: 'match-v2.8' });
    expect(ev!.evidence?.items.length).toBeGreaterThan(1);
    expect(ev!.snapshot).toHaveProperty('competitor.title');
  });

  it('a substitute is only ever in the substitute view — never in the same-product comparison, and never as "exact"', async () => {
    const cand = first.find((m) => m.relationship !== 'substitute' && m.relationship !== 'related' && m.status === 'needs_review' && m.id !== confirmedExact && m.matchClass === 'identical');
    // confirm a pair AS a substitute (a person says so)
    const r = await owner.post(`${base()}/matches/${cand!.id}/decision`, { decision: 'reclassify', relationship: 'substitute' });
    expect(r.body.match).toMatchObject({ status: 'accepted', relationship: 'substitute', matchClass: 'comparable' });
    const same = await prices('prices');
    expect(same.rows.flatMap((x: { cells: { matchId: string }[] }) => x.cells).some((c: { matchId: string }) => c.matchId === cand!.id)).toBe(false);
    const subs = await prices('substitutes');
    const cell = subs.rows.flatMap((x: { cells: { matchId: string; directlyComparable: boolean; relationship: string; caveats: string[] }[] }) => x.cells).find((c: { matchId: string }) => c.matchId === cand!.id);
    expect(cell).toMatchObject({ relationship: 'substitute', directlyComparable: false });
    expect(cell.caveats.join(' ')).toMatch(/substitute, not the same product/i);
    // and "related" is in neither view
    const rel = first.find((m) => m.relationship === 'related' || m.relationship === 'insufficient') ?? (await list('unclear'))[0];
    if (rel) {
      await owner.post(`${base()}/matches/${rel.id}/decision`, { decision: 'reclassify', relationship: 'related' });
      const ids = [...(await prices('prices')).rows, ...(await prices('substitutes')).rows].flatMap((x: { cells: { matchId: string }[] }) => x.cells.map((c) => c.matchId));
      expect(ids).not.toContain(rel.id);
    }
  });
});

describe('re-running the matcher', () => {
  it('never changes a human decision, never duplicates a pair, and does not suggest a rejected pair again', async () => {
    const waiting = await list('review');
    const reject = waiting[0]!;
    expect((await owner.post(`${base()}/matches/${reject.id}/decision`, { decision: 'reject' })).status).toBe(200);
    const decidedBefore = await db().select().from(productMatches).where(and(eq(productMatches.orgId, org), sql`${productMatches.status} in ('accepted','rejected')`));
    expect(decidedBefore.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < 3; i++) await runMatching(h.svc, db(), org);
    const decidedAfter = await db().select().from(productMatches).where(and(eq(productMatches.orgId, org), sql`${productMatches.status} in ('accepted','rejected')`));
    expect(decidedAfter).toHaveLength(decidedBefore.length);
    for (const b of decidedBefore) {
      const a = decidedAfter.find((x) => x.id === b.id)!;
      expect({ status: a.status, relationship: a.relationship, matchClass: a.matchClass, decidedBy: a.decidedBy, decidedAt: a.decidedAt, decisionNote: a.decisionNote }).toEqual({ status: b.status, relationship: b.relationship, matchClass: b.matchClass, decidedBy: b.decidedBy, decidedAt: b.decidedAt, decisionNote: b.decisionNote });
    }
    expect((await list('review')).some((m) => m.id === reject.id)).toBe(false);
    const pairs = await db().select({ s: productMatches.sourceVariantId, c: productMatches.competitorVariantId }).from(productMatches).where(eq(productMatches.orgId, org));
    expect(new Set(pairs.map((p) => `${p.s}|${p.c}`)).size).toBe(pairs.length);
    // an unchanged suggestion is not written about again
    const changed = await db().select().from(matchEvents).where(and(eq(matchEvents.orgId, org), eq(matchEvents.kind, 'changed')));
    expect(changed).toHaveLength(0);
  });

  it('flags a decided pair whose product changed — and leaves the decision exactly as it was', async () => {
    const [m] = await db().select().from(productMatches).where(and(eq(productMatches.orgId, org), eq(productMatches.status, 'accepted'), eq(productMatches.relationship, 'exact'))).limit(1);
    const [cv] = await db().select({ productId: variants.productId }).from(variants).where(eq(variants.id, m!.competitorVariantId));
    await db().update(products).set({ title: sql`${products.title} || ' Family Pack Edition'` }).where(eq(products.id, cv!.productId));
    await runMatching(h.svc, db(), org);
    const [after] = await db().select().from(productMatches).where(eq(productMatches.id, m!.id));
    expect(after).toMatchObject({ status: 'accepted', relationship: 'exact', decidedBy: m!.decidedBy, needsReevaluation: true });
    expect(after!.decidedAt).toEqual(m!.decidedAt);
    const [ev] = await db().select().from(matchEvents).where(and(eq(matchEvents.matchId, m!.id), eq(matchEvents.kind, 'flagged')));
    expect(ev).toBeTruthy();
    expect((await summary()).counts.needLookAgain).toBeGreaterThanOrEqual(1);
    // the comparison still uses the person's confirmation, and says it should be looked at again
    const cell = (await prices()).rows.flatMap((x: { cells: { matchId: string; needsReevaluation: boolean; caveats: string[] }[] }) => x.cells).find((c: { matchId: string }) => c.matchId === m!.id);
    expect(cell).toMatchObject({ needsReevaluation: true });
    expect(cell.caveats.join(' ')).toMatch(/changed after you confirmed/i);
    // keeping the decision clears the flag and is recorded
    expect((await owner.post(`${base()}/matches/${m!.id}/decision`, { decision: 'accept' })).status).toBe(200);
    expect((await db().select().from(productMatches).where(eq(productMatches.id, m!.id)))[0]!.needsReevaluation).toBe(false);
    await runMatching(h.svc, db(), org); // the new text is now the baseline: not flagged again
    expect((await db().select().from(productMatches).where(eq(productMatches.id, m!.id)))[0]!.needsReevaluation).toBe(false);
  });

  it('sets a suggestion aside when it is no longer proposed — keeps the row and its history — and brings it back when it returns', async () => {
    const [m] = await db().select().from(productMatches).where(and(eq(productMatches.orgId, org), eq(productMatches.status, 'needs_review'))).limit(1);
    const [cv] = await db().select({ productId: variants.productId }).from(variants).where(eq(variants.id, m!.competitorVariantId));
    await db().update(products).set({ delistedAt: new Date() }).where(eq(products.id, cv!.productId));
    const r = await runMatching(h.svc, db(), org);
    expect(r.removed).toBeGreaterThanOrEqual(1);
    const [gone] = await db().select().from(productMatches).where(eq(productMatches.id, m!.id));
    expect(gone).toBeTruthy(); // not deleted
    expect(gone!.supersededAt).not.toBeNull();
    expect((await list('review')).some((x) => x.id === m!.id)).toBe(false);
    expect((await list('set_aside')).some((x) => x.id === m!.id)).toBe(true);
    expect((await db().select().from(matchEvents).where(and(eq(matchEvents.matchId, m!.id), eq(matchEvents.kind, 'superseded')))).length).toBe(1);
    await db().update(products).set({ delistedAt: null }).where(eq(products.id, cv!.productId));
    await runMatching(h.svc, db(), org);
    const [back] = await db().select().from(productMatches).where(eq(productMatches.id, m!.id));
    expect(back!.supersededAt).toBeNull();
    expect((await db().select().from(matchEvents).where(and(eq(matchEvents.matchId, m!.id), eq(matchEvents.kind, 'reinstated')))).length).toBe(1);
    const history = (await owner.get(`${base()}/matches/${m!.id}/history`)).body.events as { kind: string }[];
    expect(history.map((e) => e.kind)).toEqual(expect.arrayContaining(['suggested', 'superseded', 'reinstated']));
  });

  it('two matching jobs queued together leave one row per pair', async () => {
    await Promise.all([owner.post(`${base()}/matches/run`), owner.post(`${base()}/matches/run`)]);
    await h.queue.drain();
    const pairs = await db().select({ s: productMatches.sourceVariantId, c: productMatches.competitorVariantId }).from(productMatches).where(eq(productMatches.orgId, org));
    expect(new Set(pairs.map((p) => `${p.s}|${p.c}`)).size).toBe(pairs.length);
  });
});

describe('older records keep working', () => {
  it('a decision made before engine v2 (no relationship stored) is read as it always was, and is not changed by a v2 run', async () => {
    const [m] = await db().select().from(productMatches).where(and(eq(productMatches.orgId, org), eq(productMatches.status, 'needs_review'), eq(productMatches.relationship, 'exact'))).limit(1);
    // shape an old accepted row: only the columns that existed before
    await db().update(productMatches).set({ status: 'accepted', matchClass: 'identical', relationship: null, tier: null, evidence: null, engineVersion: null, pairHash: null, decidedBy: userId, decidedAt: new Date('2026-01-01T00:00:00Z'), decisionNote: 'old decision' }).where(eq(productMatches.id, m!.id));
    expect((await prices()).rows.flatMap((x: { cells: { matchId: string; relationship: string }[] }) => x.cells).find((c: { matchId: string }) => c.matchId === m!.id)).toMatchObject({ relationship: 'exact' });
    await runMatching(h.svc, db(), org);
    const [after] = await db().select().from(productMatches).where(eq(productMatches.id, m!.id));
    expect(after).toMatchObject({ status: 'accepted', matchClass: 'identical', relationship: null, decisionNote: 'old decision', needsReevaluation: false });
    expect(after!.pairHash).not.toBeNull(); // only a baseline fingerprint was added
  });
});

describe('match history is append-only', () => {
  it('an event row cannot be changed', async () => {
    const [ev] = await db().select().from(matchEvents).where(eq(matchEvents.orgId, org)).limit(1);
    const attempt = db().update(matchEvents).set({ note: 'tampered' }).where(eq(matchEvents.id, ev!.id));
    const err = await attempt.then(() => null, (e: Error & { cause?: Error }) => e);
    expect(err).not.toBeNull();
    expect(`${err!.message} ${err!.cause?.message ?? ''}`).toMatch(/append-only/);
  });
});

describe('the other settings are untouched', () => {
  it('the engine setting is stored per workspace and defaults to the earlier engine', async () => {
    const [s] = await db().select().from(orgSettings).where(eq(orgSettings.orgId, org));
    expect(s!.matchingEngine).toBe('v2');
    const other = await h.newTenant('Default Engine');
    const [d] = await db().select().from(orgSettings).where(eq(orgSettings.orgId, other.orgId));
    expect(d!.matchingEngine).toBe('v1');
  });
});
