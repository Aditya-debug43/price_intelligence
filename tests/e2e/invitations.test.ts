import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { desc, eq, sql } from 'drizzle-orm';
import { auditEvents, emailOutbox, invitations, memberships } from '@ci/database';
import { buildApp } from '../../apps/api/src/app.ts';
import { MAX_PENDING_INVITATIONS } from '@ci/services';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';

/**
 * Inviting people: nobody is put into a workspace without accepting; the link is single-use, expires, and is useless to anyone who is not
 * signed in as the invited address; only owners/admins can invite; invitations never cross workspaces.
 */
const PASSWORD = 'Correct-Horse-9-Battery';
let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let admin: ApiClient;
let staff: ApiClient;
let orgId: string;
let otherOwner: ApiClient;
let otherOrgId: string;
const base = (o = orgId) => `/api/v1/orgs/${o}`;
const addr = (label: string) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
const tokenOf = (link: string) => new URL(link).searchParams.get('token')!;

async function register(label: string, name = label) {
  const c = new ApiClient(app);
  const email = addr(label);
  const r = await c.post('/api/v1/auth/register', { email, password: PASSWORD, displayName: name });
  expect(r.status).toBe(201);
  return { c, email };
}

interface Inv { id: string; email: string; role: string; status: string; invitedBy: string | null }
const list = async (c = owner, o = orgId) => ((await c.get(`${base(o)}/invitations`)).body.invitations ?? []) as Inv[];

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  const o = await register('inv-owner', 'Olivia Owner');
  owner = o.c;
  orgId = (await owner.post('/api/v1/orgs', { name: 'Invite Co' })).body.organization.id as string;
  for (const [label, role] of [['inv-admin', 'admin'], ['inv-staff', 'staff']] as const) {
    const u = await register(label);
    expect((await owner.post(`${base()}/members`, { email: u.email, role })).status).toBe(201);
    if (role === 'admin') admin = u.c;
    else staff = u.c;
  }
  const other = await register('inv-other-owner');
  otherOwner = other.c;
  otherOrgId = (await otherOwner.post('/api/v1/orgs', { name: 'Other Co' })).body.organization.id as string;
}, 120_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('inviting someone who has no account yet', () => {
  let invited: string;
  let first: { id: string; token: string };

  it('creates a pending invitation and — because this server cannot email — hands the link to the admin', async () => {
    invited = addr('newcomer');
    const r = await admin.post(`${base()}/invitations`, { email: invited.toUpperCase(), role: 'staff' }); // addresses are matched case-insensitively
    expect(r.status).toBe(201);
    expect(r.body.invitation).toMatchObject({ email: invited, role: 'staff', status: 'pending' });
    expect(r.body.link).toMatch(/\/invite\?token=/);
    first = { id: r.body.invitation.id, token: tokenOf(r.body.link) };
    expect(first.token.length).toBeGreaterThan(30);
  });

  it('stores only a hash of the token', async () => {
    const [row] = await h.db.worker.select().from(invitations).where(eq(invitations.id, first.id));
    expect(row!.tokenHash).not.toBe(first.token);
    expect(JSON.stringify(row)).not.toContain(first.token);
  });

  it('queues the email, naming who invited them to what', async () => {
    const mail = (await h.db.worker.select().from(emailOutbox).where(eq(emailOutbox.relatedId, first.id)))[0]!;
    expect(mail).toMatchObject({ kind: 'invitation', toAddresses: [invited] });
    expect(mail.subject).toMatch(/invited you to Invite Co on Shelfwatch/);
    expect(mail.text).toContain(`/invite?token=${first.token}`);
    expect(mail.text).toMatch(/works once and expires in 7 days/);
  });

  it('shows what the link is for, to whoever holds it — and gives nothing away for a wrong token', async () => {
    const p = await new ApiClient(app).get(`/api/v1/invitations/preview?token=${first.token}`);
    expect(p.status).toBe(200);
    expect(p.body.invitation).toMatchObject({ workspace: 'Invite Co', role: 'staff', email: invited });
    const bad = await new ApiClient(app).get(`/api/v1/invitations/preview?token=${'x'.repeat(43)}`);
    expect(bad.status).toBe(404);
    expect(bad.body.error.code).toBe('invalid_token');
    expect((await new ApiClient(app).get('/api/v1/invitations/preview')).status).toBe(400); // no token at all
  });

  it('inviting the same address again replaces the link: one pending invitation, and the old link stops working', async () => {
    const r = await admin.post(`${base()}/invitations`, { email: invited, role: 'staff' });
    expect(r.status).toBe(200);
    expect(r.body.resent).toBe(true);
    const fresh = tokenOf(r.body.link);
    expect(fresh).not.toBe(first.token);
    expect((await new ApiClient(app).get(`/api/v1/invitations/preview?token=${first.token}`)).status).toBe(404);
    expect((await new ApiClient(app).get(`/api/v1/invitations/preview?token=${fresh}`)).status).toBe(200);
    expect((await list()).filter((i) => i.email === invited && i.status === 'pending')).toHaveLength(1);
    first = { id: r.body.invitation.id, token: fresh };
  });

  it('they register with that address, open the link, and accept: now a member with the invited role', async () => {
    const c = new ApiClient(app);
    expect((await c.post('/api/v1/auth/register', { email: invited, password: PASSWORD, displayName: 'New Comer' })).status).toBe(201);
    expect((await c.get(`${base()}`)).status).toBe(404); // not a member yet
    const r = await c.post('/api/v1/invitations/accept', { token: first.token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ orgId, role: 'staff' });
    expect(r.body.memberships.some((m: { orgId: string }) => m.orgId === orgId)).toBe(true);
    expect((await c.get(`${base()}`)).status).toBe(200);
    expect((await c.get(`${base()}/members`)).body.members.find((m: { email: string }) => m.email === invited)).toMatchObject({ role: 'staff' });
  });

  it('the link works once: using it again is refused, and the invitation reads as accepted', async () => {
    const again = await new ApiClient(app).get(`/api/v1/invitations/preview?token=${first.token}`);
    expect(again.status).toBe(404);
    const reuse = new ApiClient(app);
    await reuse.post('/api/v1/auth/register', { email: addr('replay'), password: PASSWORD, displayName: 'Replay' });
    expect((await reuse.post('/api/v1/invitations/accept', { token: first.token })).status).toBe(404);
    expect((await list()).find((i) => i.id === first.id)).toMatchObject({ status: 'accepted' });
  });

  it('records who did what', async () => {
    const actions = (await h.db.worker.select().from(auditEvents).where(eq(auditEvents.orgId, orgId)).orderBy(desc(auditEvents.createdAt))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['invitation.create', 'invitation.resend', 'invitation.accept']));
  });
});

describe('a link is useless to anyone but the invited address', () => {
  it('a different signed-in account cannot accept it, is told which address it was for (masked), and does not use it up', async () => {
    const invitee = addr('target');
    const r = await owner.post(`${base()}/invitations`, { email: invitee, role: 'admin' });
    const token = tokenOf(r.body.link);
    const thief = await register('thief');
    const refused = await thief.c.post('/api/v1/invitations/accept', { token });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('wrong_account');
    expect(refused.body.error.message).toMatch(/t\*+@example\.test/);
    expect(refused.body.error.message).not.toContain(invitee);
    expect((await thief.c.get(`${base()}`)).status).toBe(404); // still not a member
    // …and the real invitee can still use it
    const real = new ApiClient(app);
    await real.post('/api/v1/auth/register', { email: invitee, password: PASSWORD, displayName: 'Real Target' });
    expect((await real.post('/api/v1/invitations/accept', { token })).status).toBe(200);
  });

  it('accepting needs a signed-in session', async () => {
    const r = await owner.post(`${base()}/invitations`, { email: addr('anon-target'), role: 'staff' });
    expect((await new ApiClient(app).post('/api/v1/invitations/accept', { token: tokenOf(r.body.link) })).status).toBe(401);
  });

  it('an existing account (not yet a member) can be invited and chooses to accept — nobody is added behind their back', async () => {
    const u = await register('existing');
    const r = await owner.post(`${base()}/invitations`, { email: u.email, role: 'staff' });
    expect((await u.c.get(`${base()}`)).status).toBe(404);
    expect((await u.c.post('/api/v1/invitations/accept', { token: tokenOf(r.body.link) })).status).toBe(200);
    expect((await u.c.get(`${base()}`)).status).toBe(200);
  });

  it('inviting someone who is already a member is refused', async () => {
    const members = (await owner.get(`${base()}/members`)).body.members as { email: string }[];
    const r = await owner.post(`${base()}/invitations`, { email: members[0]!.email, role: 'staff' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/already a member/);
  });

  it('two simultaneous acceptances create exactly one membership', async () => {
    const u = await register('racer');
    const r = await owner.post(`${base()}/invitations`, { email: u.email, role: 'staff' });
    const token = tokenOf(r.body.link);
    const results = await Promise.all([u.c.post('/api/v1/invitations/accept', { token }), u.c.post('/api/v1/invitations/accept', { token })]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 404]);
    const rows = await h.db.worker.select().from(memberships).where(sql`${memberships.orgId} = ${orgId} and ${memberships.userId} = (select id from users where email = ${u.email})`);
    expect(rows).toHaveLength(1);
  });

  it('an invitation never lowers a role the person already has', async () => {
    const u = await register('already-admin');
    expect((await owner.post(`${base()}/members`, { email: u.email, role: 'admin' })).status).toBe(201); // added another way first
    // a pending invitation created before that, for a lower role, is accepted as a no-op on the role
    const [row] = await h.db.worker.insert(invitations).values({ orgId, email: u.email, role: 'staff', tokenHash: 'h'.repeat(64), expiresAt: new Date(Date.now() + 86_400_000) }).returning();
    expect(row).toBeDefined();
    const token = 'plain-token-for-already-admin-case-0123456789';
    await h.db.worker.update(invitations).set({ tokenHash: (await import('@ci/core')).sha256Hex(token) }).where(eq(invitations.id, row!.id));
    const r = await u.c.post('/api/v1/invitations/accept', { token });
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('admin');
  });
});

describe('who may invite, list and revoke', () => {
  it('staff can do none of it', async () => {
    expect((await staff.post(`${base()}/invitations`, { email: addr('x'), role: 'staff' })).status).toBe(403);
    expect((await staff.get(`${base()}/invitations`)).status).toBe(403);
  });

  it('an admin can invite staff and admins but not owners; an owner can invite owners', async () => {
    expect((await admin.post(`${base()}/invitations`, { email: addr('a1'), role: 'admin' })).status).toBe(201);
    const denied = await admin.post(`${base()}/invitations`, { email: addr('a2'), role: 'owner' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toMatch(/Only an owner can invite another owner/);
    const ownerInvite = await owner.post(`${base()}/invitations`, { email: addr('a3'), role: 'owner' });
    expect(ownerInvite.status).toBe(201);
    // …and an admin cannot undo an owner's invitation to be an owner
    expect((await admin.delete(`${base()}/invitations/${ownerInvite.body.invitation.id}`)).status).toBe(403);
  });

  it('revoking stops the link immediately; revoking twice is harmless; an accepted invitation cannot be revoked', async () => {
    const r = await admin.post(`${base()}/invitations`, { email: addr('rev'), role: 'staff' });
    const token = tokenOf(r.body.link);
    const id = r.body.invitation.id as string;
    expect((await admin.delete(`${base()}/invitations/${id}`)).status).toBe(200);
    expect((await admin.delete(`${base()}/invitations/${id}`)).status).toBe(200);
    expect((await new ApiClient(app).get(`/api/v1/invitations/preview?token=${token}`)).status).toBe(404);
    expect((await list()).find((i) => i.id === id)).toMatchObject({ status: 'revoked' });
    const accepted = (await list()).find((i) => i.status === 'accepted')!;
    const conflict = await owner.delete(`${base()}/invitations/${accepted.id}`);
    expect(conflict.status).toBe(409);
  });

  it('resending needs an open invitation, and gives a new working link', async () => {
    const r = await admin.post(`${base()}/invitations`, { email: addr('resend'), role: 'staff' });
    const id = r.body.invitation.id as string;
    const again = await admin.post(`${base()}/invitations/${id}/resend`, {});
    expect(again.status).toBe(200);
    expect(tokenOf(again.body.link)).not.toBe(tokenOf(r.body.link));
    await admin.delete(`${base()}/invitations/${id}`);
    expect((await admin.post(`${base()}/invitations/${id}/resend`, {})).status).toBe(404);
  });

  it('an invalid address or role is a validation error', async () => {
    expect((await owner.post(`${base()}/invitations`, { email: 'not-an-email', role: 'staff' })).status).toBe(400);
    expect((await owner.post(`${base()}/invitations`, { email: addr('v'), role: 'god' })).status).toBe(400);
  });
});

describe('time and volume limits', () => {
  it('an invitation expires after 7 days, and a resend brings it back with a new link', async () => {
    const email = addr('slow');
    const r = await owner.post(`${base()}/invitations`, { email, role: 'staff' });
    const token = tokenOf(r.body.link);
    h.advance(6 * 86_400_000);
    expect((await new ApiClient(app).get(`/api/v1/invitations/preview?token=${token}`)).status).toBe(200);
    h.advance(2 * 86_400_000);
    expect((await new ApiClient(app).get(`/api/v1/invitations/preview?token=${token}`)).status).toBe(404);
    const u = new ApiClient(app);
    await u.post('/api/v1/auth/register', { email, password: PASSWORD, displayName: 'Slow' });
    expect((await u.post('/api/v1/invitations/accept', { token })).status).toBe(404);
    expect((await list()).find((i) => i.email === email)).toMatchObject({ status: 'expired' });
    const revived = await owner.post(`${base()}/invitations`, { email, role: 'staff' });
    expect(revived.status).toBe(200);
    expect((await u.post('/api/v1/invitations/accept', { token: tokenOf(revived.body.link) })).status).toBe(200);
  });

  it('there is a cap on waiting invitations, so a workspace cannot be used to spray email', async () => {
    const o = await register('cap-owner');
    const capOrg = (await o.c.post('/api/v1/orgs', { name: 'Cap Co' })).body.organization.id as string;
    for (let i = 0; i < MAX_PENDING_INVITATIONS; i++) expect((await o.c.post(`${base(capOrg)}/invitations`, { email: addr(`cap${i}`), role: 'staff' })).status).toBe(201);
    const over = await o.c.post(`${base(capOrg)}/invitations`, { email: addr('cap-over'), role: 'staff' });
    expect(over.status).toBe(409);
    expect(over.body.error.message).toMatch(/already 25 invitations waiting/);
    // re-inviting an address that already has one is still fine (it replaces, it does not add)
    const first = (await list(o.c, capOrg))[0]!;
    expect((await o.c.post(`${base(capOrg)}/invitations`, { email: first.email, role: 'staff' })).status).toBe(200);
  });
});

describe('workspaces are separate', () => {
  it('another workspace cannot list, resend or revoke these invitations — and sees none of them', async () => {
    const mine = await list();
    expect(mine.length).toBeGreaterThan(3);
    expect(await list(otherOwner, otherOrgId)).toEqual([]);
    const fresh = await owner.post(`${base()}/invitations`, { email: addr('isolated'), role: 'staff' }); // (earlier ones have expired by now)
    const id = fresh.body.invitation.id as string;
    expect((await otherOwner.delete(`${base(otherOrgId)}/invitations/${id}`)).status).toBe(404);
    expect((await otherOwner.post(`${base(otherOrgId)}/invitations/${id}/resend`, {})).status).toBe(404);
    expect((await otherOwner.get(`${base()}/invitations`)).status).toBe(404); // cannot even address this workspace
    expect((await otherOwner.post(`${base()}/invitations`, { email: addr('x'), role: 'staff' })).status).toBe(404);
    expect((await list()).find((i) => i.id === id)!.status).toBe('pending'); // untouched
  });

  it('an invitation cannot be used to land in a different workspace than the one that issued it', async () => {
    const u = await register('lands-right');
    const r = await otherOwner.post(`${base(otherOrgId)}/invitations`, { email: u.email, role: 'staff' });
    const acc = await u.c.post('/api/v1/invitations/accept', { token: tokenOf(r.body.link) });
    expect(acc.body.orgId).toBe(otherOrgId);
    expect((await u.c.get(`${base()}`)).status).toBe(404);
  });
});

describe('where email delivery is configured', () => {
  it('the link goes by email only — the admin is not handed it — and acceptance needs a verified address', async () => {
    const h2 = await createHarness({ extraEnv: { SMTP_URL: 'smtp://127.0.0.1:1' } });
    const app2 = await buildApp({ svc: { ...h2.svc, db: h2.db.app }, rootDb: h2.db.app, logger: false, authRateLimitMax: 1000 });
    try {
      const o = new ApiClient(app2);
      const ownerEmail = addr('smtp-owner');
      await o.post('/api/v1/auth/register', { email: ownerEmail, password: PASSWORD, displayName: 'SMTP Owner' });
      const verifyLink = async (email: string) => {
        const mail = (await h2.db.worker.select().from(emailOutbox).orderBy(desc(emailOutbox.createdAt))).find((m) => m.kind === 'verify-email' && m.toAddresses.includes(email))!;
        return /token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
      };
      await new ApiClient(app2).post('/api/v1/auth/verify-email', { token: await verifyLink(ownerEmail) });
      await o.post('/api/v1/auth/login', { email: ownerEmail, password: PASSWORD });
      const org = (await o.post('/api/v1/orgs', { name: 'Mailed Co' })).body.organization.id as string;

      const email = addr('smtp-invitee');
      const inv = await o.post(`/api/v1/orgs/${org}/invitations`, { email, role: 'staff' });
      expect(inv.status).toBe(201);
      expect(inv.body.link).toBeNull(); // delivered by email, not handed to the inviter
      const mail = (await h2.db.worker.select().from(emailOutbox).where(eq(emailOutbox.relatedId, inv.body.invitation.id)))[0]!;
      const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;

      const invitee = new ApiClient(app2);
      await invitee.post('/api/v1/auth/register', { email, password: PASSWORD, displayName: 'Mailed Invitee' });
      expect((await invitee.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(403); // must verify first
      await new ApiClient(app2).post('/api/v1/auth/verify-email', { token: await verifyLink(email) });
      await invitee.post('/api/v1/auth/login', { email, password: PASSWORD });
      expect((await invitee.post('/api/v1/invitations/accept', { token })).status).toBe(200);
    } finally {
      await app2.close();
      await h2.close();
    }
  });
});
