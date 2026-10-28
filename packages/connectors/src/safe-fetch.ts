import dns from 'node:dns';
import { isIP } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  EMPTY_ROBOTS,
  UrlValidationError,
  forbiddenAddressReason,
  forbiddenHostnameReason,
  parseRobots,
  robotsCrawlDelay,
  robotsDecision,
  robotsFromStatus,
  sha256Hex,
  DISALLOW_ALL_ROBOTS,
  type ParsedRobots,
} from '@ci/core';

// ───────────────────────────────────────────────────────────── errors

export class FetchError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'ssrf'
      | 'robots'
      | 'access_denied'
      | 'too_large'
      | 'content_type'
      | 'timeout'
      | 'rate_limited'
      | 'temporarily_unavailable'
      | 'network'
      | 'redirect'
      | 'budget'
      | 'invalid_url',
    readonly url?: string,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

/** Access gates and bot protection are respected, never circumvented. */
export class AccessDeniedError extends FetchError {
  constructor(message: string, url?: string) {
    super(message, 'access_denied', url);
    this.name = 'AccessDeniedError';
  }
}

// ───────────────────────────────────────────────────────────── policy

export interface FetchPolicy {
  userAgent: string;
  timeoutMs: number;
  maxHtmlBytes: number;
  maxJsonBytes: number;
  maxPdfBytes: number;
  maxRedirects: number;
  /** Permit loopback targets. A constructor-level test seam only: `fetchPolicyFrom(config)` always sets it to false and no setting or request can change that. */
  allowLoopback: boolean;
  /** Consecutive access denials (401/403/challenge) tolerated per host before the host is treated as blocked. */
  maxConsecutiveDenials: number;
  maxRetries: number;
}

export const DEFAULT_POLICY: FetchPolicy = {
  userAgent: 'CompetitorIntelBot/1.0 (+https://example.invalid/bot; respects robots.txt)',
  timeoutMs: 20_000,
  maxHtmlBytes: 3 * 1024 * 1024,
  maxJsonBytes: 12 * 1024 * 1024,
  maxPdfBytes: 20 * 1024 * 1024,
  maxRedirects: 5,
  allowLoopback: false,
  maxConsecutiveDenials: 3,
  maxRetries: 2,
};

export type FetchKind = 'html' | 'json' | 'xml' | 'pdf' | 'text' | 'any';

const CONTENT_TYPES: Record<FetchKind, RegExp | null> = {
  html: /^(text\/html|application\/xhtml\+xml)\b/i,
  json: /^(application\/([\w.+-]*\+)?json|text\/json|text\/plain)\b/i,
  xml: /^(application\/([\w.+-]*\+)?xml|text\/xml|application\/(gzip|x-gzip|octet-stream)|text\/plain)\b/i,
  pdf: /^(application\/pdf|application\/octet-stream)\b/i,
  text: /^text\//i,
  any: null,
};

export interface FetchResult {
  /** Final URL after validated redirects. */
  url: string;
  status: number;
  headers: Record<string, string>;
  contentType: string;
  body: Buffer;
  redirects: string[];
  durationMs: number;
  fetchedAt: Date;
  text(): string;
  json<T = unknown>(): T;
  contentHash: string;
}

export interface FetchOptions {
  kind?: FetchKind;
  headers?: Record<string, string>;
  maxBytes?: number;
  /** robots.txt itself must be fetchable without consulting robots.txt. */
  skipRobots?: boolean;
  /** Allow following redirects to a different host (homepage canonicalisation during profiling). */
  allowCrossHostRedirect?: boolean;
  method?: 'GET' | 'HEAD';
  /** Per-call crawl delay override (ms); otherwise the host's configured delay is used. */
  delayMs?: number;
}

// ───────────────────────────────────────────────────────────── pacing

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class Semaphore {
  private waiters: (() => void)[] = [];
  private active = 0;
  constructor(private max: number) {}
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }
}

interface HostState {
  sem: Semaphore;
  nextStart: number;
  backoffUntil: number;
  denials: number;
  blocked: boolean;
  requests: number;
  /** Extra spacing added after the website asked us to slow down (HTTP 429/503); it eases off again as requests succeed. */
  penaltyMs: number;
}

/**
 * Per-host politeness: minimum spacing between request starts, a concurrency cap, Retry-After backoff,
 * and a stop switch once access is denied repeatedly. One instance is shared per process so concurrent
 * scans of the same domain cannot exceed the limits.
 */
export class DomainLimiter {
  private hosts = new Map<string, HostState>();
  constructor(
    private readonly defaults = { delayMs: 1500, maxConcurrency: 2 },
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  private state(host: string): HostState {
    let s = this.hosts.get(host);
    if (!s) {
      s = { sem: new Semaphore(this.defaults.maxConcurrency), nextStart: 0, backoffUntil: 0, denials: 0, blocked: false, requests: 0, penaltyMs: 0 };
      this.hosts.set(host, s);
    }
    return s;
  }

  setDelay(_host: string, _delayMs: number) {
    /* delay is supplied per call; kept for API symmetry */
  }

  isBlocked(host: string): boolean {
    return this.state(host).blocked;
  }

  requestCount(host: string): number {
    return this.state(host).requests;
  }

  reset(host: string) {
    this.hosts.delete(host);
  }

  noteDenial(host: string, limit: number): boolean {
    const s = this.state(host);
    s.denials++;
    if (s.denials >= limit) s.blocked = true;
    return s.blocked;
  }

  noteSuccess(host: string) {
    const s = this.state(host);
    s.denials = 0;
    if (s.penaltyMs > 0) s.penaltyMs = s.penaltyMs < 1000 ? 0 : Math.round(s.penaltyMs * 0.85);
  }

  /** The website asked us to slow down: space this host's requests further apart (doubling, up to 20 s) until requests succeed again. */
  slowDown(host: string) {
    const s = this.state(host);
    s.penaltyMs = Math.min(20_000, s.penaltyMs ? s.penaltyMs * 2 : 3000);
  }

  penalty(host: string): number {
    return this.state(host).penaltyMs;
  }

  backoff(host: string, ms: number) {
    const s = this.state(host);
    s.backoffUntil = Math.max(s.backoffUntil, this.now() + ms);
  }

  async run<T>(host: string, delayMs: number, fn: () => Promise<T>): Promise<T> {
    const s = this.state(host);
    await s.sem.acquire();
    try {
      const start = Math.max(this.now(), s.nextStart, s.backoffUntil);
      s.nextStart = start + Math.max(0, delayMs) + s.penaltyMs;
      const pause = start - this.now();
      if (pause > 0) await this.wait(pause);
      s.requests++;
      return await fn();
    } finally {
      s.sem.release();
    }
  }
}

// ───────────────────────────────────────────────────────────── SSRF guard

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/** Validates the static parts of a URL before any network activity. */
export function assertSafeUrl(raw: string, policy: Pick<FetchPolicy, 'allowLoopback'>): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError(`Invalid URL`, 'invalid_url', raw);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError(`Protocol ${u.protocol} is not allowed`, 'ssrf', raw);
  if (u.username || u.password) throw new FetchError('Credentials in URLs are not allowed', 'ssrf', raw);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopbackOk = policy.allowLoopback && isLoopbackHost(host);
  if (!loopbackOk) {
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    if (![80, 443].includes(port)) throw new FetchError(`Port ${port} is not allowed (only 80 and 443)`, 'ssrf', raw);
    const reason = forbiddenHostnameReason(host);
    if (reason) throw new FetchError(`Blocked target: ${reason}`, 'ssrf', raw);
  }
  return u;
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') return true;
  if (isIP(host)) return host === '::1' || host.startsWith('127.');
  return false;
}

/**
 * undici `connect.lookup` hook. Runs at CONNECT time on the address that will really be used, so a hostname
 * that resolved to a public IP during pre-validation cannot be rebound to an internal IP afterwards.
 */
export function makeSafeLookup(policy: Pick<FetchPolicy, 'allowLoopback'>, resolver: Resolver = defaultResolver) {
  return (
    hostname: string,
    options: dns.LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void,
  ) => {
    resolver(hostname)
      .then((addrs) => {
        const loopbackOk = policy.allowLoopback && isLoopbackHost(hostname.toLowerCase());
        const safe = addrs.filter((a) => loopbackOk || forbiddenAddressReason(a.address) === null);
        if (addrs.length === 0 || safe.length !== addrs.length) {
          // Reject if ANY resolved address is forbidden — an attacker-controlled name may mix public and private records.
          const bad = addrs.find((a) => !loopbackOk && forbiddenAddressReason(a.address) !== null);
          const err: NodeJS.ErrnoException = new Error(
            `SSRF blocked: ${hostname} resolves to ${bad?.address ?? 'nothing'} (${bad ? forbiddenAddressReason(bad.address) : 'no address'})`,
          );
          err.code = 'ESSRF';
          callback(err);
          return;
        }
        if (options.all) callback(null, safe.map((a) => ({ address: a.address, family: a.family })));
        else callback(null, safe[0]!.address, safe[0]!.family);
      })
      .catch((e: NodeJS.ErrnoException) => callback(e));
  };
}

// ───────────────────────────────────────────────────────────── robots cache

export interface RobotsInfo {
  origin: string;
  parsed: ParsedRobots;
  httpStatus: number | null;
  fetched: boolean;
  fetchedAt: Date;
  /** Human-readable explanation when robots.txt could not be honoured normally. */
  note: string | null;
  crawlDelaySeconds: number | null;
  /**
   * robots.txt could not be read right now (the website asked us to slow down, was briefly unavailable, or did not answer). Nothing is fetched while the rules are
   * unknown, but this is NOT the website's "no": it is never cached and never reported as a robots.txt refusal, and the collection tries again later.
   */
  temporary?: boolean;
}

// ───────────────────────────────────────────────────────────── fetcher

export interface SafeFetcherDeps {
  limiter?: DomainLimiter;
  resolver?: Resolver;
  now?: () => Date;
  /** Test hook: replace the transport. Receives only validated URLs. */
  transport?: (url: URL, init: { headers: Record<string, string>; method: string; signal: AbortSignal }) => Promise<TransportResponse>;
  onRequest?: (info: { url: string; status: number | null; ms: number; error?: string }) => void;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array> | null;
}

export class SafeFetcher {
  readonly limiter: DomainLimiter;
  private readonly agent: Agent;
  private readonly robotsCache = new Map<string, Promise<RobotsInfo>>();
  private readonly policy: FetchPolicy;
  readonly requestLog: { url: string; status: number | null }[] = [];
  requestsMade = 0;
  /** Hard ceiling for this fetcher instance (a scan's request budget). */
  requestBudget = Number.POSITIVE_INFINITY;
  private delayByHost = new Map<string, number>();
  /**
   * Consecutive access denials (401/403) per host and the hosts this fetcher has stopped for that reason. Kept PER FETCHER (one collection run), never in the
   * limiter that the whole worker shares: a stop must end this run, not every later collection of that website, for every workspace, until a restart.
   */
  private readonly denials = new Map<string, number>();
  private readonly stoppedHosts = new Set<string>();

  constructor(policy: Partial<FetchPolicy> = {}, private readonly deps: SafeFetcherDeps = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.limiter = deps.limiter ?? new DomainLimiter();
    this.agent = new Agent({
      connect: { lookup: makeSafeLookup(this.policy, deps.resolver) as never, timeout: this.policy.timeoutMs },
      headersTimeout: this.policy.timeoutMs,
      bodyTimeout: this.policy.timeoutMs,
      keepAliveTimeout: 10_000,
    });
  }

  get userAgent() {
    return this.policy.userAgent;
  }

  setHostDelay(hostname: string, delayMs: number) {
    this.delayByHost.set(hostname.toLowerCase(), delayMs);
  }

  async close() {
    await this.agent.close();
  }

  // ── robots

  async robots(origin: string): Promise<RobotsInfo> {
    const key = new URL(origin).origin;
    let p = this.robotsCache.get(key);
    if (!p) {
      p = this.loadRobots(key).then((info) => {
        if (info.temporary) this.robotsCache.delete(key); // asked again next time, not remembered as a refusal
        return info;
      });
      this.robotsCache.set(key, p);
    }
    return p;
  }

  private async loadRobots(origin: string): Promise<RobotsInfo> {
    const base = { origin, fetchedAt: (this.deps.now ?? (() => new Date()))() };
    try {
      const res = await this.fetch(`${origin}/robots.txt`, { kind: 'text', skipRobots: true, maxBytes: 512 * 1024 });
      if (res.status === 429 || res.status === 408 || res.status >= 500) {
        return { ...base, parsed: DISALLOW_ALL_ROBOTS, httpStatus: res.status, fetched: false, temporary: true, note: `robots.txt could not be read right now (HTTP ${res.status}); nothing is collected until the website's rules can be read.`, crawlDelaySeconds: null };
      }
      const mode = robotsFromStatus(res.status);
      if (mode === 'parse') {
        const parsed = parseRobots(res.text());
        const delay = robotsCrawlDelay(parsed, this.policy.userAgent);
        return { ...base, parsed, httpStatus: res.status, fetched: true, note: null, crawlDelaySeconds: delay };
      }
      if (mode === 'allow_all') {
        return { ...base, parsed: EMPTY_ROBOTS, httpStatus: res.status, fetched: false, note: `No robots.txt (HTTP ${res.status}); no restrictions published.`, crawlDelaySeconds: null };
      }
      return {
        ...base,
        parsed: DISALLOW_ALL_ROBOTS,
        httpStatus: res.status,
        fetched: false,
        note: `robots.txt returned HTTP ${res.status}, so the site is treated as closed to automated collection.`,
        crawlDelaySeconds: null,
      };
    } catch (e) {
      if (e instanceof FetchError && e.code === 'ssrf') throw e;
      return {
        ...base,
        parsed: DISALLOW_ALL_ROBOTS,
        httpStatus: null,
        fetched: false,
        note: `robots.txt could not be retrieved (${(e as Error).message}); collection is paused until it can be read.`,
        crawlDelaySeconds: null,
        temporary: true,
      };
    }
  }

  async isAllowed(url: string): Promise<{ allowed: boolean; rule: string | null; info: RobotsInfo }> {
    const u = new URL(url);
    const info = await this.robots(u.origin);
    if (info.temporary) throw new FetchError(info.note ?? 'robots.txt could not be read right now', info.httpStatus === 429 ? 'rate_limited' : 'temporarily_unavailable', url);
    const d = robotsDecision(info.parsed, this.policy.userAgent, u.pathname + u.search);
    if (d.allowed && u.pathname.length > 1 && !u.pathname.endsWith('/')) {
      // Our URLs are normalised without a trailing slash, while many sites treat "/shop" and "/shop/" as the same page. A rule written for
      // "/shop/" must therefore also stop "/shop": normalising a link must never turn a forbidden page into an allowed one.
      const slash = robotsDecision(info.parsed, this.policy.userAgent, `${u.pathname}/${u.search}`);
      if (!slash.allowed) return { allowed: false, rule: `${slash.matchedRule} (applies to this page written with a trailing slash)`, info };
    }
    return { allowed: d.allowed, rule: d.matchedRule, info };
  }

  // ── fetch

  async fetch(rawUrl: string, opts: FetchOptions = {}): Promise<FetchResult> {
    const kind = opts.kind ?? 'any';
    const maxBytes =
      opts.maxBytes ?? (kind === 'html' || kind === 'text' ? this.policy.maxHtmlBytes : kind === 'pdf' ? this.policy.maxPdfBytes : this.policy.maxJsonBytes);
    const redirects: string[] = [];
    let current = rawUrl;
    const startHost = assertSafeUrl(rawUrl, this.policy).hostname.toLowerCase();
    const startKey = new URL(rawUrl).host.toLowerCase();
    const started = Date.now();

    for (let hop = 0; hop <= this.policy.maxRedirects; hop++) {
      const u = assertSafeUrl(current, this.policy);
      const host = u.host.toLowerCase();
      if (!opts.allowCrossHostRedirect && host !== startKey && !sameSiteHost(u.hostname.toLowerCase(), startHost)) {
        throw new FetchError(`Redirect to a different site (${host}) was not followed`, 'redirect', current);
      }
      if (this.stoppedHosts.has(host)) {
        throw new AccessDeniedError(`Access to ${host} was denied repeatedly; collection from this site is stopped for this run`, current);
      }
      if (!opts.skipRobots) {
        const r = await this.isAllowed(current);
        if (!r.allowed) throw new FetchError(`robots.txt disallows fetching this URL (${r.rule ?? 'rule'})`, 'robots', current);
        if (r.info.parsed === DISALLOW_ALL_ROBOTS) throw new FetchError(r.info.note ?? 'robots.txt prevents collection', 'robots', current);
      }
      if (this.requestsMade >= this.requestBudget) throw new FetchError('Request budget for this run is exhausted', 'budget', current);

      const res = await this.once(u, host, opts, kind, maxBytes);
      const loc = res.headers['location'];
      if (res.status >= 300 && res.status < 400 && loc) {
        const next = new URL(loc, u).toString();
        redirects.push(next);
        current = next;
        continue;
      }
      return this.finish(res, u.toString(), redirects, kind, started);
    }
    throw new FetchError(`Too many redirects (>${this.policy.maxRedirects})`, 'redirect', rawUrl);
  }

  private async once(
    u: URL,
    host: string,
    opts: FetchOptions,
    kind: FetchKind,
    maxBytes: number,
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const delay = opts.delayMs ?? this.delayByHost.get(host) ?? 0;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.policy.maxRetries; attempt++) {
      try {
        const out = await this.limiter.run(host, delay, async () => {
          this.requestsMade++;
          const t0 = Date.now();
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), this.policy.timeoutMs);
          try {
            const init = {
              method: opts.method ?? 'GET',
              signal: ac.signal,
              headers: {
                'user-agent': this.policy.userAgent,
                accept: acceptHeader(kind),
                'accept-language': 'en',
                ...(opts.headers ?? {}),
              },
            };
            const res = this.deps.transport
              ? await this.deps.transport(u, init)
              : await undiciFetch(u.toString(), { ...init, redirect: 'manual', dispatcher: this.agent }).then((r) => ({
                  status: r.status,
                  headers: Object.fromEntries(r.headers.entries()),
                  body: r.body as unknown as AsyncIterable<Uint8Array> | null,
                }));
            const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v]));
            const isRedirect = res.status >= 300 && res.status < 400;
            const declared = Number(headers['content-length'] ?? 0);
            if (!isRedirect && declared > maxBytes) {
              ac.abort();
              throw new FetchError(`Response too large (${declared} bytes > ${maxBytes})`, 'too_large', u.toString());
            }
            const body = isRedirect ? Buffer.alloc(0) : await readBody(res.body, maxBytes, u.toString());
            this.requestLog.push({ url: u.toString(), status: res.status });
            this.deps.onRequest?.({ url: u.toString(), status: res.status, ms: Date.now() - t0 });
            return { status: res.status, headers, body };
          } catch (e) {
            this.deps.onRequest?.({ url: u.toString(), status: null, ms: Date.now() - t0, error: (e as Error).message });
            throw e;
          } finally {
            clearTimeout(timer);
          }
        });

        // Denials: never retry, never evade. Repeated denial stops the host.
        if (out.status === 401 || out.status === 403) {
          const n = (this.denials.get(host) ?? 0) + 1;
          this.denials.set(host, n);
          if (n >= this.policy.maxConsecutiveDenials) {
            this.stoppedHosts.add(host);
            throw new AccessDeniedError(`Access denied by ${host} (HTTP ${out.status}); collection stopped`, u.toString());
          }
          return out;
        }
        if (out.status === 429 || out.status === 503) {
          // "Slow down" is not "no": it is neither retried at once nor held against the website. Space this host's later requests further apart, wait out a short
          // Retry-After here, and hand the response back; a long wait is NOT slept through (it would hold a worker for minutes): the collection pauses and continues after it.
          const retryAfter = parseRetryAfter(out.headers['retry-after']);
          this.limiter.slowDown(host);
          if (attempt < this.policy.maxRetries && (retryAfter === null || retryAfter <= MAX_INLINE_WAIT_MS)) {
            this.limiter.backoff(host, Math.min(retryAfter ?? 2 ** attempt * 2000, MAX_INLINE_WAIT_MS));
            continue;
          }
          return out;
        }
        if (out.status >= 500 && attempt < this.policy.maxRetries) {
          this.limiter.backoff(host, 2 ** attempt * 1000);
          continue;
        }
        if (out.status < 400) {
          this.denials.delete(host);
          this.limiter.noteSuccess(host);
        }
        return out;
      } catch (e) {
        lastErr = e;
        if (e instanceof FetchError) throw e;
        if ((e as { code?: string }).code === 'ESSRF' || /SSRF blocked/.test((e as Error).message) || (e as { cause?: { code?: string } }).cause?.code === 'ESSRF') {
          throw new FetchError(((e as { cause?: Error }).cause ?? (e as Error)).message, 'ssrf', u.toString());
        }
        if ((e as Error).name === 'AbortError') {
          if (attempt >= this.policy.maxRetries) throw new FetchError(`Timed out after ${this.policy.timeoutMs} ms`, 'timeout', u.toString());
        } else if (attempt >= this.policy.maxRetries) {
          throw new FetchError(`Network error: ${((e as { cause?: Error }).cause ?? (e as Error)).message}`, 'network', u.toString());
        }
        this.limiter.backoff(host, 2 ** attempt * 1000);
      }
    }
    throw new FetchError(`Network error: ${(lastErr as Error)?.message ?? 'unknown'}`, 'network', u.toString());
  }

  private finish(
    res: { status: number; headers: Record<string, string>; body: Buffer },
    finalUrl: string,
    redirects: string[],
    kind: FetchKind,
    started: number,
  ): FetchResult {
    const contentType = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const matcher = CONTENT_TYPES[kind];
    let body = res.body;
    if (res.status >= 200 && res.status < 300 && matcher && contentType && !matcher.test(contentType)) {
      throw new FetchError(`Unexpected content type "${contentType}" (expected ${kind})`, 'content_type', finalUrl);
    }
    // Only real gzip data is decompressed: some sites serve plain XML under a ".xml.gz" name.
    if (kind === 'xml' && body[0] === 0x1f && body[1] === 0x8b) {
      body = gunzipLimited(body, this.policy.maxJsonBytes * 4);
    }
    const buf = body;
    return {
      url: finalUrl,
      status: res.status,
      headers: res.headers,
      contentType,
      body: buf,
      redirects,
      durationMs: Date.now() - started,
      fetchedAt: (this.deps.now ?? (() => new Date()))(),
      contentHash: sha256Hex(buf),
      text: () => buf.toString('utf8'),
      json: <T>() => JSON.parse(buf.toString('utf8')) as T,
    };
  }
}

function acceptHeader(kind: FetchKind): string {
  switch (kind) {
    case 'json':
      return 'application/json, text/plain;q=0.5';
    case 'xml':
      return 'application/xml, text/xml, application/gzip;q=0.8, */*;q=0.1';
    case 'pdf':
      return 'application/pdf';
    case 'html':
      return 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1';
    default:
      return '*/*';
  }
}

async function readBody(body: AsyncIterable<Uint8Array> | null, maxBytes: number, url: string): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new FetchError(`Response exceeded the ${maxBytes}-byte limit`, 'too_large', url);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function gunzipLimited(buf: Buffer, maxOut: number): Buffer {
  try {
    return gunzipSync(buf, { maxOutputLength: maxOut });
  } catch (e) {
    throw new FetchError(`Compressed document rejected: ${(e as Error).message}`, 'too_large');
  }
}

/** The longest Retry-After a fetch waits out by itself; a longer one ends the sitting and the collection continues later. */
const MAX_INLINE_WAIT_MS = 30_000;

export function parseRetryAfter(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n) * 1000;
  const d = Date.parse(v);
  return Number.isNaN(d) ? null : Math.max(0, d - Date.now());
}

const MULTI_PART_SUFFIXES = new Set(['co.uk', 'com.au', 'com.br', 'co.nz', 'com.mx', 'co.za', 'com.aw', 'co.jp', 'com.co', 'com.ar', 'com.pe', 'com.do']);

export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split('.');
  if (parts.length <= 2) return host.toLowerCase();
  const last2 = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(last2)) return parts.slice(-3).join('.');
  return last2;
}

export function sameSiteHost(a: string, b: string): boolean {
  if (isIP(a) || isIP(b)) return a === b;
  return registrableDomain(a) === registrableDomain(b);
}

export { UrlValidationError };
