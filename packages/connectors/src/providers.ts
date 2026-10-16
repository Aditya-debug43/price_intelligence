import dns from 'node:dns';
import type { FxRate, LlmProvider } from '@ci/core';
import { forbiddenAddressReason, forbiddenHostnameReason } from '@ci/core';
import type { BrowserRenderer } from './types.ts';
import type { SafeFetcher } from './safe-fetch.ts';

// ───────────────────────────────────────────────────────── Anthropic (optional, provider-independent boundary)

/**
 * Minimal Messages API client. Used only when AI_PROVIDER=anthropic. The model receives no tools and no secrets;
 * callers wrap page content as untrusted data and validate every output against source evidence.
 */
export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  readonly available = true;
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    /** Overridable so the request/response handling can be tested against a local server. */
    private readonly baseUrl = 'https://api.anthropic.com',
  ) {}

  async complete(req: { system: string; user: string; maxTokens?: number }): Promise<string> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: this.model, max_tokens: req.maxTokens ?? 512, system: req.system, messages: [{ role: 'user', content: req.user }] }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`AI provider error (HTTP ${res.status})`);
    const json = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  }
}

// ───────────────────────────────────────────────────────── FX market rates (optional)

/**
 * open.er-api.com — free, no key, attribution required ("Rates By Exchange Rate API").
 * Rates are quoted per 1 USD. The caller decides how they combine with the explicit AWG peg.
 */
export async function fetchOpenErApiRates(now = new Date(), url = 'https://open.er-api.com/v6/latest/USD'): Promise<FxRate[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Exchange-rate provider returned HTTP ${res.status}`);
  const json = (await res.json()) as { result?: string; rates?: Record<string, number>; time_last_update_unix?: number };
  if (json.result !== 'success' || !json.rates) throw new Error('Exchange-rate provider returned an unexpected response');
  const at = json.time_last_update_unix ? new Date(json.time_last_update_unix * 1000) : now;
  return Object.entries(json.rates)
    .filter(([code, rate]) => code !== 'USD' && Number.isFinite(rate) && rate > 0)
    .map(([quote, rate]) => ({ base: 'USD', quote, rate, source: 'open.er-api.com (market rate)', fetchedAt: at.toISOString(), isFixed: false }));
}

// ───────────────────────────────────────────────────────── Headless browser (optional; Playwright)

/**
 * Renders a JavaScript-only page in a headless browser. Disabled by default (BROWSER_RENDERING_ENABLED=false).
 * Expensive work like this should run in the worker process only — never in the API.
 * Every sub-request the page makes is screened with the same SSRF rules as the HTTP fetcher, and the navigation
 * itself must pass robots.txt first. Stealth/anti-detection tricks are deliberately NOT used.
 */
export class PlaywrightRenderer implements BrowserRenderer {
  available = false;
  private browser: { newContext: (o: unknown) => Promise<PwContext>; close: () => Promise<void> } | null = null;

  constructor(
    private readonly fetcher: SafeFetcher,
    private readonly opts: { channel?: string; executablePath?: string; allowLoopback: boolean },
  ) {}

  async init(): Promise<boolean> {
    try {
      // Optional dependency: only imported when rendering is enabled.
      const mod = (await import(/* @vite-ignore */ 'playwright-core' as string)) as { chromium: { launch: (o: unknown) => Promise<NonNullable<PlaywrightRenderer['browser']>> } };
      this.browser = await mod.chromium.launch({
        headless: true,
        ...(this.opts.executablePath ? { executablePath: this.opts.executablePath } : { channel: this.opts.channel ?? 'chrome' }),
      });
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  async render(url: string, opts: { timeoutMs: number }): Promise<{ html: string; finalUrl: string } | null> {
    if (!this.browser) return null;
    // A target the SSRF policy forbids (or whose robots.txt cannot be read) is refused, never navigated to.
    const allowed = await this.fetcher.isAllowed(url).catch(() => null);
    if (!allowed?.allowed) return null;
    const ctx = await this.browser.newContext({ userAgent: this.fetcher.userAgent, javaScriptEnabled: true, acceptDownloads: false, serviceWorkers: 'block' });
    try {
      await ctx.route('**/*', async (route) => {
        const req = route.request();
        const type = req.resourceType();
        if (['image', 'media', 'font'].includes(type)) return route.abort();
        try {
          const u = new URL(req.url());
          if (!['http:', 'https:'].includes(u.protocol)) return route.abort();
          const loop = this.opts.allowLoopback && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
          if (!loop) {
            if (forbiddenHostnameReason(u.hostname)) return route.abort();
            const addrs = await dns.promises.lookup(u.hostname, { all: true });
            if (addrs.some((a) => forbiddenAddressReason(a.address))) return route.abort();
          }
        } catch {
          return route.abort();
        }
        return route.continue();
      });
      // WebSockets are not covered by the request screening above and product pages never need them, so a page can open none: a hostile
      // page must not be able to use this browser to talk to internal services.
      await ctx.routeWebSocket(/.*/, (ws) => ws.close({ code: 1008, reason: 'blocked' }));
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: opts.timeoutMs });
      return { html: await page.content(), finalUrl: page.url() };
    } catch {
      return null;
    } finally {
      await ctx.close();
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.available = false;
  }
}

interface PwContext {
  route(pattern: string, handler: (route: PwRoute) => Promise<unknown> | unknown): Promise<void>;
  routeWebSocket(url: RegExp, handler: (ws: { close(options?: { code?: number; reason?: string }): Promise<void> | void }) => unknown): Promise<void>;
  newPage(): Promise<{ goto(url: string, o: unknown): Promise<unknown>; content(): Promise<string>; url(): string }>;
  close(): Promise<void>;
}
interface PwRoute {
  request(): { url(): string; resourceType(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
}
