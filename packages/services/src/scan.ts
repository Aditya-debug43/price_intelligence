import { and, asc, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import {
  AccessDeniedError,
  FetchError,
  getConnector,
  rankConnectors,
  type AnyConnector,
  type ConnectorContext,
  type FeedConnector,
  type PageConnector,
  type SafeFetcher,
} from '@ci/connectors';
import { canonicalizeUrl } from '@ci/core';
import type { ScanKind, ScanStatus, SiteProfileData } from '@ci/shared';
import { crawlQueue, dailyRuns, orgSettings, products, scanRuns, siteProfiles, sites, type DbLike } from '@ci/database';
import type { Services } from './context.ts';
import { emailAlertDigest } from './alerts.ts';
import { ingestBatch, type IngestContext, type IngestSite } from './ingest.ts';
import { capabilitiesOf, runProfile } from './profiling.ts';
import { collectFlyers, expireOffers, sweepMissingSaleOffers } from './promotions.ts';
import { recordCollectionOutcome } from './stock.ts';
import { getOrgMode, loopbackAllowed } from './workspace.ts';

export class ConsentRequiredError extends Error {
  constructor(message = 'Record consent for this website before collecting from it.') {
    super(message);
    this.name = 'ConsentRequiredError';
  }
}

export interface StartScanOptions {
  kind: ScanKind;
  trigger: 'manual' | 'scheduled' | 'dev';
  limit?: number | null;
  dailyRunId?: string | null;
  deadlineAt?: Date | null;
  requestBudget?: number | null;
}

const PROFILE_MAX_AGE_MS = 7 * 86_400_000;
const FAILED_PROFILE_RETRY_MS = 12 * 3_600_000;

/** Creates a queued scan (idempotent while one is already queued/running) and enqueues the job. */
export async function startScan(svc: Services, db: DbLike, orgId: string, siteId: string, opts: StartScanOptions): Promise<{ run: typeof scanRuns.$inferSelect; created: boolean }> {
  const [site] = await db.select().from(sites).where(and(eq(sites.id, siteId), eq(sites.orgId, orgId)));
  if (!site) throw new Error('Website not found');
  if (!site.active) throw new Error('This website is switched off');
  if (site.consentStatus !== 'confirmed') throw new ConsentRequiredError();
  const [running] = await db
    .select()
    .from(scanRuns)
    .where(and(eq(scanRuns.siteId, siteId), inArray(scanRuns.status, ['queued', 'running'])))
    .orderBy(desc(scanRuns.createdAt))
    .limit(1);
  if (running) return { run: running, created: false };
  const [run] = await db
    .insert(scanRuns)
    .values({
      orgId, siteId, kind: opts.kind, trigger: opts.trigger, limitProducts: opts.limit ?? null, dailyRunId: opts.dailyRunId ?? null, deadlineAt: opts.deadlineAt ?? null,
      requestBudget: opts.requestBudget ?? null, status: 'queued',
    })
    .returning();
  await svc.queue.enqueue('scan-site', { orgId, scanRunId: run!.id }, { singletonKey: `scan:${run!.id}` });
  return { run: run!, created: true };
}

// ───────────────────────────────────────────────────────────── execution

type State = 'complete' | 'partial' | 'blocked' | 'failed';
interface Outcome {
  state: State;
  saved: number;
  errorCode?: string;
  error?: string;
  notes: string[];
  /** Move on to the next connector candidate (this one produced nothing usable). */
  tryNext?: boolean;
  estimatedTotal?: number | null;
}

interface RunEnv {
  svc: Services;
  run: typeof scanRuns.$inferSelect;
  site: typeof sites.$inferSelect;
  ic: IngestContext;
  ctx: ConnectorContext;
  fetcher: SafeFetcher;
  profile: SiteProfileData;
  deadline: Date | null;
}

const heartbeat = (svc: Services, id: string, patch: Partial<typeof scanRuns.$inferInsert> = {}) =>
  svc.db.update(scanRuns).set({ heartbeatAt: svc.clock(), ...patch }).where(eq(scanRuns.id, id));

function classify(e: unknown): { state: State; code: string; message: string; terminal: boolean } {
  if (e instanceof AccessDeniedError) return { state: 'blocked', code: 'access_denied', message: e.message, terminal: true };
  if (e instanceof FetchError) {
    if (e.code === 'robots') return { state: 'blocked', code: 'robots', message: e.message, terminal: true };
    if (e.code === 'ssrf') return { state: 'blocked', code: 'unsafe_address', message: e.message, terminal: true };
    if (e.code === 'budget') return { state: 'partial', code: 'request_budget', message: 'The request budget for this run was used up; the rest is collected on the next run.', terminal: true };
    return { state: 'failed', code: e.code, message: e.message, terminal: false };
  }
  const code = (e as { code?: string }).code ?? 'error';
  return { state: 'failed', code, message: (e as Error).message ?? String(e), terminal: false };
}

async function runFeed(env: RunEnv, connector: FeedConnector): Promise<Outcome> {
  const { svc, run, ic, ctx } = env;
  const limit = run.kind === 'sample' ? (run.limitProducts ?? 25) : null;
  let cursor = (run.cursor as Record<string, unknown> | null) ?? null;
  let saved = run.productsSaved;
  const notes: string[] = [];
  let estimated: number | null = null;
  for (let page = 0; page < 5000; page++) {
    if (env.deadline && svc.clock() >= env.deadline) return { state: 'partial', saved, notes: [...notes, 'Stopped at the time limit; the run can be resumed.'], errorCode: 'deadline', estimatedTotal: estimated };
    if (env.ctx.signal?.aborted) return { state: 'partial', saved, notes: [...notes, 'Cancelled'], errorCode: 'cancelled' };
    ctx.limits.maxProducts = limit ? Math.max(0, limit - saved) : null;
    let batch;
    try {
      batch = await connector.fetchPage(ctx, cursor);
    } catch (e) {
      const c = classify(e);
      if ((e as { code?: string }).code === 'feed_unavailable' && saved === 0) return { state: 'failed', saved, notes, errorCode: 'feed_unavailable', error: c.message, tryNext: true };
      if (saved > 0 && c.state === 'failed') return { state: 'partial', saved, notes: [...notes, `Stopped after an error: ${c.message}. Progress was saved and the run can resume.`], errorCode: c.code, error: c.message, estimatedTotal: estimated };
      return { state: c.state, saved, notes, errorCode: c.code, error: c.message, estimatedTotal: estimated };
    }
    const r = await ingestBatch(ic, batch);
    saved += r.products;
    estimated = batch.progress.estimatedTotal ?? estimated;
    notes.push(...batch.warnings);
    cursor = batch.done ? null : batch.cursor;
    await heartbeat(svc, run.id, {
      cursor,
      productsSaved: saved,
      variantsSaved: run.variantsSaved + r.variants,
      urlsFetched: run.urlsFetched + 1,
      requestsMade: env.fetcher.requestsMade,
      urlsDiscovered: Math.max(run.urlsDiscovered, saved),
      estimatedTotal: estimated,
    });
    run.variantsSaved += r.variants;
    run.urlsFetched += 1;
    if (limit && saved >= limit) return { state: 'partial', saved, notes: [...notes, `Small live refresh: stopped after ${saved} products by design (not a full catalogue).`], estimatedTotal: estimated };
    if (batch.done) {
      if (saved === 0) return { state: 'failed', saved, notes: [...notes, 'The product feed answered but listed no products.'], errorCode: 'empty_feed', error: 'The product feed listed no products. If this is unexpected, the feed may be restricted or disabled.', tryNext: true, estimatedTotal: estimated };
      return { state: 'complete', saved, notes, estimatedTotal: estimated };
    }
  }
  return { state: 'partial', saved, notes, errorCode: 'page_limit' };
}

/** Rolling-refresh priority: matched products, active offers and recent movers first, then the stalest. */
async function plannedKnownUrls(db: DbLike, siteId: string, limit: number): Promise<{ url: string; priority: number }[]> {
  const rows = await db.execute<{ url: string; score: string }>(sql`
    select p.canonical_url as url,
      (case when exists (select 1 from product_matches m join variants v on v.id in (m.source_variant_id, m.competitor_variant_id)
                         where v.product_id = p.id and m.status <> 'rejected') then 100 else 0 end)
      + (case when exists (select 1 from offers o join variants v on v.id = o.variant_id where v.product_id = p.id and o.status = 'active') then 60 else 0 end)
      + (case when exists (select 1 from variants v where v.product_id = p.id and v.last_price_change_at > now() - interval '7 days') then 30 else 0 end)
      + least(40, extract(epoch from (now() - p.last_seen_at)) / 86400 * 4)
      + (case when p.delisted_at is not null then -80 else 0 end) as score
    from products p
    where p.site_id = ${siteId}
    order by score desc, p.last_seen_at asc
    limit ${limit}`);
  return rows.rows.map((r) => ({ url: r.url, priority: Math.round(Number(r.score)) }));
}

async function runPages(env: RunEnv, connector: PageConnector): Promise<Outcome> {
  const { svc, run, ic, ctx, site } = env;
  const db = svc.db;
  const notes: string[] = [];
  let estimated: number | null = run.estimatedTotal;
  const budget = Math.max(0, (run.requestBudget ?? site.maxRequestsPerRun) - run.requestsMade);
  const limit = run.kind === 'sample' ? (run.limitProducts ?? 25) : null;

  const [{ n: queued } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(crawlQueue).where(eq(crawlQueue.scanRunId, run.id));
  let discoveryComplete = run.cursor?.['discoveryComplete'] === true;
  if (!queued) {
    // Plan the frontier once; a resumed run reuses the persisted queue.
    const known = await plannedKnownUrls(db, site.id, Math.max(budget, 1));
    const planned = new Map<string, number>(known.map((k) => [k.url, k.priority]));
    let discoveredTotal: number | null = null;
    if (run.kind === 'discovery' || known.length === 0) {
      try {
        const d = await connector.discover(ctx);
        notes.push(...d.warnings);
        discoveredTotal = d.estimatedTotal;
        for (const u of d.urls) {
          const url = canonicalizeUrl(u.url);
          const prev = planned.get(url);
          // Never-seen URLs get a mid priority so discovery proceeds without starving matched products.
          if (prev === undefined) planned.set(url, 45 + (u.lastmod ? 5 : 0));
        }
        discoveryComplete = d.estimatedTotal !== null;
        estimated = d.estimatedTotal ?? null;
      } catch (e) {
        const c = classify(e);
        return { state: c.state, saved: 0, notes, errorCode: c.code, error: c.message };
      }
    } else {
      notes.push('Rolling refresh: re-checked known products by priority; new products are found on discovery runs.');
    }
    let urls = [...planned.entries()].sort((a, b) => b[1] - a[1]);
    const cap = limit ?? budget;
    const truncated = urls.length > cap;
    if (truncated) {
      urls = urls.slice(0, cap);
      notes.push(`Request budget allows ${cap} pages this run (of ${planned.size} known); the remainder is refreshed on later runs.`);
    }
    for (const part of Array.from({ length: Math.ceil(urls.length / 500) }, (_, i) => urls.slice(i * 500, (i + 1) * 500))) {
      await db.insert(crawlQueue).values(part.map(([url, priority]) => ({ orgId: run.orgId, siteId: site.id, scanRunId: run.id, url, priority, kind: 'product' as const }))).onConflictDoNothing();
    }
    // "Complete" means the planned frontier covers everything we set out to cover. A discovery run must also have
    // enumerated the whole site; a refresh only has to re-check every known product; a sample is never complete.
    if (run.kind === 'discovery') discoveryComplete = discoveryComplete && !truncated;
    else discoveryComplete = run.kind === 'refresh' && !truncated;
    estimated = discoveredTotal ?? planned.size;
    await heartbeat(svc, run.id, { urlsDiscovered: urls.length, estimatedTotal: estimated, cursor: { discoveryComplete }, requestsMade: env.fetcher.requestsMade });
  }

  let saved = run.productsSaved;
  let failures = 0;
  for (;;) {
    if (env.deadline && svc.clock() >= env.deadline) return await pagesOutcome(env, saved, failures, discoveryComplete, estimated, [...notes, 'Stopped at the time limit; the run can be resumed.'], 'deadline');
    const pending = await db.select().from(crawlQueue).where(and(eq(crawlQueue.scanRunId, run.id), eq(crawlQueue.status, 'pending'))).orderBy(desc(crawlQueue.priority), asc(crawlQueue.url)).limit(10);
    if (!pending.length) break;
    for (const item of pending) {
      try {
        const batch = await connector.extractPage(ctx, item.url);
        const doc = batch.evidence[0];
        if (doc && (doc.httpStatus === 404 || doc.httpStatus === 410)) {
          // Direct evidence the page is gone (not inferred from absence).
          await db.update(products).set({ delistedAt: svc.clock() }).where(and(eq(products.siteId, site.id), eq(products.canonicalUrl, item.url), isNull(products.delistedAt)));
        }
        if (batch.products.length) {
          const r = await ingestBatch(ic, batch);
          saved += r.products;
          run.variantsSaved += r.variants;
        }
        notes.push(...batch.warnings.filter((w) => !/HTTP 404|HTTP 410/.test(w)).slice(0, 2));
        await db.update(crawlQueue).set({ status: 'done', attempts: item.attempts + 1, updatedAt: svc.clock() }).where(eq(crawlQueue.id, item.id));
      } catch (e) {
        const c = classify(e);
        if (c.terminal) {
          await db.update(crawlQueue).set({ lastError: c.message.slice(0, 300), updatedAt: svc.clock() }).where(eq(crawlQueue.id, item.id));
          if (c.state === 'partial') return await pagesOutcome(env, saved, failures, discoveryComplete, estimated, notes, c.code);
          return { state: c.state, saved, notes, errorCode: c.code, error: c.message, estimatedTotal: estimated };
        }
        failures++;
        const exhausted = item.attempts + 1 >= 2;
        await db.update(crawlQueue).set({ status: exhausted ? 'failed' : 'pending', attempts: item.attempts + 1, lastError: c.message.slice(0, 300), updatedAt: svc.clock() }).where(eq(crawlQueue.id, item.id));
      }
      if (limit && saved >= limit) return await pagesOutcome(env, saved, failures, false, estimated, [...notes, `Small live refresh: stopped after ${saved} products by design.`], undefined);
    }
    await heartbeat(svc, run.id, { productsSaved: saved, variantsSaved: run.variantsSaved, urlsFetched: sql`(select count(*) from crawl_queue where scan_run_id = ${run.id} and status <> 'pending')` as unknown as number, requestsMade: env.fetcher.requestsMade, errorsCount: failures });
  }
  return await pagesOutcome(env, saved, failures, discoveryComplete, estimated, notes, undefined);
}

async function pagesOutcome(env: RunEnv, saved: number, failures: number, discoveryComplete: boolean, estimated: number | null, notes: string[], code: string | undefined): Promise<Outcome> {
  const [counts] = await env.svc.db
    .select({ pending: sql<number>`count(*) filter (where status = 'pending')::int`, failed: sql<number>`count(*) filter (where status = 'failed')::int`, total: sql<number>`count(*)::int` })
    .from(crawlQueue)
    .where(eq(crawlQueue.scanRunId, env.run.id));
  const total = counts?.total ?? 0;
  const failRate = total ? (counts?.failed ?? 0) / total : 0;
  const complete = !code && (counts?.pending ?? 0) === 0 && discoveryComplete && failRate <= 0.05;
  if (saved === 0 && total > 0 && !code) {
    return { state: 'failed', saved, notes: [...notes, 'Pages were fetched but no product data could be extracted from them.'], errorCode: 'no_products_extracted', error: 'No product data could be extracted from the pages of this site with this method.', tryNext: true, estimatedTotal: estimated };
  }
  if (complete) return { state: 'complete', saved, notes, estimatedTotal: estimated };
  if (saved === 0 && failures > 0 && (counts?.pending ?? 0) === 0) return { state: 'failed', saved, notes, errorCode: 'all_pages_failed', error: 'None of the product pages could be read.', estimatedTotal: estimated };
  const why = code === 'deadline' ? 'time limit' : code === 'request_budget' ? 'request budget' : failRate > 0.05 ? `${Math.round(failRate * 100)}% of pages failed` : (counts?.pending ?? 0) > 0 ? 'pages remain' : 'coverage is partial by design';
  return { state: 'partial', saved, notes: [...notes, `Partial coverage (${why}).`], errorCode: code, estimatedTotal: estimated };
}

export interface ScanResult {
  scanRunId: string;
  status: ScanStatus;
  productsSaved: number;
  isComplete: boolean;
  connector: string | null;
}

/** Executes (or resumes) a queued scan. Safe to call again after a crash: progress and cursors are persisted. */
/** Scans this process is executing right now, so a clean shutdown can hand them back instead of leaving them to time out. */
const activeScans = new Set<string>();

/** Runs a scan while it is registered as active in this process (used by executeScan; exported so the registration is testable). */
export async function withActiveScan<T>(scanRunId: string, fn: () => Promise<T>): Promise<T> {
  activeScans.add(scanRunId);
  try {
    return await fn();
  } finally {
    activeScans.delete(scanRunId);
  }
}

/**
 * Called when this worker is stopping while scans are still in flight (a long collection outlasts any shutdown grace period). Marks them as
 * having no heartbeat, so the next scheduler pass of ANY worker resumes them from their saved cursor within about a minute — instead of the
 * website waiting out the 15-minute silence window.
 */
export async function releaseActiveScans(svc: Services): Promise<string[]> {
  const ids = [...activeScans];
  if (!ids.length) return [];
  await svc.db.update(scanRuns).set({ heartbeatAt: new Date(0) }).where(and(inArray(scanRuns.id, ids), eq(scanRuns.status, 'running')));
  return ids;
}

export async function executeScan(svc: Services, scanRunId: string): Promise<ScanResult> {
  return withActiveScan(scanRunId, () => executeScanInner(svc, scanRunId));
}

async function executeScanInner(svc: Services, scanRunId: string): Promise<ScanResult> {
  const [run0] = await svc.db.select().from(scanRuns).where(eq(scanRuns.id, scanRunId));
  if (!run0) throw new Error(`Scan ${scanRunId} not found`);
  if (!['queued', 'running'].includes(run0.status)) return { scanRunId, status: run0.status, productsSaved: run0.productsSaved, isComplete: run0.isComplete, connector: run0.connector };
  const run = run0;
  const [site] = await svc.db.select().from(sites).where(eq(sites.id, run.siteId));
  if (!site || !site.active || site.consentStatus !== 'confirmed') {
    await svc.db.update(scanRuns).set({ status: 'cancelled', finishedAt: svc.clock(), error: 'Cancelled: website removed, switched off, or consent not confirmed' }).where(eq(scanRuns.id, run.id));
    return { scanRunId, status: 'cancelled', productsSaved: 0, isComplete: false, connector: null };
  }
  const now = svc.clock();
  await svc.db.update(scanRuns).set({ status: 'running', startedAt: run.startedAt ?? now, heartbeatAt: now }).where(eq(scanRuns.id, run.id));
  run.startedAt ??= now;

  const finish = async (status: ScanStatus, o: { productsSaved: number; errorCode?: string; error?: string; notes: string[]; complete: boolean; connector: string | null; connectorVersion?: string | null; estimatedTotal?: number | null; requests?: number }) => {
    await svc.db
      .update(scanRuns)
      .set({ status, finishedAt: svc.clock(), isComplete: o.complete, errorCode: o.errorCode ?? null, error: o.error ?? null, notes: o.notes.slice(0, 20), connector: o.connector, connectorVersion: o.connectorVersion ?? null, estimatedTotal: o.estimatedTotal ?? run.estimatedTotal, ...(o.requests !== undefined ? { requestsMade: o.requests } : {}) })
      .where(eq(scanRuns.id, run.id));
    return { scanRunId: run.id, status, productsSaved: o.productsSaved, isComplete: o.complete, connector: o.connector } as ScanResult;
  };

  const alertIds: string[] = [];
  const siteRef: IngestSite = { id: site.id, orgId: site.orgId, name: site.name, origin: site.origin, role: site.role, isFixture: site.isFixture, currency: site.currency };
  const fetcher = svc.makeFetcher({ allowLoopback: loopbackAllowed({ allowLocalFixtures: svc.config.ALLOW_LOCAL_FIXTURES, mode: await getOrgMode(svc.db, site.orgId), isFixture: site.isFixture }) });
  try {
    // ── capability profile (reuse a fresh one)
    let [prof] = await svc.db.select().from(siteProfiles).where(eq(siteProfiles.siteId, site.id)).orderBy(desc(siteProfiles.createdAt)).limit(1);
    const age = prof ? now.getTime() - prof.createdAt.getTime() : Infinity;
    if (!prof || age > PROFILE_MAX_AGE_MS || ((prof.status === 'failed' || prof.status === 'blocked') && age > FAILED_PROFILE_RETRY_MS)) {
      await runProfile(svc, site.orgId, site.id);
      [prof] = await svc.db.select().from(siteProfiles).where(eq(siteProfiles.siteId, site.id)).orderBy(desc(siteProfiles.createdAt)).limit(1);
      const [fresh] = await svc.db.select().from(sites).where(eq(sites.id, site.id));
      if (fresh) siteRef.currency = fresh.currency;
    }
    const profile = prof!.data;
    if (profile.status === 'blocked') {
      const res = await finish('blocked', { productsSaved: 0, errorCode: 'blocked', error: profile.summary, notes: profile.limitations.filter((l) => l.severity === 'blocking').map((l) => l.message), complete: false, connector: null });
      await afterScan(svc, run, siteRef, res, profile.summary, alertIds);
      return res;
    }
    if (profile.status === 'failed') {
      const res = await finish('failed', { productsSaved: 0, errorCode: 'site_unreachable', error: profile.summary, notes: profile.limitations.map((l) => l.message), complete: false, connector: null });
      await afterScan(svc, run, siteRef, res, profile.summary, alertIds);
      return res;
    }

    const caps = capabilitiesOf(svc);
    const ranked = rankConnectors(profile, caps).filter((r) => r.score >= 0.3);
    // Resume with the connector already chosen for this run.
    const candidates: AnyConnector[] = (run.connector ? [getConnector(run.connector)] : ranked.slice(0, 3).map((r) => getConnector(r.id))).filter((c): c is AnyConnector => !!c);
    if (!candidates.length) {
      const msg = 'No reliable collection method is available for this website yet. ' + (profile.rendering.requiresJavaScript ? 'It needs browser rendering, which is not enabled.' : 'See the capability report for details.');
      const res = await finish('failed', { productsSaved: 0, errorCode: 'unsupported_site', error: msg, notes: [msg], complete: false, connector: null });
      await afterScan(svc, run, siteRef, res, msg, alertIds);
      return res;
    }

    const delay = Math.max(site.crawlDelayMs, profile.effort.crawlDelayMs);
    fetcher.setHostDelay(site.hostname, delay);
    const budget = Math.max(1, (run.requestBudget ?? site.maxRequestsPerRun) - run.requestsMade);
    fetcher.requestBudget = budget + 25; // headroom for sitemap/robots overhead
    const [settings] = await svc.db.select().from(orgSettings).where(eq(orgSettings.orgId, site.orgId));
    const ic: IngestContext = { svc, site: siteRef, scanRunId: run.id, threshold: settings?.lowStockThreshold ?? 5, alertIds };
    const ctx: ConnectorContext = {
      site: { id: site.id, origin: site.origin, hostname: site.hostname, isFixture: site.isFixture },
      profile,
      fetcher,
      siteCurrency: siteRef.currency,
      now: svc.clock,
      log: (m, meta) => svc.log.debug(m, meta),
      limits: { maxProducts: null },
      browser: svc.browser,
      llm: svc.llm.available ? svc.llm : null,
    };
    const env: RunEnv = { svc, run, site, ic, ctx, fetcher, profile, deadline: run.deadlineAt };

    let outcome: Outcome | null = null;
    let used: AnyConnector | null = null;
    const attempted: string[] = [];
    for (const connector of candidates) {
      used = connector;
      attempted.push(connector.id);
      await svc.db.update(scanRuns).set({ connector: connector.id, connectorVersion: connector.version }).where(eq(scanRuns.id, run.id));
      run.connector = connector.id;
      outcome = connector.kind === 'feed' ? await runFeed(env, connector) : await runPages(env, connector);
      if (outcome.tryNext || (outcome.saved === 0 && outcome.state === 'failed' && candidates.length > 1)) {
        outcome.notes.push(`Connector "${connector.label}" produced no usable data${outcome.error ? ` (${outcome.error})` : ''}; trying the next method.`);
        await svc.db.delete(crawlQueue).where(eq(crawlQueue.scanRunId, run.id));
        await svc.db.update(scanRuns).set({ cursor: null }).where(eq(scanRuns.id, run.id));
        run.cursor = null;
        continue;
      }
      break;
    }
    if (!outcome || !used) throw new Error('no connector ran');
    if (attempted.length > 1) outcome.notes.unshift(`Methods tried: ${attempted.join(' → ')}`);

    // ── post-processing
    // Only a full enumeration may be used to infer that unseen products are gone.
    const complete = outcome.state === 'complete' && run.kind === 'discovery';
    if (complete) {
      await markMissing(svc.db, site.id, run.id, svc.clock());
      await sweepMissingSaleOffers(svc.db, site.id, run.id, svc.clock());
    }
    await expireOffers(svc.db, site.orgId, svc.clock());
    if (run.kind !== 'sample' && outcome.state !== 'blocked' && profile.promotions.flyerLinks.length) {
      try {
        const f = await collectFlyers(svc, svc.db, { ...siteRef, hostname: site.hostname }, fetcher, profile.promotions.flyerLinks, svc.clock());
        if (f.flyers) outcome.notes.push(`Read ${f.flyers} promotional flyer(s) (${f.items} items).`);
      } catch (e) {
        outcome.notes.push(`Flyer reading skipped: ${(e as Error).message}`);
      }
    }

    const status: ScanStatus = outcome.state === 'complete' ? (run.kind === 'sample' ? 'partial' : 'succeeded') : outcome.state === 'blocked' ? 'blocked' : outcome.state === 'failed' ? 'failed' : 'partial';
    const res = await finish(status, { productsSaved: outcome.saved, errorCode: outcome.errorCode, error: outcome.error, notes: outcome.notes, complete, connector: used.id, connectorVersion: used.version, estimatedTotal: outcome.estimatedTotal, requests: fetcher.requestsMade });
    await afterScan(svc, run, siteRef, res, outcome.error ?? null, alertIds);
    return res;
  } catch (e) {
    const c = classify(e);
    svc.log.error('scan crashed', { scanRunId, error: (e as Error).message });
    const res = await finish(c.state === 'blocked' ? 'blocked' : 'failed', { productsSaved: run.productsSaved, errorCode: c.code, error: c.message, notes: [], complete: false, connector: run.connector });
    await afterScan(svc, run, siteRef, res, c.message, alertIds);
    return res;
  } finally {
    await fetcher.close();
  }
}

/** After a COMPLETE enumeration, products that were not seen accumulate misses; two misses mark an apparent delisting. */
async function markMissing(db: DbLike, siteId: string, scanRunId: string, now: Date): Promise<void> {
  await db
    .update(products)
    .set({ missedCompleteScans: sql`${products.missedCompleteScans} + 1`, delistedAt: sql`case when ${products.missedCompleteScans} + 1 >= 2 and ${products.delistedAt} is null then ${now.toISOString()}::timestamptz else ${products.delistedAt} end` })
    .where(and(eq(products.siteId, siteId), ne(products.lastScanRunId, scanRunId)));
  await db.update(products).set({ missedCompleteScans: sql`${products.missedCompleteScans} + 1` }).where(and(eq(products.siteId, siteId), isNull(products.lastScanRunId)));
}

async function afterScan(svc: Services, run: typeof scanRuns.$inferSelect, site: IngestSite, res: ScanResult, reason: string | null, alertIds: string[]) {
  const outcome = res.status === 'blocked' ? 'blocked' : res.status === 'failed' ? 'failed' : 'ok';
  const id = await recordCollectionOutcome(svc, svc.db, { orgId: site.orgId, siteId: site.id, siteName: site.name, outcome, reason });
  if (id) alertIds.push(id);
  await emailAlertDigest(svc, svc.db, site.orgId, alertIds, `scan of ${site.name}`);
  if (run.dailyRunId) {
    await svc.queue.enqueue('daily-assemble', { orgId: site.orgId, dailyRunId: run.dailyRunId }, { singletonKey: `assemble-check:${run.dailyRunId}:${res.scanRunId}` });
  } else if (res.productsSaved > 0) {
    await svc.queue.enqueue('match-products', { orgId: site.orgId }, { singletonKey: `match:${site.orgId}`, startAfterSeconds: 5 });
  }
}

export const MAX_SCAN_RESUMES = 3;

export interface ScanRecovery {
  /** Runs put back on the queue to continue where they stopped. */
  resumed: string[];
  /** Runs that kept dying: closed as failed so the website is no longer stuck "collecting". */
  abandoned: string[];
}

/**
 * Keeps collection from getting stuck. A run whose worker went silent (running, no heartbeat for `staleAfterMs`) is re-queued and resumes from its
 * saved cursor. A run that was queued but never started (its job was lost) is re-queued under its original job key. Each re-queue is counted and
 * given a fresh grace period, so recovery neither floods the queue nor loops forever: after `maxResumes` the run is closed as failed with an honest
 * explanation, an alert is raised, and the website can be collected again.
 */
export async function recoverScans(svc: Services, o: { staleAfterMs?: number; orphanedAfterMs?: number; maxResumes?: number } = {}): Promise<ScanRecovery> {
  const now = svc.clock();
  const maxResumes = o.maxResumes ?? MAX_SCAN_RESUMES;
  const staleCutoff = new Date(now.getTime() - (o.staleAfterMs ?? 15 * 60_000));
  const orphanCutoff = new Date(now.getTime() - (o.orphanedAfterMs ?? 30 * 60_000));
  const stale = await svc.db.select().from(scanRuns).where(and(eq(scanRuns.status, 'running'), lt(sql`coalesce(${scanRuns.heartbeatAt}, ${scanRuns.startedAt}, ${scanRuns.createdAt})`, staleCutoff)));
  const orphanCandidates = await svc.db.select().from(scanRuns).where(and(eq(scanRuns.status, 'queued'), isNull(scanRuns.startedAt), lt(sql`coalesce(${scanRuns.heartbeatAt}, ${scanRuns.createdAt})`, orphanCutoff)));
  // A scheduled run that never started before its report's assembly cut-off is not resurrected: the report is built without it and assembly cancels it.
  const dailyIds = [...new Set(orphanCandidates.map((r) => r.dailyRunId).filter((x): x is string => !!x))];
  const cutoffs = new Map((dailyIds.length ? await svc.db.select({ id: dailyRuns.id, assembleAt: dailyRuns.assembleAt }).from(dailyRuns).where(inArray(dailyRuns.id, dailyIds)) : []).map((d) => [d.id, d.assembleAt]));
  const orphaned = orphanCandidates.filter((r) => {
    const at = r.dailyRunId ? cutoffs.get(r.dailyRunId) : null;
    return !at || now < at;
  });
  const out: ScanRecovery = { resumed: [], abandoned: [] };
  for (const r of [...stale, ...orphaned]) {
    if (r.resumeCount >= maxResumes) {
      await abandonScan(svc, r);
      out.abandoned.push(r.id);
      continue;
    }
    // Claim the attempt first: the fresh heartbeat is the grace period, and a concurrent scheduler instance no longer sees the run as stale.
    const claimed = await svc.db
      .update(scanRuns)
      .set({ resumeCount: r.resumeCount + 1, heartbeatAt: now })
      .where(and(eq(scanRuns.id, r.id), eq(scanRuns.resumeCount, r.resumeCount), inArray(scanRuns.status, ['queued', 'running'])))
      .returning({ id: scanRuns.id });
    if (!claimed.length) continue;
    await svc.queue.enqueue('scan-site', { orgId: r.orgId, scanRunId: r.id }, { singletonKey: r.status === 'queued' ? `scan:${r.id}` : `scan:${r.id}:resume:${r.resumeCount + 1}` });
    out.resumed.push(r.id);
  }
  return out;
}

/** Back-compatible wrapper: the ids that were re-queued. */
export async function recoverStaleScans(svc: Services, staleAfterMs = 15 * 60_000): Promise<string[]> {
  return (await recoverScans(svc, { staleAfterMs })).resumed;
}

async function abandonScan(svc: Services, run: typeof scanRuns.$inferSelect): Promise<void> {
  const msg = 'The collection stopped responding several times in a row and was abandoned. Data collected so far is kept.';
  const closed = await svc.db
    .update(scanRuns)
    .set({ status: 'failed', finishedAt: svc.clock(), errorCode: 'worker_lost', error: msg })
    .where(and(eq(scanRuns.id, run.id), inArray(scanRuns.status, ['queued', 'running'])))
    .returning({ id: scanRuns.id });
  if (!closed.length) return;
  const [site] = await svc.db.select().from(sites).where(eq(sites.id, run.siteId));
  if (!site) return;
  const alertIds: string[] = [];
  const id = await recordCollectionOutcome(svc, svc.db, { orgId: run.orgId, siteId: site.id, siteName: site.name, outcome: 'failed', reason: msg });
  if (id) alertIds.push(id);
  await emailAlertDigest(svc, svc.db, run.orgId, alertIds, `scan of ${site.name}`);
  if (run.dailyRunId) await svc.queue.enqueue('daily-assemble', { orgId: run.orgId, dailyRunId: run.dailyRunId }, { singletonKey: `assemble-check:${run.dailyRunId}:${run.id}` });
  svc.log.warn('scan abandoned after repeated worker loss', { scanRunId: run.id, resumes: run.resumeCount });
}

export async function cancelScan(svc: Services, db: DbLike, orgId: string, scanRunId: string): Promise<boolean> {
  const r = await db.update(scanRuns).set({ status: 'cancelled', finishedAt: svc.clock(), error: 'Cancelled by a user' }).where(and(eq(scanRuns.id, scanRunId), eq(scanRuns.orgId, orgId), inArray(scanRuns.status, ['queued', 'running']))).returning({ id: scanRuns.id });
  return r.length > 0;
}
