import { DomainLimiter, SafeFetcher, type ConnectorContext, type FetchPolicy, type SafeFetcherDeps } from '@ci/connectors';
import type { SiteProfileData } from '@ci/shared';
import type { FixtureServer } from './fixtures/server.ts';

/**
 * TEST-ONLY network helpers. Nothing in the product imports this file.
 *
 * `fixtureFetcher` is the product's own fetch policy (loopback refused, public-host rules applied) with only the final network hop replaced
 * by the fictional fixture sites. `loopbackFetcher` additionally allows loopback sockets and exists for the two kinds of test that
 * need a real local socket: the fetcher's own security tests and the real-Chrome rendering tests.
 */
const instantLimiter = () => new DomainLimiter({ delayMs: 0, maxConcurrency: 4 }, Date.now, async () => {});

export function fixtureFetcher(fx: FixtureServer, over: Partial<FetchPolicy> = {}, deps: SafeFetcherDeps = {}): SafeFetcher {
  return new SafeFetcher(
    { allowLoopback: false, maxRetries: 1, timeoutMs: 8000, userAgent: 'CompetitorIntelBot/test', ...over },
    { limiter: instantLimiter(), resolver: fx.resolver, transport: fx.transport, ...deps },
  );
}

/** For tests that start their own local HTTP server (real sockets on 127.0.0.1). */
export function loopbackFetcher(over: Partial<FetchPolicy> = {}, deps: SafeFetcherDeps = {}): SafeFetcher {
  return new SafeFetcher({ allowLoopback: true, maxRetries: 1, timeoutMs: 8000, userAgent: 'CompetitorIntelBot/test', ...over }, { limiter: instantLimiter(), ...deps });
}

export function testContext(fetcher: SafeFetcher, origin: string, over: Partial<ConnectorContext> = {}, profile: SiteProfileData | null = null): ConnectorContext {
  const u = new URL(origin);
  return {
    site: { id: 'site-1', origin, hostname: u.host },
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
