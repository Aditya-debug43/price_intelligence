import { describe, expect, it } from 'vitest';
import { AccessDeniedError, DomainLimiter, FetchError, SafeFetcher, httpFailure, isTransientCode, retryAfterOf, type TransportResponse } from '@ci/connectors';
import { CONTINUATION_WINDOW_MS, MAX_IDLE_CONTINUATIONS, isContinuablePause, nextAttemptDelayMs, planContinuation } from '@ci/services';

/**
 * Directive 14 (auxito.com, shop.lingandsons.com): a website that answers "slow down" (429) or is briefly unavailable has refused nothing. These pin how the
 * fetcher treats such answers, how a failure is classified, and the waiting schedule of a paused collection.
 */
const bodyOf = (s: string): AsyncIterable<Uint8Array> => (async function* () { yield Buffer.from(s); })();
const reply = (status: number, body = '{}', headers: Record<string, string> = {}): TransportResponse => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: bodyOf(body) });

function fetcherWith(script: (n: number, url: string) => TransportResponse, limiter = new DomainLimiter({ delayMs: 0, maxConcurrency: 4 }, Date.now, async () => {}), policy: ConstructorParameters<typeof SafeFetcher>[0] = {}) {
  let n = 0;
  const seen: string[] = [];
  const f = new SafeFetcher({ maxRetries: 2, ...policy }, {
    limiter,
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async (url) => {
      seen.push(url.toString());
      return script(++n, url.toString());
    },
  });
  return { f, seen, limiter };
}
const PLAIN = { 'content-type': 'text/plain' };
const URL_1 ='https://shop.example.test/products.json?limit=250&page=4';

describe('a website that says "slow down"', () => {
  it('is waited out when it names a short wait, and the request succeeds on a later attempt', async () => {
    const { f, seen } = fetcherWith((n) => (n < 3 ? reply(429, 'slow', { 'retry-after': '2' }) : reply(200, '{"products":[]}')));
    const res = await f.fetch(URL_1, { kind: 'json', skipRobots: true });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(3);
  });

  it('is NOT slept through when it asks for a long wait: the answer is handed back at once, with its Retry-After, so the collection can pause', async () => {
    const { f, seen } = fetcherWith(() => reply(429, 'slow', { 'retry-after': '300' }));
    const res = await f.fetch(URL_1, { kind: 'json', skipRobots: true });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('300');
    expect(seen).toHaveLength(1);
  });

  it('is never held against the website: any number of 429s later it can still be fetched (it is not "blocked")', async () => {
    const { f } = fetcherWith(() => reply(429, 'slow'), undefined, { maxRetries: 0 });
    for (let i = 0; i < 6; i++) expect((await f.fetch(URL_1, { kind: 'json', skipRobots: true })).status).toBe(429);
    const ok = fetcherWith(() => reply(200, '{"products":[]}'), undefined, { maxRetries: 0 });
    expect((await ok.f.fetch(URL_1, { kind: 'json', skipRobots: true })).status).toBe(200);
  });

  it('makes the website’s later requests wait longer, and eases off as they succeed', async () => {
    let now = 1_000_000;
    const waits: number[] = [];
    const limiter = new DomainLimiter({ delayMs: 1500, maxConcurrency: 1 }, () => now, async (ms) => { waits.push(ms); now += ms; });
    const { f } = fetcherWith((n) => (n === 1 ? reply(429, 'slow', { 'retry-after': '1' }) : reply(200, '{"products":[]}')), limiter);
    await f.fetch(URL_1, { kind: 'json', skipRobots: true });
    expect(limiter.penalty('shop.example.test')).toBeGreaterThan(0);
    const penalised = limiter.penalty('shop.example.test');
    for (let i = 0; i < 30; i++) await f.fetch(URL_1, { kind: 'json', skipRobots: true });
    expect(limiter.penalty('shop.example.test')).toBeLessThan(penalised);
    expect(limiter.penalty('shop.example.test')).toBe(0);
  });
});

describe('an explicit refusal (401, 403) still stops the run — and only that run', () => {
  it('stops after three in a row for the fetcher that met them, and a later fetcher sharing the same limiter is not blocked', async () => {
    const limiter = new DomainLimiter({ delayMs: 0, maxConcurrency: 4 }, Date.now, async () => {});
    const a = fetcherWith(() => reply(403, 'no'), limiter, { maxRetries: 0 });
    await a.f.fetch(URL_1, { kind: 'json', skipRobots: true });
    await a.f.fetch(URL_1, { kind: 'json', skipRobots: true });
    await expect(a.f.fetch(URL_1, { kind: 'json', skipRobots: true })).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(a.f.fetch(URL_1, { kind: 'json', skipRobots: true })).rejects.toBeInstanceOf(AccessDeniedError); // stopped for this run
    // the next collection of the same website (another fetcher, the same worker-wide limiter) starts fresh
    const b = fetcherWith(() => reply(200, '{"products":[]}'), limiter, { maxRetries: 0 });
    expect((await b.f.fetch(URL_1, { kind: 'json', skipRobots: true })).status).toBe(200);
  });
});

describe('robots.txt that cannot be read right now is a pause, not a refusal', () => {
  it.each([[429], [503], [500]])('HTTP %i on robots.txt: the fetch fails as a temporary condition, it is not remembered, and the next attempt asks again', async (status) => {
    let robotsAnswers = 0;
    const { f } = fetcherWith((_n, url) => {
      if (url.endsWith('/robots.txt')) return ++robotsAnswers <= 1 ? reply(status, 'busy', PLAIN) : reply(200, 'User-agent: *\nDisallow: /cart\n', PLAIN);
      return reply(200, '{"products":[]}');
    }, undefined, { maxRetries: 0 });
    const first = await f.fetch(URL_1, { kind: 'json' }).catch((e) => e as FetchError);
    expect(first).toBeInstanceOf(FetchError);
    expect((first as FetchError).code).toBe(status === 429 ? 'rate_limited' : 'temporarily_unavailable');
    expect(isTransientCode((first as FetchError).code)).toBe(true);
    // robots.txt answers properly the second time: the site is fetched (it was never "closed")
    expect((await f.fetch(URL_1, { kind: 'json' })).status).toBe(200);
  });

  it('a robots.txt that forbids is still obeyed', async () => {
    const { f } = fetcherWith((_n, url) => (url.endsWith('/robots.txt') ? reply(200, 'User-agent: *\nDisallow: /\n', PLAIN) : reply(200, '{}')));
    await expect(f.fetch(URL_1, { kind: 'json' })).rejects.toMatchObject({ code: 'robots' });
  });
});

describe('what a non-success answer means', () => {
  const h = (status: number, headers: Record<string, string> = {}) => httpFailure({ status, headers }, 'The feed');
  it('classifies 429, brief outages and everything else', () => {
    expect(h(429, { 'retry-after': '120' })).toMatchObject({ code: 'rate_limited', status: 429, retryAfterMs: 120_000 });
    expect(h(429).retryAfterMs).toBeNull();
    for (const s of [500, 502, 503, 504, 408]) expect(h(s), String(s)).toMatchObject({ code: 'temporarily_unavailable', status: s });
    for (const s of [400, 410, 422]) expect(h(s), String(s)).toMatchObject({ code: 'http_error', status: s });
    expect(h(429).message).toMatch(/asked Shelfwatch to slow down/);
  });
  it('knows which failures are temporary and what wait was asked for', () => {
    for (const c of ['rate_limited', 'temporarily_unavailable', 'timeout', 'network']) expect(isTransientCode(c), c).toBe(true);
    for (const c of ['robots', 'access_denied', 'ssrf', 'feed_unavailable', 'http_error', 'invalid_url', undefined, null]) expect(isTransientCode(c), String(c)).toBe(false);
    expect(retryAfterOf(h(429, { 'retry-after': '30' }))).toBe(30_000);
    expect(retryAfterOf(new Error('x'))).toBeNull();
  });
});

describe('the schedule of a paused collection', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const MIN = 60_000;
  it('waits 2, 4, 8, 16, 32, then 60 minutes while nothing new is saved, never less than the website asked, never more than an hour', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map((i) => nextAttemptDelayMs(i, null) / MIN)).toEqual([2, 4, 8, 16, 32, 60, 60, 60]);
    expect(nextAttemptDelayMs(0, 10 * MIN)).toBe(10 * MIN);
    expect(nextAttemptDelayMs(0, 90 * MIN)).toBe(60 * MIN);
    expect(nextAttemptDelayMs(3, 1000)).toBe(16 * MIN);
  });

  it('starts the waiting over whenever a sitting saved something new, and stops trying after too many that did not', () => {
    const base = { now, retryAfterMs: null };
    expect(planContinuation({ ...base, savedBefore: 0, savedAfter: 750, idleBefore: 4 })).toMatchObject({ idle: 0 });
    expect(planContinuation({ ...base, savedBefore: 750, savedAfter: 750, idleBefore: 0 }).nextAttemptAt!.getTime() - now.getTime()).toBe(4 * MIN);
    expect(planContinuation({ ...base, savedBefore: 750, savedAfter: 750, idleBefore: MAX_IDLE_CONTINUATIONS - 1 }).nextAttemptAt).not.toBeNull();
    expect(planContinuation({ ...base, savedBefore: 750, savedAfter: 750, idleBefore: MAX_IDLE_CONTINUATIONS })).toMatchObject({ idle: MAX_IDLE_CONTINUATIONS + 1, nextAttemptAt: null });
  });

  it('only a recent, partial, non-sample run that stopped for a temporary reason can be continued (including runs saved before pausing existed)', () => {
    const run = (o: Record<string, unknown> = {}) => ({ status: 'partial', kind: 'discovery', finishedAt: new Date(now.getTime() - 5 * MIN), errorCode: 'rate_limited', error: 'x', ...o }) as Parameters<typeof isContinuablePause>[0];
    expect(isContinuablePause(run(), now)).toBe(true);
    expect(isContinuablePause(run({ errorCode: 'http_error', error: 'Shopify feed returned HTTP 429' }), now)).toBe(true); // auxito.com's run, as it is stored
    expect(isContinuablePause(run({ errorCode: 'http_error', error: 'Shopify feed returned HTTP 503' }), now)).toBe(true);
    for (const o of [
      { errorCode: 'http_error', error: 'Shopify feed returned HTTP 410' }, { errorCode: 'feed_shorter_than_catalogue' }, { errorCode: 'products_skipped' }, { errorCode: 'deadline' },
      { errorCode: 'request_budget' }, { errorCode: 'feed_not_paging' }, { errorCode: null }, { status: 'succeeded' }, { status: 'failed' }, { kind: 'sample' }, { finishedAt: null },
      { finishedAt: new Date(now.getTime() - CONTINUATION_WINDOW_MS - 1) },
    ]) expect(isContinuablePause(run(o), now), JSON.stringify(o)).toBe(false);
  });
});
