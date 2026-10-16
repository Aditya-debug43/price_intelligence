import type { FastifyInstance, FastifyReply } from 'fastify';
import { forgotPasswordSchema, invitationTokenSchema, loginSchema, registerSchema, resetPasswordSchema, verifyEmailSchema, createOrgSchema } from '@ci/shared';
import { acceptInvitation, createOrganization, listMemberships, login, logout, previewInvitation, register, requestPasswordReset, resendVerification, resetPassword, verifyEmail } from '@ci/services';
import { SESSION_COOKIE, currentUser, parse } from '../app.ts';

export async function authRoutes(app: FastifyInstance, opts: { authRateLimitMax?: number } = {}) {
  const AUTH_LIMIT = { config: { rateLimit: { max: opts.authRateLimitMax ?? 12, timeWindow: '1 minute' } } };
  const setSession = (reply: FastifyReply, token: string, expires: Date) =>
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: app.cfg.secureCookies, path: '/', expires });

  app.post('/auth/register', AUTH_LIMIT, async (req, reply) => {
    const body = parse(registerSchema, req.body);
    const user = await register(app.svc, app.rootDb, body);
    // Without an email provider there is nothing to verify against, so sign the new user straight in.
    if (!app.cfg.SMTP_URL) {
      const s = await login(app.svc, app.rootDb, { email: body.email, password: body.password, ip: req.ip, userAgent: req.headers['user-agent'] });
      setSession(reply, s.token, s.expiresAt);
      return reply.status(201).send({ user: s.user, memberships: [], verificationRequired: false });
    }
    return reply.status(201).send({ user, memberships: [], verificationRequired: true });
  });

  /** What an invitation link is for (the link is addressed to its holder). Rate-limited so tokens cannot be guessed. */
  app.get('/invitations/preview', AUTH_LIMIT, async (req) => {
    const { token } = parse(invitationTokenSchema, req.query);
    return { invitation: await previewInvitation(app.svc, app.rootDb, token) };
  });

  /** Accepting needs a signed-in session for exactly the invited address. */
  app.post('/invitations/accept', AUTH_LIMIT, async (req) => {
    const user = await currentUser(app, req);
    const { token } = parse(invitationTokenSchema, req.body);
    const r = await acceptInvitation(app.svc, app.rootDb, user, token);
    return { orgId: r.orgId, role: r.role, memberships: await listMemberships(app.rootDb, user.id) };
  });

  app.post('/auth/login', AUTH_LIMIT, async (req, reply) => {
    const body = parse(loginSchema, req.body);
    const s = await login(app.svc, app.rootDb, { ...body, ip: req.ip, userAgent: req.headers['user-agent'] });
    setSession(reply, s.token, s.expiresAt);
    return { user: s.user, memberships: await listMemberships(app.rootDb, s.user.id) };
  });

  app.post('/auth/logout', async (req, reply) => {
    await logout(app.rootDb, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const user = await currentUser(app, req);
    return { user, memberships: await listMemberships(app.rootDb, user.id) };
  });

  app.post('/auth/verify-email', AUTH_LIMIT, async (req) => {
    await verifyEmail(app.svc, app.rootDb, parse(verifyEmailSchema, req.body).token);
    return { ok: true };
  });

  app.post('/auth/resend-verification', AUTH_LIMIT, async (req) => {
    const user = await currentUser(app, req);
    await resendVerification(app.svc, app.rootDb, user.id);
    return { ok: true };
  });

  // Always answers the same way so the endpoint cannot be used to discover which emails have accounts.
  app.post('/auth/forgot-password', AUTH_LIMIT, async (req) => {
    await requestPasswordReset(app.svc, app.rootDb, parse(forgotPasswordSchema, req.body).email);
    return { ok: true };
  });

  app.post('/auth/reset-password', AUTH_LIMIT, async (req) => {
    const b = parse(resetPasswordSchema, req.body);
    await resetPassword(app.svc, app.rootDb, b.token, b.password);
    return { ok: true };
  });

  app.get('/orgs', async (req) => {
    const user = await currentUser(app, req);
    return { organizations: await listMemberships(app.rootDb, user.id) };
  });

  app.post('/orgs', async (req, reply) => {
    const user = await currentUser(app, req);
    const body = parse(createOrgSchema, req.body);
    const org = await createOrganization(app.rootDb, user.id, body.name);
    return reply.status(201).send({ organization: org });
  });
}
