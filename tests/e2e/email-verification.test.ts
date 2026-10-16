import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { emailOutbox } from '@ci/database';
import { buildApp } from '../../apps/api/src/app.ts';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';

/**
 * An account is never silently treated as verified. Where email delivery is configured, an address must be confirmed before sign-in.
 * Where it is not (local development), people can still sign in — and the account, the member list and the API all say, truthfully, that
 * the address is NOT verified; a password-reset link that only ever sat in the development outbox does not verify it either.
 */
const PASSWORD = 'Correct-Horse-9-Battery';
const NEW_PASSWORD = 'Another-Strong-Passphrase-7';

interface Server { h: Harness; app: FastifyInstance }
let plain: Server; // no email delivery configured
let mailed: Server; // email delivery configured

async function start(extraEnv?: Record<string, string>): Promise<Server> {
  const h = await createHarness({ extraEnv });
  const app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  return { h, app };
}

/** The newest mail of a kind sent to an address, and the token in its link (the way a person would follow it). */
async function linkFor(s: Server, to: string, kind: 'verify-email' | 'password-reset') {
  const rows = (await s.h.db.worker.select().from(emailOutbox).orderBy(desc(emailOutbox.createdAt))).filter((m) => m.kind === kind && m.toAddresses.includes(to));
  const mail = rows[0];
  expect(mail, `a ${kind} email to ${to}`).toBeDefined();
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail!.text)?.[1];
  expect(token).toBeTruthy();
  return { token: token!, count: rows.length };
}

const email = (label: string) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

beforeAll(async () => {
  plain = await start();
  mailed = await start({ SMTP_URL: 'smtp://127.0.0.1:1' }); // configured, never contacted: nothing here drains the send queue
}, 120_000);

afterAll(async () => {
  for (const s of [plain, mailed]) {
    await s.app.close();
    await s.h.close();
  }
});

describe('with no email delivery configured (local development)', () => {
  let c: ApiClient;
  let addr: string;
  let orgId: string;

  it('says so: verification is not enforced and email is not configured', async () => {
    const meta = (await new ApiClient(plain.app).get('/api/v1/meta')).body;
    expect(meta).toMatchObject({ emailConfigured: false, emailVerificationEnforced: false });
  });

  it('people can sign in — but the account is reported as unverified everywhere, never as verified', async () => {
    c = new ApiClient(plain.app);
    addr = email('plain');
    const reg = await c.post('/api/v1/auth/register', { email: addr, password: PASSWORD, displayName: 'Plain User' });
    expect(reg.status).toBe(201);
    expect(reg.body.user.emailVerified).toBe(false);
    const login = new ApiClient(plain.app);
    const r = await login.post('/api/v1/auth/login', { email: addr, password: PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.user.emailVerified).toBe(false);
    expect((await login.get('/api/v1/auth/me')).body.user.emailVerified).toBe(false);
  });

  it('the member list shows who is unverified', async () => {
    orgId = (await c.post('/api/v1/orgs', { name: 'Plain Org' })).body.organization.id as string;
    const members = (await c.get(`/api/v1/orgs/${orgId}/members`)).body.members as { email: string; emailVerified: boolean }[];
    expect(members.find((m) => m.email === addr)).toMatchObject({ emailVerified: false });
  });

  it('a reset link that only sat in the development outbox changes the password but does NOT verify the address', async () => {
    await c.post('/api/v1/auth/forgot-password', { email: addr });
    const { token } = await linkFor(plain, addr, 'password-reset');
    expect((await new ApiClient(plain.app).post('/api/v1/auth/reset-password', { token, password: NEW_PASSWORD })).status).toBe(200);
    const again = new ApiClient(plain.app);
    expect((await again.post('/api/v1/auth/login', { email: addr, password: PASSWORD })).status).toBe(401); // the old password is gone
    const ok = await again.post('/api/v1/auth/login', { email: addr, password: NEW_PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.user.emailVerified).toBe(false);
  });

  it('following the verification link does verify it, and the member list follows', async () => {
    const me = new ApiClient(plain.app);
    await me.post('/api/v1/auth/login', { email: addr, password: NEW_PASSWORD });
    const { token } = await linkFor(plain, addr, 'verify-email');
    expect((await new ApiClient(plain.app).post('/api/v1/auth/verify-email', { token })).status).toBe(200);
    expect((await me.get('/api/v1/auth/me')).body.user.emailVerified).toBe(true);
    const members = (await me.get(`/api/v1/orgs/${orgId}/members`)).body.members as { email: string; emailVerified: boolean }[];
    expect(members.find((m) => m.email === addr)!.emailVerified).toBe(true);
  });

  it('a verification link works once, and a made-up one never', async () => {
    const { token } = await linkFor(plain, addr, 'verify-email');
    const reuse = await new ApiClient(plain.app).post('/api/v1/auth/verify-email', { token });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('invalid_token');
    expect((await new ApiClient(plain.app).post('/api/v1/auth/verify-email', { token: 'x'.repeat(43) })).status).toBe(400);
  });

  it('resending is only possible while unverified, and sends one fresh link each time', async () => {
    const c2 = new ApiClient(plain.app);
    const a2 = email('resend');
    await c2.post('/api/v1/auth/register', { email: a2, password: PASSWORD, displayName: 'Resend' });
    const before = (await linkFor(plain, a2, 'verify-email')).count;
    expect((await c2.post('/api/v1/auth/resend-verification')).status).toBeLessThan(300);
    expect((await linkFor(plain, a2, 'verify-email')).count).toBe(before + 1);
    const { token } = await linkFor(plain, a2, 'verify-email');
    await new ApiClient(plain.app).post('/api/v1/auth/verify-email', { token });
    await c2.post('/api/v1/auth/resend-verification');
    expect((await linkFor(plain, a2, 'verify-email')).count).toBe(before + 1); // already verified: nothing more is sent
  });
});

describe('with email delivery configured', () => {
  let addr: string;

  it('says verification is enforced', async () => {
    expect((await new ApiClient(mailed.app).get('/api/v1/meta')).body).toMatchObject({ emailConfigured: true, emailVerificationEnforced: true });
  });

  it('an unverified address cannot sign in, and is told why', async () => {
    addr = email('mailed');
    const reg = await new ApiClient(mailed.app).post('/api/v1/auth/register', { email: addr, password: PASSWORD, displayName: 'Mailed User' });
    expect(reg.status).toBe(201);
    const login = await new ApiClient(mailed.app).post('/api/v1/auth/login', { email: addr, password: PASSWORD });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('unverified');
    expect(login.body.error.message).toMatch(/verify your email/i);
  });

  it('a wrong password is still just a wrong password (no hint that the account exists or is unverified)', async () => {
    const r = await new ApiClient(mailed.app).post('/api/v1/auth/login', { email: addr, password: 'Totally-Wrong-Password-1' });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('invalid_credentials');
  });

  it('after following the emailed link they can sign in, and are verified', async () => {
    const { token } = await linkFor(mailed, addr, 'verify-email');
    expect((await new ApiClient(mailed.app).post('/api/v1/auth/verify-email', { token })).status).toBe(200);
    const c = new ApiClient(mailed.app);
    const r = await c.post('/api/v1/auth/login', { email: addr, password: PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.user.emailVerified).toBe(true);
  });

  it('an emailed reset link does prove the inbox is theirs, so it verifies the address', async () => {
    const other = email('mailed-reset');
    await new ApiClient(mailed.app).post('/api/v1/auth/register', { email: other, password: PASSWORD, displayName: 'Reset User' });
    expect((await new ApiClient(mailed.app).post('/api/v1/auth/login', { email: other, password: PASSWORD })).status).toBe(403);
    await new ApiClient(mailed.app).post('/api/v1/auth/forgot-password', { email: other });
    const { token } = await linkFor(mailed, other, 'password-reset');
    expect((await new ApiClient(mailed.app).post('/api/v1/auth/reset-password', { token, password: NEW_PASSWORD })).status).toBe(200);
    const r = await new ApiClient(mailed.app).post('/api/v1/auth/login', { email: other, password: NEW_PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.user.emailVerified).toBe(true);
  });

  it('asking for a reset for an unknown address looks exactly like asking for a known one', async () => {
    const known = await new ApiClient(mailed.app).post('/api/v1/auth/forgot-password', { email: addr });
    const unknown = await new ApiClient(mailed.app).post('/api/v1/auth/forgot-password', { email: email('nobody') });
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
  });
});

describe('verification tokens are stored hashed', () => {
  it('no raw token is in the database', async () => {
    const { token } = await linkFor(plain, (await plain.h.db.worker.select().from(emailOutbox).where(eq(emailOutbox.kind, 'verify-email')))[0]!.toAddresses[0]!, 'verify-email');
    const { sql } = await import('drizzle-orm');
    const rows = await plain.h.db.worker.execute(sql`select count(*)::int as n from email_tokens where token_hash = ${token}`);
    expect((rows.rows[0] as { n: number }).n).toBe(0); // the table holds a hash, never the value in the link
  });
});
