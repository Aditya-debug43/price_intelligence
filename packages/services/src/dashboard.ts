import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DEFAULTS, type InsightRow, type ReportData, type ReportKpis, type SiteCoverage } from '@ci/shared';
import { alerts, orgSettings, productMatches, reports, scanRuns, type DbLike } from '@ci/database';
import type { Services } from './context.ts';
import { loadCoverage } from './coverage.ts';
import { planForOrg } from './scheduler.ts';
import { localDate } from '@ci/core';
import { DateTime } from 'luxon';

export interface DashboardData {
  latestReport: null | {
    id: string; periodDate: string; generatedAt: string | null; isPartial: boolean; headline: string; readyBeforeDeadline: boolean | null;
    kpis: ReportKpis; topInsights: InsightRow[]; warnings: string[];
  };
  coverage: SiteCoverage[];
  alerts: { unacknowledged: number; recent: { id: string; type: string; severity: string; title: string; body: string | null; createdAt: string; acknowledgedAt: string | null }[] };
  activeScans: { id: string; siteId: string; status: string; kind: string; productsSaved: number; estimatedTotal: number | null }[];
  matchesNeedingReview: number;
  nextReport: null | { date: string; deadlineAt: string; plannedStartAt: string; basis: string; timezone: string; enabled: boolean };
  trend: { periodDate: string; averageDiffPct: number | null; matchedProducts: number; isPartial: boolean }[];
  freshness: { newest: string | null; oldest: string | null; staleProducts: number; staleAfterHours: number };
}

export async function loadDashboard(svc: Services, db: DbLike, orgId: string): Promise<DashboardData> {
  const now = svc.clock();
  const [settings] = await db.select().from(orgSettings).where(eq(orgSettings.orgId, orgId));
  const coverage = await loadCoverage(db, orgId, now, DEFAULTS.staleAfterHours);
  const [latest] = await db.select().from(reports).where(and(eq(reports.orgId, orgId), inArray(reports.status, ['ready', 'partial']))).orderBy(desc(reports.createdAt)).limit(1);
  const data = latest?.data as ReportData | null | undefined;

  const recent = await db.select().from(alerts).where(eq(alerts.orgId, orgId)).orderBy(desc(alerts.createdAt)).limit(10);
  const [{ n: unack } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(alerts).where(and(eq(alerts.orgId, orgId), isNull(alerts.acknowledgedAt), isNull(alerts.resolvedAt)));
  const active = await db.select().from(scanRuns).where(and(eq(scanRuns.orgId, orgId), inArray(scanRuns.status, ['queued', 'running']))).limit(20);
  const [{ n: review } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(productMatches).where(and(eq(productMatches.orgId, orgId), eq(productMatches.status, 'needs_review')));

  let nextReport: DashboardData['nextReport'] = null;
  if (settings) {
    const today = localDate(now, settings.timezone);
    let sched = await planForOrg(svc, db, orgId, today);
    if (sched && sched.deadline < now) sched = await planForOrg(svc, db, orgId, DateTime.fromISO(today, { zone: settings.timezone }).plus({ days: 1 }).toISODate()!);
    if (sched) nextReport = { date: sched.date, deadlineAt: sched.deadline.toISOString(), plannedStartAt: sched.plan.startAt.toISOString(), basis: sched.plan.basis, timezone: settings.timezone, enabled: settings.scheduleEnabled };
  }

  const history = await db
    .select({ periodDate: reports.periodDate, isPartial: reports.isPartial, kpis: sql<ReportKpis | null>`${reports.data}->'kpis'` })
    .from(reports)
    .where(and(eq(reports.orgId, orgId), inArray(reports.status, ['ready', 'partial'])))
    .orderBy(desc(reports.createdAt))
    .limit(30);

  const newest = coverage.map((c) => c.newestObservation).filter(Boolean).sort().pop() ?? null;
  const oldest = coverage.map((c) => c.oldestObservation).filter(Boolean).sort()[0] ?? null;
  return {
    latestReport: latest && data ? { id: latest.id, periodDate: latest.periodDate, generatedAt: latest.generatedAt?.toISOString() ?? null, isPartial: latest.isPartial, headline: data.headline, readyBeforeDeadline: latest.readyBeforeDeadline, kpis: data.kpis, topInsights: data.insights.slice(0, 6), warnings: data.warnings.slice(0, 8) } : null,
    coverage,
    alerts: { unacknowledged: unack, recent: recent.map((a) => ({ id: a.id, type: a.type, severity: a.severity, title: a.title, body: a.body, createdAt: a.createdAt.toISOString(), acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null })) },
    activeScans: active.map((s) => ({ id: s.id, siteId: s.siteId, status: s.status, kind: s.kind, productsSaved: s.productsSaved, estimatedTotal: s.estimatedTotal })),
    matchesNeedingReview: review,
    nextReport,
    trend: history.reverse().map((h) => ({ periodDate: h.periodDate, averageDiffPct: h.kpis?.averageDiffPct ?? null, matchedProducts: h.kpis?.matchedProducts ?? 0, isPartial: h.isPartial })),
    freshness: { newest, oldest, staleProducts: coverage.reduce((a, c) => a + c.productsStale, 0), staleAfterHours: DEFAULTS.staleAfterHours },
  };
}
