import { and, eq, inArray, isNotNull, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { alerts, auditEvents, crawlQueue, dailyRuns, emailOutbox, evidence, flyers, marketingActivities, offers, orgSettings, priceObservations, products, reportExports, reports, scanRuns, stockObservations, type DbLike } from '@ci/database';
import type { Services } from './context.ts';
import { purgeExpiredAuth } from './auth.ts';
import { purgeOldInvitations } from './invitations.ts';

export interface RetentionResult {
  orgs: number;
  snapshotsPurged: number;
  priceObservationsDeleted: number;
  stockObservationsDeleted: number;
  evidenceRowsDeleted: number;
  reportsDeleted: number;
  exportFilesDeleted: number;
  alertsDeleted: number;
  scanRunsDeleted: number;
  productsDeleted: number;
  emailsDeleted: number;
  marketingDeleted: number;
  offersDeleted: number;
  flyersDeleted: number;
  dailyRunsDeleted: number;
  profilesDeleted: number;
  /** Stored files that could not be deleted this time. Their evidence rows keep the reference so the next run tries again. */
  storageErrors: number;
  invitationsDeleted: number;
}

const DAY = 86_400_000;

/**
 * Removes expired data without breaking references:
 *  - raw snapshots (storage objects) expire after `snapshotRetentionDays` (default 90); the evidence ROW — URL, time,
 *    hash, snippet — stays, so observations and reports still point to something that explains where a value came from;
 *  - structured observations, reports, alerts and runs expire after `historyRetentionDays` (default ~1 year);
 *    dependent rows use ON DELETE SET NULL / CASCADE, and report snapshots are self-contained JSON.
 *  - a file that cannot be deleted is counted and retried next run; it never stops other files or other workspaces from being cleaned up.
 *  - the newest capability profile of every website is kept however old it is, and people's decisions about matches are not "history".
 */
export async function runRetention(svc: Services, opts: { orgIds?: string[] } = {}): Promise<RetentionResult> {
  const now = svc.clock();
  const db = svc.db as unknown as DbLike;
  const result: RetentionResult = { orgs: 0, snapshotsPurged: 0, priceObservationsDeleted: 0, stockObservationsDeleted: 0, evidenceRowsDeleted: 0, reportsDeleted: 0, exportFilesDeleted: 0, alertsDeleted: 0, scanRunsDeleted: 0, productsDeleted: 0, emailsDeleted: 0, marketingDeleted: 0, offersDeleted: 0, flyersDeleted: 0, dailyRunsDeleted: 0, profilesDeleted: 0, storageErrors: 0, invitationsDeleted: 0 };
  const orgs = opts.orgIds ? (opts.orgIds.length ? await db.select().from(orgSettings).where(inArray(orgSettings.orgId, opts.orgIds)) : []) : await db.select().from(orgSettings);
  result.orgs = orgs.length;
  for (const o of orgs) {
    const snapCut = new Date(now.getTime() - o.snapshotRetentionDays * DAY);
    const histCut = new Date(now.getTime() - o.historyRetentionDays * DAY);

    // 1. raw snapshots
    const failedIds = new Set<string>();
    for (;;) {
      const batch = await db
        .select({ id: evidence.id, ref: evidence.snapshotRef })
        .from(evidence)
        .where(and(eq(evidence.orgId, o.orgId), isNotNull(evidence.snapshotRef), lt(evidence.fetchedAt, snapCut), failedIds.size ? notInArray(evidence.id, [...failedIds]) : undefined))
        .limit(500);
      if (!batch.length) break;
      const purged: string[] = [];
      for (const e of batch) {
        try {
          if (e.ref) await svc.storage.delete(e.ref);
          purged.push(e.id);
        } catch (err) {
          failedIds.add(e.id);
          result.storageErrors++;
          svc.log.warn('retention could not delete a stored file; it will be retried', { evidenceId: e.id, error: (err as Error).message });
        }
      }
      if (purged.length) await db.update(evidence).set({ snapshotRef: null, snapshotPurgedAt: now }).where(inArray(evidence.id, purged));
      result.snapshotsPurged += purged.length;
    }

    // 2. expired exports belong to expired reports; remove files first so nothing is orphaned
    const oldReports = await db.select({ id: reports.id }).from(reports).where(and(eq(reports.orgId, o.orgId), lt(reports.createdAt, histCut)));
    if (oldReports.length) {
      const exps = await db.select().from(reportExports).where(inArray(reportExports.reportId, oldReports.map((r) => r.id)));
      const stuck = new Set<string>();
      for (const e of exps) {
        try {
          await svc.storage.delete(e.storageKey);
          result.exportFilesDeleted++;
        } catch (err) {
          stuck.add(e.reportId);
          result.storageErrors++;
          svc.log.warn('retention could not delete an export file; the report is kept until the next run', { reportId: e.reportId, error: (err as Error).message });
        }
      }
      const deletable = oldReports.map((r) => r.id).filter((id) => !stuck.has(id));
      if (deletable.length) {
        await db.delete(reports).where(inArray(reports.id, deletable));
        result.reportsDeleted += deletable.length;
      }
    }

    // 3. structured history
    result.priceObservationsDeleted += (await db.delete(priceObservations).where(and(eq(priceObservations.orgId, o.orgId), lt(priceObservations.observedAt, histCut))).returning({ id: priceObservations.id })).length;
    result.stockObservationsDeleted += (await db.delete(stockObservations).where(and(eq(stockObservations.orgId, o.orgId), lt(stockObservations.observedAt, histCut))).returning({ id: stockObservations.id })).length;
    result.evidenceRowsDeleted += (await db.delete(evidence).where(and(eq(evidence.orgId, o.orgId), lt(evidence.fetchedAt, histCut), isNull(evidence.snapshotRef))).returning({ id: evidence.id })).length;
    result.alertsDeleted += (await db.delete(alerts).where(and(eq(alerts.orgId, o.orgId), lt(alerts.createdAt, histCut))).returning({ id: alerts.id })).length;
    await db.delete(crawlQueue).where(and(eq(crawlQueue.orgId, o.orgId), lt(crawlQueue.updatedAt, new Date(now.getTime() - 30 * DAY))));
    result.scanRunsDeleted += (await db.delete(scanRuns).where(and(eq(scanRuns.orgId, o.orgId), lt(scanRuns.createdAt, histCut), sql`${scanRuns.status} not in ('queued','running')`)).returning({ id: scanRuns.id })).length;
    // observed marketing content, offers and flyers that have not been seen for longer than the history window
    result.marketingDeleted += (await db.delete(marketingActivities).where(and(eq(marketingActivities.orgId, o.orgId), lt(marketingActivities.lastSeenAt, histCut))).returning({ id: marketingActivities.id })).length;
    result.offersDeleted += (await db.delete(offers).where(and(eq(offers.orgId, o.orgId), lt(offers.lastSeenAt, histCut))).returning({ id: offers.id })).length;
    result.flyersDeleted += (await db.delete(flyers).where(and(eq(flyers.orgId, o.orgId), lt(flyers.fetchedAt, histCut))).returning({ id: flyers.id })).length;
    result.dailyRunsDeleted += (await db.delete(dailyRuns).where(and(eq(dailyRuns.orgId, o.orgId), lt(dailyRuns.createdAt, histCut), inArray(dailyRuns.status, ['done', 'failed']))).returning({ id: dailyRuns.id })).length;
    // capability profiles: old ones go, but the newest of every website always stays
    const gone = await db.execute<{ id: string }>(sql`
      delete from site_profiles p
      where p.org_id = ${o.orgId} and p.created_at < ${histCut.toISOString()}::timestamptz
        and exists (select 1 from site_profiles n where n.site_id = p.site_id and n.created_at > p.created_at)
      returning p.id`);
    result.profilesDeleted += gone.rows.length;
    // products delisted longer ago than the history window (their observations are already gone)
    result.productsDeleted += (await db.delete(products).where(and(eq(products.orgId, o.orgId), lt(products.delistedAt, histCut))).returning({ id: products.id })).length;
    await db.delete(auditEvents).where(and(eq(auditEvents.orgId, o.orgId), lt(auditEvents.createdAt, new Date(now.getTime() - o.historyRetentionDays * 2 * DAY))));
  }
  result.emailsDeleted = (await db.delete(emailOutbox).where(lt(emailOutbox.createdAt, new Date(now.getTime() - 90 * DAY))).returning({ id: emailOutbox.id })).length;
  await purgeExpiredAuth(db, now);
  result.invitationsDeleted = await purgeOldInvitations(svc.db, now);
  svc.log.info('retention complete', { ...result });
  return result;
}
