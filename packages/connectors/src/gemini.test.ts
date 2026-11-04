import { describe, expect, it } from 'vitest';
import { classifyGeminiError, geminiEmbed, geminiGenerateJson, geminiListModels, isFreeTierQuota, parseRetryDelay, type GeminiHttp } from './gemini.ts';

/** The Gemini Developer API against LOCAL imitations of its documented (and observed) answers. No request is made to Google. */
const KEY = 'test-gemini-key-FFFF';
const CFG = { apiKey: KEY, model: 'gemini-3.5-flash-lite', embeddingModel: 'gemini-embedding-2' };
const SCHEMA = { type: 'OBJECT', properties: { decisions: { type: 'ARRAY' } } };
const req = { system: 'sys', user: 'user', schema: SCHEMA, maxOutputTokens: 500 };

const quota429 = (quotaId: string, metric: string, value: string, retry = '18s') => ({
  error: {
    code: 429,
    message: `You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: ${metric}, limit: ${value}, model: gemini-3.5-flash-lite\nPlease retry in 18.686539932s.`,
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: metric, quotaId, quotaDimensions: { model: 'gemini-3.5-flash-lite' }, quotaValue: value }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: retry },
    ],
  },
});
const ok = (text: string, extra: Record<string, unknown> = {}) => ({ status: 200, json: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 60, totalTokenCount: 180 }, ...extra } });

describe('how Google answers are understood', () => {
  it('reads a free-tier per-minute 429 exactly as Google sent it: which quota, its limit, and when to ask again', () => {
    const e = classifyGeminiError(CFG, 429, quota429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'generativelanguage.googleapis.com/generate_content_free_tier_requests', '15'));
    expect(e).toMatchObject({ kind: 'quota_minute', quotaValue: 15, retryAfterSeconds: 18, quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' });
    expect(e.message).toMatch(/per-minute/);
  });
  it('tells a daily quota and a token quota apart', () => {
    expect(classifyGeminiError(CFG, 429, quota429('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'generativelanguage.googleapis.com/generate_content_free_tier_requests', '250')).kind).toBe('quota_day');
    expect(classifyGeminiError(CFG, 429, quota429('GenerateContentInputTokensPerModelPerMinute-FreeTier', 'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count', '250000')).kind).toBe('quota_tokens');
  });
  it('treats a quota that is not a free-tier quota as a reason to stop, never to push on', () => {
    const e = classifyGeminiError(CFG, 429, quota429('GenerateRequestsPerMinutePerProjectPerModel', 'generativelanguage.googleapis.com/generate_content_requests', '1000'));
    expect(e.kind).toBe('paid_tier');
    expect(isFreeTierQuota('X-FreeTier', undefined)).toBe(true);
    expect(isFreeTierQuota('X', 'generate_content_free_tier_requests')).toBe(true);
    expect(isFreeTierQuota('X', 'generate_content_requests')).toBe(false);
  });
  it('classifies the other answers: model not offered to this project, refused key, overload, server trouble, bad request', () => {
    expect(classifyGeminiError(CFG, 404, { error: { code: 404, status: 'NOT_FOUND', message: 'This model models/gemini-2.5-flash-lite is no longer available to new users.' } }).kind).toBe('model_unavailable');
    expect(classifyGeminiError(CFG, 403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'denied' } }).kind).toBe('invalid_key');
    expect(classifyGeminiError(CFG, 400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } }).kind).toBe('invalid_key');
    expect(classifyGeminiError(CFG, 503, { error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' } }).kind).toBe('overloaded');
    expect(classifyGeminiError(CFG, 500, {}).kind).toBe('transient');
    expect(classifyGeminiError(CFG, 400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload' } }).kind).toBe('bad_request');
  });
  it('never repeats the key in a message', () => {
    const e = classifyGeminiError(CFG, 400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: `bad request for key ${KEY}` } });
    expect(e.message).not.toContain(KEY);
  });
  it('reads retry delays', () => {
    expect(parseRetryDelay('18s')).toBe(18);
    expect(parseRetryDelay('18.686539932s')).toBeCloseTo(18.69, 1);
    expect(parseRetryDelay('2m')).toBe(120);
    expect(parseRetryDelay('250ms')).toBe(0.25);
    expect(parseRetryDelay('soon')).toBeUndefined();
  });
});

describe('structured generation', () => {
  it('sends the key in a header only, with the schema and the output limit, and returns the parsed answer with the token usage', async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const http: GeminiHttp = async (url, init) => { seen.push({ url, headers: init.headers, body: init.body ?? '' }); return ok('{"decisions":[{"id":"1.1"}]}'); };
    const r = await geminiGenerateJson(CFG, { ...req, thinking: { level: 'minimal' } }, http);
    expect(r).toMatchObject({ ok: true, json: { decisions: [{ id: '1.1' }] }, usage: { promptTokens: 120, outputTokens: 60, totalTokens: 180 }, finishReason: 'STOP' });
    expect(seen[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    expect(seen[0]!.url).not.toContain(KEY);
    expect(seen[0]!.headers['x-goog-api-key']).toBe(KEY);
    const body = JSON.parse(seen[0]!.body);
    expect(body.generationConfig).toMatchObject({ responseMimeType: 'application/json', responseSchema: SCHEMA, maxOutputTokens: 500, temperature: 0, thinkingConfig: { thinkingLevel: 'minimal' } });
    expect(seen[0]!.body).not.toContain(KEY);
  });
  it('counts thinking tokens when the model reports them', async () => {
    const r = await geminiGenerateJson(CFG, req, async () => ok('{}', { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 300, totalTokenCount: 420 } }));
    expect(r).toMatchObject({ ok: true, usage: { thoughtsTokens: 300, totalTokens: 420 } });
  });
  it('reports an answer cut off at the output limit, and an answer that is not JSON, as retryable failures that keep the usage', async () => {
    const cut = await geminiGenerateJson(CFG, req, async () => ({ status: 200, json: { candidates: [{ content: { parts: [{ text: '{"decis' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 500, totalTokenCount: 510 } } }));
    expect(cut).toMatchObject({ ok: false, error: { kind: 'truncated' }, usage: { outputTokens: 500 } });
    const junk = await geminiGenerateJson(CFG, req, async () => ok('not json at all'));
    expect(junk).toMatchObject({ ok: false, error: { kind: 'truncated' } });
  });
  it('reports a blocked prompt', async () => {
    const r = await geminiGenerateJson(CFG, req, async () => ({ status: 200, json: { promptFeedback: { blockReason: 'SAFETY' } } }));
    expect(r).toMatchObject({ ok: false, error: { kind: 'blocked' } });
  });
  it('turns an HTTP error into a classified failure, without throwing', async () => {
    const r = await geminiGenerateJson(CFG, req, async () => ({ status: 429, json: quota429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'generativelanguage.googleapis.com/generate_content_free_tier_requests', '15') }));
    expect(r).toMatchObject({ ok: false, error: { kind: 'quota_minute', retryAfterSeconds: 18 } });
  });
  it('does nothing without a key, and turns a network failure into a failure that never quotes the key', async () => {
    expect(await geminiGenerateJson({ model: 'm' }, req, async () => { throw new Error('must not be called'); })).toMatchObject({ ok: false, error: { kind: 'not_configured' } });
    const r = await geminiGenerateJson(CFG, req, async () => { throw new Error(`connect ETIMEDOUT with key ${KEY}`); });
    expect(r).toMatchObject({ ok: false, error: { kind: 'transient' } });
    expect((r as { error: { message: string } }).error.message).not.toContain(KEY);
    const timeout = await geminiGenerateJson(CFG, req, async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
    expect(timeout).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  });
});

describe('embeddings and model list', () => {
  it('embeds a batch with a reduced dimension and checks the count', async () => {
    const seen: string[] = [];
    const http: GeminiHttp = async (url, init) => { seen.push(url + init.body); return { status: 200, json: { embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }], usageMetadata: { promptTokenCount: 40, totalTokenCount: 40 } } }; };
    const r = await geminiEmbed(CFG, ['a', 'b'], { dimensions: 2 }, http);
    expect(r).toMatchObject({ ok: true, vectors: [[0.1, 0.2], [0.3, 0.4]], usage: { promptTokens: 40 } });
    expect(seen[0]).toContain('gemini-embedding-2:batchEmbedContents');
    expect(seen[0]).toContain('"outputDimensionality":2');
    expect(seen[0]).not.toContain(KEY);
    expect(await geminiEmbed(CFG, ['a', 'b', 'c'], {}, http)).toMatchObject({ ok: false });
    expect(await geminiEmbed({ apiKey: KEY, model: 'm' }, ['a'])).toMatchObject({ ok: false, error: { kind: 'not_configured' } });
  });
  it('lists the models a key can use, following pages', async () => {
    let n = 0;
    const http: GeminiHttp = async () => (n++ === 0 ? { status: 200, json: { models: [{ name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'p2' } } : { status: 200, json: { models: [{ name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent'] }] } });
    expect(await geminiListModels(CFG, http)).toEqual({ ok: true, models: [{ name: 'gemini-3.5-flash-lite', methods: ['generateContent'] }, { name: 'gemini-embedding-2', methods: ['embedContent'] }] });
    expect(await geminiListModels({ model: 'm' })).toMatchObject({ ok: false, error: { kind: 'not_configured' } });
  });
});
