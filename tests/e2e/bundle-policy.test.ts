import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { buildApp } from '../../apps/api/src/app.ts';
import { matchEvents, productMatches, products, variants } from '@ci/database';
import { ENGINE_VERSION } from '@ci/core';
import { INCOMPARABLE_BUNDLE_CONTENT_MISMATCH } from '@ci/shared';
import { auditBundleContents, createOrganization, runMatching, startScan } from '@ci/services';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp } from '../support/auth.ts';

/**
 * The bundle-contents policy against stored decisions. Two automotive bundles (combos, kits) are compared on price only when they hold the same contents. A decision a person made about
 * a pair whose bundles differ is KEPT (and its history), the pair is just not used for price; a valid comparison of the same product against another competitor is untouched; contents
 * that are not established are never treated as different; colour options are never components; and nothing but the policy fields is written.
 */
let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let org: string;
let userId: string;
let competitorSite: string;
const base = () => `/api/v1/orgs/${org}`;
const db = () => h.db.worker;

type Pair = { key: string; s: string; c: string; sp: string; cp: string; id?: string };
const pairs: Record<string, Pair> = {};
const DECISION_COLUMNS = ['status', 'relationship', 'matchClass', 'confidence', 'method', 'decidedBy', 'decidedAt', 'decisionNote', 'autoConfirmedAt'] as const;
const COMBO = 'Sealight H11 LED Headlight + Brake Light Combo';

type Side = { title: string; variant?: { title: string; options: Record<string, string> } };
const retitle = async (p: Pair, source: Side, rival: Side, brand = 'Sealight') => {
  for (const [productId, variantId, side] of [[p.sp, p.s, source], [p.cp, p.c, rival]] as const) {
    await db().update(products).set({ title: side.title, brand, attrs: {} }).where(eq(products.id, productId));
    await db().update(variants).set({ title: side.variant?.title ?? 'Default Title', options: side.variant?.options ?? {}, qtyKind: null, qtyTotal: null, qtyLabel: null }).where(eq(variants.id, variantId));
  }
};
const policyColumns = (id: string) => db().select({ ex: productMatches.priceExclusion, at: productMatches.priceExcludedAt, q: productMatches.quantityCheck, b: productMatches.bundleCheck }).from(productMatches).where(eq(productMatches.id, id)).then((r) => r[0]!);
const decision = (id: string) => db().select().from(productMatches).where(eq(productMatches.id, id)).then((r) => Object.fromEntries(DECISION_COLUMNS.map((k) => [k, r[0]![k]])));
const events = async (kind: string, id?: string) => (await db().select().from(matchEvents).where(eq(matchEvents.orgId, org))).filter((e) => e.kind === kind && (!id || e.matchId === id));
type Cell = { variantId: string; directlyComparable: boolean; caveats: string[]; bundle?: { verdict: string; note: string } };
const comparison = async () => (await owner.get(`${base()}/comparison?pageSize=500`)).body.rows as { sourceVariantId: string; cells: Cell[] }[];
const cellOf = (rows: Awaited<ReturnType<typeof comparison>>, p: Pair) => rows.find((r) => r.sourceVariantId === p.s)?.cells.find((c) => c.variantId === p.c);
/** a row written before the policy existed: no record of either check */
const forget = (id: string) => db().update(productMatches).set({ priceExclusion: null, priceExcludedAt: null, quantityCheck: null, bundleCheck: null }).where(eq(productMatches.id, id));
const manual = async (p: Pair, note: string) => {
  const r = await owner.post(`${base()}/matches/manual`, { sourceVariantId: p.s, competitorVariantId: p.c, matchClass: 'identical', note });
  expect(r.status).toBe(201);
  p.id = r.body.match.id as string;
};

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
  await signUp(owner, h, { email: `bp-${Date.now()}@example.test`, password: 'Correct-Horse-9-Battery', displayName: 'Owner' });
  userId = (await owner.get('/api/v1/auth/me')).body.user.id;
  org = (await createOrganization(h.db.app, userId, 'Bundle policy')).id;
  const siteIds: Record<string, string> = {};
  for (const [key, role] of [['source', 'source'], ['woo', 'competitor']] as const) {
    const id = (await owner.post(`${base()}/sites`, { url: h.fixtures.origin(key), role, name: h.fixtures.sites[key]!.spec.label })).body.site.id as string;
    await owner.post(`${base()}/sites/${id}/consent`, { status: 'confirmed', attest: true });
    await startScan(h.svc, h.db.worker, org, id, { kind: 'discovery', trigger: 'manual' });
    siteIds[key] = id;
  }
  competitorSite = siteIds.woo!;
  await h.queue.drain();
  await runMatching(h.svc, db(), org);
  // one variant of each product: the pairs below retitle products, so two of them must never share one
  const distinct = <T extends { productId: string }>(rows: T[]) => { const seen = new Set<string>(); return rows.filter((r) => !seen.has(r.productId) && !!seen.add(r.productId)); };
  const src = distinct(await db().select({ id: variants.id, productId: variants.productId }).from(variants).where(eq(variants.siteId, siteIds.source!)).limit(200));
  const rival = distinct(await db().select({ id: variants.id, productId: variants.productId }).from(variants).where(eq(variants.siteId, siteIds.woo!)).limit(200));
  expect(src.length).toBeGreaterThanOrEqual(7);
  expect(rival.length).toBeGreaterThanOrEqual(8);
  ['eq', 'extra', 'single', 'count', 'unknown', 'colour', 'honey'].forEach((key, i) => { pairs[key] = { key, s: src[i]!.id, sp: src[i]!.productId, c: rival[i]!.id, cp: rival[i]!.productId }; });
  // the same source product also has a second competitor listing, with the same contents
  pairs.extra2 = { key: 'extra2', s: pairs.extra!.s, sp: pairs.extra!.sp, c: rival[7]!.id, cp: rival[7]!.productId };
  // every other suggestion is set aside, so only the pairs below exist
  await db().delete(productMatches).where(eq(productMatches.orgId, org));
  await retitle(pairs.eq!, { title: COMBO }, { title: 'Sealight H11 LED Combo: Brake Lamp and Head Lamp' });
  await retitle(pairs.extra!, { title: COMBO }, { title: 'Sealight H11 LED Headlight + Brake Light + Indicator Lights Combo' });
  await retitle(pairs.single!, { title: 'Sealight H11 LED Headlight Bulbs' }, { title: COMBO });
  await retitle(pairs.count!, { title: 'Sealight H11 LED Headlight + 2 indicator lights Combo' }, { title: 'Sealight H11 LED Headlight + 1 indicator light Combo' });
  await retitle(pairs.unknown!, { title: 'Sealight Fit for 2015-2020 Ford F-150 LED All-in-One Lighting Kit' }, { title: 'Sealight Fit for 2015-2020 Ford F-150 LED Headlight + Turn Signal + Brake Light Combo' });
  await retitle(pairs.colour!, { title: COMBO, variant: { title: 'Red', options: { Color: 'Red' } } }, { title: COMBO, variant: { title: 'Blue', options: { Color: 'Blue' } } });
  await retitle(pairs.honey!, { title: 'Acme Honey Gift Combo' }, { title: 'Acme Honey Gift Combo' }, 'Acme');
  // the second competitor listing of the "extra" source product: the same contents as its own
  await db().update(products).set({ title: COMBO, brand: 'Auxito', attrs: {} }).where(eq(products.id, pairs.extra2!.cp));
  await db().update(variants).set({ title: 'Default Title', options: {}, qtyKind: null, qtyTotal: null, qtyLabel: null }).where(eq(variants.id, pairs.extra2!.c));
}, 240_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('a person records a pair whose bundles differ', () => {
  it('the confirmation is kept, and the pair is left out of price comparison from the start, with the evidence', async () => {
    await manual(pairs.extra!, 'Checked the headlight combo');
    const row = await policyColumns(pairs.extra!.id!);
    expect(row.ex).toBe(INCOMPARABLE_BUNDLE_CONTENT_MISMATCH);
    expect(row.b).toMatchObject({ verdict: 'mismatch', exclusion: INCOMPARABLE_BUNDLE_CONTENT_MISMATCH });
    expect(row.b!.a.items).toEqual(['headlight', 'brake light']);
    expect([...row.b!.b.items].sort()).toEqual(['brake light', 'headlight', 'turn signal']);
    expect(row.b!.onlyB).toEqual(['turn signal']);
    const d = await decision(pairs.extra!.id!);
    expect(d).toMatchObject({ status: 'accepted', method: 'manual', decidedBy: userId, decisionNote: 'Checked the headlight combo' });
    expect(await events('bundle_excluded', pairs.extra!.id)).toHaveLength(1);
    expect(cellOf(await comparison(), pairs.extra!)).toBeUndefined();
  });

  it('a pair of bundles with equal contents recorded the same way is compared as usual', async () => {
    await manual(pairs.eq!, 'Same combo');
    expect((await policyColumns(pairs.eq!.id!)).ex).toBeNull();
    const cell = cellOf(await comparison(), pairs.eq!)!;
    expect(cell.directlyComparable).toBe(true);
    expect(cell.bundle?.verdict).toBe('equivalent');
  });
});

let before: Record<string, unknown> = {};
let products0 = 0;

describe('existing pairs, before anything has been recorded about them (the audit)', () => {
  it('sets up what stored pairs look like: people’s decisions, the matcher’s own confirmation, a rejection, all without a record of the policy', async () => {
    for (const k of ['unknown', 'colour', 'honey']) await manual(pairs[k]!, `Checked ${k}`);
    // a second, valid competitor listing for the same source product: confirmed by a person
    await manual(pairs.extra2!, 'The same combo from another shop');
    // the matcher confirmed a headlight against a combo on its own, before the policy existed
    const [auto] = await db().insert(productMatches).values({ orgId: org, sourceVariantId: pairs.single!.s, competitorVariantId: pairs.single!.c, competitorSiteId: competitorSite, matchClass: 'identical', confidence: 0.9, status: 'accepted', method: 'attributes', reasons: ['x'], relationship: 'exact', tier: 'medium', autoConfirmedAt: new Date(), decidedAt: new Date(), decisionNote: 'Confirmed automatically', engineVersion: ENGINE_VERSION }).returning();
    pairs.single!.id = auto!.id;
    // a person rejected one pair: that decision stands too
    const [rej] = await db().insert(productMatches).values({ orgId: org, sourceVariantId: pairs.count!.s, competitorVariantId: pairs.count!.c, competitorSiteId: competitorSite, matchClass: 'not_comparable', confidence: 0.5, status: 'rejected', method: 'attributes', reasons: ['x'], relationship: 'non_match', decidedBy: userId, decidedAt: new Date(), decisionNote: 'Different things' }).returning();
    pairs.count!.id = rej!.id;
    // every row looks as if written before the policy existed, and the history of the one the policy had already seen is cleared
    for (const p of Object.values(pairs)) await forget(p.id!);
    await db().delete(matchEvents).where(and(eq(matchEvents.orgId, org), inArray(matchEvents.kind, ['bundle_excluded', 'bundle_released'])));
    products0 = (await db().select({ id: products.id }).from(products).where(eq(products.orgId, org))).length;
    before = Object.fromEntries(await Promise.all(Object.values(pairs).map(async (p) => [p.key, await decision(p.id!)])));
    expect(Object.keys(before)).toHaveLength(8);
  });

  it('counts what it would change without writing anything', async () => {
    const a = await auditBundleContents(db(), org);
    expect(a.pairs).toBe(8);
    expect(a.assessed).toBe(7); // the honey gift combo is not lighting: the policy has nothing to say about it
    expect(a.equivalent).toBe(3); // eq, colour, extra2
    expect(a.mismatch).toBe(3); // extra, single, count
    expect(a.unknown).toBe(1);
    expect(a.mismatchByState).toMatchObject({ personAccepted: 1, autoConfirmed: 1, personRejected: 1 });
    expect(a.confirmedUnknown).toEqual({ person: 1, automatic: 0 });
    expect(a.equivalentCurrent).toBe(3);
    expect(a.newlyExcluded).toBe(3);
    expect((await policyColumns(pairs.extra!.id!)).ex).toBeNull(); // nothing written
    expect((await policyColumns(pairs.extra!.id!)).b).toBeNull();
  });

  it('writes only the policy fields: every decision, its note, its author and its time are exactly as they were, and no product is touched', async () => {
    const a = await auditBundleContents(db(), org, { apply: true });
    expect(a.newlyExcluded).toBe(3);
    for (const p of Object.values(pairs)) expect(await decision(p.id!), p.key).toEqual(before[p.key]);
    expect((await db().select({ id: products.id }).from(products).where(eq(products.orgId, org))).length).toBe(products0);
    for (const k of ['extra', 'single', 'count']) expect(await policyColumns(pairs[k]!.id!), k).toMatchObject({ ex: INCOMPARABLE_BUNDLE_CONTENT_MISMATCH, b: { verdict: 'mismatch' } });
    expect((await policyColumns(pairs.extra!.id!)).at).toBeInstanceOf(Date);
    expect((await policyColumns(pairs.count!.id!)).ex).toBe(INCOMPARABLE_BUNDLE_CONTENT_MISMATCH); // the rejection stands, the reason is recorded
    for (const k of ['eq', 'colour', 'extra2']) expect(await policyColumns(pairs[k]!.id!), k).toMatchObject({ ex: null, b: { verdict: 'equivalent' } });
    expect(await policyColumns(pairs.unknown!.id!)).toMatchObject({ ex: null, b: { verdict: 'unknown' } });
    expect(await policyColumns(pairs.honey!.id!)).toMatchObject({ ex: null, b: null });
  });

  it('records the evidence for each excluded pair: the two bundles and the difference', async () => {
    const b = (await policyColumns(pairs.single!.id!)).b!;
    expect(b.a.items).toEqual(['headlight']);
    expect(b.b.items).toEqual(['headlight', 'brake light']);
    expect(b.onlyB).toEqual(['brake light']);
    expect(b.note).toMatch(/competitor’s bundle holds headlight \+ brake light; you sell headlight on its own/);
    expect(b.note).toMatch(/includes brake light that you do not/);
    const c = (await policyColumns(pairs.count!.id!)).b!;
    expect(c.onlyA).toEqual(['2 × turn signal']);
    expect(c.onlyB).toEqual(['1 × turn signal']);
  });

  it('appends the change to each pair’s history, once, beside the person’s own decision entry', async () => {
    for (const k of ['extra', 'single', 'count']) {
      const e = await events('bundle_excluded', pairs[k]!.id);
      expect(e, k).toHaveLength(1);
      expect(e[0]!.note).toMatch(/INCOMPARABLE_BUNDLE_CONTENT_MISMATCH/);
    }
    for (const k of ['eq', 'colour', 'unknown', 'honey', 'extra2']) expect(await events('bundle_excluded', pairs[k]!.id), k).toHaveLength(0);
    expect((await events('decided', pairs.extra!.id)).length).toBeGreaterThanOrEqual(1);
  });

  it('is safe to run again: nothing changes, nothing is recorded twice', async () => {
    const a = await auditBundleContents(db(), org, { apply: true });
    expect(a.toWrite).toBe(0);
    expect(await events('bundle_excluded')).toHaveLength(3);
    for (const p of Object.values(pairs)) expect(await decision(p.id!), p.key).toEqual(before[p.key]);
  });
});

describe('what the price comparison and the review screens do afterwards', () => {
  it('mismatched bundles no longer contribute to the comparison: not a confirmed pair, not a price gap', async () => {
    const rows = await comparison();
    expect(cellOf(rows, pairs.extra!)).toBeUndefined();
    expect(cellOf(rows, pairs.single!)).toBeUndefined(); // confirmed by the matcher
    expect(cellOf(rows, pairs.count!)).toBeUndefined(); // rejected by a person
  });

  it('bundles with the same contents stay comparable, colour options included', async () => {
    const rows = await comparison();
    for (const k of ['eq', 'colour']) {
      const cell = cellOf(rows, pairs[k]!)!;
      expect(cell, k).toBeTruthy();
      expect(cell.directlyComparable).toBe(true);
      expect(cell.bundle?.verdict).toBe('equivalent');
    }
  });

  it('a source product with another valid competitor match keeps that comparison: only the invalid pair is excluded', async () => {
    const row = (await comparison()).find((r) => r.sourceVariantId === pairs.extra!.s)!;
    expect(row.cells.map((c) => c.variantId)).toEqual([pairs.extra2!.c]);
    expect(row.cells[0]!.directlyComparable).toBe(true);
    expect(row.cells[0]!.bundle?.verdict).toBe('equivalent');
  });

  it('contents that are not established are not treated as different: a person’s own confirmation still counts, and says so', async () => {
    const cell = cellOf(await comparison(), pairs.unknown!)!;
    expect(cell).toBeTruthy();
    expect(cell.bundle?.verdict).toBe('unknown');
    expect(cell.directlyComparable).toBe(true);
    expect(cell.caveats.some((c) => /Bundle contents not verified/.test(c))).toBe(true);
  });

  it('a product that is not a lighting bundle is untouched by the policy', async () => {
    const cell = cellOf(await comparison(), pairs.honey!)!;
    expect(cell).toBeTruthy();
    expect(cell.bundle).toBeUndefined();
    expect(cell.directlyComparable).toBe(true);
  });

  it('the Match review counts the left-out pairs and shows the evidence, without calling them quantity problems', async () => {
    const s = (await owner.get(`${base()}/matches/summary`)).body;
    expect(s.counts.quantityExcluded).toBe(2); // the headline pair and the matcher's own confirmation (the rejected pair is not work)
    expect(s.counts.quantityExcludedConfirmed).toBe(2);
    const list = (await owner.get(`${base()}/matches?bucket=quantity&pageSize=50`)).body.rows as { id: string; status: string; priceExclusion: string; bundleCheck: { verdict: string; onlyB: string[] } }[];
    expect(list.map((r) => r.id).sort()).toEqual([pairs.extra!.id, pairs.single!.id].sort());
    expect(list.find((r) => r.id === pairs.extra!.id)).toMatchObject({ status: 'accepted', priceExclusion: INCOMPARABLE_BUNDLE_CONTENT_MISMATCH, bundleCheck: { verdict: 'mismatch', onlyB: ['turn signal'] } });
  });
});

describe('what the matcher does with bundles (engine v2 over the same products)', () => {
  it('never suggests mismatched bundles as the same product or a substitute, never confirms them on its own, and withdraws its own earlier confirmation', async () => {
    expect((await owner.put(`${base()}/settings`, { matchingEngine: 'v2', matchingAutoConfirm: true })).status).toBe(200);
    await runMatching(h.svc, db(), org);
    // a person’s decisions are exactly as they were
    for (const k of ['eq', 'extra', 'unknown', 'colour', 'honey', 'extra2', 'count']) expect(await decision(pairs[k]!.id!), k).toEqual(before[k]);
    // the matcher’s own confirmation of a headlight against a combo is withdrawn; the reason stays recorded
    const single = await policyColumns(pairs.single!.id!);
    expect(single.ex).toBe(INCOMPARABLE_BUNDLE_CONTENT_MISMATCH);
    const row = (await db().select().from(productMatches).where(eq(productMatches.id, pairs.single!.id!)))[0]!;
    expect(row.autoConfirmedAt).toBeNull();
    expect(row.status).not.toBe('accepted');
    // (a pair the matcher no longer proposes is set aside and keeps its old label as history; a live one is never labelled as comparable)
    if (row.supersededAt === null) expect(['exact', 'variant', 'substitute']).not.toContain(row.relationship);
    expect(await events('auto_withdrawn', pairs.single!.id)).toHaveLength(1);
    // across everything the run proposed among these products: a mismatch is excluded and never automatic or comparable
    const all = await db().select().from(productMatches).where(eq(productMatches.orgId, org));
    const mine = new Set(Object.values(pairs).flatMap((p) => [p.s, p.c]));
    let mismatches = 0;
    for (const r of all.filter((m) => mine.has(m.sourceVariantId) && mine.has(m.competitorVariantId))) {
      if (r.bundleCheck?.verdict === 'mismatch') {
        mismatches++;
        expect(r.priceExclusion, r.id).toBe(INCOMPARABLE_BUNDLE_CONTENT_MISMATCH);
        if (r.decidedBy === null) {
          expect(r.autoConfirmedAt, r.id).toBeNull();
          expect(r.status, r.id).not.toBe('accepted');
          if (r.supersededAt === null) expect(['exact', 'variant', 'substitute'], r.id).not.toContain(r.relationship);
        }
      }
      if (r.bundleCheck?.verdict === 'equivalent') expect(r.priceExclusion, r.id).toBeNull();
    }
    expect(mismatches).toBeGreaterThanOrEqual(3);
  });

  it('a second run changes nothing a person decided', async () => {
    await runMatching(h.svc, db(), org);
    for (const k of ['eq', 'extra', 'unknown', 'colour', 'honey', 'extra2', 'count']) expect(await decision(pairs[k]!.id!), k).toEqual(before[k]);
    expect(await events('bundle_excluded', pairs.extra!.id)).toHaveLength(1);
  });
});
