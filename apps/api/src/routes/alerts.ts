import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ALERT_SEVERITIES, ALERT_STATUSES, ALERT_TYPES, alertRuleSchema, paginationSchema } from '@ci/shared';
import { acknowledgeAlert, acknowledgeAll, ActionNotPossibleError, getAlertRules, listAlerts, resolveAlert, upsertAlertRule } from '@ci/services';
import { HttpError, parse, requireRole } from '../app.ts';

export async function alertRoutes(app: FastifyInstance) {
  app.get('/alerts', async (req) => {
    const q = parse(paginationSchema.extend({ status: z.enum([...ALERT_STATUSES, 'all']).default('all'), type: z.enum(ALERT_TYPES).optional(), severity: z.enum(ALERT_SEVERITIES).optional() }), req.query);
    return req.tx((tx) => listAlerts(tx, req.orgId!, q));
  });

  app.post('/alerts/ack-all', async (req) => ({ acknowledged: await req.tx((tx) => acknowledgeAll(tx, req.orgId!, req.user!.id, app.svc.clock())) }));

  app.post('/alerts/:alertId/ack', async (req) => {
    const { alertId } = parse(z.object({ alertId: z.uuid() }), req.params);
    const ok = await req.tx((tx) => acknowledgeAlert(tx, req.orgId!, alertId, req.user!.id, app.svc.clock()));
    if (!ok) throw new HttpError(404, 'not_found', 'Alert not found.');
    return { ok: true };
  });

  /** A person closes an alert about a condition (low stock, a failing website…), optionally saying what was done. */
  app.post('/alerts/:alertId/resolve', async (req) => {
    const { alertId } = parse(z.object({ alertId: z.uuid() }), req.params);
    const { note } = parse(z.object({ note: z.string().trim().max(500).optional() }), req.body ?? {});
    const outcome = await req.tx((tx) => resolveAlert(tx, req.orgId!, alertId, req.user!.id, app.svc.clock(), note));
    if (outcome === 'not_found') throw new HttpError(404, 'not_found', 'Alert not found.');
    if (outcome === 'already_resolved') throw new ActionNotPossibleError('This alert is already resolved.', 'already_resolved', {});
    if (outcome === 'not_resolvable') throw new ActionNotPossibleError('This is a one-off notice, so there is nothing to resolve. Acknowledge it instead.', 'not_resolvable', {});
    return { ok: true };
  });

  app.get('/alert-rules', async (req) => ({ rules: await req.tx((tx) => getAlertRules(tx, req.orgId!)) }));

  app.put('/alert-rules', async (req) => {
    requireRole(req, 'admin');
    const body = parse(alertRuleSchema, req.body);
    return { rule: await req.tx((tx) => upsertAlertRule(tx, req.orgId!, body)) };
  });
}
