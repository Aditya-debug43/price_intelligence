import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, errorMessage, orgPath, requestHeaders } from '../../apps/web/src/api.ts';

/**
 * Found when "Remove website and its data" answered 400 Bad Request: `api.del` declared `content-type: application/json` but sent no body, and the
 * API (Fastify) rejects that combination ("Body cannot be empty when content-type is set to 'application/json'"). Every bodyless DELETE — remove a
 * website, revoke an invitation, remove a member, disconnect an integration — failed the same way, while the server tests (which sent DELETE with no
 * content type at all) stayed green. These tests pin the request the browser really sends.
 */
type Seen = { url: string; method: string; headers: Record<string, string>; body: unknown };
let seen: Seen[] = [];

function stubFetch(status: number, payload: unknown) {
  seen = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: unknown }) => {
      seen.push({ url, method: init.method, headers: init.headers, body: init.body });
      return new Response(payload === null ? null : JSON.stringify(payload), { status });
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe('request headers', () => {
  it('declare a JSON content type only when there is a JSON body', () => {
    expect(requestHeaders(true)).toMatchObject({ 'content-type': 'application/json', 'x-requested-with': 'ci-web', accept: 'application/json' });
    const bodyless = requestHeaders(false);
    expect(bodyless).not.toHaveProperty('content-type');
    expect(bodyless).toMatchObject({ 'x-requested-with': 'ci-web', accept: 'application/json' }); // the CSRF header is always sent
  });
});

describe('what each helper actually sends', () => {
  it('DELETE (remove a website) sends no body and therefore no content type — the 400 of the bug report', async () => {
    stubFetch(200, { ok: true });
    await api.del(orgPath('org-1', '/sites/site-1'));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: '/api/v1/orgs/org-1/sites/site-1', method: 'DELETE', body: undefined });
    expect(seen[0]!.headers).not.toHaveProperty('content-type');
    expect(seen[0]!.headers['x-requested-with']).toBe('ci-web');
  });

  it('GET sends no body and no content type either', async () => {
    stubFetch(200, { sites: [] });
    await api.get('/api/v1/orgs/org-1/sites');
    expect(seen[0]!.headers).not.toHaveProperty('content-type');
    expect(seen[0]!.body).toBeUndefined();
  });

  it('POST, PUT and PATCH keep sending a JSON body with its content type — an empty one defaults to {}', async () => {
    stubFetch(200, { ok: true });
    await api.post('/p', { a: 1 });
    await api.post('/p');
    await api.put('/p', { b: 2 });
    await api.patch('/p', { c: 3 });
    expect(seen.map((s) => [s.method, s.headers['content-type'], s.body])).toEqual([
      ['POST', 'application/json', '{"a":1}'],
      ['POST', 'application/json', '{}'],
      ['PUT', 'application/json', '{"b":2}'],
      ['PATCH', 'application/json', '{"c":3}'],
    ]);
  });
});

describe('failures are reported with the server’s own message', () => {
  it('turns an error response into an ApiError carrying status, code and message, which is what the dialog shows', async () => {
    stubFetch(404, { error: { code: 'not_found', message: 'Website not found.' } });
    const e = await api.del('/api/v1/orgs/o/sites/s').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 404, code: 'not_found', message: 'Website not found.' });
    expect(errorMessage(e)).toBe('Website not found.');
  });

  it('still produces a readable message when the server sends no JSON at all', async () => {
    stubFetch(502, null);
    const e = await api.del('/api/v1/orgs/o/sites/s').catch((x: unknown) => x);
    expect(errorMessage(e)).toBe('Request failed (502)');
  });

  it('returns the parsed body on success', async () => {
    stubFetch(200, { ok: true });
    expect(await api.del('/api/v1/orgs/o/sites/s')).toEqual({ ok: true });
  });
});
