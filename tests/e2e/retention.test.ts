import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { alerts, dailyRuns, evidence, flyers, marketingActivities, offers, orgSettings, priceObservations, productMatches, reportExports, reports, siteProfiles, stockObservations } from '@ci/database';
import { exportReport, generateReport, runMatching, runRetention, startScan } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';

/**
 * Retention: raw snapshots ≈90 days, structured history/reports ≈1 year — each workspace on its own settings. Deletion is exact at the
 * boundary, covers everything that would otherwise grow forever, keeps what is not "history" (the newest profile of a website, people's
 * match decisions), never lets a failing storage backend stop the rest, and is safe to run repeatedly.
 */
const DAY = 86_400_000;
let h: Harness;
let A: Tenant; // short windows: 7-day snapshots, 30-day history
let B: Tenant; // defaults: 90 / 365
const ids: Record<string, Record<string, string>> = { A: {}, B: {} };
const reportOf: Record<string, string> = {};
const db = () => h.db.worker;
/** Retention is global by design; the test database is shared with other files, so each run here is scoped to this file's two workspaces. */
const SCOPE = () => ({ orgIds: [A.orgId, B.orgId] });
const t0 = new Date('2026-10-14T12:00:00Z');
const at = (daysFromStart: number) => new Date(t0.getTime() + daysFromStart * DAY);
const count = async <T>(q: Promise<T[]>) => (await q).length;

const evidenceOf = (t: Tenant) => db().select().from(evidence).where(eq(evidence.orgId, t.orgId));
const obsOf = (t: Tenant) => db().select().from(priceObservations).where(eq(priceObservations.orgId, t.orgId));
const reportsOf = (t: Tenant) => db().select().from(reports).where(eq(reports.orgId, t.orgId));
const exportsOf = (t: Tenant) => db().select().from(reportExports).where(eq(reportExports.orgId, t.orgId));
const matchesOf = (t: Tenant) => db().select().from(productMatches).where(eq(productMatches.orgId, t.orgId));

beforeAll(async () => {
  h = await createHarness({ now: t0.toISOString() });
  A = await h.newTenant('RetentionA');
  B = await h.newTenant('RetentionB');
  for (const [key, t] of [['A', A], ['B', B]] as const) {
    ids[key]!.source = await t.addFixtureSite('source', 'source');
    ids[key]!.woo = await t.addFixtureSite('woo', 'competitor');
    ids[key]!.jsonld = await t.addFixtureSite('jsonld', 'competitor'); // page-based: stores a snapshot per product page
    for (const s of Object.values(ids[key]!)) await t.tx((tx) => startScan(h.svc, tx, t.orgId, s, { kind: 'discovery', trigger: 'manual' }));
  }
  await h.queue.drain();
  for (const [key, t] of [['A', A], ['B', B]] as const) {
    await runMatching(h.svc, db(), t.orgId);
    const rep = await generateReport(h.svc, db(), t.orgId, { kind: 'manual', deadlineAt: null, createdBy: t.userId });
    reportOf[key] = rep.id;
    await exportReport(h.svc, db(), t.orgId, rep.id, 'pdf');
    await exportReport(h.svc, db(), t.orgId, rep.id, 'csv');
  }
  await db().update(orgSettings).set({ snapshotRetentionDays: 7, historyRetentionDays: 30 }).where(eq(orgSettings.orgId, A.orgId));
}, 180_000);

afterAll(async () => {
  await h.close();
});

describe('each workspace keeps data for its own windows', () => {
  it('has something to expire in both workspaces', async () => {
    for (const t of [A, B]) {
      expect((await evidenceOf(t)).filter((e) => e.snapshotRef).length).toBeGreaterThan(5);
      expect((await obsOf(t)).length).toBeGreaterThan(20);
      expect(await reportsOf(t)).toHaveLength(1);
      expect(await exportsOf(t)).toHaveLength(2);
    }
  });

  it('nothing is removed while everything is inside its window', async () => {
    h.setNow(at(5)); // A's snapshots are 5 days old (< 7), history 5 days (< 30)
    const r = await runRetention(h.svc, SCOPE());
    expect(r).toMatchObject({ snapshotsPurged: 0, priceObservationsDeleted: 0, reportsDeleted: 0, exportFilesDeleted: 0, storageErrors: 0 });
  });

  it('day 40: workspace A (7/30 days) is cleaned, workspace B (90/365 days) is not touched at all', async () => {
    const beforeB = { evidence: await evidenceOf(B), obs: (await obsOf(B)).length, reports: (await reportsOf(B)).length, exports: await exportsOf(B), matches: (await matchesOf(B)).length };
    const aSnapshots = (await evidenceOf(A)).filter((e) => e.snapshotRef).map((e) => e.snapshotRef!);
    h.setNow(at(40));
    const r = await runRetention(h.svc, SCOPE());
    expect(r.snapshotsPurged).toBe(aSnapshots.length);
    for (const ref of aSnapshots) expect(await h.storage.exists(ref)).toBe(false);
    expect((await evidenceOf(A)).filter((e) => e.snapshotRef)).toHaveLength(0);
    expect(await obsOf(A)).toHaveLength(0);
    expect(await reportsOf(A)).toHaveLength(0);
    expect(await exportsOf(A)).toHaveLength(0);

    // B: byte-for-byte untouched
    expect((await evidenceOf(B)).map((e) => [e.id, e.snapshotRef])).toEqual(beforeB.evidence.map((e) => [e.id, e.snapshotRef]));
    for (const e of beforeB.evidence) if (e.snapshotRef) expect(await h.storage.exists(e.snapshotRef)).toBe(true);
    expect(await obsOf(B)).toHaveLength(beforeB.obs);
    expect(await reportsOf(B)).toHaveLength(beforeB.reports);
    expect((await exportsOf(B)).map((e) => e.storageKey).sort()).toEqual(beforeB.exports.map((e) => e.storageKey).sort());
    for (const e of beforeB.exports) expect(await h.storage.exists(e.storageKey)).toBe(true);
    expect(await matchesOf(B)).toHaveLength(beforeB.matches);
  });

  it('day 100: B’s raw snapshots go (past 90 days), but its structured history, reports and exports stay (inside 365)', async () => {
    const files = (await evidenceOf(B)).filter((e) => e.snapshotRef).map((e) => e.snapshotRef!);
    const obs = (await obsOf(B)).length;
    h.setNow(at(100));
    const r = await runRetention(h.svc, SCOPE());
    expect(r.snapshotsPurged).toBe(files.length);
    for (const f of files) expect(await h.storage.exists(f)).toBe(false);
    const rows = await evidenceOf(B);
    expect(rows.every((e) => e.snapshotRef === null && e.url && e.contentHash)).toBe(true); // the evidence ROW — where a value came from — remains
    expect(rows.filter((e) => e.snapshotPurgedAt).length).toBe(files.length);
    expect(await obsOf(B)).toHaveLength(obs);
    expect(await reportsOf(B)).toHaveLength(1);
    expect(await exportsOf(B)).toHaveLength(2);
  });

  it('day 400: B’s history window (365) has passed — observations, report and export files are removed together', async () => {
    const exportFiles = (await exportsOf(B)).map((e) => e.storageKey);
    h.setNow(at(400));
    const r = await runRetention(h.svc, SCOPE());
    expect(r.reportsDeleted).toBeGreaterThanOrEqual(1);
    expect(r.exportFilesDeleted).toBe(exportFiles.length);
    for (const f of exportFiles) expect(await h.storage.exists(f)).toBe(false);
    expect(await obsOf(B)).toHaveLength(0);
    expect(await reportsOf(B)).toHaveLength(0);
    expect(await exportsOf(B)).toHaveLength(0);
  });

  it('is safe to run again: a second run deletes nothing and reports no errors', async () => {
    const r = await runRetention(h.svc, SCOPE());
    expect(r).toMatchObject({ snapshotsPurged: 0, priceObservationsDeleted: 0, stockObservationsDeleted: 0, reportsDeleted: 0, exportFilesDeleted: 0, alertsDeleted: 0, marketingDeleted: 0, offersDeleted: 0, flyersDeleted: 0, storageErrors: 0 });
  });
});

describe('the retention boundary is exact', () => {
  it('a raw snapshot exactly at the cut-off is kept; one millisecond older is purged', async () => {
    const now = at(500);
    h.setNow(now);
    const cut = new Date(now.getTime() - 90 * DAY); // B's snapshot window
    const base = { orgId: B.orgId, siteId: ids.B!.woo!, contentHash: 'h', httpStatus: 200, contentType: 'text/html', bytes: 4, isFixture: true as const };
    await h.storage.put('retention-test/at-cut.html', 'keep');
    await h.storage.put('retention-test/just-older.html', 'drop');
    const [atCut] = await db().insert(evidence).values({ ...base, url: 'https://example.test/at-cut', fetchedAt: cut, snapshotRef: 'retention-test/at-cut.html' }).returning();
    const [older] = await db().insert(evidence).values({ ...base, url: 'https://example.test/older', fetchedAt: new Date(cut.getTime() - 1), snapshotRef: 'retention-test/just-older.html' }).returning();
    await runRetention(h.svc, SCOPE());
    expect((await db().select().from(evidence).where(eq(evidence.id, atCut!.id)))[0]!.snapshotRef).toBe('retention-test/at-cut.html');
    expect(await h.storage.exists('retention-test/at-cut.html')).toBe(true);
    expect((await db().select().from(evidence).where(eq(evidence.id, older!.id)))[0]).toMatchObject({ snapshotRef: null });
    expect(await h.storage.exists('retention-test/just-older.html')).toBe(false);
  });
});

describe('what would otherwise grow forever is expired too', () => {
  const now = () => h.svc.clock();
  const ago = (d: number) => new Date(now().getTime() - d * DAY);

  it('marketing content, offers, flyers, finished daily runs and old profiles expire with the history window; recent ones stay', async () => {
    h.setNow(at(600));
    const site = ids.B!.woo!;
    const mk = (key: string, lastSeen: Date) => ({ orgId: B.orgId, siteId: site, platform: 'site' as const, kind: 'announcement_bar' as const, title: key, extractionMethod: 'public_banner', dedupeKey: key, firstSeenAt: lastSeen, lastSeenAt: lastSeen, isFixture: true });
    await db().insert(marketingActivities).values([mk('old-banner', ago(400)), mk('fresh-banner', ago(3))]);
    const of = (key: string, lastSeen: Date, status: 'active' | 'ended' | 'expired') => ({ orgId: B.orgId, siteId: site, kind: 'banner' as const, title: key, extractionMethod: 'public_banner', dedupeKey: key, firstSeenAt: lastSeen, lastSeenAt: lastSeen, status });
    await db().insert(offers).values([of('old-offer', ago(400), 'ended'), of('fresh-offer', ago(3), 'active')]);
    const fl = (hash: string, fetchedAt: Date) => ({ orgId: B.orgId, siteId: site, url: `https://example.test/${hash}.pdf`, contentHash: hash, status: 'extracted' as const, fetchedAt });
    await db().insert(flyers).values([fl('old-flyer', ago(400)), fl('fresh-flyer', ago(3))]);
    await db().insert(dailyRuns).values([
      { orgId: B.orgId, periodDate: '2025-05-01', status: 'done', createdAt: ago(400) },
      { orgId: B.orgId, periodDate: '2025-05-02', status: 'collecting', createdAt: ago(400) }, // unfinished runs are never deleted from under the scheduler
      { orgId: B.orgId, periodDate: '2026-12-01', status: 'done', createdAt: ago(3) },
    ]);
    const profile = (summary: string, createdAt: Date) => ({ orgId: B.orgId, siteId: site, status: 'full' as const, summary, data: {} as never, createdAt });
    await db().insert(siteProfiles).values([profile('ancient', ago(500)), profile('old', ago(450)), profile('recent', ago(3))]);

    const r = await runRetention(h.svc, SCOPE());
    expect(r).toMatchObject({ marketingDeleted: 1, offersDeleted: 1, flyersDeleted: 1, dailyRunsDeleted: 1 });
    const titles = async (q: Promise<{ title: string | null }[]>) => (await q).map((x) => x.title).sort();
    expect(await titles(db().select({ title: marketingActivities.title }).from(marketingActivities).where(and(eq(marketingActivities.orgId, B.orgId), inArray(marketingActivities.title, ['old-banner', 'fresh-banner']))))).toEqual(['fresh-banner']);
    expect(await titles(db().select({ title: offers.title }).from(offers).where(and(eq(offers.orgId, B.orgId), inArray(offers.title, ['old-offer', 'fresh-offer']))))).toEqual(['fresh-offer']);
    expect((await db().select().from(flyers).where(eq(flyers.orgId, B.orgId))).map((f) => f.contentHash)).toEqual(['fresh-flyer']);
    expect((await db().select().from(dailyRuns).where(eq(dailyRuns.orgId, B.orgId))).map((d) => d.periodDate).sort()).toEqual(['2025-05-02', '2026-12-01']);
    const profiles = (await db().select().from(siteProfiles).where(and(eq(siteProfiles.orgId, B.orgId), eq(siteProfiles.siteId, site)))).map((p) => p.summary);
    expect(profiles).toContain('recent');
    expect(profiles).not.toContain('ancient');
    expect(profiles).not.toContain('old');
  });

  it('the newest profile of a website is kept however old it is', async () => {
    h.setNow(at(2000)); // years later: every profile is past the window
    await runRetention(h.svc, SCOPE());
    const left = await db().select().from(siteProfiles).where(eq(siteProfiles.siteId, ids.B!.woo!));
    expect(left).toHaveLength(1);
    expect(left[0]!.summary).toBe('recent');
  });

  it('structured alerts and stock history follow the same window', async () => {
    h.setNow(at(3000));
    const old = new Date(h.svc.clock().getTime() - 400 * DAY);
    await db().insert(alerts).values({ orgId: B.orgId, type: 'out_of_stock', severity: 'critical', title: 'Ancient alert', dedupeKey: 'ancient-alert', createdAt: old });
    await db().insert(alerts).values({ orgId: B.orgId, type: 'out_of_stock', severity: 'critical', title: 'Fresh alert', dedupeKey: 'fresh-alert' , createdAt: new Date(h.svc.clock().getTime() - DAY) });
    const r = await runRetention(h.svc, SCOPE());
    expect(r.alertsDeleted).toBeGreaterThanOrEqual(1);
    expect((await db().select().from(alerts).where(inArray(alerts.dedupeKey, ['ancient-alert', 'fresh-alert']))).map((a) => a.title)).toEqual(['Fresh alert']);
    expect(await count(db().select().from(stockObservations).where(eq(stockObservations.orgId, B.orgId)))).toBe(0);
  });
});

describe('a failing storage backend never stops the rest of the clean-up', () => {
  it('a file that cannot be deleted is counted and kept for the next run; everything else is cleaned', async () => {
    h.setNow(at(4000));
    const base = { orgId: A.orgId, siteId: ids.A!.woo!, contentHash: 'h', httpStatus: 200, contentType: 'text/html', bytes: 4, isFixture: true as const, fetchedAt: new Date(h.svc.clock().getTime() - 30 * DAY) };
    const keys = ['retention-test/ok-1.html', 'retention-test/stuck.html', 'retention-test/ok-2.html'];
    for (const k of keys) await h.storage.put(k, 'x');
    const rows = await db().insert(evidence).values(keys.map((k) => ({ ...base, url: `https://example.test/${k}`, snapshotRef: k }))).returning();
    const stuckId = rows.find((r) => r.snapshotRef === 'retention-test/stuck.html')!.id;

    const realDelete = h.storage.delete.bind(h.storage);
    h.storage.delete = async (k: string) => {
      if (k === 'retention-test/stuck.html') throw new Error('AccessDenied');
      return realDelete(k);
    };
    const r = await runRetention(h.svc, SCOPE());
    expect(r.storageErrors).toBe(1);
    expect(r.snapshotsPurged).toBe(2);
    const after = await db().select().from(evidence).where(inArray(evidence.id, rows.map((x) => x.id)));
    expect(after.find((x) => x.id === stuckId)!.snapshotRef).toBe('retention-test/stuck.html'); // still referenced, so it will be retried — never orphaned
    expect(after.filter((x) => x.id !== stuckId).every((x) => x.snapshotRef === null)).toBe(true);
    expect(await h.storage.exists('retention-test/ok-1.html')).toBe(false);
    expect(await h.storage.exists('retention-test/stuck.html')).toBe(true);

    h.storage.delete = realDelete; // the backend recovers
    const again = await runRetention(h.svc, SCOPE());
    expect(again.storageErrors).toBe(0);
    expect(again.snapshotsPurged).toBe(1);
    expect(await h.storage.exists('retention-test/stuck.html')).toBe(false);
    expect((await db().select().from(evidence).where(eq(evidence.id, stuckId)))[0]!.snapshotRef).toBeNull();
  });

  it('a report whose export file cannot be deleted is kept until it can be (no orphaned files, no half-deleted reports)', async () => {
    h.setNow(at(4100));
    const [rep] = await db().insert(reports).values({ orgId: A.orgId, kind: 'manual', status: 'ready', periodDate: '2020-01-01', title: 'Old test report', data: {} as never, dataHash: 'test-hash', generatedAt: new Date(h.svc.clock().getTime() - 200 * DAY), createdAt: new Date(h.svc.clock().getTime() - 200 * DAY) }).returning();
    await h.storage.put('retention-test/export-stuck.pdf', 'pdf');
    await db().insert(reportExports).values({ orgId: A.orgId, reportId: rep!.id, format: 'pdf', storageKey: 'retention-test/export-stuck.pdf', bytes: 3, checksum: 'test-checksum' });
    const realDelete = h.storage.delete.bind(h.storage);
    h.storage.delete = async (k: string) => {
      if (k === 'retention-test/export-stuck.pdf') throw new Error('timeout');
      return realDelete(k);
    };
    const r = await runRetention(h.svc, SCOPE());
    expect(r.storageErrors).toBe(1);
    expect(await db().select().from(reports).where(eq(reports.id, rep!.id))).toHaveLength(1);
    expect(await h.storage.exists('retention-test/export-stuck.pdf')).toBe(true);
    h.storage.delete = realDelete;
    await runRetention(h.svc, SCOPE());
    expect(await db().select().from(reports).where(eq(reports.id, rep!.id))).toHaveLength(0);
    expect(await h.storage.exists('retention-test/export-stuck.pdf')).toBe(false);
  });
});

describe('people’s decisions are not history', () => {
  it('match decisions made by a person survive any amount of retention', async () => {
    const m = await matchesOf(A);
    expect(m.length).toBeGreaterThan(0);
    await db().update(productMatches).set({ status: 'accepted', method: 'manual', confidence: 1, decidedAt: new Date('2020-01-01T00:00:00Z'), updatedAt: new Date('2020-01-01T00:00:00Z') }).where(eq(productMatches.id, m[0]!.id));
    h.setNow(at(9000));
    await runRetention(h.svc, SCOPE());
    expect((await db().select().from(productMatches).where(eq(productMatches.id, m[0]!.id)))[0]).toMatchObject({ status: 'accepted', method: 'manual' });
  });
});
