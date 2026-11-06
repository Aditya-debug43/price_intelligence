import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { paginationSchema } from '@ci/shared';
import { evalProgress, labelEvalCase, listEvalCases, prepareEvalSet, setAutoApproval, skipEvalCase } from '@ci/services';
import { parse, requireRole } from '../app.ts';

const uuid = z.uuid();

/**
 * The independent evaluation of matching and the switch for automatic approval. Labels come only from people through these routes; the measurement runs in the worker; a class of automatic
 * approval can be switched on only when the latest measurement passed the release gate (the service checks this itself, not the page).
 */
export async function matchEvalRoutes(app: FastifyInstance) {
  app.get('/eval/status', async (req) => req.tx((tx) => evalProgress(tx, req.orgId!)));

  /** Selects a stratified sample of your variants (against each competitor website) to be labelled. */
  app.post('/eval/prepare', async (req) => {
    requireRole(req, 'admin');
    const body = parse(z.object({ size: z.number().int().min(20).max(1000).optional() }), req.body ?? {});
    return req.tx((tx) => prepareEvalSet(tx, req.orgId!, { size: body.size }));
  });

  app.get('/eval/cases', async (req) => {
    const q = parse(paginationSchema.extend({ status: z.enum(['pending', 'labelled', 'skipped']).optional(), split: z.enum(['development', 'holdout']).optional() }), req.query);
    return req.tx((tx) => listEvalCases(tx, req.orgId!, { status: q.status, split: q.split, page: q.page, pageSize: q.pageSize }));
  });

  app.post('/eval/cases/:caseId/label', async (req) => {
    requireRole(req, 'admin');
    const { caseId } = parse(z.object({ caseId: uuid }), req.params);
    const body = parse(
      z.object({
        // the full form: a judgment for each candidate the person looked at, and whether the list is complete
        judgments: z.array(z.object({ variantId: uuid, relationship: z.enum(['exact', 'variant', 'equivalent', 'substitute', 'related', 'incorrect']), critical: z.boolean().optional() })).max(40).optional(),
        complete: z.boolean().optional(),
        // the older form: one counterpart (or none)
        relationship: z.enum(['exact', 'variant', 'equivalent', 'substitute', 'related', 'none']).optional(),
        truthVariantId: uuid.nullish(),
        expertise: z.enum(['knowledgeable', 'general']),
        note: z.string().max(500).optional(),
      }),
      req.body,
    );
    const row = await req.tx((tx) => labelEvalCase(tx, req.orgId!, req.user!.id, caseId, body, app.svc.clock()));
    return { id: row.id, status: row.status };
  });

  app.post('/eval/cases/:caseId/skip', async (req) => {
    requireRole(req, 'admin');
    const { caseId } = parse(z.object({ caseId: uuid }), req.params);
    const body = parse(z.object({ note: z.string().max(500).optional() }), req.body ?? {});
    const row = await req.tx((tx) => skipEvalCase(tx, req.orgId!, req.user!.id, caseId, body.note, app.svc.clock()));
    return { id: row.id, status: row.status };
  });

  /** Measures the system against the labelled cases (in the worker: it builds the whole catalogue's analysis). */
  app.post('/eval/run', async (req, reply) => {
    requireRole(req, 'admin');
    const jobId = await app.svc.queue.enqueue('ai-match', { orgId: req.orgId, task: 'evaluate', userId: req.user!.id }, { singletonKey: `eval:${req.orgId}` });
    return reply.status(202).send({ queued: true, jobId });
  });

  /** Switches a class of automatic approval on (only after it passed the gate) or off. */
  app.post('/eval/auto-approval', async (req) => {
    requireRole(req, 'admin');
    const body = parse(z.object({ domain: z.enum(['automotive', 'grocery']), autoClass: z.enum(['exact_item', 'compatible_equivalent']), enabled: z.boolean() }), req.body);
    await req.tx((tx) => setAutoApproval(tx, app.svc.queue, req.orgId!, req.user!.id, body, app.svc.clock()));
    return { ok: true };
  });
}
