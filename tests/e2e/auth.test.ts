import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { emailOutbox, emailTokens, sessions, users } from '@ci/database';
import { buildApp } from '../../apps/api/src/app.ts';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp, TEST_PASSWORD as PASSWORD } from '../support/auth.ts';

/**
 * Genuine authentication, end to end through the real HTTP API and a real PostgreSQL. The mail server is a test stand-in that records what
 * the product hands it (like an inbox); delivery over a real SMTP conversation is covered in email-smtp.test.ts, and delivery through
 * Gmail is checked by the owner with the real credentials (see docs/integrations.md).
 *
 * The rules under test: an account exists only after its address is verified by a single-use, expiring emailed link; nobody is signed in by
 * registering; no email → no registration (stated plainly, never faked); wrong passwords, unknown addresses and duplicate registrations are
 * indistinguishable from outside; passwords are only ever stored hashed; sessions end; a reset link works once, for an hour.
 */
let h: Harness;
let app: FastifyInstance;
let none: Harness; // a server with no mail server configured
let noneApp: FastifyInstance;
const addr = (label: string) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
const db = () => h.db.worker;
const HOUR = 3_600_000;

beforeAll(async () => {
  h = await createHarness({ extraEnv: { SESSION_TTL_DAYS: '2' } });
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  none = await createHarness({ mail: 'none' });
  noneApp = await buildApp({ svc: { ...none.svc, db: none.db.app }, rootDb: none.db.app, logger: false, authRateLimitMax: 1000 });
}, 120_000);

afterAll(async () => {
  for (const [a, x] of [[app, h], [noneApp, none]] as const) {
    await a.close();
    await x.close();
  }
});

describe('a server with no email delivery configured says so, and creates nothing', () => {
  it('reports email as not configured', async () => {
    expect((await new ApiClient(noneApp).get('/api/v1/meta')).body).toMatchObject({ emailConfigured: false });
    expect((await new ApiClient(noneApp).get('/api/v1/ready')).body.checks.email).toMatchObject({ level: 'warn' });
  });

  it('refuses registration with the reason (503) and does not create an account', async () => {
    const email = addr('noemail');
    const r = await new ApiClient(noneApp).post('/api/v1/auth/register', { email, password: PASSWORD, displayName: 'No Mail' });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('email_not_configured');
    expect(r.body.error.message).toMatch(/cannot send email|SMTP/i);
    expect(await none.db.worker.select().from(users).where(eq(users.email, email))).toHaveLength(0);
    expect((await none.emails()).filter((m) => m.toAddresses.includes(email))).toHaveLength(0);
  });

  it('refuses a password reset and a resend the same way — it never claims to have sent anything', async () => {
    const c = new ApiClient(noneApp);
    expect((await c.post('/api/v1/auth/forgot-password', { email: 'someone@example.test' })).status).toBe(503);
    expect((await c.post('/api/v1/auth/resend-verification', { email: 'someone@example.test' })).status).toBe(503);
  });

  it('records any other email it is asked to send as "not_configured", never as sent', async () => {
    const id = await none.svc.mailer.queue(none.db.worker, { orgId: null, to: ['x@example.test'], subject: 'Alert', text: 't', html: '<p>t</p>', kind: 'daily-summary' });
    const [row] = await none.db.worker.select().from(emailOutbox).where(eq(emailOutbox.id, id));
    expect(row).toMatchObject({ status: 'not_configured' });
    expect(row!.error).toMatch(/not configured/i);
    expect(row!.sentAt).toBeNull();
    await none.queue.drain();
    expect(none.mail.sent).toHaveLength(0);
  });
});

describe('registration and email verification', () => {
  const email = addr('customer');
  let client: ApiClient;
  let firstToken: string;

  it('creates an UNVERIFIED account, hashes the password, signs nobody in, and says to check the inbox', async () => {
    client = new ApiClient(app);
    const r = await client.post('/api/v1/auth/register', { email, password: PASSWORD, displayName: 'Cora Customer' });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ verificationRequired: true, email });
    expect(client.cookies.size).toBe(0);
    const [u] = await db().select().from(users).where(eq(users.email, email));
    expect(u).toMatchObject({ displayName: 'Cora Customer', emailVerifiedAt: null });
    expect(u!.passwordHash).toMatch(/^scrypt\$/);
    expect(JSON.stringify(u)).not.toContain(PASSWORD);
    expect((await client.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('emails a verification link: queued first, "sent" only once the mail server accepted it, with the server’s answer stored', async () => {
    const queued = (await db().select().from(emailOutbox)).find((m) => m.kind === 'verify-email' && m.toAddresses.includes(email))!;
    expect(queued.status).toBe('queued');
    expect(queued.sentAt).toBeNull();
    await h.queue.drain();
    const [sent] = await db().select().from(emailOutbox).where(eq(emailOutbox.id, queued.id));
    expect(sent).toMatchObject({ status: 'sent', attempts: 1, error: null });
    expect(sent!.providerMessageId).toMatch(/^<test-/);
    expect(sent!.providerResponse).toMatch(/^250/);
    const mail = h.mail.inboxOf(email).at(-1)!;
    expect(mail.subject).toMatch(/verify/i);
    expect(mail.text).toContain('http://localhost:5173/verify-email?token=');
    expect(mail.text).toMatch(/expires in 48 hours/);
    expect(mail.from).toBe(h.svc.mailer.from);
    firstToken = h.mail.tokenIn(email, 'verify-email')!;
    expect(firstToken.length).toBeGreaterThan(30);
  });

  it('stores only a hash of the token', async () => {
    const rows = await db().select().from(emailTokens);
    expect(JSON.stringify(rows)).not.toContain(firstToken);
  });

  it('refuses to sign in before verification — with the right password the answer is "verify first", with a wrong one it is generic', async () => {
    const right = await client.post('/api/v1/auth/login', { email, password: PASSWORD });
    expect(right.status).toBe(403);
    expect(right.body.error.code).toBe('unverified');
    const wrong = await client.post('/api/v1/auth/login', { email, password: 'Wrong-Password-1' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.message).toBe('Email or password is incorrect.');
    expect(client.cookies.size).toBe(0);
  });

  it('rejects an invalid token and an expired one, and does not verify the account', async () => {
    expect((await client.post('/api/v1/auth/verify-email', { token: 'x'.repeat(40) })).status).toBe(400);
    const other = addr('expiry');
    const c2 = new ApiClient(app);
    await c2.post('/api/v1/auth/register', { email: other, password: PASSWORD, displayName: 'Slow Sam' });
    await h.queue.drain();
    const token = h.mail.tokenIn(other, 'verify-email')!;
    h.advance(49 * HOUR);
    const late = await c2.post('/api/v1/auth/verify-email', { token });
    expect(late.status).toBe(400);
    expect(late.body.error.message).toMatch(/invalid or has expired/);
    expect((await db().select().from(users).where(eq(users.email, other)))[0]!.emailVerifiedAt).toBeNull();
    h.advance(-49 * HOUR);
  });

  it('the link works exactly once', async () => {
    expect((await client.post('/api/v1/auth/verify-email', { token: firstToken })).status).toBe(200);
    const again = await client.post('/api/v1/auth/verify-email', { token: firstToken });
    expect(again.status).toBe(400);
    const [u] = await db().select().from(users).where(eq(users.email, email));
    expect(u!.emailVerifiedAt).not.toBeNull();
  });

  it('after verification the person can sign in; the session cookie is HttpOnly + SameSite and the hash never leaves the server', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-requested-with': 'ci-web' }, payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(res.body).not.toMatch(/passwordHash|scrypt/);
    const r = await client.post('/api/v1/auth/login', { email, password: PASSWORD });
    expect(r.body.user).toMatchObject({ email, emailVerified: true });
    expect((await client.get('/api/v1/auth/me')).body.user.email).toBe(email);
  });

  it('creates the customer’s own, genuinely empty workspace', async () => {
    const org = await client.post('/api/v1/orgs', { name: 'Cora’s Corner Shop' });
    expect(org.status).toBe(201);
    const id = org.body.organization.id as string;
    expect((await client.get(`/api/v1/orgs/${id}/sites`)).body.sites).toEqual([]);
    expect((await client.get(`/api/v1/orgs/${id}/products`)).body.total).toBe(0);
    expect((await client.get(`/api/v1/orgs/${id}/reports`)).body.reports).toEqual([]);
    expect((await client.get('/api/v1/auth/me')).body.memberships).toHaveLength(1);
  });
});

describe('asking for another verification email', () => {
  it('sends a new link, kills the old one, and answers identically for unknown and already-verified addresses', async () => {
    const email = addr('resend');
    const c = new ApiClient(app);
    await c.post('/api/v1/auth/register', { email, password: PASSWORD, displayName: 'Resend' });
    await h.queue.drain();
    const old = h.mail.tokenIn(email, 'verify-email')!;
    h.advance(2 * 60_000); // past the one-minute throttle
    const r = await c.post('/api/v1/auth/resend-verification', { email });
    expect(r.status).toBe(202);
    await h.queue.drain();
    const fresh = h.mail.tokenIn(email, 'verify-email')!;
    expect(fresh).not.toBe(old);
    expect((await c.post('/api/v1/auth/verify-email', { token: old })).status).toBe(400); // replaced
    expect((await c.post('/api/v1/auth/verify-email', { token: fresh })).status).toBe(200);

    const unknown = await c.post('/api/v1/auth/resend-verification', { email: addr('ghost') });
    const verified = await c.post('/api/v1/auth/resend-verification', { email });
    expect([unknown.status, unknown.body]).toEqual([r.status, r.body]);
    expect([verified.status, verified.body]).toEqual([r.status, r.body]);
    await h.queue.drain();
    expect(h.mail.inboxOf(email).filter((m) => /verify/i.test(m.subject))).toHaveLength(2); // none after verification
  });

  it('is throttled to one email a minute per account', async () => {
    const email = addr('throttle');
    const c = new ApiClient(app);
    await c.post('/api/v1/auth/register', { email, password: PASSWORD, displayName: 'T' });
    for (let i = 0; i < 4; i++) await c.post('/api/v1/auth/resend-verification', { email });
    await h.queue.drain();
    expect(h.mail.inboxOf(email)).toHaveLength(1);
  });
});

describe('registering an address that already has an account', () => {
  it('answers exactly like a new registration, creates nothing, and tells the real owner by email (once an hour)', async () => {
    const email = addr('owner');
    const first = await new ApiClient(app).post('/api/v1/auth/register', { email, password: PASSWORD, displayName: 'The Owner' });
    await h.queue.drain();
    const usersBefore = (await db().select().from(users).where(eq(users.email, email))).length;

    const again = await new ApiClient(app).post('/api/v1/auth/register', { email, password: 'Another-Strong-Phrase-42', displayName: 'Imposter' });
    await new ApiClient(app).post('/api/v1/auth/register', { email, password: 'Another-Strong-Phrase-43', displayName: 'Imposter' });
    await h.queue.drain();
    expect([again.status, again.body]).toEqual([first.status, first.body]);
    const rows = await db().select().from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(usersBefore);
    expect(rows[0]!.displayName).toBe('The Owner');
    const notices = h.mail.inboxOf(email).filter((m) => /already have one/i.test(m.text));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).not.toContain('token=');
  });
});

describe('sign-in failures', () => {
  it('wrong password and unknown address are indistinguishable; repeated failures lock the account, even against the right password', async () => {
    const email = addr('lock');
    await signUp(new ApiClient(app), h, { email, password: PASSWORD, displayName: 'Lock' });
    const c = new ApiClient(app);
    const bad = await c.post('/api/v1/auth/login', { email, password: 'Wrong-Password-1' });
    const ghost = await c.post('/api/v1/auth/login', { email: addr('ghost'), password: 'Wrong-Password-1' });
    expect([bad.status, bad.body]).toEqual([ghost.status, ghost.body]);
    for (let i = 0; i < 7; i++) await c.post('/api/v1/auth/login', { email, password: 'Wrong-Password-1' });
    expect((await c.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(429);
    h.advance(16 * 60_000); // the lock lasts 15 minutes
    expect((await c.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(200);
  });

  it('validates input: malformed addresses, short and common passwords, empty names', async () => {
    const c = new ApiClient(app);
    expect((await c.post('/api/v1/auth/register', { email: 'not-an-email', password: PASSWORD, displayName: 'A' })).status).toBe(400);
    expect((await c.post('/api/v1/auth/register', { email: addr('x'), password: 'short', displayName: 'A' })).status).toBe(400);
    expect((await c.post('/api/v1/auth/register', { email: addr('x'), password: 'password12345', displayName: 'A' })).body.error.message).toMatch(/too easy/);
    expect((await c.post('/api/v1/auth/register', { email: addr('x'), password: PASSWORD, displayName: '   ' })).status).toBe(400);
    expect((await c.post('/api/v1/auth/login', { email: 'x', password: '' })).status).toBe(400);
  });
});

describe('sessions', () => {
  it('end at logout (server-side), at expiry, and on password reset', async () => {
    const email = addr('session');
    const c = new ApiClient(app);
    await signUp(c, h, { email, password: PASSWORD, displayName: 'Sess' });
    const token = new Map(c.cookies);
    expect((await c.get('/api/v1/auth/me')).status).toBe(200);
    const [account] = await db().select().from(users).where(eq(users.email, email));
    expect((await db().select().from(sessions).where(eq(sessions.userId, account!.id))).length).toBe(1);
    expect((await c.post('/api/v1/auth/logout')).status).toBe(200);
    const replay = new ApiClient(app);
    replay.cookies = new Map(token);
    expect((await replay.get('/api/v1/auth/me')).status).toBe(401);

    const c2 = new ApiClient(app);
    expect((await c2.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(200);
    h.advance(3 * 24 * HOUR); // the test server's sessions last 2 days
    expect((await c2.get('/api/v1/auth/me')).status).toBe(401);
    h.advance(-3 * 24 * HOUR);
  });

  it('a signed-out request cannot reach any workspace data', async () => {
    const anon = new ApiClient(app);
    expect((await anon.get('/api/v1/auth/me')).status).toBe(401);
    expect((await anon.get('/api/v1/orgs')).status).toBe(401);
    expect((await anon.get('/api/v1/orgs/00000000-0000-4000-8000-000000000000/sites')).status).toBe(401);
  });
});

describe('password reset', () => {
  it('emails a single-use link valid for one hour; sets the new password; signs every session out; proves the address', async () => {
    const email = addr('reset');
    const c = new ApiClient(app);
    await signUp(c, h, { email, password: PASSWORD, displayName: 'Rita' });
    h.advance(2 * 60_000);
    const ghostAddr = addr('ghost');
    const asked = await c.post('/api/v1/auth/forgot-password', { email });
    const ghost = await c.post('/api/v1/auth/forgot-password', { email: ghostAddr });
    expect([asked.status, asked.body]).toEqual([ghost.status, ghost.body]);
    await h.queue.drain();
    expect(h.mail.inboxOf(ghostAddr)).toHaveLength(0); // nothing is sent to an address that has no account
    const mail = h.mail.inboxOf(email).at(-1)!;
    expect(mail.text).toMatch(/within one hour/);
    const token = h.mail.tokenIn(email, 'reset-password')!;

    expect((await c.post('/api/v1/auth/reset-password', { token, password: 'short' })).status).toBe(400);
    expect((await c.post('/api/v1/auth/reset-password', { token, password: 'New-Strong-Pass-77' })).status).toBe(200);
    expect((await c.post('/api/v1/auth/reset-password', { token, password: 'Another-Strong-Pass-8' })).status).toBe(400); // single use
    expect((await c.get('/api/v1/auth/me')).status).toBe(401); // the old session is gone
    expect((await new ApiClient(app).post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(401); // the old password is gone
    expect((await new ApiClient(app).post('/api/v1/auth/login', { email, password: 'New-Strong-Pass-77' })).status).toBe(200);
  });

  it('a link older than an hour, or replaced by a newer one, is refused', async () => {
    const email = addr('stale');
    await signUp(new ApiClient(app), h, { email, password: PASSWORD, displayName: 'Stale' });
    const c = new ApiClient(app);
    h.advance(2 * 60_000);
    await c.post('/api/v1/auth/forgot-password', { email });
    await h.queue.drain();
    const t1 = h.mail.tokenIn(email, 'reset-password')!;
    h.advance(2 * 60_000);
    await c.post('/api/v1/auth/forgot-password', { email });
    await h.queue.drain();
    const t2 = h.mail.tokenIn(email, 'reset-password')!;
    expect(t2).not.toBe(t1);
    expect((await c.post('/api/v1/auth/reset-password', { token: t1, password: 'New-Strong-Pass-78' })).status).toBe(400); // replaced
    h.advance(61 * 60_000);
    const late = await c.post('/api/v1/auth/reset-password', { token: t2, password: 'New-Strong-Pass-78' });
    expect(late.status).toBe(400);
    expect(late.body.error.message).toMatch(/invalid or has expired/);
    expect((await new ApiClient(app).post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(200); // unchanged
  });

  it('resetting an account that never verified also verifies it: the link proves the inbox is theirs', async () => {
    const email = addr('unverified');
    const c = new ApiClient(app);
    await c.post('/api/v1/auth/register', { email, password: PASSWORD, displayName: 'Never Clicked' });
    await h.queue.drain();
    h.advance(2 * 60_000);
    await c.post('/api/v1/auth/forgot-password', { email });
    await h.queue.drain();
    const token = h.mail.tokenIn(email, 'reset-password')!;
    expect((await c.post('/api/v1/auth/reset-password', { token, password: 'New-Strong-Pass-79' })).status).toBe(200);
    expect((await new ApiClient(app).post('/api/v1/auth/login', { email, password: 'New-Strong-Pass-79' })).status).toBe(200);
  });
});

describe('changing the password while signed in', () => {
  it('needs the current password, and signs the other sessions out but not this one', async () => {
    const email = addr('change');
    const mine = new ApiClient(app);
    await signUp(mine, h, { email, password: PASSWORD, displayName: 'Chang' });
    const other = new ApiClient(app);
    await other.post('/api/v1/auth/login', { email, password: PASSWORD });
    expect((await mine.post('/api/v1/auth/change-password', { currentPassword: 'Not-The-Password-1', newPassword: 'Brand-New-Pass-123' })).status).toBe(403);
    expect((await mine.post('/api/v1/auth/change-password', { currentPassword: PASSWORD, newPassword: 'weak' })).status).toBe(400);
    expect((await mine.post('/api/v1/auth/change-password', { currentPassword: PASSWORD, newPassword: 'Brand-New-Pass-123' })).status).toBe(200);
    expect((await mine.get('/api/v1/auth/me')).status).toBe(200);
    expect((await other.get('/api/v1/auth/me')).status).toBe(401);
    expect((await new ApiClient(app).post('/api/v1/auth/login', { email, password: 'Brand-New-Pass-123' })).status).toBe(200);
  });
});

describe('when delivery to the mail server fails', () => {
  const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:587'), { code: 'ECONNREFUSED' });
  const badLogin = () => Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535, response: '535-5.7.8 Username and Password not accepted. For more information, go to 535 5.7.8 https://support.google.com/mail/?p=BadCredentials' });

  it('a temporary failure is recorded as "retrying" with an actionable reason, retried, and finally "sent" when the server recovers', async () => {
    const email = addr('retry');
    h.mail.failWith = refused;
    await new ApiClient(app).post('/api/v1/auth/register', { email, password: PASSWORD, displayName: 'Retry' });
    await h.queue.drain();
    const [row] = (await db().select().from(emailOutbox)).filter((m) => m.toAddresses.includes(email));
    expect(row).toMatchObject({ status: 'retrying', attempts: 1, sentAt: null });
    expect(row!.error).toMatch(/connection_refused/);
    expect(row!.error).toMatch(/SMTP_HOST|SMTP_PORT/);
    expect(h.mail.inboxOf(email)).toHaveLength(0);
    expect(h.queue.history.at(-1)).toMatchObject({ name: 'send-email', ok: false }); // thrown so the queue retries it later

    h.mail.failWith = null; // the server is back
    await expect(h.svc.mailer.deliver(row!.id)).resolves.toBe('sent');
    const [after] = await db().select().from(emailOutbox).where(eq(emailOutbox.id, row!.id));
    expect(after).toMatchObject({ status: 'sent', attempts: 2, error: null });
    expect(h.mail.inboxOf(email)).toHaveLength(1);
    expect(await h.svc.mailer.deliver(row!.id)).toBe('skipped'); // never sent twice
  });

  it('bad Gmail credentials are not retried: the message is "failed" with the exact thing to fix, and the secret is never in the record', async () => {
    const email = addr('badlogin');
    h.mail.failWith = badLogin;
    await new ApiClient(app).post('/api/v1/auth/register', { email, password: PASSWORD, displayName: 'Bad Login' });
    await h.queue.drain();
    h.mail.failWith = null;
    const [row] = (await db().select().from(emailOutbox)).filter((m) => m.toAddresses.includes(email));
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    expect(row!.error).toMatch(/auth_failed/);
    expect(row!.error).toMatch(/App Password/);
    expect(h.queue.history.at(-1)).toMatchObject({ name: 'send-email', ok: true }); // a permanent failure is not retried
    expect(JSON.stringify(row)).not.toMatch(/Password-1|secret/i);
  });

  it('gives up after the maximum number of attempts', async () => {
    const email = addr('giveup');
    h.mail.failWith = refused;
    await new ApiClient(app).post('/api/v1/auth/register', { email, password: PASSWORD, displayName: 'Give Up' });
    await h.queue.drain();
    const [row] = (await db().select().from(emailOutbox)).filter((m) => m.toAddresses.includes(email));
    for (let i = 0; i < 4; i++) await expect(h.svc.mailer.deliver(row!.id)).rejects.toThrow(/will retry/);
    expect(await h.svc.mailer.deliver(row!.id)).toBe('failed'); // the sixth attempt is the last
    h.mail.failWith = null;
    const [after] = await db().select().from(emailOutbox).where(eq(emailOutbox.id, row!.id));
    expect(after).toMatchObject({ status: 'failed', attempts: 6 });
  });

  it('a one-off connection check reports the same plain-language problem', async () => {
    h.mail.failWith = badLogin;
    const check = await h.svc.mailer.verify();
    h.mail.failWith = null;
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.problem.code).toBe('auth_failed');
    expect(await h.svc.mailer.verify()).toEqual({ ok: true });
  });
});

describe('the email delivery panel (workspace settings)', () => {
  let owner: ApiClient;
  let staff: ApiClient;
  let orgId: string;
  const ownerEmail = addr('panel-owner');
  const staffEmail = addr('panel-staff');
  beforeAll(async () => {
    owner = new ApiClient(app);
    staff = new ApiClient(app);
    await signUp(owner, h, { email: ownerEmail, password: PASSWORD, displayName: 'Panel Owner' });
    await signUp(staff, h, { email: staffEmail, password: PASSWORD, displayName: 'Panel Staff' });
    orgId = (await owner.post('/api/v1/orgs', { name: 'Panel Co' })).body.organization.id as string;
    expect((await owner.post(`/api/v1/orgs/${orgId}/members`, { email: staffEmail, role: 'staff' })).status).toBe(201);
  });

  it('reports that email is configured, what it sends as, and what happened to recent messages', async () => {
    const r = await owner.get(`/api/v1/orgs/${orgId}/email`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: true, host: 'test transport' });
    expect(r.body.from).toBe(h.svc.mailer.from);
    expect(Array.isArray(r.body.recent)).toBe(true);
  });

  it('sends one real test message to the signed-in admin and shows what the mail server answered', async () => {
    const r = await owner.post(`/api/v1/orgs/${orgId}/email/test`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, to: ownerEmail });
    expect(r.body.response).toMatch(/^250/);
    expect(h.mail.inboxOf(ownerEmail).some((m) => /test email/i.test(m.subject))).toBe(true);
    const log = (await owner.get(`/api/v1/orgs/${orgId}/email`)).body.recent as { kind: string; status: string }[];
    expect(log.find((m) => m.kind === 'test-email')).toMatchObject({ status: 'sent' });
  });

  it('reports a failed test with the plain-language reason and records it as not delivered', async () => {
    h.mail.failWith = () => Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535, response: '535-5.7.8 Username and Password not accepted' });
    const r = await owner.post(`/api/v1/orgs/${orgId}/email/test`, {});
    h.mail.failWith = null;
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, problem: { code: 'auth_failed' } });
    expect(r.body.problem.message).toMatch(/SMTP_USER|App Password/);
    const log = (await owner.get(`/api/v1/orgs/${orgId}/email`)).body.recent as { status: string; error: string | null }[];
    expect(log.some((m) => m.status === 'failed' && /auth_failed/.test(m.error ?? ''))).toBe(true);
  });

  it('is for admins only, and a workspace never sees another workspace’s messages', async () => {
    expect((await staff.get(`/api/v1/orgs/${orgId}/email`)).status).toBe(403);
    expect((await staff.post(`/api/v1/orgs/${orgId}/email/test`, {})).status).toBe(403);
    const stranger = new ApiClient(app);
    await signUp(stranger, h, { email: addr('panel-stranger'), password: PASSWORD, displayName: 'Stranger' });
    expect((await stranger.get(`/api/v1/orgs/${orgId}/email`)).status).toBe(404);
    const other = (await stranger.post('/api/v1/orgs', { name: 'Elsewhere' })).body.organization.id as string;
    expect(((await stranger.get(`/api/v1/orgs/${other}/email`)).body.recent as unknown[]).length).toBe(0);
  });

  it('refuses a test message honestly when the server has no email configured (409, with the reason)', async () => {
    const t = await none.db.worker.insert(users).values({ email: addr('nomail-admin'), passwordHash: await (await import('@ci/core')).hashPassword(PASSWORD), displayName: 'Old Admin', emailVerifiedAt: new Date() }).returning();
    const c = new ApiClient(noneApp);
    expect((await c.post('/api/v1/auth/login', { email: t[0]!.email, password: PASSWORD })).status).toBe(200);
    const org = (await c.post('/api/v1/orgs', { name: 'No Mail Panel' })).body.organization.id as string;
    expect((await c.get(`/api/v1/orgs/${org}/email`)).body).toMatchObject({ configured: false, host: null, from: null });
    const r = await c.post(`/api/v1/orgs/${org}/email/test`, {});
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/not configured|SMTP_HOST/i);
    expect(none.mail.sent).toHaveLength(0);
  });
});
