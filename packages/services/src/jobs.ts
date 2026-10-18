import { and, eq } from 'drizzle-orm';
import { reports } from '@ci/database';
import type { JobName, Services } from './context.ts';
import { runProfile } from './profiling.ts';
import { executeScan } from './scan.ts';
import { runMatching } from './matching.ts';
import { runInventorySync, handleShopifyUninstalled } from './integrations.ts';
import { syncSocial } from './social-sync.ts';
import { generateReport } from './report.ts';
import { runRetention } from './retention.ts';
import { schedulerTick, dailyAssemble } from './scheduler.ts';
import { refreshMarketRates } from './fx.ts';

type Handler<T> = (svc: Services, data: T) => Promise<unknown>;

/** Every background job. The worker (pg-boss) and the in-memory test queue run exactly these functions. */
export const JOB_HANDLERS: { [K in JobName]: Handler<any> } = {
  'profile-site': (svc, d: { orgId: string; siteId: string }) => runProfile(svc, d.orgId, d.siteId),
  'scan-site': (svc, d: { orgId: string; scanRunId: string }) => executeScan(svc, d.scanRunId),
  'match-products': (svc, d: { orgId: string }) => runMatching(svc, svc.db, d.orgId),
  'sync-inventory': (svc, d: { orgId: string; connectionId: string }) => runInventorySync(svc, svc.db, d.orgId, d.connectionId),
  'sync-social': (svc, d: { orgId: string; siteId?: string; manual?: boolean }) => syncSocial(svc, svc.db, d.orgId, { siteId: d.siteId, manual: d.manual, http: svc.socialHttp }),
  'generate-report': async (svc, d: { orgId: string; reportId: string; userId?: string; refreshFirst?: boolean }) => {
    await runMatching(svc, svc.db, d.orgId);
    await generateReport(svc, svc.db, d.orgId, { kind: 'manual', deadlineAt: null, createdBy: d.userId ?? null, reportId: d.reportId });
  },
  'send-email': (svc, d: { id: string }) => svc.mailer.deliver(d.id),
  retention: (svc) => runRetention(svc),
  'scheduler-tick': (svc) => schedulerTick(svc),
  'daily-assemble': (svc, d: { orgId: string; dailyRunId: string; cutoff?: boolean }) => dailyAssemble(svc, d.orgId, d.dailyRunId, { cutoff: d.cutoff }),
  'refresh-fx': (svc) => refreshMarketRates(svc),
  'integration-event': async (svc, d: { topic: string; shop: string }) => {
    if (d.topic === 'app/uninstalled') await handleShopifyUninstalled(svc, d.shop);
  },
};

/** Marks a manually requested report as failed if its job dies for good (so the UI stops polling). */
export async function failDraftReport(svc: Services, orgId: string, reportId: string, message: string): Promise<void> {
  await svc.db.update(reports).set({ status: 'failed', error: message.slice(0, 300) }).where(and(eq(reports.id, reportId), eq(reports.orgId, orgId), eq(reports.status, 'generating')));
}
