import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { buildApp } from '../../apps/api/src/app.ts';
import { matchEvents, productMatches, products, variants } from '@ci/database';
import { ENGINE_VERSION, assessQuantities, measureQuantity, parseQuantity, type Suggestion } from '@ci/core';
import { INCOMPARABLE_QUANTITY_MISMATCH } from '@ci/shared';
import { auditStoredPairs, bulkAcceptMatches, createOrganization, decideMatch, persistSuggestions, runMatching, startScan } from '@ci/services';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp } from '../support/auth.ts';

/**
 * The quantity-compatibility policy against stored decisions. Products that hold different actual quantities are left out of price comparison; a decision a person
 * made about such a pair is KEPT (and its history), the pair is just not used for price; equal quantities in other units stay comparable; a quantity that is not stated
 * is never taken as a match; and nothing is ever converted into a price per unit.
 */
let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let org: string;
let userId: string;
const base = () => `/api/v1/orgs/${org}`;
const db = () => h.db.worker;
const now = () => new Date();

type Pair = { key: string; s: string; c: string; sp: string; cp: string; id?: string };
const pairs: Record<string, Pair> = {};
const DECISION_COLUMNS = ['status', 'relationship', 'matchClass', 'confidence', 'method', 'decidedBy', 'decidedAt', 'decisionNote', 'autoConfirmedAt'] as const;

const retitle = async (p: Pair, source: string, rival: string, sizes: { s?: [string, number, string] | null; c?: [string, number, string] | null } = {}) => {
  for (const [productId, variantId, title, size] of [[p.sp, p.s, source, sizes.s ?? null], [p.cp, p.c, rival, sizes.c ?? null]] as const) {
    await db().update(products).set({ title, attrs: {} }).where(eq(products.id, productId));
    await db().update(variants).set({ title: 'Default Title', options: {}, qtyKind: size?.[0] ?? null, qtyTotal: size?.[1] ?? null, qtyLabel: size?.[2] ?? null }).where(eq(variants.id, variantId));
  }
};
const policyColumns = (id: string) => db().select({ ex: productMatches.priceExclusion, at: productMatches.priceExcludedAt, q: productMatches.quantityCheck }).from(productMatches).where(eq(productMatches.id, id)).then((r) => r[0]!);
const decision = (id: string) => db().select().from(productMatches).where(eq(productMatches.id, id)).then((r) => Object.fromEntries(DECISION_COLUMNS.map((k) => [k, r[0]![k]])));
const events = async (kind: string, id?: string) => (await db().select().from(matchEvents).where(eq(matchEvents.orgId, org))).filter((e) => e.kind === kind && (!id || e.matchId === id));
const comparison = async () => (await owner.get(`${base()}/comparison?pageSize=500`)).body.rows as { sourceVariantId: string; cells: { variantId: string; directlyComparable: boolean; unitDiffPct: number | null; caveats: string[]; quantity?: { verdict: string } }[]; sourceUnitPrice: { value: number | null }; position: string }[];
const cellOf = (rows: Awaited<ReturnType<typeof comparison>>, p: Pair) => rows.find((r) => r.sourceVariantId === p.s)?.cells.find((c) => c.variantId === p.c);
const forget = (id: string) => db().update(productMatches).set({ priceExclusion: null, priceExcludedAt: null, quantityCheck: null }).where(eq(productMatches.id, id)); // a row written before the policy existed

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
  await signUp(owner, h, { email: `qp-${Date.now()}@example.test`, password: 'Correct-Horse-9-Battery', displayName: 'Owner' });
  userId = (await owner.get('/api/v1/auth/me')).body.user.id;
  org = (await createOrganization(h.db.app, userId, 'Quantity policy')).id;
  const siteIds: Record<string, string> = {};
  for (const [key, role] of [['source', 'source'], ['woo', 'competitor']] as const) {
    const id = (await owner.post(`${base()}/sites`, { url: h.fixtures.origin(key), role, name: h.fixtures.sites[key]!.spec.label })).body.site.id as string;
    await owner.post(`${base()}/sites/${id}/consent`, { status: 'confirmed', attest: true });
    await startScan(h.svc, h.db.worker, org, id, { kind: 'discovery', trigger: 'manual' });
    siteIds[key] = id;
  }
  await h.queue.drain();
  await runMatching(h.svc, db(), org);
  const src = await db().select({ id: variants.id, productId: variants.productId }).from(variants).where(eq(variants.siteId, siteIds.source!)).limit(8);
  const rival = await db().select({ id: variants.id, productId: variants.productId }).from(variants).where(eq(variants.siteId, siteIds.woo!)).limit(8);
  ['oil', 'juice', 'honey', 'flour', 'rice', 'soap'].forEach((key, i) => { pairs[key] = { key, s: src[i]!.id, sp: src[i]!.productId, c: rival[i]!.id, cp: rival[i]!.productId }; });
  // every other suggestion is set aside, so only the pairs below exist
  await db().delete(productMatches).where(eq(productMatches.orgId, org));
  await retitle(pairs.oil!, 'Acme Cooking Oil 10 L', 'Acme Cooking Oil 20 L', { s: ['volume', 10000, '10 L'], c: ['volume', 20000, '20 L'] });
  await retitle(pairs.juice!, 'Acme Orange Juice 1 L', 'Acme Orange Juice 1000 ml', { s: ['volume', 1000, '1 L'], c: ['volume', 1000, '1000 ml'] });
  await retitle(pairs.honey!, 'Acme Honey', 'Acme Honey');
  await retitle(pairs.flour!, 'Acme Flour 500 g', 'Acme Flour 1 kg', { s: ['mass', 500, '500 g'], c: ['mass', 1000, '1 kg'] });
  await retitle(pairs.rice!, 'Acme Rice 1 kg', 'Acme Rice 1000 g', { s: ['mass', 1000, '1 kg'], c: ['mass', 1000, '1000 g'] });
  await retitle(pairs.soap!, 'Acme Soap 1 kg', 'Acme Soap 1 L', { s: ['mass', 1000, '1 kg'], c: ['volume', 1000, '1 L'] });
  // a person confirms each of them as the same product (the policy has not looked at any of them yet: the rows are written as before it existed)
  for (const key of ['oil', 'juice', 'honey', 'rice']) {
    const r = await owner.post(`${base()}/matches/manual`, { sourceVariantId: pairs[key]!.s, competitorVariantId: pairs[key]!.c, matchClass: 'identical', note: `Checked ${key}` });
    expect(r.status).toBe(201);
    pairs[key]!.id = r.body.match.id as string;
    await forget(pairs[key]!.id);
  }
  // the matcher confirmed one of the mismatched pairs on its own, before the policy existed
  const [auto] = await db().insert(productMatches).values({ orgId: org, sourceVariantId: pairs.flour!.s, competitorVariantId: pairs.flour!.c, competitorSiteId: siteIds.woo!, matchClass: 'identical', confidence: 0.9, status: 'accepted', method: 'attributes', reasons: ['x'], relationship: 'exact', tier: 'medium', autoConfirmedAt: new Date(), decidedAt: new Date(), decisionNote: 'Confirmed automatically', engineVersion: ENGINE_VERSION }).returning();
  pairs.flour!.id = auto!.id;
  // a person rejected one pair; the policy must leave that decision alone too
  const [rej] = await db().insert(productMatches).values({ orgId: org, sourceVariantId: pairs.soap!.s, competitorVariantId: pairs.soap!.c, competitorSiteId: siteIds.woo!, matchClass: 'not_comparable', confidence: 0.5, status: 'rejected', method: 'attributes', reasons: ['x'], relationship: 'non_match', decidedBy: userId, decidedAt: new Date(), decisionNote: 'Different things' }).returning();
  pairs.soap!.id = rej!.id;
}, 240_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

let before: Record<string, unknown> = {};

describe('existing pairs, before anything has been recorded about them', () => {
  it('a pair whose products hold different quantities is left out of the price comparison even though a person confirmed it', async () => {
    const rows = await comparison();
    expect(cellOf(rows, pairs.oil!)).toBeUndefined(); // 10 L against 20 L
    expect(cellOf(rows, pairs.flour!)).toBeUndefined(); // 500 g against 1 kg (confirmed by the matcher)
  });

  it('equal quantities written in other units stay comparable, and the price difference is the plain one', async () => {
    const cell = cellOf(await comparison(), pairs.juice!)!; // 1 L against 1000 ml
    expect(cell).toBeTruthy();
    expect(cell.directlyComparable).toBe(true);
    expect(cell.quantity?.verdict).toBe('same');
    expect(cell.unitDiffPct).toBeNull(); // a direct comparison carries no second, per-unit figure
  });

  it('a quantity that is not stated is not taken as a match, but a person’s own confirmation still counts and says so', async () => {
    const cell = cellOf(await comparison(), pairs.honey!)!;
    expect(cell).toBeTruthy();
    expect(cell.quantity?.verdict).toBe('unknown');
    expect(cell.directlyComparable).toBe(true);
    expect(cell.caveats.some((c) => /Quantity not verified/.test(c))).toBe(true);
  });

  it('nothing is converted to a price per unit anywhere in the comparison', async () => {
    const rows = await comparison();
    expect(rows.every((r) => r.sourceUnitPrice.value === null)).toBe(true);
    expect(rows.flatMap((r) => r.cells).every((c) => (c as unknown as { unitPrice: { value: number | null } }).unitPrice.value === null)).toBe(true);
  });
});

describe('recording the policy on stored pairs (the audit)', () => {
  it('counts what it would change without writing anything', async () => {
    const snapshot = await Promise.all(Object.values(pairs).map((p) => decision(p.id!)));
    before = Object.fromEntries(Object.values(pairs).map((p, i) => [p.key, snapshot[i]]));
    const a = await auditStoredPairs(db(), org);
    expect(a.pairs).toBe(6);
    expect(a.different).toBe(3); // oil, flour, soap (a weight against a volume)
    expect(a.same).toBe(2); // juice, rice
    expect(a.unknown).toBe(1); // honey
    expect(a.excludedByState).toMatchObject({ personAccepted: 1, autoConfirmed: 1, personRejected: 1 });
    expect(a.confirmedUnverified).toEqual({ person: 1, automatic: 0 });
    expect(a.toWrite).toBe(6);
    expect((await policyColumns(pairs.oil!.id!)).ex).toBeNull(); // nothing written
  });

  it('writes only the policy fields: every decision, its note, its author and its time are exactly as they were', async () => {
    const a = await auditStoredPairs(db(), org, { apply: true });
    expect(a.newlyExcluded).toBe(3);
    for (const p of Object.values(pairs)) expect(await decision(p.id!), p.key).toEqual(before[p.key]);
    expect(await policyColumns(pairs.oil!.id!)).toMatchObject({ ex: INCOMPARABLE_QUANTITY_MISMATCH, q: { verdict: 'different', exclusion: INCOMPARABLE_QUANTITY_MISMATCH } });
    const q = (await policyColumns(pairs.oil!.id!)).q!;
    expect([q.a.label, q.a.total, q.a.unit, q.b.label, q.b.total, q.b.unit]).toEqual(['10 L', 10000, 'ml', '20 L', 20000, 'ml']);
    expect(q.note).toMatch(/volume differs \(10 L vs 20 L\)/);
    expect((await policyColumns(pairs.oil!.id!)).at).toBeInstanceOf(Date);
    expect(await policyColumns(pairs.juice!.id!)).toMatchObject({ ex: null, q: { verdict: 'same' } });
    expect(await policyColumns(pairs.honey!.id!)).toMatchObject({ ex: null, q: { verdict: 'unknown' } });
    expect(await policyColumns(pairs.soap!.id!)).toMatchObject({ ex: INCOMPARABLE_QUANTITY_MISMATCH }); // the rejection stands, the reason is recorded
  });

  it('appends the change to each pair’s history, once', async () => {
    for (const k of ['oil', 'flour', 'soap']) {
      const e = await events('quantity_excluded', pairs[k]!.id);
      expect(e, k).toHaveLength(1);
      expect(e[0]!.note).toMatch(/INCOMPARABLE_QUANTITY_MISMATCH/);
    }
    expect(await events('quantity_excluded', pairs.juice!.id)).toHaveLength(0);
    expect((await events('decided', pairs.oil!.id)).length).toBeGreaterThanOrEqual(1); // the person’s own decision entry is still there
  });

  it('is safe to run again: nothing changes, nothing is recorded twice', async () => {
    const a = await auditStoredPairs(db(), org, { apply: true });
    expect(a.toWrite).toBe(0);
    expect(await events('quantity_excluded')).toHaveLength(3);
  });

  it('the price comparison now reads the recorded reason, and the Match review counts it', async () => {
    const rows = await comparison();
    expect(cellOf(rows, pairs.oil!)).toBeUndefined();
    expect(cellOf(rows, pairs.juice!)).toBeTruthy();
    const s = (await owner.get(`${base()}/matches/summary`)).body;
    expect(s.counts.quantityExcluded).toBe(2); // the oil and the flour (the rejected pair is not counted as work or as a left-out confirmation)
    expect(s.counts.quantityExcludedConfirmed).toBe(2);
    const list = (await owner.get(`${base()}/matches?bucket=quantity&pageSize=50`)).body.rows as { id: string; priceExclusion: string; quantityCheck: { note: string }; status: string }[];
    expect(list.map((r) => r.id).sort()).toEqual([pairs.oil!.id, pairs.flour!.id].sort());
    expect(list.find((r) => r.id === pairs.oil!.id)).toMatchObject({ status: 'accepted', priceExclusion: INCOMPARABLE_QUANTITY_MISMATCH });
  });
});

describe('what the matcher does with a pair whose quantities differ', () => {
  const sizes = (a: string, b: string) => assessQuantities(measureQuantity(parseQuantity(a), { title: a }), measureQuantity(parseQuantity(b), { title: b }));
  const suggest = (p: Pair, quantity: ReturnType<typeof sizes>, o: Partial<Suggestion> = {}): Suggestion => ({
    sourceVariantId: p.s, competitorVariantId: p.c, competitorSiteId: '00000000-0000-0000-0000-000000000000', relationship: 'exact', tier: 'medium', method: 'attributes', autoEligible: false, rank: 0.9, pairHash: 'h1', engineVersion: ENGINE_VERSION, quantity, bundle: null,
    evidence: { items: [], signals: 1, summary: 'Looks like the same product.' }, ...o,
  });

  it('withdraws a confirmation the MATCHER made when the quantities are not shown equal, and never one a person made', async () => {
    const siteId = (await db().select({ s: productMatches.competitorSiteId }).from(productMatches).where(eq(productMatches.id, pairs.flour!.id!)))[0]!.s;
    const run = await persistSuggestions(db(), org, [{ ...suggest(pairs.flour!, sizes('Acme Flour 500 g', 'Acme Flour 1 kg'), { autoEligible: false }), competitorSiteId: siteId }], now(), { autoConfirm: true });
    expect(run.autoWithdrawn).toBe(1);
    expect(await decision(pairs.flour!.id!)).toMatchObject({ status: 'needs_review', autoConfirmedAt: null, decidedAt: null });
    expect(await policyColumns(pairs.flour!.id!)).toMatchObject({ ex: INCOMPARABLE_QUANTITY_MISMATCH });
    // the person’s confirmation of the honey (quantity not stated) is untouched by a run that cannot verify it
    const h2 = await persistSuggestions(db(), org, [{ ...suggest(pairs.honey!, sizes('Acme Honey', 'Acme Honey')), competitorSiteId: siteId }], now(), { autoConfirm: true });
    expect(h2.autoWithdrawn).toBe(0);
    expect(await decision(pairs.honey!.id!)).toEqual(before.honey);
  });

  it('a run never changes a person’s decision; it keeps the marker up to date, and says when it is released', async () => {
    // the oil’s products are corrected to the same quantity
    await retitle(pairs.oil!, 'Acme Cooking Oil 20 L', 'Acme Cooking Oil 20 L', { s: ['volume', 20000, '20 L'], c: ['volume', 20000, '20 L'] });
    const siteId = (await db().select({ s: productMatches.competitorSiteId }).from(productMatches).where(eq(productMatches.id, pairs.oil!.id!)))[0]!.s;
    const run = await persistSuggestions(db(), org, [{ ...suggest(pairs.oil!, sizes('Acme Cooking Oil 20 L', 'Acme Cooking Oil 20 L'), { pairHash: 'h2' }), competitorSiteId: siteId }], now(), { autoConfirm: true });
    expect(run.protectedDecisions).toBe(1);
    expect(run.quantityReleased).toBe(1);
    expect(await decision(pairs.oil!.id!)).toEqual(before.oil); // the decision is untouched
    expect(await policyColumns(pairs.oil!.id!)).toMatchObject({ ex: null, at: null, q: { verdict: 'same' } });
    expect(await events('quantity_released', pairs.oil!.id)).toHaveLength(1);
    expect(cellOf(await comparison(), pairs.oil!)).toBeTruthy(); // compared again, because the quantities agree
    // and back: a change in the other direction is recorded as well
    await persistSuggestions(db(), org, [{ ...suggest(pairs.oil!, sizes('Acme Cooking Oil 20 L', 'Acme Cooking Oil 10 L'), { pairHash: 'h3' }), competitorSiteId: siteId }], now(), { autoConfirm: true });
    expect(await policyColumns(pairs.oil!.id!)).toMatchObject({ ex: INCOMPARABLE_QUANTITY_MISMATCH });
    expect(await events('quantity_excluded', pairs.oil!.id)).toHaveLength(2);
    expect(await decision(pairs.oil!.id!)).toEqual(before.oil);
  });
});

describe('choosing pairs by hand or in bulk', () => {
  it('a pair a person makes by hand is recorded as they chose it; if the quantities differ it is left out of the price comparison and says why', async () => {
    const p = pairs.soap!; // 1 kg against 1 L, rejected earlier: the person now says it is the same product
    const r = await owner.post(`${base()}/matches/manual`, { sourceVariantId: p.s, competitorVariantId: p.c, matchClass: 'identical', note: 'Same bottle, label says kg' });
    expect(r.status).toBe(201);
    expect(r.body.match).toMatchObject({ status: 'accepted', method: 'manual', priceExclusion: INCOMPARABLE_QUANTITY_MISMATCH, decisionNote: 'Same bottle, label says kg' });
    expect(cellOf(await comparison(), p)).toBeUndefined();
  });

  it('bulk acceptance never accepts a pair that the policy leaves out of price comparison', async () => {
    const [x] = await db().insert(productMatches).values({
      orgId: org, sourceVariantId: pairs.rice!.s, competitorVariantId: pairs.flour!.c, competitorSiteId: (await db().select({ s: productMatches.competitorSiteId }).from(productMatches).where(eq(productMatches.id, pairs.flour!.id!)))[0]!.s,
      matchClass: 'identical', confidence: 0.95, status: 'needs_review', method: 'attributes', reasons: ['x'], relationship: 'exact', tier: 'strong', priceExclusion: INCOMPARABLE_QUANTITY_MISMATCH, quantityCheck: assessQuantities(measureQuantity(parseQuantity('1 kg'), { title: '1 kg' }), measureQuantity(parseQuantity('1 L'), { title: '1 L' })),
    }).returning();
    const dry = await bulkAcceptMatches(db(), org, userId, { matchClass: 'identical', minConfidence: 0.5, dryRun: true }, now());
    const all = await db().select({ id: productMatches.id }).from(productMatches).where(and(eq(productMatches.orgId, org), inArray(productMatches.status, ['needs_review', 'auto'])));
    expect(all.some((m) => m.id === x!.id)).toBe(true);
    expect(dry.count).toBe(0);
    const [unchanged] = await db().select().from(productMatches).where(eq(productMatches.id, x!.id));
    expect(unchanged!.status).toBe('needs_review');
    // and it does not wait in the review queue either: nobody is asked to review a pair that would not be compared
    const s = (await owner.get(`${base()}/matches/summary`)).body;
    expect(s.counts.awaiting).toBe(0);
  });

  it('a person can still reject or reclassify such a pair; the decision is theirs', async () => {
    const [m] = await db().select().from(productMatches).where(and(eq(productMatches.orgId, org), eq(productMatches.status, 'needs_review'), sql`${productMatches.priceExclusion} is not null`));
    const d = await decideMatch(db(), org, m!.id, userId, { decision: 'reject', note: 'No' }, now());
    expect(d).toMatchObject({ status: 'rejected', decidedBy: userId });
  });
});
