import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { shopifyStartSchema, socialAccountSchema } from '@ci/shared';
import { verifyShopifyWebhookHmac } from '@ci/core';
import {
  addSocialAccount,
  completeShopifyOAuth,
  confirmSocialAccount,
  disconnectIntegration,
  integrationOverview,
  startShopifyOAuth,
  IntegrationError,
  assertCanSyncSocial,
  loadReadiness,
} from '@ci/services';
import { currentUser, HttpError, parse, requireRole } from '../app.ts';

/** Organisation-scoped integration management. */
export async function integrationRoutes(app: FastifyInstance) {
  app.get('/integrations', async (req) => req.tx((tx) => integrationOverview(app.svc, tx, req.orgId!)));

  app.post('/integrations/shopify/start', async (req) => {
    requireRole(req, 'admin');
    const body = parse(shopifyStartSchema, req.body);
    return startShopifyOAuth(app.svc, app.rootDb, req.orgId!, req.user!.id, body.shop, body.siteId);
  });

  app.post('/integrations/:connectionId/sync', async (req, reply) => {
    requireRole(req, 'admin');
    const { connectionId } = parse(z.object({ connectionId: z.uuid() }), req.params);
    const jobId = await app.svc.queue.enqueue('sync-inventory', { orgId: req.orgId, connectionId }, { singletonKey: `inv:${connectionId}:manual` });
    return reply.status(202).send({ queued: true, jobId });
  });

  app.delete('/integrations/:connectionId', async (req) => {
    requireRole(req, 'admin');
    const { connectionId } = parse(z.object({ connectionId: z.uuid() }), req.params);
    return req.tx((tx) => disconnectIntegration(app.svc, tx, req.orgId!, req.user!.id, connectionId));
  });

  // social accounts (mapped from official site links; confirmed by the customer before any API call)
  app.post('/social-accounts', async (req, reply) => {
    requireRole(req, 'admin');
    const b = parse(socialAccountSchema, req.body);
    return reply.status(201).send({ account: await req.tx((tx) => addSocialAccount(tx, req.orgId!, req.user!.id, b)) });
  });

  app.patch('/social-accounts/:accountId', async (req) => {
    requireRole(req, 'admin');
    const { accountId } = parse(z.object({ accountId: z.uuid() }), req.params);
    const b = parse(z.object({ confirmed: z.boolean() }), req.body);
    return { account: await req.tx((tx) => confirmSocialAccount(tx, req.orgId!, req.user!.id, accountId, b.confirmed)) };
  });

  app.post('/social/sync', async (req, reply) => {
    requireRole(req, 'admin');
    assertCanSyncSocial(await req.tx((tx) => loadReadiness(tx, req.orgId!)));
    const jobId = await app.svc.queue.enqueue('sync-social', { orgId: req.orgId, manual: true }, { singletonKey: `social:${req.orgId}:manual` });
    return reply.status(202).send({ queued: true, jobId });
  });
}

/** Routes that arrive without an organisation in the path: the Shopify redirect and webhooks. */
export async function publicIntegrationRoutes(app: FastifyInstance) {
  // The merchant is redirected back here by Shopify. The signed query, single-use state and logged-in user are all verified.
  app.get('/integrations/shopify/callback', async (req, reply) => {
    const web = app.cfg.APP_BASE_URL.replace(/\/$/, '');
    try {
      const user = await currentUser(app, req);
      const query = Object.fromEntries(Object.entries(req.query as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
      const r = await completeShopifyOAuth(app.svc, app.rootDb, user.id, query);
      return reply.redirect(`${web}/settings?tab=integrations&connected=shopify&org=${r.orgId}`);
    } catch (e) {
      const msg = e instanceof IntegrationError || e instanceof HttpError ? e.message : 'The connection could not be completed.';
      req.log.warn({ err: { message: (e as Error).message } }, 'shopify callback failed');
      return reply.redirect(`${web}/settings?tab=integrations&error=${encodeURIComponent(msg)}`);
    }
  });

  // Webhooks need the raw body to verify the HMAC, so they live in their own encapsulated context.
  await app.register(async (hook) => {
    hook.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    hook.post('/webhooks/shopify', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
      const secret = app.cfg.SHOPIFY_CLIENT_SECRET;
      if (!secret) return reply.status(501).send({ error: { code: 'not_configured', message: 'Shopify is not configured.' } });
      const raw = req.body as Buffer;
      if (!verifyShopifyWebhookHmac(raw, req.headers['x-shopify-hmac-sha256'] as string | undefined, secret)) return reply.status(401).send({ error: { code: 'bad_signature', message: 'Invalid signature.' } });
      const topic = String(req.headers['x-shopify-topic'] ?? '');
      const shop = String(req.headers['x-shopify-shop-domain'] ?? '').toLowerCase();
      if (topic === 'app/uninstalled' && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
        await app.svc.queue.enqueue('integration-event', { topic, shop }, { singletonKey: `uninstalled:${shop}` });
      }
      return reply.status(200).send({ ok: true });
    });
  });
}
