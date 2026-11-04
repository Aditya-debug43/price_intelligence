import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AI_MATCH_TYPES, AI_SUGGESTION_STATUSES, aiReviewSchema, aiRunSchema, paginationSchema } from '@ci/shared';
import { aiStatus, embeddingStatus, cancelAiRun, createAiRun, enqueueAiRun, getAiRun, listAiRuns, listAiSuggestions, pauseAiRun, resumeAiRun, resumeGemini, reviewAiSuggestion } from '@ci/services';
import { parse, requireRole } from '../app.ts';

const uuid = z.uuid();

/**
 * AI-assisted matching. The model key never reaches this layer's responses (only whether one is configured), nothing here runs the model inside a request (a run is a worker job),
 * and a suggestion only ever changes a match when a person reviews it, through the existing human-decision functions.
 */
export async function aiMatchRoutes(app: FastifyInstance) {
  app.get('/ai/status', async (req) => req.tx((tx) => aiStatus(tx, app.svc.config, req.orgId!, app.svc.clock())));

  /** Semantic search: how much of the catalogue has been embedded (the free tier allows about 100 texts a minute, so it is built in the background, once). */
  app.get('/ai/embeddings', async (req) => req.tx((tx) => embeddingStatus(tx, req.orgId!, app.svc.config.GEMINI_EMBEDDING_MODEL)));

  app.post('/ai/embeddings/run', async (req, reply) => {
    requireRole(req, 'admin');
    if (!app.svc.config.GEMINI_EMBEDDING_MODEL || !app.svc.config.GEMINI_API_KEY) return reply.status(409).send({ error: { code: 'not_configured', message: 'Semantic search is not set up on this server (no embedding model is configured). Everything else works without it.' } });
    const jobId = await app.svc.queue.enqueue('ai-match', { orgId: req.orgId, task: 'embed' }, { singletonKey: `embed:${req.orgId}` });
    return reply.status(202).send({ queued: true, jobId });
  });

  app.get('/ai/runs', async (req) => ({ runs: await req.tx((tx) => listAiRuns(tx, req.orgId!)) }));

  app.get('/ai/runs/:runId', async (req) => {
    const { runId } = parse(z.object({ runId: uuid }), req.params);
    return { run: await req.tx((tx) => getAiRun(tx, req.orgId!, runId)) };
  });

  /** Starts an analysis of a limited, spread-out set of the shop's own products. Heavy work happens in the worker, never in this request. */
  app.post('/ai/runs', async (req, reply) => {
    requireRole(req, 'admin');
    const body = parse(aiRunSchema, req.body ?? {});
    const created = await req.tx((tx) => createAiRun(tx, app.svc.config, req.orgId!, req.user!.id, body));
    await enqueueAiRun(app.svc.queue, req.orgId!, created.run.id);
    return reply.status(202).send(created);
  });

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/ai/runs/:runId/${action}`, async (req) => {
      requireRole(req, 'admin');
      const { runId } = parse(z.object({ runId: uuid }), req.params);
      const now = app.svc.clock();
      const run = await req.tx((tx) =>
        action === 'pause' ? pauseAiRun(tx, req.orgId!, req.user!.id, runId, now) : action === 'cancel' ? cancelAiRun(tx, req.orgId!, req.user!.id, runId, now) : resumeAiRun(tx, app.svc.queue, req.orgId!, req.user!.id, runId, now),
      );
      return { run };
    });
  }

  /** A person clears a stop (a rejected key, a missing model) after fixing the cause. */
  app.post('/ai/resume-gemini', async (req) => {
    requireRole(req, 'admin');
    await req.tx((tx) => resumeGemini(tx, app.svc.config, req.user!.id, req.orgId!, app.svc.clock()));
    return { ok: true };
  });

  app.get('/ai/suggestions', async (req) => {
    const q = parse(
      paginationSchema.extend({
        status: z.enum([...AI_SUGGESTION_STATUSES, 'all']).optional(),
        matchType: z.enum(AI_MATCH_TYPES).optional(),
        siteId: uuid.optional(),
        sourceVariantId: uuid.optional(),
        runId: uuid.optional(),
        decided: z.enum(['hide', 'only', 'all']).optional(),
      }),
      req.query,
    );
    return req.tx((tx) => listAiSuggestions(tx, req.orgId!, { status: q.status, matchType: q.matchType, siteId: q.siteId, sourceVariantId: q.sourceVariantId, runId: q.runId, decided: q.decided, page: q.page, pageSize: q.pageSize }));
  });

  /** Accept / Change / Uncertain / None of these / Find another product. Accept and Change are ordinary human decisions (the quantity and bundle policies apply as always). */
  app.post('/ai/suggestions/:suggestionId/review', async (req) => {
    requireRole(req, 'admin');
    const { suggestionId } = parse(z.object({ suggestionId: uuid }), req.params);
    const body = parse(aiReviewSchema, req.body);
    return req.tx((tx) => reviewAiSuggestion(tx, req.orgId!, req.user!.id, suggestionId, body, app.svc.clock()));
  });
}
