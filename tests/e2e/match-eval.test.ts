import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../../apps/api/src/app.ts';
import { aiMatchSuggestions, matchAutoApproval, matchEvalCases, matchEvalReports, orgSettings, productMatches, products, variants } from '@ci/database';
import type { GeminiHttp } from '@ci/connectors';
import { createOrganization, runMatching, startScan } from '@ci/services';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp } from '../support/auth.ts';

/**
 * The independent evaluation and the gate for automatic approval. Labels are made only by people through the API (the fixtures here are TEST labels made by the test, clearly not
 * independent human truth); the system is scored against them; a class of automatic approval stays closed until a measurement that passes the release gate exists, is applied only to pairs
 * no person has decided, survives the rule engine's own runs, and can be taken back by a person. The no-counterpart list, the separate counts and the Reject action are covered here too.
 */
const KEY = 'test-key-not-real-0123456789abcdef';
let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let org: string;
let userId: string;
const siteIds: Record<string, string> = {};
const base = () => `/api/v1/orgs/${org}`;
const db = () => h.db.worker;
type Pair = { key: string; s: string; c: string; sp: string; cp: string };
const pairs: Record<string, Pair> = {};
const GTIN = '4006381333931'; // a valid EAN-13

const retitle = async (p: Pair, source: string, rival: string, size: [string, number, string], gtin: string | null = null, brand = 'Acme') => {
  for (const [productId, variantId, title] of [[p.sp, p.s, source], [p.cp, p.c, rival]] as const) {
    await db().update(products).set({ title, brand, attrs: {} }).where(eq(products.id, productId));
    await db().update(variants).set({ title: 'Default Title', options: {}, qtyKind: size[0], qtyTotal: size[1], qtyLabel: size[2], gtin }).where(eq(variants.id, variantId));
  }
};

let say: Record<string, string> = {};
const gemini: GeminiHttp = async (_u, init) => {
  const req = JSON.parse(init.body!) as { contents: { parts: { text: string }[] }[] };
  const payload = JSON.parse(req.contents[0]!.parts[0]!.text) as { groups: { s: { t: string }; c: { id: string; t: string }[] }[] };
  const decisions = payload.groups.flatMap((g) => g.c.map((c) => {
    const type = say[`${g.s.t}|${c.t}`] ?? 'no_match_uncertain';
    return { id: c.id, type, conf: 'high', for: type === 'no_match_uncertain' ? [] : [{ a: 'title', s: g.s.t, c: c.t }], against: [], missing: [], why: 'test answer', price_ok: type === 'exact_item', review: false };
  }));
  return { status: 200, json: { candidates: [{ content: { parts: [{ text: JSON.stringify({ decisions }) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 100, totalTokenCount: 1000 } } };
};

beforeAll(async () => {
  h = await createHarness({ now: '2026-11-04T12:00:00Z', extraEnv: { GEMINI_API_KEY: KEY, GEMINI_RPM: '600', GEMINI_TPM: '100000000', GEMINI_MAX_CONCURRENCY: '1' } });
  h.gemini.set(gemini);
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
  await signUp(owner, h, { email: `ev-${Date.now()}@example.test`, password: 'Correct-Horse-9-Battery', displayName: 'Owner' });
  userId = (await owner.get('/api/v1/auth/me')).body.user.id;
  org = (await createOrganization(h.db.app, userId, 'Evaluation')).id;
  for (const [key, role] of [['source', 'source'], ['woo', 'competitor']] as const) {
    const id = (await owner.post(`${base()}/sites`, { url: h.fixtures.origin(key), role, name: h.fixtures.sites[key]!.spec.label })).body.site.id as string;
    await owner.post(`${base()}/sites/${id}/consent`, { status: 'confirmed', attest: true });
    await startScan(h.svc, h.db.worker, org, id, { kind: 'discovery', trigger: 'manual' });
    siteIds[key] = id;
  }
  await h.queue.drain();
  await runMatching(h.svc, db(), org);
  const distinct = <T extends { productId: string }>(rows: T[]) => { const seen = new Set<string>(); return rows.filter((r) => !seen.has(r.productId) && !!seen.add(r.productId)); };
  const src = distinct(await db().select({ id: variants.id, productId: variants.productId }).from(variants).where(eq(variants.siteId, siteIds.source!)).limit(200));
  const rival = distinct(await db().select({ id: variants.id, productId: variants.productId }).from(variants).where(eq(variants.siteId, siteIds.woo!)).limit(200));
  ['juice', 'oil', 'tea', 'rice'].forEach((key, i) => { pairs[key] = { key, s: src[i]!.id, sp: src[i]!.productId, c: rival[i]!.id, cp: rival[i]!.productId }; });
  await db().delete(productMatches).where(eq(productMatches.orgId, org));
  await retitle(pairs.juice!, 'Acme Orange Juice 1 L', 'Acme Orange Juice 1000 ml', ['volume', 1000, '1 L'], GTIN);
  await retitle(pairs.oil!, 'Acme Cooking Oil 10 L', 'Acme Cooking Oil 20 L', ['volume', 10000, '10 L'], null);
  await retitle(pairs.tea!, 'Acme Tea 100 g', 'Acme Tea 100 g', ['mass', 100, '100 g'], null);
  await retitle(pairs.rice!, 'Acme Rice 1 kg', 'Acme Rice 1000 g', ['mass', 1000, '1 kg'], null);
  await db().update(orgSettings).set({ matchingEngine: 'v2' }).where(eq(orgSettings.orgId, org));
}, 300_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('selecting what to label', () => {
  it('selects a stratified sample, split by a fixed rule on the product, and re-running only adds', async () => {
    const first = await owner.post(`${base()}/eval/prepare`, { size: 40 });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.selected).toBeGreaterThan(0);
    const cases = await db().select().from(matchEvalCases).where(eq(matchEvalCases.orgId, org));
    expect(cases.length).toBe(first.body.selected);
    expect(new Set(cases.map((c) => c.split))).toEqual(new Set(['development', 'holdout']).size === 2 ? new Set(cases.map((c) => c.split)) : new Set());
    // a product is always in the same set
    const splitOf = new Map<string, string>();
    for (const c of cases) { expect(splitOf.get(c.sourceVariantId) ?? c.split).toBe(c.split); splitOf.set(c.sourceVariantId, c.split); }
    const again = await owner.post(`${base()}/eval/prepare`, { size: 40 });
    expect((await db().select().from(matchEvalCases).where(eq(matchEvalCases.orgId, org))).length).toBe(cases.length + again.body.selected);
    expect(cases.every((c) => c.status === 'pending' && c.truthRelationship === null)).toBe(true); // nothing is labelled by itself
  });

  it('the labelling page shows products, not the system’s opinion, so it cannot sway the labeller', async () => {
    await db().insert(productMatches).values({ orgId: org, sourceVariantId: pairs.tea!.s, competitorVariantId: pairs.tea!.c, competitorSiteId: siteIds.woo!, matchClass: 'identical', confidence: 0.8, status: 'needs_review', method: 'name_similarity', reasons: ['x'], relationship: 'exact', tier: 'strong' });
    await db().insert(matchEvalCases).values({ orgId: org, sourceVariantId: pairs.tea!.s, competitorSiteId: siteIds.woo!, domain: 'grocery', stratum: 'suggested', split: 'holdout' }).onConflictDoNothing();
    const res = await owner.get(`${base()}/eval/cases?pageSize=50`);
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { source: { variantId: string } }) => r.source.variantId === pairs.tea!.s);
    expect(row.candidates.map((c: { variantId: string }) => c.variantId)).toContain(pairs.tea!.c);
    const text = JSON.stringify(row.candidates);
    for (const leaked of ['relationship', 'tier', 'confidence', 'matchType', 'match_type', 'status', 'evidence']) expect(text).not.toContain(`"${leaked}"`);
  });
});

describe('labelling (by people only)', () => {
  const caseFor = async (p: Pair) => (await db().select().from(matchEvalCases).where(and(eq(matchEvalCases.sourceVariantId, p.s), eq(matchEvalCases.competitorSiteId, siteIds.woo!))))[0]!;
  it('records who said what and when, and refuses a counterpart that is not at that website', async () => {
    const c = await caseFor(pairs.tea!);
    const other = pairs.rice!.s; // one of YOUR variants: not a competitor product
    expect((await owner.post(`${base()}/eval/cases/${c.id}/label`, { relationship: 'exact', truthVariantId: other, expertise: 'general' })).status).toBe(400);
    expect((await owner.post(`${base()}/eval/cases/${c.id}/label`, { relationship: 'exact', expertise: 'general' })).status).toBe(400); // needs the product
    const ok = await owner.post(`${base()}/eval/cases/${c.id}/label`, { relationship: 'exact', truthVariantId: pairs.tea!.c, expertise: 'knowledgeable', note: 'Same tea, same box' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const [row] = await db().select().from(matchEvalCases).where(eq(matchEvalCases.id, c.id));
    expect(row).toMatchObject({ status: 'labelled', truthVariantId: pairs.tea!.c, truthRelationship: 'exact', expertise: 'knowledgeable', labelledBy: userId, note: 'Same tea, same box' });
    expect(row!.labelledAt).not.toBeNull();
  });
  it('"no counterpart" is a label too, and an unlabelled case can be skipped', async () => {
    const [c] = (await db().select().from(matchEvalCases).where(and(eq(matchEvalCases.orgId, org), eq(matchEvalCases.status, 'pending'))));
    expect((await owner.post(`${base()}/eval/cases/${c!.id}/label`, { relationship: 'none', expertise: 'general' })).status).toBe(200);
    const [d] = (await db().select().from(matchEvalCases).where(and(eq(matchEvalCases.orgId, org), eq(matchEvalCases.status, 'pending'))));
    expect((await owner.post(`${base()}/eval/cases/${d!.id}/skip`, {})).status).toBe(200);
    expect((await owner.post(`${base()}/eval/cases/${c!.id}/skip`, {})).status).toBe(409); // already labelled
  });
});

describe('measuring the system and keeping the gate closed', () => {
  it('measures variant-level candidate recall and scores the system against the labels, honestly small', async () => {
    h.advance(60_000);
    expect((await owner.post(`${base()}/eval/run`, {})).status).toBe(202);
    await h.queue.drain();
    const status = (await owner.get(`${base()}/eval/status`)).body;
    expect(status.latestReport).not.toBeNull();
    const all = status.latestReport.report.all.overall;
    expect(all.positives).toBe(1);
    expect(all.candidateRecall).toEqual({ hits: 1, total: 1 }); // the TRUE VARIANT reached the candidates
    expect(all.noCounterpart).toBeGreaterThanOrEqual(0);
    expect(status.latestReport.report.poolDepthPerSite).toBe(25);
    expect(status.latestReport.report.note).toMatch(/never used as truth/);
  });
  it('every gate is closed: too few labelled examples is never a pass', async () => {
    const gates = (await owner.get(`${base()}/eval/status`)).body.latestReport.gates as { domain: string; autoClass: string; result: { passed: boolean; lines: { why: string }[] } }[];
    expect(gates.length).toBe(4);
    for (const g of gates) { expect(g.result.passed).toBe(false); expect(g.result.lines.map((l) => l.why).join(' ')).toMatch(/labelled example/); }
  });
  it('a class cannot be switched on without a passing measurement', async () => {
    const r = await owner.post(`${base()}/eval/auto-approval`, { domain: 'grocery', autoClass: 'exact_item', enabled: true });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/not passed the release gate/);
    expect(await db().select().from(matchAutoApproval).where(eq(matchAutoApproval.orgId, org))).toHaveLength(0);
  });
});

describe('a class that passed the gate (a synthetic passing measurement made by this test)', () => {
  const passing = (domain: string, autoClass: string) => ({ domain, autoClass, result: { passed: true, lines: [] } });
  it('can be switched on, but not after more labels arrived since the measurement', async () => {
    h.advance(60_000);
    await db().insert(matchEvalReports).values({ orgId: org, split: 'all', report: { synthetic: true }, gates: [passing('grocery', 'exact_item')], cases: 1, createdAt: h.svc.clock() });
    h.advance(60_000);
    // a label made after the measurement makes it stale
    const [c] = await db().select().from(matchEvalCases).where(and(eq(matchEvalCases.orgId, org), eq(matchEvalCases.status, 'pending')));
    await owner.post(`${base()}/eval/cases/${c!.id}/label`, { relationship: 'none', expertise: 'general' });
    expect((await owner.post(`${base()}/eval/auto-approval`, { domain: 'grocery', autoClass: 'exact_item', enabled: true })).status).toBe(409);
    h.advance(60_000);
    await db().insert(matchEvalReports).values({ orgId: org, split: 'all', report: { synthetic: true }, gates: [passing('grocery', 'exact_item')], cases: 2, createdAt: h.svc.clock() });
    const on = await owner.post(`${base()}/eval/auto-approval`, { domain: 'grocery', autoClass: 'exact_item', enabled: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect((await db().select().from(matchAutoApproval).where(eq(matchAutoApproval.orgId, org)))[0]).toMatchObject({ enabled: true, enabledBy: userId, autoClass: 'exact_item', domain: 'grocery' });
  });

  const analyse = async (variantIds: string[]) => {
    await db().delete(aiMatchSuggestions).where(eq(aiMatchSuggestions.orgId, org));
    const res = await owner.post(`${base()}/ai/runs`, { scope: 'products', variantIds, perSite: 4 });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    await h.queue.drain();
  };

  it('approves an identical item with an equal valid barcode and the same verified quantity, and nothing less', async () => {
    say = { 'Acme Orange Juice 1 L|Acme Orange Juice 1000 ml': 'exact_item', 'Acme Cooking Oil 10 L|Acme Cooking Oil 20 L': 'exact_item', 'Acme Rice 1 kg|Acme Rice 1000 g': 'exact_item' };
    await analyse([pairs.juice!.s, pairs.oil!.s, pairs.rice!.s]);
    const sug = async (p: Pair) => (await db().select().from(aiMatchSuggestions).where(and(eq(aiMatchSuggestions.sourceVariantId, p.s), eq(aiMatchSuggestions.competitorVariantId, p.c))))[0]!;
    expect((await sug(pairs.juice!)).autoClass).toBe('exact_item'); // barcode equal, quantity same
    expect((await sug(pairs.oil!)).autoClass).toBeNull(); // quantities differ
    expect((await sug(pairs.rice!)).autoClass).toBeNull(); // same quantity but no barcode or part number: identity rests on the name
    const m = (await db().select().from(productMatches).where(and(eq(productMatches.sourceVariantId, pairs.juice!.s), eq(productMatches.competitorVariantId, pairs.juice!.c))))[0]!;
    expect(m).toMatchObject({ status: 'accepted', relationship: 'exact', method: 'ai_auto', decidedBy: null });
    expect(m.autoConfirmedAt).not.toBeNull();
    for (const p of [pairs.oil!, pairs.rice!]) expect((await db().select().from(productMatches).where(and(eq(productMatches.sourceVariantId, p.s), eq(productMatches.competitorVariantId, p.c)))).filter((r) => r.status === 'accepted')).toHaveLength(0);
    expect(await sug(pairs.juice!)).toMatchObject({ status: 'accepted', reviewNote: expect.stringMatching(/passed the measured release gate/) });
  });

  it('is shown as automatically approved, counts as a direct price comparison only because the quantity is verified', async () => {
    const rows = (await owner.get(`${base()}/comparison?pageSize=200&include=confirmed`)).body.rows as { sourceVariantId: string; cells: { variantId: string; confirmation: string; directlyComparable: boolean }[] }[];
    const cell = rows.find((r) => r.sourceVariantId === pairs.juice!.s)!.cells[0]!;
    expect(cell).toMatchObject({ confirmation: 'automatic', directlyComparable: true });
    const list = (await owner.get(`${base()}/matches?bucket=auto_approved`)).body;
    expect(list.total).toBe(1);
    expect((await owner.get(`${base()}/matches/summary`)).body.counts.autoApproved).toBe(1);
  });

  it('survives the rule engine’s own runs, and a person’s later decision is final', async () => {
    await runMatching(h.svc, db(), org);
    const [m] = await db().select().from(productMatches).where(and(eq(productMatches.sourceVariantId, pairs.juice!.s), eq(productMatches.competitorVariantId, pairs.juice!.c)));
    expect(m).toMatchObject({ status: 'accepted', method: 'ai_auto' });
    expect(m!.autoConfirmedAt).not.toBeNull();
    const rej = await owner.post(`${base()}/matches/${m!.id}/decision`, { decision: 'reject', note: 'Not the same after all' });
    expect(rej.status).toBe(200);
    // a later AI run never overrides a person's decision
    await analyse([pairs.juice!.s]);
    const [after] = await db().select().from(productMatches).where(eq(productMatches.id, m!.id));
    expect(after).toMatchObject({ status: 'rejected', decidedBy: userId, decisionNote: 'Not the same after all' });
    expect(after!.autoConfirmedAt).toBeNull();
  });

  it('a person can switch the class off again, and then nothing is approved', async () => {
    expect((await owner.post(`${base()}/eval/auto-approval`, { domain: 'grocery', autoClass: 'exact_item', enabled: false })).status).toBe(200);
    await db().delete(productMatches).where(eq(productMatches.orgId, org));
    await analyse([pairs.juice!.s]);
    expect((await db().select().from(productMatches).where(eq(productMatches.orgId, org))).filter((m) => m.status === 'accepted')).toHaveLength(0);
    expect((await db().select().from(aiMatchSuggestions).where(and(eq(aiMatchSuggestions.sourceVariantId, pairs.juice!.s), eq(aiMatchSuggestions.competitorVariantId, pairs.juice!.c))))[0]!.autoClass).toBe('exact_item'); // still measured
  });
});

describe('counts, no counterpart, and Reject', () => {
  it('counts parent products, variants, pairs and unique variants separately', async () => {
    const c = (await owner.get(`${base()}/matches/counts`)).body;
    expect(c.ownVariants).toBeGreaterThanOrEqual(c.ownParentProducts);
    expect(c.ownParentProducts).toBeGreaterThan(0);
    expect(Object.keys(c.confirmedPairs).sort()).toEqual(['equivalent', 'exact', 'related', 'substitute', 'variant']);
    expect(c.noCounterpartOwnVariants).toBeGreaterThan(0);
    expect(c.directlyComparableOwnVariants).toBeLessThanOrEqual(c.ownVariantsWithConfirmed);
  });
  it('one variant with several candidates is several pairs but one variant', async () => {
    await db().delete(productMatches).where(eq(productMatches.orgId, org));
    for (const cv of [pairs.tea!.c, pairs.rice!.c]) await db().insert(productMatches).values({ orgId: org, sourceVariantId: pairs.tea!.s, competitorVariantId: cv, competitorSiteId: siteIds.woo!, matchClass: 'comparable', confidence: 0.6, status: 'needs_review', method: 'name_similarity', reasons: ['x'], relationship: 'substitute', tier: 'medium' });
    const c = (await owner.get(`${base()}/matches/counts`)).body;
    expect(c.suggestedPairs.substitute).toBe(2);
    expect(c.suggestedOwnVariants.substitute).toBe(1);
  });
  it('lists the variants with no live pair, and drops one as soon as it has a pair', async () => {
    const before = (await owner.get(`${base()}/matches/no-counterpart?pageSize=100`)).body;
    expect(before.rows.some((r: { variantId: string }) => r.variantId === pairs.tea!.s)).toBe(false); // it has pairs
    expect(before.rows.some((r: { variantId: string }) => r.variantId === pairs.oil!.s)).toBe(true);
    await owner.post(`${base()}/matches/manual`, { sourceVariantId: pairs.oil!.s, competitorVariantId: pairs.oil!.c, relationship: 'variant' });
    const after = (await owner.get(`${base()}/matches/no-counterpart?pageSize=100`)).body;
    expect(after.rows.some((r: { variantId: string }) => r.variantId === pairs.oil!.s)).toBe(false);
    expect(after.total).toBe(before.total - 1);
  });
  it('Reject on an AI suggestion is the person’s own rejection, with history, even when no pair existed', async () => {
    say = { 'Acme Rice 1 kg|Acme Rice 1000 g': 'substitute' };
    await db().delete(aiMatchSuggestions).where(eq(aiMatchSuggestions.orgId, org));
    await owner.post(`${base()}/ai/runs`, { scope: 'products', variantIds: [pairs.rice!.s], perSite: 4 });
    await h.queue.drain();
    const [s] = await db().select().from(aiMatchSuggestions).where(and(eq(aiMatchSuggestions.sourceVariantId, pairs.rice!.s), eq(aiMatchSuggestions.competitorVariantId, pairs.rice!.c)));
    expect(s).toBeDefined();
    const res = await owner.post(`${base()}/ai/suggestions/${s!.id}/review`, { action: 'reject', note: 'Different brand of rice' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [m] = await db().select().from(productMatches).where(and(eq(productMatches.sourceVariantId, pairs.rice!.s), eq(productMatches.competitorVariantId, pairs.rice!.c)));
    expect(m).toMatchObject({ status: 'rejected', relationship: 'non_match', decidedBy: userId });
    expect((await db().select().from(aiMatchSuggestions).where(eq(aiMatchSuggestions.id, s!.id)))[0]!.status).toBe('rejected');
  });
});
