import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { aiMatchRuns, aiMatchSuggestions, aiMatchWork, aiQuotaState, aiUsageDaily, productMatches } from '@ci/database';
import { aiResumeTick, aiStatus, embedCatalogue } from '@ci/services';
import { KEY1, KEY2, createBulbs, imitation, okResponse, quotaResponse, type Bulbs, type Imitation, type Seeded } from '../support/bulbs.ts';

/**
 * Two Gemini keys, used together within the free tier. What is proved: work is spread over both keys, each with its own count and limits; a key that Google pauses or refuses is set aside on its
 * own while the other carries on; when both are out the work waits and then resumes; and neither key ever appears in a response, a stored record, an address or a log line.
 */
let b: Bulbs;
let im: Imitation;
const made: { s: Seeded; c: Seeded }[] = [];
const COUNT = 24;

const run = async (ids: string[]) => {
  const res = await b.owner.post(`${b.base}/ai/runs`, { scope: 'products', variantIds: ids, perSite: 2 });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  await b.h.queue.drain();
  return (await b.db.select().from(aiMatchRuns).where(eq(aiMatchRuns.id, res.body.run.id)))[0]!;
};
const fresh = async () => {
  await b.db.update(aiMatchRuns).set({ status: 'cancelled' }).where(and(eq(aiMatchRuns.orgId, b.org), inArray(aiMatchRuns.status, ['queued', 'running', 'paused'])));
  await b.db.delete(aiQuotaState);
  await b.db.delete(aiUsageDaily);
  await b.db.delete(aiMatchSuggestions); // every test asks afresh
  await b.db.delete(aiMatchWork);
  im.asked.length = 0;
  im.intercept = null;
  b.h.gemini.calls.length = 0;
  b.h.advance(5 * 60_000);
};
const pairsAsked = () => im.asked.map((a) => a.pair);

beforeAll(async () => {
  b = await createBulbs({ env: { GEMINI_API_KEY_2: KEY2, GEMINI_BATCH_CANDIDATES: '3', GEMINI_MAX_CONCURRENCY: '1' } });
  im = imitation();
  b.h.gemini.set(im.handler);
  for (let i = 0; i < COUNT; i++) {
    const code = `H${40 + i}`;
    const s = await b.seed('source', `Sealight ${code} LED Headlight Bulb`, { brand: 'Sealight' });
    const c = await b.seed('woo', `Lumex ${code} LED Headlight Bulb`, { brand: 'Lumex' });
    im.verdicts[`${s.title}|${c.title}`] = 'close_equivalent';
    made.push({ s, c });
  }
}, 300_000);

afterAll(async () => b.close());
beforeEach(fresh);

const ids = () => made.map((m) => m.s.variantId);

describe('work is spread over both keys, each counted on its own', () => {
  it('both keys carry requests, every pair is asked exactly once, and each key’s count is its own', async () => {
    const r = await run(ids());
    expect(r.status, r.error ?? '').toBe('completed');
    const keys = new Set(im.asked.map((a) => a.key));
    expect(keys).toEqual(new Set([KEY1, KEY2]));
    expect(new Set(pairsAsked()).size).toBe(pairsAsked().length);
    expect(pairsAsked().length).toBe(COUNT);
    // per-key usage rows add up to the requests actually sent, and each key's row matches what that key sent
    const rows = await b.db.select().from(aiUsageDaily);
    expect(rows.map((x) => x.keyId).sort()).toEqual(['k1', 'k2']);
    for (const [id, key] of [['k1', KEY1], ['k2', KEY2]] as const) {
      const sent = b.h.gemini.calls.filter((c) => c.headers['x-goog-api-key'] === key).length;
      expect(rows.find((x) => x.keyId === id)!.requests, id).toBe(sent);
      expect(sent).toBeGreaterThan(0);
    }
    expect(rows.reduce((a, x) => a + x.requests, 0)).toBe(b.h.gemini.calls.length);
  });

  it('the status shows each key by label with its own use, and the totals', async () => {
    await run(ids());
    const s = (await b.owner.get(`${b.base}/ai/status`)).body;
    expect(s.keys.map((k: { id: string; state: string }) => [k.id, k.state])).toEqual([['k1', 'ready'], ['k2', 'ready']]);
    expect(s.keys[0].today.requests + s.keys[1].today.requests).toBe(s.today.requests);
    expect(s.limits.dailyBudget).toBe(2 * b.h.svc.config.GEMINI_DAILY_REQUESTS); // the ceilings of both keys together
    expect(s.limits.rpm).toBe(2 * b.h.svc.config.GEMINI_RPM);
  });

  it('neither key ever appears in a response, a stored record, an address or a request body', async () => {
    await run(ids());
    for (const c of b.h.gemini.calls) {
      expect(c.url).not.toContain(KEY1);
      expect(c.url).not.toContain(KEY2);
      expect(c.body).not.toContain(KEY1);
      expect(c.body).not.toContain(KEY2);
    }
    const bodies = [(await b.owner.get(`${b.base}/ai/status`)).body, (await b.owner.get(`${b.base}/ai/runs`)).body, (await b.owner.get(`${b.base}/ai/suggestions?decided=all&status=all&pageSize=100`)).body, (await b.owner.get(`${b.base}/ai/funnel`)).body];
    for (const body of bodies) for (const k of [KEY1, KEY2]) expect(JSON.stringify(body)).not.toContain(k);
    for (const row of [await b.db.select().from(aiQuotaState), await b.db.select().from(aiUsageDaily), await b.db.select().from(aiMatchRuns)]) for (const k of [KEY1, KEY2]) expect(JSON.stringify(row)).not.toContain(k);
  });
});

describe('a key that is paused or refused is set aside on its own', () => {
  it('when Google pauses the first key (its daily quota), the second key finishes the work', async () => {
    im.intercept = ({ key }) => (key === KEY1 ? quotaResponse('day') : null);
    const r = await run(ids());
    expect(r.status, r.error ?? '').toBe('completed');
    expect(new Set(im.asked.map((a) => a.key))).toEqual(new Set([KEY2]));
    expect(pairsAsked().length).toBe(COUNT);
    const s = (await b.owner.get(`${b.base}/ai/status`)).body;
    const k1 = s.keys.find((k: { id: string }) => k.id === 'k1');
    expect(k1.state).toBe('paused');
    expect(k1.pausedUntil).toBeTruthy();
    expect(s.keys.find((k: { id: string }) => k.id === 'k2').state).toBe('ready');
    expect(s.state).not.toBe('paused'); // one key is still working
  });

  it('when Google refuses the second key, that key is stopped and the first carries on; a person can bring it back', async () => {
    im.intercept = ({ key }) => (key === KEY2 ? { status: 400, json: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } } } : null);
    const r = await run(ids());
    expect(r.status, r.error ?? '').toBe('completed');
    expect(new Set(im.asked.map((a) => a.key))).toEqual(new Set([KEY1]));
    const [k2] = await b.db.select().from(aiQuotaState).where(eq(aiQuotaState.keyId, 'k2'));
    expect(k2!.stopped).toBeTruthy();
    expect(JSON.stringify(k2)).not.toContain(KEY2);
    const s = (await b.owner.get(`${b.base}/ai/status`)).body;
    expect(s.keys.find((k: { id: string }) => k.id === 'k2').state).toBe('stopped');
    expect(s.keys.find((k: { id: string }) => k.id === 'k1').state).toBe('ready');
    expect((await b.owner.post(`${b.base}/ai/resume-gemini`, {})).status).toBe(200);
    expect((await b.db.select().from(aiQuotaState).where(eq(aiQuotaState.keyId, 'k2')))[0]!.stopped).toBeNull();
  });

  it('a non-free-tier quota on one key stops that key only: nothing is ever sent as a paid request', async () => {
    im.intercept = ({ key }) => (key === KEY1 ? { status: 429, json: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel', quotaMetric: 'generativelanguage.googleapis.com/generate_content_requests', quotaValue: '10000' }] }] } } } : null);
    const r = await run(ids());
    expect(r.status, r.error ?? '').toBe('completed');
    expect(new Set(im.asked.map((a) => a.key))).toEqual(new Set([KEY2]));
    expect((await b.db.select().from(aiQuotaState).where(eq(aiQuotaState.keyId, 'k1')))[0]!.stopped).toMatch(/free/i);
  });
});

describe('both keys out of quota: the work waits, then resumes from where it stopped', () => {
  it('pauses with a resume time, never marks anything done, and finishes after the quota resets', async () => {
    let served = 0;
    im.intercept = () => (served++ >= 2 ? quotaResponse('day') : null);
    const res = await b.owner.post(`${b.base}/ai/runs`, { scope: 'products', variantIds: ids(), perSite: 2 });
    await b.h.queue.drain();
    const [paused] = await b.db.select().from(aiMatchRuns).where(eq(aiMatchRuns.id, res.body.run.id));
    expect(paused!.status).toBe('paused');
    expect(paused!.resumeAt).not.toBeNull();
    const s = (await b.owner.get(`${b.base}/ai/status`)).body;
    expect(s.state).toBe('paused');
    expect(s.keys.every((k: { state: string }) => k.state === 'paused')).toBe(true);
    const askedSoFar = pairsAsked().length;
    expect(askedSoFar).toBeLessThan(COUNT);
    im.intercept = null;
    b.h.advance(paused!.resumeAt!.getTime() - b.h.svc.clock().getTime() + 120_000);
    await aiResumeTick(b.h.svc);
    await b.h.queue.drain();
    const [done] = await b.db.select().from(aiMatchRuns).where(eq(aiMatchRuns.id, res.body.run.id));
    expect(done!.status, done!.error ?? '').toBe('completed');
    expect(new Set(pairsAsked()).size).toBe(pairsAsked().length); // nothing asked twice
    expect(pairsAsked().length).toBe(COUNT);
    expect((await b.db.select().from(productMatches).where(eq(productMatches.orgId, b.org))).filter((m) => m.status === 'accepted')).toHaveLength(0); // no policy on: still nothing approved
  });
});

describe('semantic indexing is spread over the keys and survives a stopped key', () => {
  it('embeds in paced batches on both keys, each counted under its own label', async () => {
    for (let i = 0; i < 60; i++) await b.seed('source', `Filler product ${i} for semantic indexing`, { brand: 'Filler' });
    const seen: string[] = [];
    b.h.gemini.set(async (url, init) => {
      if (!url.includes('embed')) return im.handler(url, init);
      seen.push(init.headers['x-goog-api-key'] ?? '');
      const n = (JSON.parse(init.body!) as { requests: unknown[] }).requests.length;
      return { status: 200, json: { embeddings: Array.from({ length: n }, () => ({ values: Array.from({ length: 256 }, (_, i) => Math.sin(i + n)) })), usageMetadata: { promptTokenCount: 10 * n, totalTokenCount: 10 * n } } };
    });
    const svc = { ...b.h.svc, config: { ...b.h.svc.config, GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001' } };
    let guard = 0;
    for (;;) {
      const r = await embedCatalogue(svc, b.org);
      if (r.outcome !== 'continue' || ++guard > 20) { expect(r.outcome).toBe('done'); break; }
    }
    expect(new Set(seen)).toEqual(new Set([KEY1, KEY2]));
    const rows = await b.db.select().from(aiUsageDaily).where(eq(aiUsageDaily.model, 'gemini-embedding-001'));
    expect(rows.map((r) => r.keyId).sort()).toEqual(['k1', 'k2']);
    b.h.gemini.set(im.handler);
  });
});

void [okResponse, aiStatus];
