import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicProvider, fetchOpenErApiRates } from './providers.ts';

/**
 * Request/response handling of the optional third-party providers, against a local server that imitates them.
 * No real API is called (no key, no cost) — so this proves our client code, not the live services.
 */
let server: http.Server;
let base = '';
let received: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_q, r) => r.writeHead(404).end();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      respond(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('AnthropicProvider (local imitation of the Messages API)', () => {
  it('sends the key, version header, model, system prompt and user text, and returns only the text blocks', async () => {
    received = [];
    respond = (_q, res) => json(res, 200, { content: [{ type: 'thinking', text: 'ignored' }, { type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] });
    const p = new AnthropicProvider('sk-test-123', 'claude-haiku-5-5', `${base}/`);
    const out = await p.complete({ system: 'You are terse.', user: 'Say hi', maxTokens: 64 });
    expect(out).toBe('Hello world');

    const r = received[0]!;
    expect(r).toMatchObject({ method: 'POST', url: '/v1/messages' });
    expect(r.headers['x-api-key']).toBe('sk-test-123');
    expect(r.headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(r.body)).toEqual({ model: 'claude-haiku-5-5', max_tokens: 64, system: 'You are terse.', messages: [{ role: 'user', content: 'Say hi' }] });
  });

  it('fails with a status-only message that never contains the key or the provider body', async () => {
    respond = (_q, res) => json(res, 429, { error: { message: 'rate limited for key sk-test-123' } });
    const p = new AnthropicProvider('sk-test-123', 'claude-haiku-5-5', base);
    const err = await p.complete({ system: 's', user: 'u' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('AI provider error (HTTP 429)');
    expect((err as Error).message).not.toContain('sk-test-123');
  });

  it('returns an empty string (not a crash) when the answer has no text blocks', async () => {
    respond = (_q, res) => json(res, 200, { content: [] });
    expect(await new AnthropicProvider('k', 'm', base).complete({ system: 's', user: 'u' })).toBe('');
  });
});

describe('fetchOpenErApiRates (local imitation of open.er-api.com)', () => {
  it('turns a successful answer into per-USD rates stamped with the provider time, skipping USD and invalid values', async () => {
    respond = (_q, res) => json(res, 200, { result: 'success', time_last_update_unix: 1_791_936_000, rates: { USD: 1, AWG: 1.79, EUR: 0.86, BAD: 0, WORSE: -2, NAN: null } });
    const rates = await fetchOpenErApiRates(new Date('2026-10-14T00:00:00Z'), `${base}/v6/latest/USD`);
    expect(rates.map((r) => r.quote).sort()).toEqual(['AWG', 'EUR']);
    expect(rates.every((r) => r.base === 'USD' && r.isFixed === false && r.source.includes('open.er-api.com'))).toBe(true);
    expect(rates[0]!.fetchedAt).toBe(new Date(1_791_936_000 * 1000).toISOString());
  });

  it('rejects an HTTP error and an unexpected body instead of storing guesses', async () => {
    respond = (_q, res) => json(res, 500, {});
    await expect(fetchOpenErApiRates(new Date(), `${base}/x`)).rejects.toThrow(/HTTP 500/);
    respond = (_q, res) => json(res, 200, { result: 'error', 'error-type': 'quota-reached' });
    await expect(fetchOpenErApiRates(new Date(), `${base}/x`)).rejects.toThrow(/unexpected response/);
  });
});
