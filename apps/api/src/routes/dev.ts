import type { FastifyInstance } from 'fastify';
import { desc, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { emailOutbox } from '@ci/database';
import { HttpError, parse, requireRole } from '../app.ts';

/** Development tooling. Registered only outside production. */
export async function devRoutes(app: FastifyInstance) {
  /** Emails recorded locally (no SMTP): this is how verification and reset links are read during development. */
  app.get('/dev/outbox', async (req) => {
    const rows = await app.rootDb
      .select()
      .from(emailOutbox)
      .where(or(eq(emailOutbox.orgId, req.orgId!), eq(emailOutbox.relatedId, req.user!.id)))
      .orderBy(desc(emailOutbox.createdAt))
      .limit(50);
    return { emails: rows.map((r) => ({ id: r.id, to: r.toAddresses, subject: r.subject, text: r.text, kind: r.kind, status: r.status, createdAt: r.createdAt })) };
  });

  /**
   * Runs one scheduler pass, optionally pretending it is a different time of day, so the 9:00 AM Aruba report flow can
   * be demonstrated at any time. Executed by the worker; only honoured when SCHEDULER_MODE=dev.
   */
  app.post('/dev/scheduler/tick', async (req, reply) => {
    requireRole(req, 'admin');
    // A fake clock would produce reports dated in the future or past, so it is confined to demo workspaces.
    if (req.orgMode !== 'demo') throw new HttpError(403, 'wrong_workspace_mode', 'The developer scheduler clock exists only in demo workspaces. A live workspace always runs on real time.');
    if (app.cfg.SCHEDULER_MODE !== 'dev') throw new HttpError(403, 'forbidden', 'Set SCHEDULER_MODE=dev to use the development scheduler.');
    const body = parse(z.object({ now: z.iso.datetime().optional() }), req.body ?? {});
    const jobId = await app.svc.queue.enqueue('scheduler-tick', { now: body.now }, {});
    return reply.status(202).send({ queued: true, jobId, now: body.now ?? null });
  });
}
