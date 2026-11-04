import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { buildApp } from '../../apps/api/src/app.ts';
import { aiDossiers, aiMatchFeedback, aiMatchRuns, aiMatchSuggestions, aiQuotaState, aiUsageDaily, auditEvents, productMatches, products, variants } from '@ci/database';
import type { GeminiHttp } from '@ci/connectors';
import { AI_PROMPT_VERSION } from '@ci/core';
import { aiResumeTick, aiStatus, createAiRun, createOrganization, MatchError, processAiRun, runMatching, startScan } from '@ci/services';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp } from '../support/auth.ts';

/**
 * AI-assisted matching against an IMITATION of the Gemini API (no test ever reaches Google). What is proved here: a run is a worker job that stores suggestions in its own tables and changes
 * nothing a person decided or any price; the safeguards keep the quantity and bundle policies in force whatever the model says; unchanged pairs are never asked again; quota answers
 * pause the work instead of failing it and a non-free-tier quota stops it; a person's Accept / Change / Uncertain / None of these / Find another product goes through the existing
 * human-decision functions; and the API key never appears in a response, a stored record or an address.
 */
const KEY = 'test-key-not-real-0123456789abcdef';
let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let org: string;
let userId: string;
const base = () => `/api/v1/orgs/${org}`;
const db = () => h.db.worker;

type Pair = { key: string; s: string; c: string; sp: string; cp: string };
const pairs: Record<string, Pair> = {};
const TITLES: Record<string, [string, string]> = {};
let lampMatchId = '';

// ── imitation Gemini ──────────────────────────────────────────────────────────────────────────────────────────────
type Wire = { t: string; brand?: string; chk?: { q: string; b?: string } };
/** What the imitation says for a (source title, candidate title). Everything else: nothing suitable. */
let verdicts: Record<string, string> = {};
const ok = (decisions: unknown[], usage = { promptTokenCount: 1200, candidatesTokenCount: 110 * Math.max(1, decisions.length) }) => ({
  status: 200,
  json: { candidates: [{ content: { parts: [{ text: JSON.stringify({ decisions }) }] }, finishReason: 'STOP' }], usageMetadata: { ...usage, totalTokenCount: usage.promptTokenCount + usage.candidatesTokenCount } },
});
const decisionsOf = (init: { body?: string }) => {
  const req = JSON.parse(init.body!) as { contents: { parts: { text: string }[] }[] };
  const payload = JSON.parse(req.contents[0]!.parts[0]!.text) as { groups: { g: number; s: Wire; c: (Wire & { id: string })[] }[] };
  return payload.groups.flatMap((g) =>
    g.c.map((c) => {
      const type = verdicts[`${g.s.t}|${c.t}`] ?? 'no_match_uncertain';
      return { id: c.id, type, conf: 'high', for: type === 'no_match_uncertain' ? [] : [{ a: 'title', s: g.s.t, c: c.t }], against: [], missing: [], why: `${g.s.t} against ${c.t}`, price_ok: type === 'exact_item', review: false };
    }),
  );
};
const gemini: GeminiHttp = async (_url, init) => ok(decisionsOf(init));
const quotaError = (id: string, value: number, retry = '1s', metric = 'generativelanguage.googleapis.com/generate_content_free_tier_requests') => ({
  status: 429,
  json: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: id, quotaMetric: metric, quotaValue: String(value) }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: retry }] } },
});

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────
const retitle = async (p: Pair, source: string, rival: string, size: { s?: [string, number, string]; c?: [string, number, string] } = {}, brand = 'Acme') => {
  TITLES[p.key] = [source, rival];
  for (const [productId, variantId, title, sz] of [[p.sp, p.s, source, size.s], [p.cp, p.c, rival, size.c]] as const) {
    await db().update(products).set({ title, brand, attrs: {} }).where(eq(products.id, productId));
    await db().update(variants).set({ title: 'Default Title', options: {}, qtyKind: sz?.[0] ?? null, qtyTotal: sz?.[1] ?? null, qtyLabel: sz?.[2] ?? null }).where(eq(variants.id, variantId));
  }
};
const suggestion = async (p: Pair) => (await db().select().from(aiMatchSuggestions).where(and(eq(aiMatchSuggestions.sourceVariantId, p.s), eq(aiMatchSuggestions.competitorVariantId, p.c))))[0];
const allSuggestions = () => db().select().from(aiMatchSuggestions).where(eq(aiMatchSuggestions.orgId, org));
const matchRows = () => db().select().from(productMatches).where(eq(productMatches.orgId, org));
const comparison = async () => (await owner.get(`${base()}/comparison?pageSize=500`)).body;
const sourceIds = () => Object.values(pairs).map((p) => p.s);
const startRun = async (extra: Record<string, unknown> = {}) => {
  const res = await owner.post(`${base()}/ai/runs`, { scope: 'products', variantIds: [...new Set(sourceIds())], perSite: 4, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return res.body.run.id as string;
};
const runNow = async (id: string) => (await db().select().from(aiMatchRuns).where(eq(aiMatchRuns.id, id)))[0]!;
const finish = async (id: string) => { await h.queue.drain(); return runNow(id); };
const ask = async (url: string, method: 'get' | 'post' = 'get', body?: unknown) => (method === 'get' ? owner.get(url) : owner.post(url, body));

beforeAll(async () => {
  h = await createHarness({ now: '2026-11-04T12:00:00Z', extraEnv: { GEMINI_API_KEY: KEY, GEMINI_RPM: '600', GEMINI_TPM: '100000000', GEMINI_MAX_CONCURRENCY: '1' } });
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
  await signUp(owner, h, { email: `ai-${Date.now()}@example.test`, password: 'Correct-Horse-9-Battery', displayName: 'Owner' });
  userId = (await owner.get('/api/v1/auth/me')).body.user.id;
  org = (await createOrganization(h.db.app, userId, 'AI matching')).id;
  const siteIds: Record<string, string> = {};
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
  expect(src.length).toBeGreaterThanOrEqual(8);
  expect(rival.length).toBeGreaterThanOrEqual(9);
  ['exact', 'oil', 'honey', 'combo', 'single', 'lamp', 'soap', 'other'].forEach((key, i) => { pairs[key] = { key, s: src[i]!.id, sp: src[i]!.productId, c: rival[i]!.id, cp: rival[i]!.productId }; });
  // only the pairs below exist as the engine's own suggestions; a run writes to the AI tables alone, so these rows must come out of it byte for byte
  await db().delete(productMatches).where(eq(productMatches.orgId, org));
  await retitle(pairs.exact!, 'Acme Orange Juice 1 L', 'Acme Orange Juice 1000 ml', { s: ['volume', 1000, '1 L'], c: ['volume', 1000, '1000 ml'] });
  await retitle(pairs.oil!, 'Acme Cooking Oil 10 L', 'Acme Cooking Oil 20 L', { s: ['volume', 10000, '10 L'], c: ['volume', 20000, '20 L'] });
  await retitle(pairs.honey!, 'Acme Wild Honey', 'Acme Wild Honey');
  await retitle(pairs.combo!, 'Sealight H11 LED Headlight + Brake Light Combo', 'Sealight H11 LED Headlight + Brake Light + Indicator Lights Combo', {}, 'Sealight');
  await retitle(pairs.single!, 'Sealight H11 LED Headlight Bulbs', 'Sealight H11 LED Headlight + Brake Light Combo', {}, 'Sealight');
  await retitle(pairs.lamp!, 'Sealight H11 LED Headlight Bulbs', 'Sealight H11 LED Headlight Bulbs Pair', {}, 'Sealight');
  await retitle(pairs.soap!, 'Acme Soap Bar', 'Acme Soap Liquid', {}, 'Acme');
  await retitle(pairs.other!, 'Acme Basmati Rice 1 kg', 'Acme Basmati Rice 5 kg', { s: ['mass', 1000, '1 kg'], c: ['mass', 5000, '5 kg'] });
  const [engineRow] = await db().insert(productMatches).values({ orgId: org, sourceVariantId: pairs.lamp!.s, competitorVariantId: pairs.lamp!.c, competitorSiteId: siteIds.woo!, matchClass: 'comparable', confidence: 0.6, status: 'needs_review', method: 'name_similarity', reasons: ['x'], relationship: 'substitute', tier: 'medium' }).returning();
  lampMatchId = engineRow!.id;
  verdicts = {
    [TITLES.exact!.join('|')]: 'exact_item',
    [TITLES.oil!.join('|')]: 'exact_item', // the model is wrong: different quantities. The safeguards must not let it stand.
    [TITLES.honey!.join('|')]: 'exact_item', // no quantity stated anywhere
    [TITLES.combo!.join('|')]: 'exact_item', // verified different bundle contents
    [TITLES.single!.join('|')]: 'close_equivalent', // a single bulb against a combo
    [TITLES.lamp!.join('|')]: 'close_equivalent',
    [TITLES.soap!.join('|')]: 'related',
    [TITLES.other!.join('|')]: 'same_product_different_pack',
  };
}, 300_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

beforeEach(() => {
  h.gemini.set(gemini);
  h.advance(5 * 60_000); // time only moves forward, as it does for the real limiter
});

/** A clean slate for a test about quota: no open run, no record of use or of what Google taught, no earlier calls. */
const resetQuota = async () => {
  await db().update(aiMatchRuns).set({ status: 'cancelled' }).where(and(eq(aiMatchRuns.orgId, org), inArray(aiMatchRuns.status, ['queued', 'running', 'paused'])));
  await db().delete(aiQuotaState);
  await db().delete(aiUsageDaily);
  h.gemini.calls.length = 0;
};

describe('setup', () => {
  it('cannot start without a configured key, and says so', async () => {
    await expect(createAiRun(db(), { ...h.svc.config, GEMINI_API_KEY: undefined }, org, userId, { scope: 'sample' })).rejects.toBeInstanceOf(MatchError);
    const status = await aiStatus(db(), { ...h.svc.config, GEMINI_API_KEY: undefined }, org, h.svc.clock());
    expect(status).toMatchObject({ configured: false, state: 'not_configured' });
    expect(status.note).toMatch(/without it/);
  });

  it('the status reports the setup without the key', async () => {
    const res = await ask(`${base()}/ai/status`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: true, model: 'gemini-3.5-flash-lite', state: 'idle' });
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(res.body.limits.rpm).toBe(600);
  });
});

describe('a shadow analysis', () => {
  let before: { matches: string; comparison: string };
  let runId: string;

  it('is a worker job: starting it answers at once and asks Gemini nothing until the worker runs', async () => {
    before = { matches: JSON.stringify(await matchRows()), comparison: JSON.stringify((await comparison()).rows) };
    runId = await startRun();
    expect(h.gemini.calls).toHaveLength(0);
    expect(h.queue.pending.map((p) => p.name)).toContain('ai-match');
    expect((await runNow(runId)).status).toBe('queued');
  });

  it('stores suggestions in its own tables, with the model, the prompt version and the evidence', async () => {
    const run = await finish(runId);
    expect(run.status, run.error ?? '').toBe('completed');
    expect(run.cursor).toBe(run.sourceIds.length);
    expect(h.gemini.calls.length).toBeGreaterThan(0);
    const rows = await allSuggestions();
    expect(rows.length).toBeGreaterThan(0);
    const s = (await suggestion(pairs.exact!))!;
    expect(s).toMatchObject({ matchType: 'exact_item', aiMatchType: 'exact_item', model: 'gemini-3.5-flash-lite', promptVersion: AI_PROMPT_VERSION, status: 'pending' });
    expect(s.supporting[0]).toMatchObject({ attribute: 'title', grounded: true });
    expect(s.foundBy.length).toBeGreaterThan(0);
    expect(s.explanation).toContain('Acme Orange Juice');
    expect(s.policy.quantity?.verdict).toBe('same');
    expect(s.priceComparable).toBe(true);
    // what the model was shown is kept per product
    expect((await db().select().from(aiDossiers).where(eq(aiDossiers.variantId, pairs.exact!.s))).length).toBe(1);
  });

  it('changes nothing a person can see: matches, decisions and the price comparison are exactly as they were', async () => {
    expect(JSON.stringify(await matchRows())).toBe(before.matches);
    expect(JSON.stringify((await comparison()).rows)).toBe(before.comparison);
  });

  it('keeps the quantity policy in force whatever the model says', async () => {
    const oil = (await suggestion(pairs.oil!))!;
    expect(oil.aiMatchType).toBe('exact_item'); // what the model said
    expect(oil.matchType).toBe('same_product_different_pack'); // what is allowed to stand
    expect(oil.priceComparable).toBe(false);
    expect(oil.guards.map((g) => g.code)).toContain('quantity_different');
    expect(oil.requiresReview).toBe(true);
    const honey = (await suggestion(pairs.honey!))!;
    expect(honey.priceComparable).toBe(false); // an unknown quantity is never assumed equal
    expect(honey.guards.map((g) => g.code)).toContain('quantity_unknown');
    expect(honey.confidence).not.toBe('high');
  });

  it('keeps the bundle policy in force: a verified bundle mismatch is never an exact item and never price-comparable', async () => {
    const combo = (await suggestion(pairs.combo!))!;
    expect(combo.aiMatchType).toBe('exact_item');
    expect(['related', 'no_match_uncertain']).toContain(combo.matchType);
    expect(combo.priceComparable).toBe(false);
    expect(combo.guards.map((g) => g.code).some((c) => c === 'bundle_mismatch' || c === 'bundle_unknown')).toBe(true);
    expect(combo.policy.bundle).not.toBeNull();
  });

  it('records usage: requests, tokens and what was served from the cache', async () => {
    const status = (await ask(`${base()}/ai/status`)).body;
    expect(status.today.requests).toBe(h.gemini.calls.length);
    expect(status.today.inputTokens).toBeGreaterThan(0);
    expect(status.today.outputTokens).toBeGreaterThan(0);
    const run = (await ask(`${base()}/ai/runs/${runId}`)).body.run;
    expect(run.usage.requests).toBe(h.gemini.calls.length);
    expect(run.usage.inputTokens).toBe(1200 * h.gemini.calls.length);
    expect(run.progress.sourcesDone).toBe(run.progress.sources);
    expect(run.progress.answered).toBeGreaterThan(0);
  });

  it('the key is only ever sent as a header: never in an address, a body, a response or a stored record', async () => {
    for (const c of h.gemini.calls) {
      expect(c.url).not.toContain(KEY);
      expect(c.body).not.toContain(KEY);
      expect(c.headers['x-goog-api-key']).toBe(KEY);
    }
    const bodies = [(await ask(`${base()}/ai/status`)).body, (await ask(`${base()}/ai/runs`)).body, (await ask(`${base()}/ai/suggestions?decided=all&status=all&pageSize=100`)).body];
    for (const b of bodies) expect(JSON.stringify(b)).not.toContain(KEY);
    expect(JSON.stringify(await db().select().from(aiMatchRuns))).not.toContain(KEY);
    expect(JSON.stringify(await allSuggestions())).not.toContain(KEY);
  });

  it('a second analysis of the same products asks Google nothing and creates no duplicates', async () => {
    const rows = (await allSuggestions()).length;
    const calls = h.gemini.calls.length;
    const run = await finish(await startRun());
    expect(run.status).toBe('completed');
    expect(h.gemini.calls.length).toBe(calls);
    expect(run.usage.requests).toBe(0);
    expect(run.usage.cachedResults).toBeGreaterThan(0);
    expect((await allSuggestions()).length).toBe(rows);
  });

  it('a product that changed is asked about again, and still has one row', async () => {
    const rows = (await allSuggestions()).length;
    const old = (await suggestion(pairs.exact!))!;
    await db().update(products).set({ title: 'Acme Orange Juice Premium' }).where(eq(products.id, pairs.exact!.cp));
    TITLES.exact = ['Acme Orange Juice 1 L', 'Acme Orange Juice Premium'];
    verdicts['Acme Orange Juice 1 L|Acme Orange Juice Premium'] = 'close_equivalent';
    const run = await finish(await startRun());
    expect(run.usage.requests).toBeGreaterThan(0);
    expect((await allSuggestions()).length).toBe(rows);
    const now = (await suggestion(pairs.exact!))!;
    expect(now.id).toBe(old.id);
    expect(now.candidateFingerprint).not.toBe(old.candidateFingerprint);
    // the model calls it a close equivalent, but a juice of another listing is no VERIFIED compatible equivalent: the gate makes it a substitute and says so
    expect(now.aiMatchType).toBe('close_equivalent');
    expect(now.matchType).toBe('substitute');
    expect(now.guards.map((g) => g.code)).toContain('compat_gate');
  });
});

describe('people review a suggestion', () => {
  const review = (id: string, body: Record<string, unknown>) => owner.post(`${base()}/ai/suggestions/${id}/review`, body);

  it('Accept records an ordinary human decision and leaves the other suggestions waiting', async () => {
    const s = (await suggestion(pairs.other!))!;
    const others = (await db().select().from(aiMatchSuggestions).where(and(eq(aiMatchSuggestions.sourceVariantId, s.sourceVariantId), eq(aiMatchSuggestions.status, 'pending')))).length;
    const res = await review(s.id, { action: 'accept', note: 'Same rice, bigger bag' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('accepted');
    const m = (await db().select().from(productMatches).where(and(eq(productMatches.sourceVariantId, s.sourceVariantId), eq(productMatches.competitorVariantId, s.competitorVariantId))))[0]!;
    expect(m).toMatchObject({ status: 'accepted', relationship: 'variant', decidedBy: userId });
    expect(m.decisionNote).toContain('AI suggestion');
    // the quantity policy still leaves the pair out of price comparison (different quantities); the person's decision is kept
    expect(m.priceExclusion).not.toBeNull();
    expect((await suggestion(pairs.other!))!).toMatchObject({ status: 'accepted', reviewRelationship: 'variant', reviewNote: 'Same rice, bigger bag' });
    expect((await db().select().from(aiMatchSuggestions).where(and(eq(aiMatchSuggestions.sourceVariantId, s.sourceVariantId), eq(aiMatchSuggestions.status, 'pending')))).length).toBe(others - 1);
    const fb = await db().select().from(aiMatchFeedback).where(eq(aiMatchFeedback.suggestionId, s.id));
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ action: 'accept', aiMatchType: 'same_product_different_pack', relationship: 'variant', matchId: m.id, userId });
    expect((await db().select().from(auditEvents).where(and(eq(auditEvents.orgId, org), eq(auditEvents.action, 'ai_match.accept')))).length).toBe(1);
    const cmp = JSON.stringify((await comparison()).rows);
    expect(cmp).not.toContain(s.competitorVariantId); // a pair of different quantities does not enter the comparison
  });

  it('Change records what the person says the products are', async () => {
    const s = (await suggestion(pairs.lamp!))!;
    const res = await review(s.id, { action: 'change', relationship: 'exact' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await suggestion(pairs.lamp!))!).toMatchObject({ status: 'changed', reviewRelationship: 'exact' });
    const m = (await db().select().from(productMatches).where(and(eq(productMatches.sourceVariantId, s.sourceVariantId), eq(productMatches.competitorVariantId, s.competitorVariantId))))[0]!;
    expect(m).toMatchObject({ id: lampMatchId, status: 'accepted', relationship: 'exact', decidedBy: userId }); // the engine's own pair, decided through the existing function
    expect((await review(s.id, { action: 'change' })).status).toBe(400); // "change" needs a choice
  });

  it('Accept on "no match" is refused: the person says what the products are instead', async () => {
    const none = (await allSuggestions()).find((r) => r.matchType === 'no_match_uncertain' && r.status === 'pending');
    expect(none).toBeDefined();
    const res = await review(none!.id, { action: 'accept' });
    expect(res.status).toBe(400);
    expect((await db().select().from(aiMatchSuggestions).where(eq(aiMatchSuggestions.id, none!.id)))[0]!.status).toBe('pending');
  });

  it('Uncertain only records the person’s doubt', async () => {
    const s = (await suggestion(pairs.soap!))!;
    const before = JSON.stringify(await matchRows());
    expect((await review(s.id, { action: 'uncertain', note: 'Need to check the label' })).status).toBe(200);
    expect((await suggestion(pairs.soap!))!).toMatchObject({ status: 'uncertain', reviewNote: 'Need to check the label' });
    expect(JSON.stringify(await matchRows())).toBe(before);
  });

  it('None of these closes every waiting suggestion for that product and changes no match', async () => {
    const s = (await suggestion(pairs.honey!))!;
    const waiting = (await db().select().from(aiMatchSuggestions).where(and(eq(aiMatchSuggestions.sourceVariantId, s.sourceVariantId), eq(aiMatchSuggestions.status, 'pending')))).length;
    expect(waiting).toBeGreaterThan(0);
    const before = JSON.stringify(await matchRows());
    const res = await review(s.id, { action: 'none_of_these' });
    expect(res.status).toBe(200);
    expect(res.body.affected).toBe(waiting);
    expect((await db().select().from(aiMatchSuggestions).where(and(eq(aiMatchSuggestions.sourceVariantId, s.sourceVariantId), eq(aiMatchSuggestions.status, 'pending')))).length).toBe(0);
    expect(JSON.stringify(await matchRows())).toBe(before);
    expect((await db().select().from(aiMatchFeedback).where(and(eq(aiMatchFeedback.sourceVariantId, s.sourceVariantId), eq(aiMatchFeedback.action, 'none_of_these')))).length).toBe(waiting);
  });

  it('Find another product records the person’s own choice through the existing manual-match function', async () => {
    const s = (await suggestion(pairs.single!))!;
    const other = pairs.exact!.c;
    const res = await review(s.id, { action: 'choose_other', competitorVariantId: other, relationship: 'substitute', note: 'Better fit' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const m = (await db().select().from(productMatches).where(and(eq(productMatches.sourceVariantId, s.sourceVariantId), eq(productMatches.competitorVariantId, other))))[0]!;
    expect(m).toMatchObject({ status: 'accepted', method: 'manual', relationship: 'substitute', decidedBy: userId });
    const fb = (await db().select().from(aiMatchFeedback).where(eq(aiMatchFeedback.suggestionId, s.id)))[0]!;
    expect(fb).toMatchObject({ action: 'choose_other', chosenVariantId: other });
    expect((await review(s.id, { action: 'choose_other' })).status).toBe(400);
  });

  it('the list shows each suggestion with both products, the evidence and the link, and hides what a person already decided', async () => {
    const res = await ask(`${base()}/ai/suggestions?status=all&decided=all&pageSize=100`);
    expect(res.status).toBe(200);
    const row = res.body.rows[0];
    expect(row.source.title).toBeTruthy();
    expect(row.candidate.siteName).toBeTruthy();
    expect(Array.isArray(row.supporting)).toBe(true);
    expect(row.model).toBe('gemini-3.5-flash-lite');
    const accepted = res.body.rows.find((r: { source: { variantId: string }; candidate: { variantId: string } }) => r.source.variantId === pairs.other!.s && r.candidate.variantId === pairs.other!.c);
    expect(accepted.existingMatch).toMatchObject({ status: 'accepted' });
    const hidden = await ask(`${base()}/ai/suggestions?status=all&pageSize=100`);
    expect(hidden.body.rows.some((r: { source: { variantId: string }; candidate: { variantId: string } }) => r.source.variantId === pairs.other!.s && r.candidate.variantId === pairs.other!.c)).toBe(false);
  });

  it('another workspace sees none of it', async () => {
    const other = new ApiClient(app);
    await signUp(other, h, { email: `ai2-${Date.now()}@example.test`, password: 'Correct-Horse-9-Battery', displayName: 'Other' });
    const otherId = (await other.get('/api/v1/auth/me')).body.user.id;
    const otherOrg = (await createOrganization(h.db.app, otherId, 'Elsewhere')).id;
    const res = await other.get(`/api/v1/orgs/${otherOrg}/ai/suggestions?status=all&decided=all`);
    expect(res.body.rows).toHaveLength(0);
    expect((await other.get(`/api/v1/orgs/${otherOrg}/ai/runs`)).body.runs).toHaveLength(0);
    expect((await other.post(`/api/v1/orgs/${otherOrg}/ai/suggestions/${(await allSuggestions())[0]!.id}/review`, { action: 'uncertain' })).status).toBe(404);
  });
});

describe('quota and failures', () => {
  const makeSuggestionsStale = async () => { await db().delete(aiMatchSuggestions).where(eq(aiMatchSuggestions.orgId, org)); };

  it('a per-minute 429 does not fail the run: it waits for the time Google named, learns the limit and continues', async () => {
    await resetQuota();
    await makeSuggestionsStale();
    let n = 0;
    h.gemini.set(async (_u, init) => (++n === 1 ? quotaError('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 15, '1s') : ok(decisionsOf(init))));
    const run = await finish(await startRun());
    expect(run.status).toBe('completed');
    expect(run.usage.rateLimited).toBe(1);
    expect(run.usage.successes).toBeGreaterThan(0);
    expect((await db().select().from(aiQuotaState))[0]).toMatchObject({ learnedRpm: 15 });
    expect((await allSuggestions()).length).toBeGreaterThan(0);
  }, 60_000);

  it('a used-up daily quota pauses the run until the quota resets, then it continues without repeating finished work', async () => {
    await resetQuota();
    await makeSuggestionsStale();
    h.gemini.set(async () => quotaError('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 20, '3600s'));
    const id = await startRun();
    const paused = await finish(id);
    expect(paused.status).toBe('paused');
    expect(paused.pauseReason).toMatch(/daily quota/i);
    expect(paused.resumeAt!.getTime()).toBeGreaterThan(h.svc.clock().getTime());
    expect(h.gemini.calls).toHaveLength(1); // one request, then it stopped asking
    expect((await db().select().from(aiQuotaState))[0]).toMatchObject({ learnedRpd: 20, stopped: null });
    // the same day: nothing more is asked
    await aiResumeTick(h.svc);
    await h.queue.drain();
    expect(h.gemini.calls).toHaveLength(1);
    // after the reset
    h.setNow('2026-11-06T12:00:00Z');
    h.gemini.set(gemini);
    expect((await aiResumeTick(h.svc)).queued).toContain(id);
    const done = await finish(id);
    expect(done.status).toBe('completed');
    expect((await allSuggestions()).length).toBeGreaterThan(0);
  }, 60_000);

  it('a quota that is not a free-tier quota stops all Gemini processing until a person looks at it', async () => {
    await resetQuota();
    await makeSuggestionsStale();
    h.gemini.set(async () => quotaError('GenerateRequestsPerMinutePerProjectPerModel', 1000, '1s', 'generativelanguage.googleapis.com/generate_content_paid_tier_requests'));
    const id = await startRun();
    const stopped = await finish(id);
    expect(stopped.status).toBe('paused');
    expect(stopped.pauseReason).toMatch(/non-free-tier/i);
    expect(h.gemini.calls).toHaveLength(1);
    expect((await db().select().from(aiQuotaState))[0]!.stopped).toMatch(/non-free-tier/i);
    expect((await ask(`${base()}/ai/status`)).body).toMatchObject({ state: 'stopped' });
    // nothing else is asked, not even by a new run
    await owner.post(`${base()}/ai/runs/${id}/cancel`);
    const again = await startRun();
    h.gemini.set(gemini);
    expect((await finish(again)).status).toBe('paused');
    expect(h.gemini.calls).toHaveLength(1);
    // a person clears the stop after fixing the cause
    expect((await owner.post(`${base()}/ai/resume-gemini`, {})).status).toBe(200);
    expect((await owner.post(`${base()}/ai/runs/${again}/resume`)).status).toBe(200);
    expect((await finish(again)).status).toBe('completed');
  }, 60_000);

  it('a refused key stops processing without being retried', async () => {
    await resetQuota();
    await makeSuggestionsStale();
    h.gemini.set(async () => ({ status: 403, json: { error: { code: 403, status: 'PERMISSION_DENIED', message: `API key ${KEY} not valid` } } }));
    const id = await startRun();
    const run = await finish(id);
    expect(run.status).toBe('paused');
    expect(h.gemini.calls).toHaveLength(1);
    expect(JSON.stringify(run)).not.toContain(KEY);
    expect((await db().select().from(aiQuotaState))[0]!.stopped).toMatch(/refused the API key/);
    await owner.post(`${base()}/ai/runs/${id}/cancel`);
    await owner.post(`${base()}/ai/resume-gemini`, {});
  });

  it('an answer that is cut off or is not JSON is asked again with fewer candidates', async () => {
    await resetQuota();
    await makeSuggestionsStale();
    let n = 0;
    h.gemini.set(async (_u, init) => (++n === 1 ? { status: 200, json: { candidates: [{ content: { parts: [{ text: '{"decisions":[{"id":' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 6000, totalTokenCount: 7000 } } } : ok(decisionsOf(init))));
    const run = await finish(await startRun());
    expect(run.status).toBe('completed');
    expect(run.usage.failures).toBe(1);
    expect(h.gemini.calls.length).toBeGreaterThan(2);
    expect((await allSuggestions()).length).toBeGreaterThan(0);
  });

  it('a decision the model leaves out is asked for once more; one that never validates is simply not stored', async () => {
    await resetQuota();
    await makeSuggestionsStale();
    let dropped: string | null = null;
    h.gemini.set(async (_u, init) => {
      const all = decisionsOf(init);
      if (dropped === null && all.length > 1) { dropped = all[0]!.id; return ok(all.slice(1)); }
      return ok(all);
    });
    const run = await finish(await startRun());
    expect(run.status).toBe('completed');
    expect(dropped).not.toBeNull();
    const expected = (await db().select().from(aiMatchRuns).where(eq(aiMatchRuns.id, run.id)))[0]!.progress;
    expect(expected.answered).toBe(expected.candidates - (expected.cachedResults ?? 0));
  });

  it('the daily request budget is a hard ceiling: the run pauses instead of asking more', async () => {
    await resetQuota();
    await makeSuggestionsStale();
    const small = { ...h.svc, config: { ...h.svc.config, GEMINI_DAILY_REQUESTS: 1, GEMINI_BATCH_CANDIDATES: 2 } };
    const created = await createAiRun(db(), small.config, org, userId, { scope: 'products', variantIds: [...new Set(sourceIds())], perSite: 4 });
    await processAiRun(small, org, created.run.id);
    const run = await runNow(created.run.id);
    expect(run.status).toBe('paused');
    expect(run.pauseReason).toMatch(/daily quota/i);
    expect(h.gemini.calls).toHaveLength(1);
    await owner.post(`${base()}/ai/runs/${run.id}/cancel`);
  });
});

describe('controls', () => {
  beforeEach(resetQuota);

  it('a run can be paused, resumed and cancelled, and only an administrator may start or control one', async () => {
    await db().delete(aiMatchSuggestions).where(eq(aiMatchSuggestions.orgId, org));
    const id = await startRun();
    expect((await owner.post(`${base()}/ai/runs/${id}/pause`)).body.run.status).toBe('paused');
    await h.queue.drain();
    expect(h.gemini.calls).toHaveLength(0); // paused: the job does nothing
    expect((await owner.post(`${base()}/ai/runs/${id}/resume`)).body.run.status).toBe('queued');
    expect((await finish(id)).status).toBe('completed');
    // a second run cannot start while one is open
    const second = await startRun();
    expect((await owner.post(`${base()}/ai/runs`, { scope: 'products', variantIds: [pairs.exact!.s] })).status).toBe(409);
    expect((await owner.post(`${base()}/ai/runs/${second}/cancel`)).body.run.status).toBe('cancelled');
    await h.queue.drain();
    expect((await runNow(second)).status).toBe('cancelled');
    expect((await owner.post(`${base()}/ai/runs/${second}/cancel`)).status).toBe(409);
    const members = await ask(`${base()}/ai/runs`);
    expect(members.body.runs.length).toBeGreaterThanOrEqual(2);
  });

  it('a run for products that are not the shop’s own, or none at all, is refused', async () => {
    expect((await owner.post(`${base()}/ai/runs`, { scope: 'products', variantIds: [pairs.exact!.c] })).status).toBe(400); // a competitor's product
    expect((await owner.post(`${base()}/ai/runs`, { scope: 'products', variantIds: [] })).status).toBe(400);
    expect((await owner.post(`${base()}/ai/runs`, { scope: 'sample', limit: 9999 })).status).toBe(400);
  });

  it('a sample draws on the waiting, confirmed and unmatched products alike and stays inside its limit', async () => {
    await db().delete(aiMatchSuggestions).where(eq(aiMatchSuggestions.orgId, org));
    const res = await owner.post(`${base()}/ai/runs`, { scope: 'sample', limit: 5, perSite: 2 });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.selected).toBeGreaterThan(0);
    expect(res.body.selected).toBeLessThanOrEqual(5);
    const run = await finish(res.body.run.id);
    expect(['completed', 'paused']).toContain(run.status);
    expect(new Set(run.sourceIds).size).toBe(run.sourceIds.length);
  });
});
