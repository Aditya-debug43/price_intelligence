import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DEFAULTS, REPORT_FORMATS, reportGenerateSchema, type ReportData } from '@ci/shared';
import { reports } from '@ci/database';
import { CSV_DATASETS, assertCanReport, compareReports, exportReport, getReport, listReports, getSettings, loadReadiness } from '@ci/services';
import { localDate } from '@ci/core';
import { HttpError, parse } from '../app.ts';

export async function reportRoutes(app: FastifyInstance) {
  app.get('/reports', async (req) => ({ reports: await req.tx((tx) => listReports(tx, req.orgId!)) }));

  /** Creates a draft immediately (so the page can poll its id); the worker fills it from fresh analysis. */
  app.post('/reports', async (req, reply) => {
    parse(reportGenerateSchema, req.body ?? {});
    // A report with nothing collected would only look like an answer; refuse and say what is missing.
    assertCanReport(await req.tx((tx) => loadReadiness(tx, req.orgId!)));
    const draft = await req.tx(async (tx) => {
      const s = await getSettings(tx, req.orgId!);
      const today = localDate(app.svc.clock(), s?.timezone ?? DEFAULTS.timezone);
      const [row] = await tx.insert(reports).values({ orgId: req.orgId!, kind: 'manual', status: 'generating', periodDate: today, title: `Competitor report — ${today}`, createdBy: req.user!.id }).returning();
      return row!;
    });
    await app.svc.queue.enqueue('generate-report', { orgId: req.orgId, reportId: draft.id, userId: req.user!.id }, { singletonKey: `report:${draft.id}` });
    return reply.status(202).send({ report: { id: draft.id, status: draft.status } });
  });

  app.get('/reports/latest', async (req) => {
    const [r] = await req.tx((tx) => tx.select().from(reports).where(and(eq(reports.orgId, req.orgId!), inArray(reports.status, ['ready', 'partial']))).orderBy(desc(reports.createdAt)).limit(1));
    if (!r) throw new HttpError(404, 'not_found', 'No report has been generated yet.');
    return { report: r };
  });

  app.get('/reports/compare', async (req) => {
    const q = parse(z.object({ a: z.uuid(), b: z.uuid() }), req.query);
    const [ra, rb] = await Promise.all([req.tx((tx) => getReport(tx, req.orgId!, q.a)), req.tx((tx) => getReport(tx, req.orgId!, q.b))]);
    if (!ra?.data || !rb?.data) throw new HttpError(404, 'not_found', 'Both reports must exist and be finished.');
    return { comparison: compareReports(ra.data as ReportData, rb.data as ReportData) };
  });

  app.get('/reports/:reportId', async (req) => {
    const { reportId } = parse(z.object({ reportId: z.uuid() }), req.params);
    const r = await req.tx((tx) => getReport(tx, req.orgId!, reportId));
    if (!r) throw new HttpError(404, 'not_found', 'Report not found.');
    return { report: r };
  });

  app.get('/reports/:reportId/export', async (req, reply) => {
    const { reportId } = parse(z.object({ reportId: z.uuid() }), req.params);
    const q = parse(z.object({ format: z.enum(REPORT_FORMATS), dataset: z.enum(CSV_DATASETS).default('comparison') }), req.query);
    const out = await req.tx((tx) => exportReport(app.svc, tx, req.orgId!, reportId, q.format, q.dataset));
    return reply.header('content-type', out.contentType).header('content-disposition', `attachment; filename="${out.filename}"`).send(out.body);
  });
}
