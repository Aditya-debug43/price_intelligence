import path from 'node:path';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { ZodError, type ZodType } from 'zod';
import { PINO_REDACT_PATHS, type AppConfig } from '@ci/core';
import type { MemberRole, OrgMode } from '@ci/shared';
import { withTenant, type Db, type DbLike } from '@ci/database';
import {
  AuthError,
  ConsentRequiredError,
  ExportError,
  IntegrationError,
  ActionNotPossibleError,
  WorkspaceModeError,
  checkSystemReadiness,
  MatchError,
  ProfileError,
  SiteError,
  getOrgContext,
  getSession,
  roleAtLeast,
  type Services,
  type SessionUser,
} from '@ci/services';
import { authRoutes } from './routes/auth.ts';
import { orgRoutes } from './routes/orgs.ts';
import { siteRoutes } from './routes/sites.ts';
import { catalogRoutes } from './routes/catalog.ts';
import { reportRoutes } from './routes/reports.ts';
import { alertRoutes } from './routes/alerts.ts';
import { integrationRoutes, publicIntegrationRoutes } from './routes/integrations.ts';
import { devRoutes } from './routes/dev.ts';

export const SESSION_COOKIE = 'ci_session';

declare module 'fastify' {
  interface FastifyInstance {
    svc: Services;
    rootDb: Db;
    cfg: AppConfig;
  }
  interface FastifyRequest {
    user?: SessionUser;
    orgId?: string;
    role?: MemberRole;
    /** 'live' or 'demo' — decided when the workspace was created. */
    orgMode?: OrgMode;
    tx<T>(fn: (tx: DbLike) => Promise<T>): Promise<T>;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const parse = <T>(schema: ZodType<T>, data: unknown): T => schema.parse(data);

export function requireRole(req: FastifyRequest, min: MemberRole) {
  if (!req.role || !roleAtLeast(req.role, min)) throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
}

export interface BuildAppOptions {
  svc: Services;
  /** RLS-enforced connection (ci_app). */
  rootDb: Db;
  logger?: boolean | Record<string, unknown>;
  webDist?: string;
  /** Per-IP limit for sign-in / registration style endpoints per minute (default 12). */
  authRateLimitMax?: number;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { svc, rootDb } = opts;
  const cfg = svc.config;
  const app = Fastify({
    logger: opts.logger === false ? false : { level: cfg.LOG_LEVEL, redact: { paths: PINO_REDACT_PATHS, censor: '[REDACTED]' }, ...(typeof opts.logger === 'object' ? opts.logger : {}) },
    bodyLimit: 1024 * 1024,
    trustProxy: cfg.isProduction,
  });
  app.decorate('svc', svc);
  app.decorate('rootDb', rootDb);
  app.decorate('cfg', cfg);
  app.decorateRequest('tx', async function (this: FastifyRequest, fn: (tx: DbLike) => Promise<unknown>) {
    if (!this.orgId) throw new HttpError(500, 'internal', 'No tenant bound to this request');
    return withTenant(rootDb, this.orgId, fn);
  } as never);

  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute', allowList: (req) => req.url === '/api/v1/health' });

  // ── security headers
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('x-frame-options', 'DENY');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (req.url.startsWith('/api/')) {
      reply.header('cache-control', 'no-store');
      if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    }
    if (cfg.isProduction) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  });

  // ── CSRF defence in depth: SameSite=Lax cookie + required custom header + Origin check on unsafe methods
  const allowedOrigins = new Set([new URL(cfg.APP_BASE_URL).origin, ...(cfg.CORS_ORIGIN ? [cfg.CORS_ORIGIN] : [])]);
  app.addHook('onRequest', async (req) => {
    if (!UNSAFE.has(req.method) || !req.url.startsWith('/api/') || req.url.startsWith('/api/v1/webhooks/')) return;
    if (req.headers['x-requested-with'] !== 'ci-web') throw new HttpError(403, 'csrf', 'Missing required request header.');
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin) && origin !== `${req.protocol}://${req.headers.host}`) throw new HttpError(403, 'csrf', 'Cross-site request blocked.');
  });

  // ── errors
  app.setErrorHandler((err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    const send = (status: number, code: string, message: string, details?: unknown) => reply.status(status).send({ error: { code, message, ...(details ? { details } : {}) } });
    if (err instanceof ZodError) return send(400, 'validation', 'Some fields are not valid.', err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    if (err instanceof HttpError) return send(err.status, err.code, err.message, err.details);
    if (err instanceof AuthError || err instanceof SiteError || err instanceof IntegrationError || err instanceof MatchError || err instanceof ExportError) {
      return send((err as { status: number }).status, (err as { code?: string }).code ?? 'error', err.message);
    }
    if (err instanceof ActionNotPossibleError) return send(err.status, err.code, err.message, err.details);
    if (err instanceof WorkspaceModeError) return send(err.status, 'wrong_workspace_mode', err.message);
    if (err instanceof ConsentRequiredError) return send(409, 'consent_required', err.message);
    if (err instanceof ProfileError) return send(404, 'not_found', err.message);
    const fe = err as FastifyError;
    if (fe.statusCode === 429) return send(429, 'rate_limited', 'Too many requests. Please slow down.');
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) return send(fe.statusCode, fe.code ?? 'bad_request', fe.message);
    req.log.error({ err: { message: err.message, stack: cfg.isProduction ? undefined : err.stack } }, 'unhandled error');
    return send(500, 'internal', 'Something went wrong on our side. Please try again.');
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'not_found', message: 'Not found.' } });
    return reply.callNotFound();
  });

  // ── public meta
  app.get('/api/v1/health', async () => {
    await rootDb.execute('select 1' as never);
    return { ok: true, time: svc.clock().toISOString() };
  });
  /**
   * Readiness: can this deployment do its job? 503 only when it cannot safely serve (database down, schema out of date, tenant isolation not
   * enforced); 200 "degraded" when pages work but something important (worker, queue, storage) is wrong. Contains no secrets or tenant data.
   */
  app.get('/api/v1/ready', async (_req, reply) => {
    const r = await checkSystemReadiness(svc, rootDb);
    return reply.status(r.status === 'not_ready' ? 503 : 200).send(r);
  });
  app.get('/api/v1/meta', async () => ({
    appBaseUrl: cfg.APP_BASE_URL,
    schedulerMode: cfg.SCHEDULER_MODE,
    devTools: !cfg.isProduction,
    allowLocalFixtures: cfg.ALLOW_LOCAL_FIXTURES,
    emailConfigured: !!cfg.SMTP_URL,
    /** With email delivery configured, an account must verify its address before it can sign in. Without it, accounts stay visibly unverified. */
    emailVerificationEnforced: !!cfg.SMTP_URL,
    aiProvider: svc.llm.available ? svc.llm.id : 'none',
    browserRendering: !!svc.browser?.available,
    shopifyConfigured: !!(cfg.SHOPIFY_CLIENT_ID && cfg.SHOPIFY_CLIENT_SECRET && cfg.SHOPIFY_REDIRECT_URI && svc.keyRing),
    version: '0.1.0',
  }));

  await app.register(authRoutes, { prefix: '/api/v1', authRateLimitMax: opts.authRateLimitMax ?? 12 });
  await app.register(publicIntegrationRoutes, { prefix: '/api/v1' });
  await app.register(
    async (scope) => {
      await scope.register(integrationOrgScope);
    },
    { prefix: '/api/v1' },
  );

  // static web build (single-container deployment)
  if (cfg.SERVE_WEB) {
    const dist = opts.webDist ?? path.resolve(process.cwd(), 'apps/web/dist');
    if (existsSync(dist)) {
      const fastifyStatic = (await import('@fastify/static')).default;
      await app.register(fastifyStatic, { root: dist, wildcard: false });
      app.get('/*', (req, reply) => {
        if (req.url.startsWith('/api/')) return reply.callNotFound();
        return reply.sendFile('index.html');
      });
    } else app.log.warn({ dist }, 'SERVE_WEB is set but the web build was not found');
  }
  return app;
}

/** All organisation-scoped routes live under /api/v1/orgs/:orgId with membership enforced before any handler runs. */
async function integrationOrgScope(app: FastifyInstance) {
  await app.register(
    async (scope) => {
      scope.addHook('preHandler', async (req) => {
        const token = req.cookies[SESSION_COOKIE];
        const session = await getSession(app.svc, app.rootDb, token);
        if (!session) throw new HttpError(401, 'unauthenticated', 'Please sign in.');
        const orgId = (req.params as { orgId?: string }).orgId ?? '';
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orgId)) throw new HttpError(404, 'not_found', 'Workspace not found.');
        const ctx = await getOrgContext(app.rootDb, session.user.id, orgId);
        // Non-members get the same answer as for a workspace that does not exist.
        if (!ctx) throw new HttpError(404, 'not_found', 'Workspace not found.');
        const role = ctx.role;
        req.user = session.user;
        req.orgId = orgId;
        req.role = role;
        req.orgMode = ctx.mode;
      });
      await scope.register(orgRoutes);
      await scope.register(siteRoutes);
      await scope.register(catalogRoutes);
      await scope.register(reportRoutes);
      await scope.register(alertRoutes);
      await scope.register(integrationRoutes);
      if (!app.cfg.isProduction) await scope.register(devRoutes);
    },
    { prefix: '/orgs/:orgId' },
  );
}

/** Requires a signed-in user for non-org routes. */
export async function currentUser(app: FastifyInstance, req: FastifyRequest): Promise<SessionUser> {
  const session = await getSession(app.svc, app.rootDb, req.cookies[SESSION_COOKIE]);
  if (!session) throw new HttpError(401, 'unauthenticated', 'Please sign in.');
  req.user = session.user;
  return session.user;
}
