import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { alerts, dailyRuns, scanRuns } from '@ci/database';
import { MAX_SCAN_RESUMES, executeScan, recoverScans, recoverStaleScans, releaseActiveScans, schedulerTick, startScan, withActiveScan } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';

/**
 * Collection must never get stuck. A scan whose worker died resumes and finishes; a scan that was queued but whose job was lost is
 * re-queued; a scan that keeps dying is closed as failed (with an alert) instead of looping forever; healthy and finished scans are
 * never touched; recovery never queues the same attempt twice.
 */
let h: Harness;
let t: Tenant;
let siteId: string;
const MIN = 60_000;
const db = () => h.db.worker;
const row = async (id: string) => (await db().select().from(scanRuns).where(eq(scanRuns.id, id)))[0]!;
const scanJobs = () => h.queue.pending.filter((p) => p.name === 'scan-site');

/** A scan that exists in the database but whose queue job has been lost (as after a crash). */
async function lostScan(patch: Partial<typeof scanRuns.$inferInsert> = {}) {
  const { run, created } = await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
  expect(created).toBe(true);
  h.queue.pending.length = 0;
  if (Object.keys(patch).length) await db().update(scanRuns).set(patch).where(eq(scanRuns.id, run.id));
  return run.id;
}
const ago = (ms: number) => new Date(h.svc.clock().getTime() - ms);

beforeAll(async () => {
  h = await createHarness();
  t = await h.newTenant('Recovery');
  siteId = await t.addFixtureSite('woo', 'competitor');
}, 120_000);

afterEach(async () => {
  // leave no active run behind: a website can only have one at a time
  await db().update(scanRuns).set({ status: 'cancelled' }).where(and(eq(scanRuns.orgId, t.orgId), inArray(scanRuns.status, ['queued', 'running'])));
  h.queue.pending.length = 0;
});

afterAll(async () => {
  await h.close();
});

describe('a scan whose worker died', () => {
  it('is re-queued, resumes, and finishes the collection', async () => {
    const id = await lostScan({ status: 'running', startedAt: ago(60 * MIN), heartbeatAt: ago(20 * MIN) });
    const r = await recoverScans(h.svc);
    expect(r).toEqual({ resumed: [id], abandoned: [] });
    expect(await row(id)).toMatchObject({ resumeCount: 1, status: 'running' });
    expect(scanJobs()).toHaveLength(1);
    await h.queue.drain();
    expect(await row(id)).toMatchObject({ status: 'succeeded', isComplete: true });
    expect((await row(id)).productsSaved).toBeGreaterThan(0);
  });

  it('is left alone while its heartbeat is recent', async () => {
    const id = await lostScan({ status: 'running', startedAt: ago(30 * MIN), heartbeatAt: ago(5 * MIN) });
    expect((await recoverScans(h.svc)).resumed).toEqual([]);
    expect(scanJobs()).toHaveLength(0);
    expect((await row(id)).resumeCount).toBe(0);
  });

  it('is never queued twice for the same lapse, however often the scheduler looks', async () => {
    const id = await lostScan({ status: 'running', startedAt: ago(60 * MIN), heartbeatAt: ago(20 * MIN) });
    expect((await recoverScans(h.svc)).resumed).toEqual([id]);
    expect((await recoverScans(h.svc)).resumed).toEqual([]); // the fresh heartbeat is its grace period
    expect((await recoverScans(h.svc)).resumed).toEqual([]);
    expect(scanJobs()).toHaveLength(1);
    expect((await row(id)).resumeCount).toBe(1);
  });

  it('gets a new chance only after the grace period has passed again', async () => {
    const id = await lostScan({ status: 'running', startedAt: ago(90 * MIN), heartbeatAt: ago(20 * MIN) });
    await recoverScans(h.svc);
    h.queue.pending.length = 0;
    h.advance(16 * MIN); // the resumed worker also went silent
    expect((await recoverScans(h.svc)).resumed).toEqual([id]);
    expect((await row(id)).resumeCount).toBe(2);
  });

  it('a run that keeps dying is closed as failed, with an alert, instead of looping forever', async () => {
    const id = await lostScan({ status: 'running', startedAt: ago(5 * 3_600_000), heartbeatAt: ago(2 * 3_600_000), resumeCount: MAX_SCAN_RESUMES });
    const r = await recoverScans(h.svc);
    expect(r).toEqual({ resumed: [], abandoned: [id] });
    expect(scanJobs()).toHaveLength(0);
    const closed = await row(id);
    expect(closed).toMatchObject({ status: 'failed', errorCode: 'worker_lost' });
    expect(closed.error).toMatch(/stopped responding several times/);
    expect(closed.error).toMatch(/Data collected so far is kept/);
    expect(closed.finishedAt).not.toBeNull();
    const failureAlerts = await db().select().from(alerts).where(and(eq(alerts.orgId, t.orgId), eq(alerts.type, 'collection_failure'), eq(alerts.siteId, siteId)));
    expect(failureAlerts.length).toBeGreaterThanOrEqual(1);
    expect(failureAlerts.some((a) => a.resolvedAt === null)).toBe(true);

    // …and the website is not stuck: a new collection can start
    const next = await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
    expect(next.created).toBe(true);
    expect(next.run.id).not.toBe(id);
  });

  it('the scheduler tick reports what it resumed and what it abandoned', async () => {
    const resume = await lostScan({ status: 'running', startedAt: ago(60 * MIN), heartbeatAt: ago(20 * MIN) });
    const tick = await schedulerTick(h.svc);
    expect(tick.recoveredScans).toContain(resume);
    expect(tick.abandonedScans).not.toContain(resume);
    await db().update(scanRuns).set({ resumeCount: MAX_SCAN_RESUMES, heartbeatAt: ago(20 * MIN) }).where(eq(scanRuns.id, resume));
    expect((await schedulerTick(h.svc)).abandonedScans).toContain(resume);
  });
});

describe('a scan that was queued but whose job was lost', () => {
  it('is re-queued under its original job key once it has waited too long', async () => {
    const id = await lostScan({ createdAt: ago(2 * 3_600_000) });
    const r = await recoverScans(h.svc);
    expect(r.resumed).toEqual([id]);
    expect(scanJobs().map((j) => j.key)).toEqual([`scan:${id}`]); // the original key: a still-waiting original job is not duplicated
    await h.queue.drain();
    expect(await row(id)).toMatchObject({ status: 'succeeded' });
  });

  it('is left alone while it has only just been queued', async () => {
    const id = await lostScan({ createdAt: ago(5 * MIN) });
    expect((await recoverScans(h.svc)).resumed).toEqual([]);
    expect((await row(id)).resumeCount).toBe(0);
  });

  it('a scheduled run that never started is not resurrected after its report’s assembly cut-off — the report goes out without it', async () => {
    const [dr] = await db().insert(dailyRuns).values({ orgId: t.orgId, periodDate: '2026-12-01', assembleAt: ago(10 * MIN), deadlineAt: new Date(h.svc.clock().getTime() + 10 * MIN) }).returning({ id: dailyRuns.id });
    const id = await lostScan({ createdAt: ago(2 * 3_600_000), dailyRunId: dr!.id });
    expect((await recoverScans(h.svc)).resumed).toEqual([]);
    expect(await row(id)).toMatchObject({ status: 'queued', resumeCount: 0 }); // assembly, not recovery, closes it ("Not started before the report cut-off")
    // …but before the cut-off it is still recovered
    await db().update(dailyRuns).set({ assembleAt: new Date(h.svc.clock().getTime() + 30 * MIN) }).where(eq(dailyRuns.id, dr!.id));
    expect((await recoverScans(h.svc)).resumed).toEqual([id]);
  });

  it('is not recovered again straight away (fresh grace period)', async () => {
    await lostScan({ createdAt: ago(2 * 3_600_000) });
    expect((await recoverScans(h.svc)).resumed).toHaveLength(1);
    expect((await recoverScans(h.svc)).resumed).toHaveLength(0);
  });
});

describe('what recovery never touches', () => {
  it('finished and cancelled runs, however old their heartbeat', async () => {
    const id = await lostScan({ status: 'succeeded', startedAt: ago(5 * 3_600_000), heartbeatAt: ago(4 * 3_600_000), finishedAt: ago(4 * 3_600_000) });
    const cancelled = await db().insert(scanRuns).values({ orgId: t.orgId, siteId, kind: 'discovery', trigger: 'manual', status: 'cancelled', heartbeatAt: ago(4 * 3_600_000) }).returning({ id: scanRuns.id });
    const r = await recoverScans(h.svc);
    expect(r).toEqual({ resumed: [], abandoned: [] });
    expect(await row(id)).toMatchObject({ status: 'succeeded', resumeCount: 0 });
    expect(await row(cancelled[0]!.id)).toMatchObject({ status: 'cancelled', resumeCount: 0 });
  });

  it('a job that fires for a run that has already finished does no second collection', async () => {
    const id = await lostScan({ status: 'running', startedAt: ago(60 * MIN), heartbeatAt: ago(20 * MIN) });
    await recoverScans(h.svc);
    await h.queue.drain();
    const done = await row(id);
    expect(done.status).toBe('succeeded');
    const again = await executeScan(h.svc, id); // e.g. the original job's retry, hours later
    expect(again).toMatchObject({ status: 'succeeded', scanRunId: id });
    expect(await row(id)).toMatchObject({ requestsMade: done.requestsMade, productsSaved: done.productsSaved, finishedAt: done.finishedAt });
  });

  it('the old wrapper still returns the resumed ids', async () => {
    const id = await lostScan({ status: 'running', startedAt: ago(60 * MIN), heartbeatAt: ago(20 * MIN) });
    expect(await recoverStaleScans(h.svc)).toEqual([id]);
  });
});

describe('a worker that is stopping while a collection is still running', () => {
  it('hands the collection back, so it resumes within a scheduler pass instead of waiting out the silence window', async () => {
    const id = await lostScan({ status: 'running', startedAt: ago(3 * MIN), heartbeatAt: ago(MIN) }); // healthy: heartbeat a minute ago
    expect((await recoverScans(h.svc)).resumed).toEqual([]); // not stale yet, so recovery would leave it for 15 minutes…

    const released = await withActiveScan(id, () => releaseActiveScans(h.svc)); // …but a worker that is shutting down releases what it is running
    expect(released).toEqual([id]);
    const r = await recoverScans(h.svc);
    expect(r.resumed).toEqual([id]); // the next scheduler pass resumes it
    expect(scanJobs()).toHaveLength(1);
    await h.queue.drain();
    expect(await row(id)).toMatchObject({ status: 'succeeded' });
  });

  it('releases only scans that are still running, and only this process’s own', async () => {
    const other = await lostScan({ status: 'running', startedAt: ago(3 * MIN), heartbeatAt: ago(MIN) }); // someone else's collection
    expect(await releaseActiveScans(h.svc)).toEqual([]); // this process is running nothing
    expect((await recoverScans(h.svc)).resumed).toEqual([]);
    expect((await row(other)).heartbeatAt!.getTime()).toBe(ago(MIN).getTime());
    // a scan that already finished is never put back
    await db().update(scanRuns).set({ status: 'succeeded', finishedAt: ago(MIN) }).where(eq(scanRuns.id, other));
    expect(await withActiveScan(other, () => releaseActiveScans(h.svc))).toEqual([other]);
    expect(await row(other)).toMatchObject({ status: 'succeeded' });
    expect((await recoverScans(h.svc)).resumed).toEqual([]);
  });

  it('a scan stops being "active" when it finishes, even if it throws', async () => {
    await expect(withActiveScan('00000000-0000-4000-8000-000000000001', async () => { throw new Error('crash'); })).rejects.toThrow('crash');
    expect(await releaseActiveScans(h.svc)).toEqual([]);
  });
});
