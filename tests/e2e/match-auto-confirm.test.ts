import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../apps/api/src/app.ts';
import { matchEvents, matchRuns, productMatches } from '@ci/database';
import { ENGINE_VERSION, type Suggestion } from '@ci/core';
import { createOrganization, decideMatch, persistSuggestions, runMatching, startScan, withdrawAutoConfirmations } from '@ci/services';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp } from '../support/auth.ts';

/**
 * Automatic confirmation. The rules under test, in order of importance:
 *  - nothing is confirmed unless the workspace turned it on AND the engine says the pair meets the policy;
 *  - an engine confirmation is marked (`auto_confirmed_at`) and has no person on it; it is recorded in the pair's history;
 *  - a person's decision always wins: it clears the marker, and a later run never changes it;
 *  - the engine withdraws only confirmations it made (policy no longer met / turned off), and never touches a person's;
 *  - running again changes nothing (no duplicate rows) and the comparison labels each price with who stands behind it.
 */
let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let org: string;
let userId: string;
let pair: { sourceVariantId: string; competitorVariantId: string; competitorSiteId: string };
const base = () => `/api/v1/orgs/${org}`;
const db = () => h.db.worker;
const now = () => new Date();

const suggestion = (o: Partial<Suggestion> = {}): Suggestion => ({
  ...pair, relationship: 'exact', tier: 'medium', method: 'attributes', autoEligible: true, rank: 0.9, pairHash: 'hash-1', engineVersion: ENGINE_VERSION,
  evidence: { items: [{ kind: 'name', effect: 'supports', strength: 'moderate', text: 'The names say the same thing' }], signals: 1, summary: 'Looks like the same product.' }, ...o,
});
const rows = () => db().select().from(productMatches).where(eq(productMatches.orgId, org));
const events = async (kind: string) => (await db().select().from(matchEvents).where(eq(matchEvents.orgId, org))).filter((e) => e.kind === kind);

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
  await signUp(owner, h, { email: `ac-${Date.now()}@example.test`, password: 'Correct-Horse-9-Battery', displayName: 'Owner' });
  userId = (await owner.get('/api/v1/auth/me')).body.user.id;
  org = (await createOrganization(h.db.app, userId, 'Auto confirm')).id;
  for (const [key, role] of [['source', 'source'], ['woo', 'competitor'], ['jsonld', 'competitor']] as const) {
    const id = (await owner.post(`${base()}/sites`, { url: h.fixtures.origin(key), role, name: h.fixtures.sites[key]!.spec.label })).body.site.id as string;
    await owner.post(`${base()}/sites/${id}/consent`, { status: 'confirmed', attest: true });
    await startScan(h.svc, h.db.worker, org, id, { kind: 'discovery', trigger: 'manual' });
  }
  await h.queue.drain();
  await db().delete(productMatches).where(eq(productMatches.orgId, org));
  await db().delete(matchRuns).where(eq(matchRuns.orgId, org));
  expect((await owner.put(`${base()}/settings`, { matchingEngine: 'v2' })).status).toBe(200);
  // a real pair to work with (the ids must exist), taken from an ordinary run; the table is emptied again before each test
  await runMatching(h.svc, db(), org);
  const first = (await rows())[0]!;
  pair = { sourceVariantId: first.sourceVariantId, competitorVariantId: first.competitorVariantId, competitorSiteId: first.competitorSiteId };
}, 180_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

const reset = async () => {
  await db().delete(matchEvents).where(eq(matchEvents.orgId, org));
  await db().delete(productMatches).where(eq(productMatches.orgId, org));
};

describe('automatic confirmation', () => {
  it('confirms nothing while the setting is off, even for a pair that meets the policy', async () => {
    await reset();
    const r = await persistSuggestions(db(), org, [suggestion()], now(), { autoConfirm: false });
    expect(r.autoConfirmed).toBe(0);
    const [m] = await rows();
    expect(m).toMatchObject({ status: 'needs_review', autoConfirmedAt: null, decidedBy: null });
  });

  it('confirms a pair that meets the policy, marks it, and records it in the history', async () => {
    await reset();
    const r = await persistSuggestions(db(), org, [suggestion()], now(), { autoConfirm: true });
    expect(r).toMatchObject({ created: 1, autoConfirmed: 1 });
    const [m] = await rows();
    expect(m!.status).toBe('accepted');
    expect(m!.autoConfirmedAt).not.toBeNull();
    expect(m!.decidedBy).toBeNull();
    expect(m!.decisionNote).toMatch(/automatically/i);
    const ev = await events('auto_confirmed');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ matchId: m!.id, decision: 'accept', actorId: null });
  });

  it('a pair that does not meet the policy still waits for a person', async () => {
    await reset();
    await persistSuggestions(db(), org, [suggestion({ autoEligible: false })], now(), { autoConfirm: true });
    expect((await rows())[0]).toMatchObject({ status: 'needs_review', autoConfirmedAt: null });
  });

  it('running again changes nothing and creates no second row', async () => {
    await reset();
    await persistSuggestions(db(), org, [suggestion()], now(), { autoConfirm: true });
    const before = await rows();
    const r = await persistSuggestions(db(), org, [suggestion()], now(), { autoConfirm: true });
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(r).toMatchObject({ created: 0, unchanged: 1, autoConfirmed: 0, autoWithdrawn: 0 });
    expect(after[0]!.autoConfirmedAt?.getTime()).toBe(before[0]!.autoConfirmedAt?.getTime());
    expect(await events('auto_confirmed')).toHaveLength(1);
  });

  it('withdraws its own confirmation when the pair stops meeting the policy, and says so in the history', async () => {
    await reset();
    await persistSuggestions(db(), org, [suggestion()], now(), { autoConfirm: true });
    const r = await persistSuggestions(db(), org, [suggestion({ autoEligible: false, pairHash: 'hash-2' })], now(), { autoConfirm: true });
    expect(r.autoWithdrawn).toBe(1);
    expect((await rows())[0]).toMatchObject({ status: 'needs_review', autoConfirmedAt: null, decidedAt: null });
    expect(await events('auto_withdrawn')).toHaveLength(1);
  });

  it('withdraws its own confirmation when the pair is no longer proposed at all', async () => {
    await reset();
    await persistSuggestions(db(), org, [suggestion()], now(), { autoConfirm: true });
    const r = await persistSuggestions(db(), org, [], now(), { autoConfirm: true });
    expect(r.autoWithdrawn).toBe(1);
    const [m] = await rows();
    expect(m).toMatchObject({ status: 'needs_review', autoConfirmedAt: null });
    expect(m!.supersededAt).not.toBeNull();
  });

  it('turning the setting off takes back every confirmation the engine made at once', async () => {
    await reset();
    await persistSuggestions(db(), org, [suggestion()], now(), { autoConfirm: true });
    expect(await withdrawAutoConfirmations(db(), org, now())).toBe(1);
    expect((await rows())[0]).toMatchObject({ status: 'needs_review', autoConfirmedAt: null });
    // through the API the same thing happens when an admin switches it off
    await persistSuggestions(db(), org, [suggestion()], now(), { autoConfirm: true });
    expect((await owner.put(`${base()}/settings`, { matchingAutoConfirm: false })).status).toBe(200);
    expect((await rows())[0]).toMatchObject({ status: 'needs_review', autoConfirmedAt: null });
  });

  it('a person\'s decision clears the marker and is final: later runs never change it, whatever the engine says', async () => {
    await reset();
    await persistSuggestions(db(), org, [suggestion()], now(), { autoConfirm: true });
    const id = (await rows())[0]!.id;
    await decideMatch(db(), org, id, userId, { decision: 'reject', note: 'different product' }, now());
    expect((await rows())[0]).toMatchObject({ status: 'rejected', autoConfirmedAt: null, decidedBy: userId });
    const r = await persistSuggestions(db(), org, [suggestion({ pairHash: 'hash-3' })], now(), { autoConfirm: true });
    expect(r.autoConfirmed).toBe(0);
    expect((await rows())[0]).toMatchObject({ status: 'rejected', autoConfirmedAt: null, decidedBy: userId });
    // a person who confirms a pair the engine had confirmed takes it over: it is then theirs
    await reset();
    await persistSuggestions(db(), org, [suggestion()], now(), { autoConfirm: true });
    const id2 = (await rows())[0]!.id;
    await decideMatch(db(), org, id2, userId, { decision: 'accept' }, now());
    expect((await rows())[0]).toMatchObject({ status: 'accepted', autoConfirmedAt: null, decidedBy: userId });
    await persistSuggestions(db(), org, [suggestion({ autoEligible: false, pairHash: 'hash-4' })], now(), { autoConfirm: false });
    expect((await rows())[0]).toMatchObject({ status: 'accepted', decidedBy: userId });
  });

  it('the comparison says who stands behind each price, and suggestions never count towards a position', async () => {
    await reset();
    await persistSuggestions(db(), org, [suggestion()], now(), { autoConfirm: true });
    const confirmed = (await owner.get(`${base()}/comparison?view=prices`)).body;
    const cell = confirmed.rows.flatMap((r: { cells: { confirmation: string; directlyComparable: boolean }[] }) => r.cells)[0];
    expect(cell).toMatchObject({ confirmation: 'automatic' });
    // as a suggestion only (the setting is off): hidden by default, shown and labelled on request, and never "directly comparable"
    await reset();
    await persistSuggestions(db(), org, [suggestion({ tier: 'strong' })], now(), { autoConfirm: false });
    expect((await owner.get(`${base()}/comparison?view=prices`)).body.total).toBe(0);
    const shown = (await owner.get(`${base()}/comparison?view=prices&include=suggested`)).body;
    expect(shown.total).toBe(1);
    const sugg = shown.rows[0].cells[0];
    expect(sugg).toMatchObject({ confirmation: 'suggested', directlyComparable: false });
    expect(shown.rows[0].position).toBe('no_data');
  });
});
