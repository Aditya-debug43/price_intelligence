import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { alerts, dailyRuns, emailOutbox, orgSettings, reports, scanRuns } from '@ci/database';
import type { ReportData } from '@ci/shared';
import { planForOrg, runMatching, schedulerTick, startScan } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';

let h: Harness;
let t: Tenant;
const ids: Record<string, string> = {};
const db = () => h.db.worker;

/** 09:00 America/Aruba (UTC-4, no DST) == 13:00Z. */
const ARUBA = (date: string, hhmm: string) => new Date(`${date}T${String((Number(hhmm.slice(0, 2)) + 4) % 24).padStart(2, '0')}${hhmm.slice(2)}:00Z`);

beforeAll(async () => {
  h = await createHarness({ now: '2026-10-13T20:00:00Z' });
  t = await h.newTenant('Sched');
  ids.source = await t.addFixtureSite('source', 'source');
  ids.woo = await t.addFixtureSite('woo', 'competitor');
  ids.jsonld = await t.addFixtureSite('jsonld', 'competitor');
  // baseline collection the evening before
  for (const k of Object.keys(ids)) await t.tx((tx) => startScan(h.svc, tx, t.orgId, ids[k]!, { kind: 'discovery', trigger: 'manual' }));
  await h.queue.drain();
  await runMatching(h.svc, db(), t.orgId);
  // give the measured history realistic durations (a frozen test clock would otherwise record 0 ms)
  await db().execute(sql`update scan_runs set started_at = finished_at - interval '60 minutes' where org_id = ${t.orgId} and status = 'succeeded'`);
}, 120_000);

afterAll(async () => {
  await h.close();
});

describe('start time is computed from measured durations, in the workspace timezone', () => {
  it('uses the slowest site P90 × safety factor + assembly time before the 09:00 Aruba deadline', async () => {
    const s = (await planForOrg(h.svc, db(), t.orgId, '2026-10-15'))!;
    expect(s.deadline.toISOString()).toBe('2026-10-15T13:00:00.000Z'); // 09:00 in America/Aruba
    expect(s.plan.slowestSiteMs).toBe(60 * 60_000);
    expect(s.plan.leadMs).toBe(60 * 60_000 * 1.6 + 10 * 60_000);
    expect(s.plan.startAt.toISOString()).toBe(new Date(s.deadline.getTime() - 106 * 60_000).toISOString());
    expect(s.plan.assembleAt.toISOString()).toBe('2026-10-15T12:50:00.000Z');
    expect(s.plan.basis).toMatch(/P90/);
  });

  it('follows DST rules of other zones without hard-coded offsets', async () => {
    const other = await h.newTenant('NY');
    await other.tx((tx) => tx.update(orgSettings).set({ timezone: 'America/New_York' }).where(eq(orgSettings.orgId, other.orgId)));
    expect((await planForOrg(h.svc, db(), other.orgId, '2026-01-15'))!.deadline.toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect((await planForOrg(h.svc, db(), other.orgId, '2026-07-15'))!.deadline.toISOString()).toBe('2026-07-15T13:00:00.000Z');
  });
});

describe('a normal morning', () => {
  it('does nothing before the planned start', async () => {
    h.setNow(ARUBA('2026-10-15', '06:00'));
    const r = await schedulerTick(h.svc);
    expect(r.started).toEqual([]);
    expect(await db().select().from(dailyRuns).where(eq(dailyRuns.orgId, t.orgId))).toHaveLength(0);
  });

  it('starts budgeted scans at the planned time, exactly once, and publishes the report before the deadline', async () => {
    h.setNow(ARUBA('2026-10-15', '07:20')); // after 07:14 planned start
    const r = await schedulerTick(h.svc);
    expect(r.started).toEqual([{ orgId: t.orgId, date: '2026-10-15', scans: 3 }]);
    await schedulerTick(h.svc); // a second tick must not start it again
    const [dr] = await db().select().from(dailyRuns).where(eq(dailyRuns.orgId, t.orgId));
    expect(dr).toMatchObject({ periodDate: '2026-10-15', status: 'collecting', trigger: 'scheduled' });
    expect(dr!.assembleAt!.toISOString()).toBe('2026-10-15T12:50:00.000Z');
    const scans = await db().select().from(scanRuns).where(eq(scanRuns.dailyRunId, dr!.id));
    expect(scans).toHaveLength(3);
    expect(scans.every((s) => s.trigger === 'scheduled' && s.requestBudget! >= 25 && s.deadlineAt!.toISOString() === '2026-10-15T12:50:00.000Z')).toBe(true);
    // feeds are refreshed completely; the page-crawl site does a rolling refresh of known products
    expect(scans.find((s) => s.siteId === ids.source)!.kind).toBe('discovery');
    expect(scans.find((s) => s.siteId === ids.jsonld)!.kind).toBe('refresh');

    await h.queue.drain();
    const [done] = await db().select().from(dailyRuns).where(eq(dailyRuns.id, dr!.id));
    expect(done).toMatchObject({ status: 'done' });
    const [rep] = await db().select().from(reports).where(eq(reports.id, done!.reportId!));
    expect(rep).toMatchObject({ kind: 'scheduled', periodDate: '2026-10-15', status: 'ready', isPartial: false, readyBeforeDeadline: true });
    expect(rep!.generatedAt!.getTime()).toBeLessThan(ARUBA('2026-10-15', '09:00').getTime());
    const data = rep!.data as ReportData;
    expect(data.meta.isPartial).toBe(false);
    expect(data.meta.deadlineAt).toBe('2026-10-15T13:00:00.000Z');
    expect(data.sites.every((s) => s.complete)).toBe(true);
  });

  it('sends the concise summary email and an in-app notification', async () => {
    const mails = (await db().select().from(emailOutbox).where(eq(emailOutbox.orgId, t.orgId))).filter((m) => m.kind === 'daily-summary');
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ status: 'dev_logged' });
    expect(mails[0]!.subject).toBe('Competitor report — 2026-10-15');
    expect(mails[0]!.toAddresses).toEqual([t.email]);
    expect(mails[0]!.text).toMatch(/Open the full report: http:\/\/localhost:5173\/reports\//);
    expect(mails[0]!.text.length).toBeLessThan(3000);
    const a = await db().select().from(alerts).where(and(eq(alerts.orgId, t.orgId), eq(alerts.type, 'report_ready')));
    expect(a).toHaveLength(1);
  });

  it('is idempotent: later ticks that morning create nothing new', async () => {
    h.setNow(ARUBA('2026-10-15', '08:30'));
    await schedulerTick(h.svc);
    await h.queue.drain();
    expect(await db().select().from(dailyRuns).where(and(eq(dailyRuns.orgId, t.orgId), eq(dailyRuns.periodDate, '2026-10-15')))).toHaveLength(1);
    expect((await db().select().from(reports).where(and(eq(reports.orgId, t.orgId), eq(reports.kind, 'scheduled')))).length).toBe(1);
  });
});

describe('a slow morning: partial report at the cut-off, stale data never presented as fresh', () => {
  it('publishes a clearly labelled partial report at 08:50 when one site has not run', async () => {
    h.setNow(ARUBA('2026-10-17', '07:20')); // nothing ran on the 16th ⇒ yesterday's data is ~2 days old
    await schedulerTick(h.svc);
    // simulate a worker backlog: the jsonld scan never starts
    const dropped = h.queue.pending.filter((p) => p.name === 'scan-site' && p.key && (p.data as { scanRunId: string }).scanRunId);
    const [dr] = await db().select().from(dailyRuns).where(and(eq(dailyRuns.orgId, t.orgId), eq(dailyRuns.periodDate, '2026-10-17')));
    const slowRun = (await db().select().from(scanRuns).where(and(eq(scanRuns.dailyRunId, dr!.id), eq(scanRuns.siteId, ids.jsonld!))))[0]!;
    h.queue.pending.splice(0, h.queue.pending.length, ...dropped.filter((p) => (p.data as { scanRunId: string }).scanRunId !== slowRun.id));
    await h.queue.drain(); // the other two sites finish; assembly waits for the third
    expect((await db().select().from(dailyRuns).where(eq(dailyRuns.id, dr!.id)))[0]!.status).toBe('collecting');
    expect(await db().select().from(reports).where(and(eq(reports.orgId, t.orgId), eq(reports.periodDate, '2026-10-17')))).toHaveLength(0);

    h.setNow(ARUBA('2026-10-17', '08:55')); // past the 08:50 assembly cut-off, before the 09:00 deadline
    const r = await schedulerTick(h.svc);
    expect(r.assembleQueued).toEqual([{ orgId: t.orgId, date: '2026-10-17' }]);
    await h.queue.drain();

    const [after] = await db().select().from(dailyRuns).where(eq(dailyRuns.id, dr!.id));
    expect(after!.status).toBe('done');
    const [rep] = await db().select().from(reports).where(eq(reports.id, after!.reportId!));
    expect(rep).toMatchObject({ status: 'partial', isPartial: true, readyBeforeDeadline: true });
    const data = rep!.data as ReportData;
    expect(data.headline).toMatch(/^Partial report/);
    expect(data.warnings.join(' ')).toMatch(/cut-off was reached before .*Superstore/);
    const stale = data.sites.find((s) => s.name.includes('Superstore'))!;
    expect(stale.complete).toBe(false);
    expect(stale.productsStale).toBeGreaterThan(0);
    expect(stale.warnings.join(' ')).toMatch(/latest collection was cancelled .*cut-off/i);
    expect(stale.warnings.join(' ')).toMatch(/not been observed within 36 h/);
    // prices from that site keep their ORIGINAL observation time and are flagged stale
    const cells = data.comparisons.flatMap((c) => c.cells).filter((c) => c.siteName.includes('Superstore'));
    expect(cells.length).toBeGreaterThan(5);
    expect(cells.every((c) => c.price.stale && c.price.observedAt! < '2026-10-16')).toBe(true);
    expect(cells.every((c) => c.caveats.some((x) => /stale/i.test(x)))).toBe(true);
    // the scan that never started is cancelled, not left dangling or pretended-complete
    const [cancelled] = await db().select().from(scanRuns).where(eq(scanRuns.id, slowRun.id));
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    // freshly collected sites remain fresh
    expect(data.sites.filter((s) => !s.name.includes('Superstore')).every((s) => s.productsStale === 0)).toBe(true);
    const a = await db().select().from(alerts).where(and(eq(alerts.orgId, t.orgId), eq(alerts.reportId, rep!.id)));
    expect(a[0]!.type).toBe('report_partial');
  });

  it('a late scan job that fires after the cut-off does nothing', async () => {
    const scans = await db().select().from(scanRuns).where(and(eq(scanRuns.orgId, t.orgId), eq(scanRuns.status, 'cancelled')));
    const before = (await db().select().from(reports).where(eq(reports.orgId, t.orgId))).length;
    await h.queue.enqueue('scan-site', { orgId: t.orgId, scanRunId: scans[0]!.id });
    await h.queue.drain();
    expect((await db().select().from(scanRuns).where(eq(scanRuns.id, scans[0]!.id)))[0]!.status).toBe('cancelled');
    expect((await db().select().from(reports).where(eq(reports.orgId, t.orgId))).length).toBe(before);
  });
});

describe('late and disabled schedules', () => {
  it('starts a late run within the grace window (flagged as past the deadline) but not hours later', async () => {
    const late = await h.newTenant('Late');
    const s = await late.addFixtureSite('woo', 'source');
    void s;
    h.setNow(ARUBA('2026-10-20', '09:30')); // worker was down overnight
    const r = await schedulerTick(h.svc);
    expect(r.started.find((x) => x.orgId === late.orgId)).toMatchObject({ date: '2026-10-20', scans: 1 });
    await h.queue.drain();
    const [rep] = await db().select().from(reports).where(and(eq(reports.orgId, late.orgId), eq(reports.kind, 'scheduled')));
    expect(rep!.readyBeforeDeadline).toBe(false);
    expect((rep!.data as ReportData).meta.readyBeforeDeadline).toBe(false);

    const later = await h.newTenant('TooLate');
    await later.addFixtureSite('woo', 'source');
    h.setNow(ARUBA('2026-10-21', '14:00')); // 5 h after the deadline with no run: do not start a stale "today" run
    const r2 = await schedulerTick(h.svc);
    expect(r2.started.find((x) => x.orgId === later.orgId && x.date === '2026-10-21')).toBeUndefined();
  });

  it('skips workspaces whose schedule is switched off', async () => {
    const off = await h.newTenant('Off');
    await off.addFixtureSite('woo', 'source');
    await off.tx((tx) => tx.update(orgSettings).set({ scheduleEnabled: false }).where(eq(orgSettings.orgId, off.orgId)));
    h.setNow(ARUBA('2026-10-22', '08:00'));
    const r = await schedulerTick(h.svc);
    expect(r.started.find((x) => x.orgId === off.orgId)).toBeUndefined();
  });

  it('re-queues scans whose worker died (no heartbeat) so they resume', async () => {
    const run = (await db().select().from(scanRuns).where(eq(scanRuns.orgId, t.orgId)))[0]!;
    await db().update(scanRuns).set({ status: 'running', heartbeatAt: new Date(h.svc.clock().getTime() - 3_600_000) }).where(eq(scanRuns.id, run.id));
    const r = await schedulerTick(h.svc);
    expect(r.recoveredScans).toContain(run.id);
    expect(h.queue.pending.some((p) => p.name === 'scan-site' && (p.data as { scanRunId: string }).scanRunId === run.id)).toBe(true);
    h.queue.pending.length = 0;
  });
});
