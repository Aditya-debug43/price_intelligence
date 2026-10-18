import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { decideDailyAction, deadlineInstant, localDate, planStartTime, requestBudget, type StartTimePlan } from '@ci/core';
import { dailyRuns, integrationConnections, orgSettings, scanRuns, siteProfiles, sites, socialAccounts, type DbLike } from '@ci/database';
import type { Services } from './context.ts';
import { generateReport } from './report.ts';
import { runMatching } from './matching.ts';
import { startScan, recoverScans } from './scan.ts';
import { DateTime } from 'luxon';

/**
 * Daily reporting orchestration.
 *
 *   start time = deadline − max(minLead, P90(slowest site's measured duration) × safety + assembly time)
 *
 * Sites are collected in parallel, each bounded by a request budget derived from the time available. At the
 * assembly cut-off the report is built from whatever was observed and is clearly labelled PARTIAL when any site is
 * incomplete. Observations keep their original timestamps, so stale data is never presented as fresh.
 */

const ASSEMBLY_MS = 10 * 60_000;
const SAFETY_FACTOR = 1.6;
const DEFAULT_SITE_MS = 45 * 60_000;
const MIN_LEAD_MS = 30 * 60_000;
const MAX_LEAD_MS = 8 * 3_600_000;
const LATE_START_GRACE_MS = 3 * 3_600_000;

export async function measuredDurations(db: DbLike, orgId: string, siteIds: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (const id of siteIds) {
    const rows = await db
      .select({ s: scanRuns.startedAt, f: scanRuns.finishedAt })
      .from(scanRuns)
      .where(and(eq(scanRuns.orgId, orgId), eq(scanRuns.siteId, id), eq(scanRuns.status, 'succeeded'), sql`${scanRuns.kind} <> 'sample'`))
      .orderBy(desc(scanRuns.finishedAt))
      .limit(10);
    out.push(rows.filter((r) => r.s && r.f).map((r) => r.f!.getTime() - r.s!.getTime()));
  }
  return out;
}

export interface OrgSchedule {
  orgId: string;
  date: string;
  deadline: Date;
  plan: StartTimePlan;
}

export async function planForOrg(svc: Services, db: DbLike, orgId: string, date: string): Promise<OrgSchedule | null> {
  const [s] = await db.select().from(orgSettings).where(eq(orgSettings.orgId, orgId));
  if (!s) return null;
  const siteRows = await db.select().from(sites).where(and(eq(sites.orgId, orgId), eq(sites.active, true), eq(sites.consentStatus, 'confirmed')));
  const deadline = deadlineInstant(date, s.reportReadyTime, s.timezone);
  const durations = await measuredDurations(db, orgId, siteRows.map((x) => x.id));
  const plan = planStartTime({ deadline, siteDurationsMs: durations.length ? durations : [[]], defaultSiteDurationMs: DEFAULT_SITE_MS, assemblyMs: ASSEMBLY_MS, safetyFactor: SAFETY_FACTOR, minLeadMs: MIN_LEAD_MS, maxLeadMs: MAX_LEAD_MS });
  return { orgId, date, deadline, plan };
}

async function chooseKind(db: DbLike, siteId: string, now: Date): Promise<'discovery' | 'refresh'> {
  const [prof] = await db.select().from(siteProfiles).where(eq(siteProfiles.siteId, siteId)).orderBy(desc(siteProfiles.createdAt)).limit(1);
  // A stored profile from an older version (or a damaged one) may lack a strategy; that must never stop the whole scheduler pass.
  const primary = prof?.data?.strategy?.primary;
  const feed = primary === 'shopify-products-json' || primary === 'woocommerce-store-api';
  if (feed) return 'discovery'; // a machine feed refreshes the whole catalogue in a few requests
  const [last] = await db.select().from(scanRuns).where(and(eq(scanRuns.siteId, siteId), eq(scanRuns.kind, 'discovery'), inArray(scanRuns.status, ['succeeded', 'partial']))).orderBy(desc(scanRuns.finishedAt)).limit(1);
  if (!last?.finishedAt || now.getTime() - last.finishedAt.getTime() > 7 * 86_400_000) return 'discovery';
  return 'refresh';
}

export interface TickResult {
  started: { orgId: string; date: string; scans: number }[];
  assembleQueued: { orgId: string; date: string }[];
  recoveredScans: string[];
  /** Runs that kept dying and were closed as failed this tick. */
  abandonedScans: string[];
}

/** One scheduler pass. `svc.clock()` is the notion of "now", so a test can place the pass at any time of day. */
export async function schedulerTick(svc: Services): Promise<TickResult> {
  const now = svc.clock();
  const recovery = await recoverScans(svc);
  const result: TickResult = { started: [], assembleQueued: [], recoveredScans: recovery.resumed, abandonedScans: recovery.abandoned };
  const orgs = await svc.db.select().from(orgSettings).where(eq(orgSettings.scheduleEnabled, true));
  for (const o of orgs) {
    const today = localDate(now, o.timezone);
    const tomorrow = DateTime.fromISO(today, { zone: o.timezone }).plus({ days: 1 }).toISODate()!;
    for (const date of [today, tomorrow]) {
      const sched = await planForOrg(svc, svc.db, o.orgId, date);
      if (!sched) continue;
      const [dr] = await svc.db.select().from(dailyRuns).where(and(eq(dailyRuns.orgId, o.orgId), eq(dailyRuns.periodDate, date)));
      if (!dr && date === today && now.getTime() > sched.deadline.getTime() + LATE_START_GRACE_MS) continue; // too late to start today's run
      const action = decideDailyAction(now, sched.plan, { collectionStarted: !!dr, reportExists: dr?.status === 'done' || dr?.status === 'assembling' });
      if (action === 'collect') {
        const n = await startDailyRun(svc, o.orgId, date, sched, 'scheduled');
        if (n !== null) result.started.push({ orgId: o.orgId, date, scans: n });
      } else if (action === 'assemble' && dr) {
        await svc.queue.enqueue('daily-assemble', { orgId: o.orgId, dailyRunId: dr.id, cutoff: true }, { singletonKey: `assemble:${dr.id}` });
        result.assembleQueued.push({ orgId: o.orgId, date });
      }
    }
  }
  return result;
}

/** Creates the daily run once (unique per org+date) and starts a budgeted scan for every eligible site. */
export async function startDailyRun(svc: Services, orgId: string, date: string, sched: OrgSchedule, trigger: 'scheduled' | 'manual' | 'dev'): Promise<number | null> {
  const now = svc.clock();
  const [dr] = await svc.db
    .insert(dailyRuns)
    .values({ orgId, periodDate: date, status: 'collecting', trigger, plannedStartAt: sched.plan.startAt, startedAt: now, assembleAt: sched.plan.assembleAt, deadlineAt: sched.deadline, plan: { basis: sched.plan.basis, leadMinutes: Math.round(sched.plan.leadMs / 60000), slowestSiteMinutes: Math.round(sched.plan.slowestSiteMs / 60000) } })
    .onConflictDoNothing({ target: [dailyRuns.orgId, dailyRuns.periodDate] })
    .returning();
  if (!dr) return null; // another tick already started it
  const siteRows = await svc.db.select().from(sites).where(and(eq(sites.orgId, orgId), eq(sites.active, true), eq(sites.consentStatus, 'confirmed')));
  let started = 0;
  const availableMs = Math.max(60_000, sched.plan.assembleAt.getTime() - now.getTime());
  for (const s of siteRows) {
    const kind = await chooseKind(svc.db, s.id, now);
    const budget = requestBudget({ availableMs, crawlDelayMs: s.crawlDelayMs, avgLatencyMs: 600, maxConcurrency: 1, policyMaxRequests: s.maxRequestsPerRun });
    const { created } = await startScan(svc, svc.db, orgId, s.id, { kind, trigger: trigger === 'scheduled' ? 'scheduled' : trigger === 'dev' ? 'dev' : 'manual', dailyRunId: dr.id, deadlineAt: sched.plan.assembleAt, requestBudget: Math.max(25, budget) });
    if (created) started++;
  }
  // Authorised inventory and social activity are refreshed in the same window.
  const conns = await svc.db.select().from(integrationConnections).where(and(eq(integrationConnections.orgId, orgId), eq(integrationConnections.status, 'connected')));
  for (const c of conns) await svc.queue.enqueue('sync-inventory', { orgId, connectionId: c.id }, { singletonKey: `inv:${c.id}:${date}` });
  const accts = await svc.db.select({ n: sql<number>`count(*)::int` }).from(socialAccounts).where(and(eq(socialAccounts.orgId, orgId), eq(socialAccounts.confirmed, true)));
  if ((accts[0]?.n ?? 0) > 0) await svc.queue.enqueue('sync-social', { orgId }, { singletonKey: `social:${orgId}:${date}` });
  if (started === 0) await svc.queue.enqueue('daily-assemble', { orgId, dailyRunId: dr.id }, { singletonKey: `assemble:${dr.id}:empty` });
  svc.log.info('daily run started', { orgId, date, scans: started });
  return started;
}

export type AssembleOutcome = 'waiting' | 'assembled' | 'already_done' | 'not_found';

/** Builds the report when all scans are finished, or at the cut-off with whatever exists (labelled partial). */
export async function dailyAssemble(svc: Services, orgId: string, dailyRunId: string, opts: { cutoff?: boolean } = {}): Promise<{ outcome: AssembleOutcome; reportId?: string }> {
  const now = svc.clock();
  const [dr] = await svc.db.select().from(dailyRuns).where(and(eq(dailyRuns.id, dailyRunId), eq(dailyRuns.orgId, orgId)));
  if (!dr) return { outcome: 'not_found' };
  if (dr.status !== 'collecting') return { outcome: 'already_done', reportId: dr.reportId ?? undefined };
  const scans = await svc.db.select().from(scanRuns).where(eq(scanRuns.dailyRunId, dailyRunId));
  const unfinished = scans.filter((s) => s.status === 'queued' || s.status === 'running');
  const cutoffReached = opts.cutoff || (dr.assembleAt && now >= dr.assembleAt);
  if (unfinished.length && !cutoffReached) return { outcome: 'waiting' };

  // Claim the assembly exactly once.
  const claimed = await svc.db.update(dailyRuns).set({ status: 'assembling' }).where(and(eq(dailyRuns.id, dailyRunId), eq(dailyRuns.status, 'collecting'))).returning({ id: dailyRuns.id });
  if (!claimed.length) return { outcome: 'already_done', reportId: dr.reportId ?? undefined };

  let partialReason: string | undefined;
  if (unfinished.length) {
    const names = await svc.db.select({ id: sites.id, name: sites.name }).from(sites).where(inArray(sites.id, unfinished.map((u) => u.siteId)));
    partialReason = `The assembly cut-off was reached before ${names.map((n) => n.name).join(', ')} finished. Their data shows the last completed observations with original timestamps.`;
    // Runs that never started are cancelled; running ones stop themselves at their own deadline.
    const neverStarted = unfinished.filter((u) => u.status === 'queued').map((u) => u.id);
    if (neverStarted.length) await svc.db.update(scanRuns).set({ status: 'cancelled', finishedAt: now, error: 'Not started before the report cut-off' }).where(and(inArray(scanRuns.id, neverStarted), eq(scanRuns.status, 'queued')));
  }
  try {
    await runMatching(svc, svc.db, orgId);
    const report = await generateReport(svc, svc.db, orgId, { kind: 'scheduled', deadlineAt: dr.deadlineAt, forcePartial: !!partialReason, forcePartialReason: partialReason, dailyRunId, sendSummaryEmail: true });
    await svc.db.update(dailyRuns).set({ status: 'done', reportId: report.id, assembledAt: svc.clock() }).where(eq(dailyRuns.id, dailyRunId));
    return { outcome: 'assembled', reportId: report.id };
  } catch (e) {
    await svc.db.update(dailyRuns).set({ status: 'failed' }).where(eq(dailyRuns.id, dailyRunId));
    svc.log.error('daily assembly failed', { orgId, dailyRunId, error: (e as Error).message });
    throw e;
  }
}
