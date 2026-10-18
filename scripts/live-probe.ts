/**
 * LIVE capability probe (no database, no collection). Runs the site profiler against real websites with the
 * production safety settings (no loopback, robots.txt honoured, honest user agent, polite delay, request budget).
 * It reads robots.txt, the homepage, sitemap index files and up to three sample product pages per site (~10–25 requests).
 *
 *   npm run live:probe -- https://example-shop.com https://other.com
 *
 * It sends real requests to the websites you name, so no address is built in: you must pass at least one, and it is your responsibility to be
 * entitled to look at it. Nothing is collected or stored beyond the JSON record of what was found.
 *
 * Writes docs/live-probe-<date>-<time>.json (one file per run, never overwritten) so the exact findings are recorded.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadDotEnv } from '@ci/core';
import { DomainLimiter, SafeFetcher, profileSite } from '@ci/connectors';
import { root } from './lib/root.ts';

loadDotEnv(root);
const targets = process.argv.slice(2).filter((a) => /^https?:\/\//i.test(a));
if (!targets.length) {
  console.error('Usage: npm run live:probe -- https://website-one.example https://website-two.example\nNo website is built in; name the sites you want to inspect.');
  process.exit(1);
}
const ua = process.env.COLLECTOR_USER_AGENT ?? 'CompetitorIntelBot/1.0 (+https://example.invalid/bot; respects robots.txt)';
const delay = Number(process.env.COLLECTOR_DEFAULT_DELAY_MS ?? 1500);

const results: unknown[] = [];
for (const url of targets) {
  const fetcher = new SafeFetcher({ userAgent: ua, allowLoopback: false, timeoutMs: 20_000, maxRetries: 1 }, { limiter: new DomainLimiter({ delayMs: delay, maxConcurrency: 1 }) });
  const started = Date.now();
  const p = await profileSite(url, { fetcher, capabilities: { browserEnabled: false, aiEnabled: false }, defaultCrawlDelayMs: delay, defaultMaxRequests: 2000, maxSampleProducts: 3 });
  await fetcher.close();
  console.log(`\n━━ ${url}`);
  console.log(`   status:    ${p.status.toUpperCase()}   (${p.requestsMade} requests, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
  console.log(`   summary:   ${p.summary}`);
  console.log(`   platform:  ${p.platform.id} (${Math.round(p.platform.confidence * 100)}%)   currency: ${p.currency.detected ?? 'unknown'}${p.currency.conflicting ? ' (conflicting)' : ''}`);
  console.log(`   robots:    ${p.access.robots.fetched ? 'read' : 'not read'} (HTTP ${p.access.robots.httpStatus ?? '—'})${p.access.robots.crawlDelaySeconds ? `, crawl-delay ${p.access.robots.crawlDelaySeconds}s` : ''}${p.access.robots.disallowsAll ? ' — DISALLOWS automated access' : ''}`);
  console.log(`   catalogue: ~${p.catalogue.estimatedProducts ?? 'unknown'} products (${p.catalogue.estimateBasis}); sitemaps: ${p.catalogue.sitemaps.length}; public APIs: ${p.catalogue.publicApis.map((a) => `${a.kind}${a.usable ? '✓' : '✗'}`).join(', ') || 'none'}`);
  console.log(`   strategy:  ${p.strategy.primary ?? 'none'} — ${p.strategy.reason}`);
  for (const l of p.limitations.slice(0, 6)) console.log(`   • [${l.severity}] ${l.message}`);
  results.push({ url, probedAt: new Date().toISOString(), profile: p });
}
mkdirSync(path.join(root, 'docs'), { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '');
const file = path.join(root, 'docs', `live-probe-${stamp}.json`);
writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`\nSaved ${file}`);
