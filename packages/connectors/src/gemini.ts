/**
 * Client for the official Google Gemini Developer API (generativelanguage.googleapis.com). Backend only.
 *
 * Rules this file keeps:
 *  - the API key travels in the `x-goog-api-key` header, never in an address, so it cannot reach a log line, a stored message or a response;
 *    every message that could quote it is redacted;
 *  - nothing here retries or paces: the caller owns rate limiting, so one place decides how fast Shelfwatch talks to Google;
 *  - every failure is classified from Google's own error shape (a free-tier quota names the quota that was hit and when to ask again);
 *  - a quota that is NOT a free-tier quota is reported as `paid_tier`, so the caller can stop before anything could be billed.
 */

export interface GeminiConfig {
  apiKey?: string;
  model: string;
  embeddingModel?: string;
  timeoutMs?: number;
}

export interface GeminiHttpInit {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export type GeminiHttp = (url: string, init: GeminiHttpInit) => Promise<{ status: number; json: unknown; headers?: Record<string, string> }>;

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const defaultGeminiHttp: GeminiHttp = async (url, init) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), init.timeoutMs);
  try {
    const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: ac.signal });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, json, headers };
  } finally {
    clearTimeout(t);
  }
};

export type GeminiErrorKind =
  | 'not_configured'
  | 'invalid_key'
  | 'quota_minute'
  | 'quota_day'
  | 'quota_tokens'
  | 'paid_tier'
  | 'model_unavailable'
  | 'overloaded'
  | 'timeout'
  | 'bad_request'
  | 'blocked'
  | 'truncated'
  | 'transient';

export interface GeminiError {
  kind: GeminiErrorKind;
  status: number;
  /** A sentence for people. Never contains the key. */
  message: string;
  /** How long Google asked us to wait (429), in seconds. */
  retryAfterSeconds?: number;
  /** The quota that was hit, as Google names it ("GenerateRequestsPerMinutePerProjectPerModel-FreeTier"), and its limit. */
  quotaId?: string;
  quotaMetric?: string;
  quotaValue?: number;
}

export interface GeminiUsage {
  promptTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && Number.isFinite(Number(v)) ? Number(v) : 0);

const redact = (cfg: GeminiConfig, text: string): string => (cfg.apiKey ? text.split(cfg.apiKey).join('[key]') : text);
const headers = (cfg: GeminiConfig) => ({ 'x-goog-api-key': cfg.apiKey ?? '', 'content-type': 'application/json' });

/** "18s", "18.686539932s", "1m" → seconds. */
export function parseRetryDelay(v: unknown): number | undefined {
  const t = s(v);
  if (!t) return undefined;
  const m = t.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/);
  if (!m) return undefined;
  const x = Number(m[1]);
  return m[2] === 'ms' ? x / 1000 : m[2] === 'm' ? x * 60 : x;
}

/** Whether a quota name belongs to the free tier ("…-FreeTier", "generate_content_free_tier_requests"). A paid-tier quota means billing may apply. */
export const isFreeTierQuota = (quotaId?: string, metric?: string): boolean => /free[_-]?tier/i.test(`${quotaId ?? ''} ${metric ?? ''}`);

/** Reads Google's error body into something the caller can act on. Pure. */
export function classifyGeminiError(cfg: GeminiConfig, status: number, json: unknown): GeminiError {
  const e = o(o(json)['error']);
  const gStatus = s(e['status']) ?? '';
  const message = redact(cfg, s(e['message']) ?? `HTTP ${status}`);
  const details = arr(e['details']).map(o);
  const failure = details.find((d) => String(d['@type']).endsWith('QuotaFailure'));
  const violation = o(arr(failure?.['violations'])[0]);
  const quotaId = s(violation['quotaId']) ?? undefined;
  const quotaMetric = s(violation['quotaMetric']) ?? undefined;
  const quotaValue = n(violation['quotaValue']) || undefined;
  const retry = parseRetryDelay(o(details.find((d) => String(d['@type']).endsWith('RetryInfo')))['retryDelay']) ?? (/retry in ([\d.]+)s/i.exec(message) ? Number(/retry in ([\d.]+)s/i.exec(message)![1]) : undefined);
  const base = { status, retryAfterSeconds: retry, quotaId, quotaMetric, quotaValue };
  if (status === 429 || gStatus === 'RESOURCE_EXHAUSTED') {
    // a quota that is not a free-tier one means the project is billed: stop, never push on
    if ((quotaId || quotaMetric) && !isFreeTierQuota(quotaId, quotaMetric)) return { ...base, kind: 'paid_tier', message: 'Google reports a non-free-tier quota for this project. Gemini processing is stopped so that nothing could be billed.' };
    const q = `${quotaId ?? ''} ${quotaMetric ?? ''} ${message}`;
    if (/PerDay|per day|daily/i.test(q)) return { ...base, kind: 'quota_day', message: `The free daily request quota is used up${quotaValue ? ` (${quotaValue} a day)` : ''}. Gemini processing resumes after it resets (midnight Pacific Time).` };
    if (/token/i.test(q)) return { ...base, kind: 'quota_tokens', message: `The free per-minute token quota was reached${quotaValue ? ` (${quotaValue})` : ''}; waiting before the next request.` };
    return { ...base, kind: 'quota_minute', message: `The free per-minute request quota was reached${quotaValue ? ` (${quotaValue} a minute)` : ''}; waiting before the next request.` };
  }
  if (status === 404 || gStatus === 'NOT_FOUND') return { ...base, kind: 'model_unavailable', message: `The model is not available to this project: ${message}` };
  if (status === 401 || status === 403 || /API[_ ]KEY/i.test(`${gStatus} ${message}`) && status === 400) return { ...base, kind: 'invalid_key', message: 'Google refused the API key (missing, invalid, restricted or without access to this model).' };
  if (status === 503 || gStatus === 'UNAVAILABLE') return { ...base, kind: 'overloaded', message: 'The model is overloaded at the moment (HTTP 503). It will be tried again later.' };
  if (status === 408 || status === 504) return { ...base, kind: 'timeout', message: `Google did not answer in time (HTTP ${status}).` };
  if (status >= 500) return { ...base, kind: 'transient', message: `Google had a problem (HTTP ${status}).` };
  return { ...base, kind: 'bad_request', message: `Google rejected the request (HTTP ${status}): ${message.slice(0, 300)}` };
}

const usageOf = (json: unknown): GeminiUsage => {
  const u = o(o(json)['usageMetadata']);
  const prompt = n(u['promptTokenCount']);
  const out = n(u['candidatesTokenCount']);
  const thoughts = n(u['thoughtsTokenCount']);
  return { promptTokens: prompt, outputTokens: out, thoughtsTokens: thoughts, totalTokens: n(u['totalTokenCount']) || prompt + out + thoughts, cachedTokens: n(u['cachedContentTokenCount']) };
};

export interface GenerateRequest {
  system: string;
  user: string;
  /** OpenAPI-subset schema for the answer (Gemini `responseSchema`). */
  schema: Obj;
  maxOutputTokens: number;
  temperature?: number;
  /** For models that think before answering: how much. Omitted = the model's default. */
  thinking?: { level?: 'minimal' | 'low' | 'medium' | 'high'; budget?: number };
}

export type GenerateResult =
  | { ok: true; text: string; json: unknown; usage: GeminiUsage; ms: number; finishReason: string }
  | { ok: false; error: GeminiError; ms: number; usage?: GeminiUsage };

/** One structured-JSON generation. A truncated or unparsable answer is a failure the caller can retry with a smaller request. */
export async function geminiGenerateJson(cfg: GeminiConfig, req: GenerateRequest, http: GeminiHttp = defaultGeminiHttp): Promise<GenerateResult> {
  const t0 = Date.now();
  if (!cfg.apiKey) return { ok: false, ms: 0, error: { kind: 'not_configured', status: 0, message: 'No Gemini API key is configured (GEMINI_API_KEY).' } };
  const generationConfig: Obj = { responseMimeType: 'application/json', responseSchema: req.schema, temperature: req.temperature ?? 0, maxOutputTokens: req.maxOutputTokens };
  if (req.thinking) generationConfig['thinkingConfig'] = req.thinking.budget !== undefined ? { thinkingBudget: req.thinking.budget } : { thinkingLevel: req.thinking.level };
  const body = JSON.stringify({ systemInstruction: { parts: [{ text: req.system }] }, contents: [{ role: 'user', parts: [{ text: req.user }] }], generationConfig });
  try {
    const r = await http(`${BASE}/models/${encodeURIComponent(cfg.model)}:generateContent`, { method: 'POST', headers: headers(cfg), body, timeoutMs: cfg.timeoutMs ?? 90_000 });
    const ms = Date.now() - t0;
    if (r.status !== 200) return { ok: false, ms, error: classifyGeminiError(cfg, r.status, r.json) };
    const usage = usageOf(r.json);
    const cand = o(arr(o(r.json)['candidates'])[0]);
    const finishReason = s(cand['finishReason']) ?? 'UNKNOWN';
    const text = arr(o(cand['content'])['parts']).map((p) => s(o(p)['text']) ?? '').join('');
    const blocked = s(o(o(r.json)['promptFeedback'])['blockReason']);
    if (blocked) return { ok: false, ms, usage, error: { kind: 'blocked', status: 200, message: `Google declined to answer (${blocked}).` } };
    if (finishReason === 'MAX_TOKENS') return { ok: false, ms, usage, error: { kind: 'truncated', status: 200, message: 'The answer was cut off at the output limit.' } };
    try {
      return { ok: true, text, json: JSON.parse(text), usage, ms, finishReason };
    } catch {
      return { ok: false, ms, usage, error: { kind: 'truncated', status: 200, message: 'The answer was not valid JSON.' } };
    }
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError';
    return { ok: false, ms: Date.now() - t0, error: { kind: aborted ? 'timeout' : 'transient', status: 0, message: redact(cfg, aborted ? 'Google did not answer in time.' : `The request to Google failed: ${(e as Error).message}`) } };
  }
}

export type EmbedResult = { ok: true; vectors: number[][]; usage: GeminiUsage; ms: number } | { ok: false; error: GeminiError; ms: number };

/** Embeddings of a batch of texts (the free tier counts every text as a request: about 100 a minute). Optional, not used unless enabled. */
export async function geminiEmbed(cfg: GeminiConfig, texts: string[], opts: { dimensions?: number; task?: string } = {}, http: GeminiHttp = defaultGeminiHttp): Promise<EmbedResult> {
  const t0 = Date.now();
  if (!cfg.apiKey || !cfg.embeddingModel) return { ok: false, ms: 0, error: { kind: 'not_configured', status: 0, message: 'No Gemini API key or embedding model is configured.' } };
  const model = cfg.embeddingModel;
  const body = JSON.stringify({ requests: texts.map((t) => ({ model: `models/${model}`, content: { parts: [{ text: t }] }, taskType: opts.task ?? 'SEMANTIC_SIMILARITY', ...(opts.dimensions ? { outputDimensionality: opts.dimensions } : {}) })) });
  try {
    const r = await http(`${BASE}/models/${encodeURIComponent(model)}:batchEmbedContents`, { method: 'POST', headers: headers(cfg), body, timeoutMs: cfg.timeoutMs ?? 90_000 });
    const ms = Date.now() - t0;
    if (r.status !== 200) return { ok: false, ms, error: classifyGeminiError(cfg, r.status, r.json) };
    const vectors = arr(o(r.json)['embeddings']).map((e) => arr(o(e)['values']).map(Number));
    if (vectors.length !== texts.length) return { ok: false, ms, error: { kind: 'bad_request', status: 200, message: 'Google returned a different number of embeddings than texts sent.' } };
    return { ok: true, vectors, usage: usageOf(r.json), ms };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: { kind: (e as Error).name === 'AbortError' ? 'timeout' : 'transient', status: 0, message: redact(cfg, `The request to Google failed: ${(e as Error).message}`) } };
  }
}

/** The models this key can use (names only). Costs no quota. */
export async function geminiListModels(cfg: GeminiConfig, http: GeminiHttp = defaultGeminiHttp): Promise<{ ok: true; models: { name: string; methods: string[] }[] } | { ok: false; error: GeminiError }> {
  if (!cfg.apiKey) return { ok: false, error: { kind: 'not_configured', status: 0, message: 'No Gemini API key is configured (GEMINI_API_KEY).' } };
  const models: { name: string; methods: string[] }[] = [];
  let token = '';
  for (let i = 0; i < 10; i++) {
    const r = await http(`${BASE}/models?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, { method: 'GET', headers: headers(cfg), timeoutMs: cfg.timeoutMs ?? 30_000 }).catch((e: Error) => ({ status: 0, json: { error: { message: e.message } } }));
    if (r.status !== 200) return { ok: false, error: classifyGeminiError(cfg, r.status, r.json) };
    for (const m of arr(o(r.json)['models']).map(o)) models.push({ name: (s(m['name']) ?? '').replace(/^models\//, ''), methods: arr(m['supportedGenerationMethods']).map(String) });
    token = s(o(r.json)['nextPageToken']) ?? '';
    if (!token) break;
  }
  return { ok: true, models };
}
