import { DomainLimiter, SafeFetcher, type FetchPolicy, type SafeFetcherDeps } from './safe-fetch.ts';
import type { ConnectorContext } from './types.ts';
import type { SiteProfileData } from '@ci/shared';

/** A fetcher for tests: loopback allowed (fixtures only), no real waiting, one retry. */
export function testFetcher(over: Partial<FetchPolicy> = {}, deps: SafeFetcherDeps = {}): SafeFetcher {
  const limiter = new DomainLimiter({ delayMs: 0, maxConcurrency: 4 }, Date.now, async () => {});
  return new SafeFetcher({ allowLoopback: true, maxRetries: 1, timeoutMs: 8000, userAgent: 'CompetitorIntelBot/test', ...over }, { limiter, ...deps });
}

export function testContext(fetcher: SafeFetcher, origin: string, over: Partial<ConnectorContext> = {}, profile: SiteProfileData | null = null): ConnectorContext {
  const u = new URL(origin);
  return {
    site: { id: 'site-1', origin, hostname: u.host, isFixture: true },
    profile,
    fetcher,
    siteCurrency: null,
    now: () => new Date('2026-10-14T12:00:00Z'),
    log: () => {},
    limits: { maxProducts: null },
    browser: null,
    llm: null,
    ...over,
  };
}
