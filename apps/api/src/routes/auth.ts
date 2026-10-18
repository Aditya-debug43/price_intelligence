import type { FastifyInstance, FastifyReply } from 'fastify';
import { changePasswordSchema, forgotPasswordSchema, invitationTokenSchema, loginSchema, registerSchema, resendVerificationSchema, resetPasswordSchema, verifyEmailSchema, createOrgSchema } from '@ci/shared';
import { acceptInvitation, changePassword, createOrganization, getSession, listMemberships, login, logout, previewInvitation, registerAccount, requestPasswordReset, resendVerification, resetPassword, verifyEmail } from '@ci/services';
import { SESSION_COOKIE, currentUser, parse } from '../app.ts';

export async function authRoutes(app: FastifyInstance, opts: { authRateLimitMax?: number } = {}) {
  const AUTH_LIMIT = { config: { rateLimit: { max: opts.authRateLimitMax ?? 12, timeWindow: '1 minute' } } };
  const setSession = (reply: FastifyReply, token: string, expires: Date) =>
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: app.cfg.secureCookies, path: '/', expires });

  /**
   * Creates an unverified account and emails a verification link. The answer is the same whether or not the address was already registered,
   * and the person is NOT signed in: an account is usable only after the link in the email has been opened.
   */
  app.post('/auth/register', AUTH_LIMIT, async (req, reply) => {
    const body = parse(registerSchema, req.body);
    await registerAccount(app.svc, app.rootDb, body);
    return reply.status(201).send({ verificationRequired: true, email: body.email.trim().toLowerCase() });
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

  // Answers the same way for unknown, verified and unverified addresses.
  app.post('/auth/resend-verification', AUTH_LIMIT, async (req, reply) => {
    await resendVerification(app.svc, app.rootDb, parse(resendVerificationSchema, req.body).email);
    return reply.status(202).send({ ok: true });
  });

  app.post('/auth/change-password', async (req) => {
    const user = await currentUser(app, req);
    const session = await getSession(app.svc, app.rootDb, req.cookies[SESSION_COOKIE]);
    const b = parse(changePasswordSchema, req.body);
    await changePassword(app.svc, app.rootDb, user.id, session!.sessionId, b.currentPassword, b.newPassword);
    return { ok: true };
  });

  // Always answers the same way so the endpoint cannot be used to discover which emails have accounts.
  app.post('/auth/forgot-password', AUTH_LIMIT, async (req, reply) => {
    await requestPasswordReset(app.svc, app.rootDb, parse(forgotPasswordSchema, req.body).email);
    return reply.status(202).send({ ok: true });
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
