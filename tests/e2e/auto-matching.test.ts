import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { aiMatchRuns, aiMatchSuggestions, aiMatchWork, matchAutoApproval, matchEvalReports, matchEvents, productMatches, products, scanRuns, variants } from '@ci/database';
import { AUTO_POLICY_VERSION } from '@ci/core';
import { aiResumeTick, reconcileSuggestions, runMatching } from '@ci/services';
import { KEY1, createBulbs, imitation, quotaResponse, type Bulbs, type Imitation, type Seeded } from '../support/bulbs.ts';

/**
 * Automatic matching, end to end, against an IMITATION of Gemini (no test reaches Google). The catalogue is seeded so every title, option, code and quantity is controlled. What is proved: a
 * stored answer is promoted without asking the model again; new products are matched with no Analyse and no Accept; the safeguards hold whatever the model says; a person's decision is final;
 * facts that change take an approval back while price-only changes cost nothing; work survives a quota stop and resumes from its checkpoint; and equivalents are visible but never counted as
 * the same item.
 *
 * Switching a policy ON is done here by setting its state directly (it is the state these tests are about). The real route to that state, labelling → measurement → gate → activation, is proved in
 * match-gate-path.test.ts without any made-up measurement.
 */
let b: Bulbs;
let im: Imitation;
const pairs: Record<string, { s: Seeded; c: Seeded }> = {};

const policyOn = async (on: boolean, autoClass: 'exact_item' | 'compatible_equivalent' = 'compatible_equivalent') => {
  await b.db.insert(matchAutoApproval).values({ orgId: b.org, domain: 'automotive', autoClass, enabled: on, policyVersion: AUTO_POLICY_VERSION, enabledAt: b.h.svc.clock(), updatedAt: b.h.svc.clock() })
    .onConflictDoUpdate({ target: [matchAutoApproval.orgId, matchAutoApproval.domain, matchAutoApproval.autoClass], set: { enabled: on, policyVersion: AUTO_POLICY_VERSION, updatedAt: b.h.svc.clock() } });
};
const matchOf = async (p: { s: Seeded; c: Seeded }) => (await b.db.select().from(productMatches).where(and(eq(productMatches.sourceVariantId, p.s.variantId), eq(productMatches.competitorVariantId, p.c.variantId))))[0];
const sugOf = async (p: { s: Seeded; c: Seeded }) => (await b.db.select().from(aiMatchSuggestions).where(and(eq(aiMatchSuggestions.sourceVariantId, p.s.variantId), eq(aiMatchSuggestions.competitorVariantId, p.c.variantId))))[0];
const analyse = async (variantIds?: string[]) => {
  const ids = variantIds ?? Object.values(pairs).map((p) => p.s.variantId);
  const res = await b.owner.post(`${b.base}/ai/runs`, { scope: 'products', variantIds: [...new Set(ids)], perSite: 4 });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  await b.h.queue.drain();
  return (await b.db.select().from(aiMatchRuns).where(eq(aiMatchRuns.id, res.body.run.id)))[0]!;
};
const reconcileJob = async () => {
  await b.h.svc.queue.enqueue('ai-match', { orgId: b.org, task: 'reconcile' }, { singletonKey: `reconcile:${b.org}` });
  await b.h.queue.drain();
};
const eventsOf = async () => (await b.db.select().from(matchEvents).where(eq(matchEvents.orgId, b.org))).length;
const accepted = async () => (await b.db.select().from(productMatches).where(and(eq(productMatches.orgId, b.org), eq(productMatches.status, 'accepted')))).filter((m) => m.method === 'ai_auto');

beforeAll(async () => {
  b = await createBulbs({ competitors: 2 });
  im = imitation();
  b.h.gemini.set(im.handler);
  // a learned code family: listings in this catalogue write H8, H9 and H11 together (a retrieval hint, never evidence of the same lamp)
  // (three listings on two websites that write the three together are what the software learns a family from)
  await b.seed('woo', 'Lumex H8 H9 H11 LED Headlight Bulb', { brand: 'Lumex' });
  await b.seed('woo', 'Zenith H8 H9 H11 LED Headlight Bulb', { brand: 'Zenith' });
  await b.seed('extra', 'Brightline H8 H9 H11 LED Headlight Bulb', { brand: 'Brightline' });
  const make = async (key: string, src: [string, SeedOptionsArg?], cand: [string, SeedOptionsArg?], verdict: string) => {
    const s = await b.seed('source', src[0], { brand: 'Sealight', ...(src[1] ?? {}) });
    const c = await b.seed('woo', cand[0], { brand: 'Lumex', ...(cand[1] ?? {}) });
    pairs[key] = { s, c };
    im.verdicts[`${src[0]}|${cand[0]}`] = verdict;
  };
  // eligible compatible equivalents: the same standard code and the same job, another maker
  await make('h11', ['Sealight H11 LED Headlight Bulb'], ['Lumex H11 LED Headlight Bulb'], 'close_equivalent');
  await make('alias', ['Sealight 9005 LED Headlight Bulb'], ['Lumex HB3 LED Headlight Bulb'], 'close_equivalent'); // 9005 and HB3 are one standard lamp
  // never eligible, however sure the model is
  await make('learned', ['Sealight H8 LED Fog Light Bulb'], ['Lumex H11 LED Fog Light Bulb'], 'close_equivalent'); // H8/H11 only co-occur in the catalogue
  await make('function', ['Sealight H7 LED Headlight Bulb'], ['Lumex H7 LED Fog Light Bulb'], 'close_equivalent'); // same code, another job
  await make('code', ['Sealight H1 LED Headlight Bulb'], ['Lumex H3 LED Headlight Bulb'], 'close_equivalent'); // another lamp
  await make('code_exact', ['Sealight H16 LED Headlight Bulb'], ['Sealight H4 LED Headlight Bulb', { brand: 'Sealight' }], 'exact_item'); // the model says "identical" for two different lamps
  await make('kit', ['Sealight 9006 LED Headlight Bulb'], ['Lumex 9006 LED Headlight Bulb Kit'], 'close_equivalent'); // a kit is not a bulb
  await make('nofit', ['Sealight LED Headlight Bulb Bright'], ['Lumex LED Headlight Bulb Bright'], 'close_equivalent'); // no code stated by either
  // quantity: the same lamp, a different number in the pack
  await make('qty', ['Sealight H10 LED Fog Light Bulb (2 pack)', { qty: ['count', 2, '2 pack'] }], ['Lumex H10 LED Fog Light Bulb (4 pack)', { qty: ['count', 4, '4 pack'] }], 'close_equivalent');
  // an identical item with an equal valid barcode and the same quantity
  await make('exact', ['Sealight 9012 LED Headlight Bulb', { gtin: '4006381333931', qty: ['count', 2, '2 pack'] }], ['Sealight 9012 LED Headlight Bulb Twin', { brand: 'Sealight', gtin: '4006381333931', qty: ['count', 2, '2 pack'] }], 'exact_item');
  await runMatching(b.h.svc, b.db, b.org);
}, 300_000);

type SeedOptionsArg = Parameters<Bulbs['seed']>[2];

afterAll(async () => b.close());

describe('the setup', () => {
  it('reports the key by a label only, never the key', async () => {
    const status = (await b.owner.get(`${b.base}/ai/status`)).body;
    expect(status.configured).toBe(true);
    expect(status.keys.map((k: { id: string }) => k.id)).toEqual(['k1']);
    expect(JSON.stringify(status)).not.toContain(KEY1);
  });
});

describe('a stored answer is promoted without asking the model again', () => {
  let callsAfterFirst = 0;
  it('with the policy off, the answers are stored and nothing is approved', async () => {
    await policyOn(false);
    const run = await analyse();
    expect(run.status, run.error ?? '').toBe('completed');
    expect(im.asked.length).toBeGreaterThan(0);
    expect(await accepted()).toHaveLength(0);
    callsAfterFirst = b.h.gemini.calls.length;
    // each eligible pair was recorded as eligible, for the policy version in force
    for (const k of ['h11', 'alias']) expect(await sugOf(pairs[k]!), k).toMatchObject({ autoClass: 'compatible_equivalent', autoPolicyVersion: AUTO_POLICY_VERSION });
  });

  it('switching the policy on approves the qualifying answers from the stored answers: zero Gemini requests', async () => {
    await policyOn(true);
    await reconcileJob();
    expect(b.h.gemini.calls.length).toBe(callsAfterFirst);
    const ok = await accepted();
    const keys = Object.entries(pairs).filter(([, p]) => ok.some((m) => m.competitorVariantId === p.c.variantId && m.sourceVariantId === p.s.variantId)).map(([k]) => k).sort();
    expect(keys).toEqual(['alias', 'h11']);
    for (const m of ok) expect(m).toMatchObject({ status: 'accepted', method: 'ai_auto', relationship: 'equivalent', decidedBy: null, confidence: 0 });
    expect((await sugOf(pairs.h11!))!.status).toBe('accepted');
  });

  it('reconciling again changes nothing and records nothing twice', async () => {
    const before = { events: await eventsOf(), rows: JSON.stringify(await accepted()) };
    await reconcileJob();
    await reconcileJob();
    expect(await eventsOf()).toBe(before.events);
    expect(JSON.stringify(await accepted())).toBe(before.rows);
    expect(b.h.gemini.calls.length).toBe(callsAfterFirst);
  });

  it('a cache hit is promoted too: a re-run asks nothing and still decides the approval', async () => {
    const [m] = await accepted();
    await b.db.update(productMatches).set({ status: 'needs_review', autoConfirmedAt: null, decidedAt: null }).where(eq(productMatches.id, m!.id)); // as if it had not been approved yet
    const run = await analyse();
    expect(run.status).toBe('completed');
    expect(run.usage.requests).toBe(0);
    expect(run.usage.cachedResults).toBeGreaterThan(0);
    expect((await accepted()).map((x) => x.id)).toContain(m!.id);
  });
});

describe('a critical incompatibility never auto-approves, whatever the model says', () => {
  it.each(['function', 'code', 'code_exact', 'kit', 'nofit'])('%s', async (k) => {
    const s = await sugOf(pairs[k]!);
    // a decisively different lamp (another code) may never even be sent to the model; if it was sent, it must not qualify
    if (['function', 'kit'].includes(k)) expect(s, 'the model was asked').toBeDefined();
    if (s) {
      expect(s.autoClass).toBeNull();
      if (s.aiMatchType === 'close_equivalent') expect(s.matchType).not.toBe('close_equivalent'); // the compatibility gate demoted it
    }
    expect((await matchOf(pairs[k]!))?.status ?? 'none').not.toBe('accepted');
    expect((await accepted()).map((m) => m.competitorVariantId)).not.toContain(pairs[k]!.c.variantId);
  });
  it('the model said "close equivalent" with high confidence, and that was recorded as what it said', async () => {
    const s = (await sugOf(pairs.function!))!;
    expect(s.aiMatchType).toBe('close_equivalent');
    expect(s.aiConfidence).toBe('high');
    expect(s.guards.map((g) => g.code)).toContain('compat_gate');
    expect(s.policy.compat?.fields.function).toBe('conflicting');
  });
});

describe('a learned code family retrieves a candidate but can never satisfy compatibility', () => {
  it('H8 against H11 is found, judged, and not approved', async () => {
    const s = (await sugOf(pairs.learned!))!;
    expect(s, 'retrieval found the H11 fog bulb for an H8 fog bulb').toBeDefined();
    expect(s.autoClass).toBeNull();
    expect(s.policy.compat).toMatchObject({ eligible: false, fields: { code: 'conflicting' } });
    expect(s.guards.map((g) => g.code)).toContain('compat_gate');
    expect(await matchOf(pairs.learned!)).toBeUndefined();
  });
  it('a verified standard alias (9005 / HB3) does satisfy it', async () => {
    const s = (await sugOf(pairs.alias!))!;
    expect(s.policy.compat).toMatchObject({ eligible: true, fields: { code: 'established' } });
    expect((await matchOf(pairs.alias!))).toMatchObject({ status: 'accepted', method: 'ai_auto' });
  });
});


describe('quantity stays separate from compatibility', () => {
  it('the same lamp in packs of different sizes is never approved as an equivalent', async () => {
    const s = (await sugOf(pairs.qty!))!;
    expect(s, 'asked about').toBeDefined();
    expect(s.policy.quantity?.verdict).toBe('different');
    expect(s.autoClass).toBeNull();
    expect((await matchOf(pairs.qty!))?.status ?? 'none').not.toBe('accepted');
  });
  it('an unknown pack size keeps the relationship visible but gives no price percentage', async () => {
    const res = await b.owner.get(`${b.base}/comparison?view=approved&pageSize=200`);
    const row = (res.body.rows as { sourceVariantId: string; cells: { relationship: string; diffPct: number | null; diffAbs: number | null; priceLimitation: string | null }[] }[]).find((r) => r.sourceVariantId === pairs.h11!.s.variantId)!;
    expect(row.cells[0]).toMatchObject({ relationship: 'equivalent', diffPct: null, diffAbs: null });
    expect(row.cells[0]!.priceLimitation).toMatch(/not verified/);
  });
});

describe('equivalents are visible, labelled, and never counted as the same item', () => {
  type Cell = { relationship: string; confirmation: string; directlyComparable: boolean; matchStatus: string; approval: { by: string; policyVersion: string | null; reason: string | null; evidence: string[] }; priceLimitation: string | null; price: { observedAt: string | null }; siteName: string; variantTitle: string | null; title: string };
  type Row = { sourceVariantId: string; cells: Cell[]; position: string };
  const view = async (v: string) => (await b.owner.get(`${b.base}/comparison?view=${v}&pageSize=300`)).body.rows as Row[];

  it('appear in the approved overview with the competitor, the matched product, the price time, who approved them and why', async () => {
    const row = (await view('approved')).find((r) => r.sourceVariantId === pairs.h11!.s.variantId)!;
    const cell = row.cells[0]!;
    expect(cell).toMatchObject({ relationship: 'equivalent', confirmation: 'automatic', directlyComparable: false, matchStatus: 'accepted', title: 'Lumex H11 LED Headlight Bulb' });
    expect(cell.approval).toMatchObject({ by: 'policy', policyVersion: AUTO_POLICY_VERSION });
    expect(cell.approval.evidence.join(' ')).toMatch(/H11/);
    expect(cell.price.observedAt).toBeTruthy();
    expect(cell.siteName).toBeTruthy();
    expect(row.position).toBe('no_data'); // an equivalent is never an identical-item price position
  });
  it('appear in the Equivalents view too, and not in the identical-item view', async () => {
    expect((await view('equivalents')).map((r) => r.sourceVariantId)).toContain(pairs.h11!.s.variantId);
    expect((await view('prices')).map((r) => r.sourceVariantId)).not.toContain(pairs.h11!.s.variantId);
  });
  it('need no Accept: the suggestion shows as approved by the policy, with nobody having reviewed it', async () => {
    const s = (await sugOf(pairs.h11!))!;
    expect(s).toMatchObject({ status: 'accepted', reviewedBy: null, reviewRelationship: 'equivalent' });
    expect(s.reviewNote).toMatch(/Approved automatically/);
  });
  it('do not change the identical-item counts', async () => {
    const counts = (await b.owner.get(`${b.base}/matches/counts`)).body;
    expect(counts.confirmedPairs.equivalent).toBeGreaterThanOrEqual(2);
    expect(counts.directlyComparableOwnVariants).toBe(0);
    expect(counts.confirmedPairs.exact).toBe(0);
  });
});

describe('evidence consistency', () => {
  it('what the approval rests on is the same code and the same job the policy recorded, never the model’s words', async () => {
    const s = (await sugOf(pairs.h11!))!;
    expect(s.policy.compat).toMatchObject({ version: AUTO_POLICY_VERSION, eligible: true, sharedCode: 'H11', fields: { code: 'established', function: 'established' } });
    const m = (await matchOf(pairs.h11!))!;
    expect(m.reasons.join(' ')).toMatch(/H11/);
    expect(m.confidence).toBe(0); // no model score is dressed up as a calibrated number
  });
  it('a verified alias records the code the listings write, not a merged code', async () => {
    const s = (await sugOf(pairs.alias!))!;
    expect(s.policy.compat?.sharedCode).toMatch(/9005|HB3/i);
  });
});

describe('a person’s decision is final, even against a race', () => {
  it('a rejected pair is never approved again, whatever the evidence', async () => {
    const m = (await matchOf(pairs.h11!))!;
    expect((await b.owner.post(`${b.base}/matches/${m.id}/decision`, { decision: 'reject', note: 'Not suitable' })).status).toBe(200);
    await reconcileJob();
    await analyse([pairs.h11!.s.variantId]);
    expect(await matchOf(pairs.h11!)).toMatchObject({ status: 'rejected', decidedBy: b.userId, decisionNote: 'Not suitable' });
    expect((await sugOf(pairs.h11!))!.status).not.toBe('accepted');
  });
  it('a person’s own acceptance stays, however the evidence changes later', async () => {
    const m = (await matchOf(pairs.alias!))!;
    expect((await b.owner.post(`${b.base}/matches/${m.id}/decision`, { decision: 'accept', relationship: 'equivalent' })).status).toBe(200);
    await b.db.update(products).set({ title: 'Lumex H3 LED Headlight Bulb' }).where(eq(products.id, pairs.alias!.c.productId)); // now a different lamp
    await reconcileJob();
    await analyse([pairs.alias!.s.variantId]);
    expect(await matchOf(pairs.alias!)).toMatchObject({ status: 'accepted', decidedBy: b.userId });
    await b.db.update(products).set({ title: 'Lumex HB3 LED Headlight Bulb' }).where(eq(products.id, pairs.alias!.c.productId));
  });
  it('a pair a person decided is never approved by the system, even if its status was reset to waiting', async () => {
    const pair = pairs.h11!;
    const m = (await matchOf(pair))!;
    await b.db.update(productMatches).set({ status: 'needs_review', decidedBy: b.userId, decidedAt: b.h.svc.clock(), decisionNote: 'looked at by hand', autoConfirmedAt: null, method: 'name_similarity' }).where(eq(productMatches.id, m.id));
    await reconcileSuggestions(b.h.svc, b.org);
    expect(await matchOf(pair)).toMatchObject({ status: 'needs_review', decidedBy: b.userId, autoConfirmedAt: null, method: 'name_similarity' });
  });
  it('a decision made at the same moment as a reconciliation always wins', async () => {
    // a pair the system suggested and has not approved; the person rejects it while a reconciliation runs, over and over
    const pair = pairs.h11!;
    for (let i = 0; i < 8; i++) {
      await b.db.update(productMatches).set({ status: 'needs_review', decidedBy: null, decidedAt: null, decisionNote: null, autoConfirmedAt: null }).where(and(eq(productMatches.sourceVariantId, pair.s.variantId), eq(productMatches.competitorVariantId, pair.c.variantId)));
      const m = (await matchOf(pair))!;
      await Promise.all([
        b.owner.post(`${b.base}/matches/${m.id}/decision`, { decision: 'reject', note: `race ${i}` }),
        reconcileSuggestions(b.h.svc, b.org),
        reconcileSuggestions(b.h.svc, b.org),
      ]);
      expect(await matchOf(pair), `round ${i}`).toMatchObject({ status: 'rejected', decidedBy: b.userId });
    }
  });
});

describe('changed facts take an approval back; price-only changes cost nothing', () => {
  it('a price change refreshes the comparison without asking the model anything', async () => {
    const pair = pairs.alias!;
    await b.db.update(productMatches).set({ status: 'needs_review', decidedBy: null, decidedAt: null, decisionNote: null }).where(eq(productMatches.id, (await matchOf(pair))!.id));
    await reconcileJob(); // approved again by the policy
    expect(await matchOf(pair)).toMatchObject({ status: 'accepted', method: 'ai_auto' });
    const calls = im.asked.length;
    await b.db.update(variants).set({ price: 17.25 }).where(eq(variants.id, pair.c.variantId));
    const res = await b.owner.post(`${b.base}/ai/runs`, { scope: 'sweep' });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    await b.h.queue.drain();
    expect(im.asked.length).toBe(calls);
    expect(await matchOf(pair)).toMatchObject({ status: 'accepted', method: 'ai_auto' });
    const row = ((await b.owner.get(`${b.base}/comparison?view=approved&pageSize=300`)).body.rows as { sourceVariantId: string; cells: { price: { amount: number } }[] }[]).find((r) => r.sourceVariantId === pair.s.variantId)!;
    expect(row.cells[0]!.price.amount).toBe(17.25);
  });
  it('a changed fact (another bulb code) takes the approval back, even though the pair is no longer shortlisted', async () => {
    const pair = pairs.alias!;
    const before = await eventsOf();
    await b.db.update(products).set({ title: 'Lumex H3 LED Headlight Bulb' }).where(eq(products.id, pair.c.productId));
    const res = await b.owner.post(`${b.base}/ai/runs`, { scope: 'sweep' });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    await b.h.queue.drain();
    const m = (await matchOf(pair))!;
    expect(m.status).not.toBe('accepted');
    expect(m.autoConfirmedAt).toBeNull();
    expect(await eventsOf()).toBeGreaterThan(before);
    const events = await b.db.select().from(matchEvents).where(eq(matchEvents.matchId, m.id));
    expect(events.map((e) => e.kind)).toContain('auto_withdrawn');
    await b.db.update(products).set({ title: 'Lumex HB3 LED Headlight Bulb' }).where(eq(products.id, pair.c.productId));
  });
});

describe('retries and idempotency', () => {
  it('a transient failure is retried by itself; every pair is answered once and stored once', async () => {
    const s = await b.seed('source', 'Sealight H15 LED Headlight Bulb', { brand: 'Sealight' });
    const c = await b.seed('woo', 'Lumex H15 LED Headlight Bulb', { brand: 'Lumex' });
    im.verdicts[`${s.title}|${c.title}`] = 'close_equivalent';
    let failed = 0;
    im.intercept = () => (failed++ === 0 ? { status: 503, json: { error: { code: 503, status: 'UNAVAILABLE', message: 'busy' } } } : null);
    const run = await analyse([s.variantId]);
    im.intercept = null;
    expect(run.status, run.error ?? '').toBe('completed');
    expect(failed).toBeGreaterThan(1); // it was asked again after the failure
    const rows = await b.db.select().from(aiMatchSuggestions).where(and(eq(aiMatchSuggestions.sourceVariantId, s.variantId), eq(aiMatchSuggestions.competitorVariantId, c.variantId)));
    expect(rows).toHaveLength(1);
    expect(im.asked.filter((a) => a.pair === `${s.title}|${c.title}`)).toHaveLength(1);
    expect(await matchOf({ s, c })).toMatchObject({ status: 'accepted', method: 'ai_auto' });
  });
  it('replaying a finished job changes nothing and records nothing twice', async () => {
    const [run] = await b.db.select().from(aiMatchRuns).where(eq(aiMatchRuns.orgId, b.org)).orderBy(aiMatchRuns.createdAt);
    const before = { events: await eventsOf(), asked: im.asked.length, suggestions: (await b.db.select().from(aiMatchSuggestions).where(eq(aiMatchSuggestions.orgId, b.org))).length };
    for (let i = 0; i < 3; i++) await b.h.svc.queue.enqueue('ai-match', { orgId: b.org, runId: run!.id }, { singletonKey: `replay:${i}` });
    await b.h.queue.drain();
    expect(await eventsOf()).toBe(before.events);
    expect(im.asked.length).toBe(before.asked);
    expect((await b.db.select().from(aiMatchSuggestions).where(eq(aiMatchSuggestions.orgId, b.org))).length).toBe(before.suggestions);
  });
});

describe('continuous matching: new products are matched with no Analyse and no Accept', () => {
  const sweeps = async () => (await b.db.select().from(aiMatchRuns).where(and(eq(aiMatchRuns.orgId, b.org), eq(aiMatchRuns.kind, 'sweep')))).length;
  let start = 0;
  it('does nothing while it is off', async () => {
    start = await sweeps();
    b.h.advance(60_000);
    expect((await aiResumeTick(b.h.svc)).swept).toEqual([]);
    expect(await sweeps()).toBe(start);
  });
  it('turned on, it works through the whole catalogue once (the initial backlog) with no one pressing anything', async () => {
    b.h.advance(25 * 3_600_000); // the last whole-catalogue look is more than a day old
    const res = await b.owner.post(`${b.base}/ai/continuous`, { enabled: true });
    expect(res.body).toEqual({ continuous: true });
    await b.h.queue.drain();
    expect(await sweeps()).toBe(start + 1);
    const run = (await b.db.select().from(aiMatchRuns).where(and(eq(aiMatchRuns.orgId, b.org), eq(aiMatchRuns.kind, 'sweep')))).sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0]!;
    expect(run.status).toBe('completed');
    expect(run.createdBy).toBeNull(); // started by the system, not by a person
    const work = await b.db.select().from(aiMatchWork).where(eq(aiMatchWork.orgId, b.org));
    expect(work.length).toBeGreaterThanOrEqual(Object.keys(pairs).length);
    expect(work.every((w) => w.status === 'completed' || w.status === 'needs_evidence')).toBe(true);
  });
  it('does not start again until a collection has finished', async () => {
    b.h.advance(5 * 60_000);
    expect((await aiResumeTick(b.h.svc)).swept).toEqual([]);
  });
  it('a collection finishing brings in the new product: it is found, judged and approved by itself', async () => {
    const s = await b.seed('source', 'Sealight H13 LED Headlight Bulb', { brand: 'Sealight' });
    const c = await b.seed('woo', 'Lumex H13 LED Headlight Bulb', { brand: 'Lumex' });
    im.verdicts[`${s.title}|${c.title}`] = 'close_equivalent';
    b.h.advance(5 * 60_000);
    await b.db.insert(scanRuns).values({ orgId: b.org, siteId: b.sites.woo, kind: 'discovery', status: 'succeeded', trigger: 'scheduled', isComplete: true, finishedAt: b.h.svc.clock() });
    const tick = await aiResumeTick(b.h.svc);
    expect(tick.swept).toHaveLength(1);
    await b.h.queue.drain();
    expect(await matchOf({ s, c })).toMatchObject({ status: 'accepted', method: 'ai_auto', relationship: 'equivalent', decidedBy: null });
    expect(im.asked.filter((a) => a.pair === `${s.title}|${c.title}`)).toHaveLength(1);
    const [w] = await b.db.select().from(aiMatchWork).where(eq(aiMatchWork.sourceVariantId, s.variantId));
    expect(w).toMatchObject({ status: 'completed', reason: 'approved', approved: 1 });
    expect(await sweeps()).toBe(start + 2);
  });
});

describe('quota: work waits, is never marked done, and resumes from its checkpoint', () => {
  it('a daily quota stop pauses the run with its place kept; the next day finishes it with every pair asked once', async () => {
    // fourteen new products (three windows of six)
    const made: { s: Seeded; c: Seeded }[] = [];
    for (let i = 0; i < 14; i++) {
      const code = `H${30 + i}`;
      const s = await b.seed('source', `Sealight ${code} LED Headlight Bulb`, { brand: 'Sealight' });
      const c = await b.seed('woo', `Lumex ${code} LED Headlight Bulb`, { brand: 'Lumex' });
      im.verdicts[`${s.title}|${c.title}`] = 'close_equivalent';
      made.push({ s, c });
    }
    const ids = made.map((m) => m.s.variantId);
    // the model answers two requests, then the free daily quota is gone
    const askedBefore = im.asked.length;
    let n = 0;
    im.intercept = () => (n++ >= 2 ? quotaResponse('day') : null);
    const res = await b.owner.post(`${b.base}/ai/runs`, { scope: 'products', variantIds: ids, perSite: 2 });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    await b.h.queue.drain();
    const [paused] = await b.db.select().from(aiMatchRuns).where(eq(aiMatchRuns.id, res.body.run.id));
    expect(paused!.status).toBe('paused');
    expect(paused!.resumeAt).not.toBeNull();
    expect(paused!.pauseReason).toMatch(/quota/i);
    expect(paused!.cursor).toBeGreaterThan(0);
    expect(paused!.cursor).toBeLessThan(ids.length);
    // the work that was not reached is waiting for quota, never "completed"
    const work = await b.db.select().from(aiMatchWork).where(inArray(aiMatchWork.sourceVariantId, ids));
    expect(work.filter((w) => w.status === 'completed').length).toBeLessThan(ids.length);
    expect(work.some((w) => w.status === 'waiting_quota')).toBe(true);
    const pausedAsked = im.asked.length - askedBefore;
    // tomorrow: the quota is back, the same run goes on from where it stopped
    im.intercept = null;
    b.h.advance(paused!.resumeAt!.getTime() - b.h.svc.clock().getTime() + 120_000);
    await aiResumeTick(b.h.svc);
    await b.h.queue.drain();
    const [done] = await b.db.select().from(aiMatchRuns).where(eq(aiMatchRuns.id, res.body.run.id));
    expect(done!.status, done!.error ?? '').toBe('completed');
    expect(done!.cursor).toBe(ids.length);
    const mine = im.asked.slice(askedBefore).filter((a) => ids.some((_, i) => a.pair === `${made[i]!.s.title}|${made[i]!.c.title}`));
    expect(new Set(mine.map((a) => a.pair)).size).toBe(mine.length); // no pair asked twice
    expect(mine.length).toBe(ids.length);
    expect(pausedAsked).toBeLessThan(ids.length);
    for (const m of made) expect(await matchOf(m), m.s.title).toMatchObject({ status: 'accepted', method: 'ai_auto' });
    const after = await b.db.select().from(aiMatchWork).where(inArray(aiMatchWork.sourceVariantId, ids));
    expect(after.every((w) => w.status === 'completed')).toBe(true);
  });
});

describe('a measurement made before families and policy versions existed (what production holds)', () => {
  it('does not break the funnel or the evaluation screen, and counts for nothing under the current rules', async () => {
    // the shape the earlier version stored: four gates, none with `units` or a policy version, one for a policy that is not offered
    const old = (domain: string, autoClass: string) => ({ domain, autoClass, result: { passed: false, lines: [{ name: 'automatic approval precision', interval: { estimate: null, low: null, high: null }, needed: 0.98, examples: 0, passed: false, why: 'only 0 labelled examples (at least 100 are needed)' }] } });
    await b.db.insert(matchEvalReports).values({ orgId: b.org, split: 'all', report: { all: {}, holdout: {}, development: {}, note: 'old' }, gates: [old('automotive', 'exact_item'), old('automotive', 'compatible_equivalent'), old('grocery', 'exact_item'), old('grocery', 'compatible_equivalent')], cases: 0, createdAt: new Date(b.h.svc.clock().getTime() + 10 * 60_000) });
    const f = await b.owner.get(`${b.base}/ai/funnel`);
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect(f.body.precision).toHaveLength(3); // the policies that exist
    for (const p of f.body.precision) expect(p).toMatchObject({ families: 0, correct: 0, passed: false, critical: 0 });
    const s = await b.owner.get(`${b.base}/eval/status`);
    expect(s.status).toBe(200);
    expect(s.body.latestReport.gates.map((g: { domain: string; autoClass: string }) => `${g.domain}/${g.autoClass}`).sort()).toEqual(['automotive/compatible_equivalent', 'automotive/exact_item', 'grocery/exact_item']);
    // and it cannot be used to switch anything on
    const on = await b.owner.post(`${b.base}/eval/auto-approval`, { domain: 'automotive', autoClass: 'compatible_equivalent', enabled: true });
    expect(on.status).toBe(409);
  });
});
