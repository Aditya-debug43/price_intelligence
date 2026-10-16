import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { randomToken, sha256Hex } from '@ci/core';
import type { MemberRole } from '@ci/shared';
import { auditEvents, invitations, memberships, organizations, users, withTenant, type Db } from '@ci/database';
import type { Services } from './context.ts';
import { AuthError, normalizeEmail, roleAtLeast, type SessionUser } from './auth.ts';
import { invitationEmail } from './mailer.ts';

/**
 * Inviting people into a workspace.
 *  - An admin invites an email address. The invitee gets a single-use link (valid 7 days); only a hash of the token is stored.
 *  - Following the link shows what they are being invited to. To accept, they must be signed in as exactly the invited address —
 *    a forwarded link is useless to anyone else — and, where email delivery is configured, have a verified address.
 *  - A resend replaces the link (the old one stops working); revoking stops it immediately; accepting uses it up.
 *  - Unlike adding an existing account by email, nobody is put into a workspace without choosing to accept.
 */
export const INVITATION_TTL_MS = 7 * 86_400_000;
export const MAX_PENDING_INVITATIONS = 25;

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface InvitationView {
  id: string;
  email: string;
  role: MemberRole;
  status: InvitationStatus;
  invitedBy: string | null;
  createdAt: string;
  lastSentAt: string;
  expiresAt: string;
  acceptedAt: string | null;
}

const statusOf = (r: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now: Date): InvitationStatus =>
  r.acceptedAt ? 'accepted' : r.revokedAt ? 'revoked' : r.expiresAt <= now ? 'expired' : 'pending';

function assertCanInvite(actor: { role: MemberRole }, role: MemberRole) {
  if (!roleAtLeast(actor.role, 'admin')) throw new AuthError('Only owners and admins can invite people.', 'forbidden', 403);
  if (role === 'owner' && actor.role !== 'owner') throw new AuthError('Only an owner can invite another owner.', 'forbidden', 403);
}

/** One pending invitation per address: inviting again replaces the link and restarts the clock (so "resend" and "invite again" are the same thing). */
export async function createInvitation(
  svc: Services,
  db: Db,
  orgId: string,
  actor: { userId: string; role: MemberRole; name: string },
  input: { email: string; role: MemberRole },
): Promise<{ invitation: InvitationView; /** Present only when this server cannot email it: the admin has to hand it over. */ link: string | null; resent: boolean }> {
  assertCanInvite(actor, input.role);
  const email = normalizeEmail(input.email);
  const now = svc.clock();

  const [alreadyMember] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, orgId), eq(users.email, email)));
  if (alreadyMember) throw new AuthError('That person is already a member of this workspace.', 'conflict', 409);

  const [existing] = await db.select().from(invitations).where(and(eq(invitations.orgId, orgId), eq(invitations.email, email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
  if (!existing) {
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(invitations)
      .where(and(eq(invitations.orgId, orgId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now)));
    if (n >= MAX_PENDING_INVITATIONS) throw new AuthError(`There are already ${MAX_PENDING_INVITATIONS} invitations waiting. Revoke some, or wait for them to be accepted or expire.`, 'conflict', 409);
  }

  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
  const values = { role: input.role, tokenHash: sha256Hex(token), invitedBy: actor.userId, lastSentAt: now, expiresAt };
  const [row] = existing
    ? await db.update(invitations).set(values).where(eq(invitations.id, existing.id)).returning()
    : await db.insert(invitations).values({ orgId, email, ...values }).returning();

  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
  const link = `${svc.config.APP_BASE_URL}/invite?token=${token}`;
  const mail = invitationEmail(actor.name, org?.name ?? 'a workspace', input.role, link);
  await svc.mailer.queue(db, { orgId, to: [email], subject: mail.subject, html: mail.html, text: mail.text, kind: 'invitation', relatedId: row!.id });
  await withTenant(db, orgId, (tx) => tx.insert(auditEvents).values({ orgId, userId: actor.userId, action: existing ? 'invitation.resend' : 'invitation.create', target: row!.id, meta: { role: input.role } }));
  return { invitation: view(row!, now, actor.name), link: svc.config.SMTP_URL ? null : link, resent: !!existing };
}

function view(r: typeof invitations.$inferSelect, now: Date, invitedBy: string | null): InvitationView {
  return { id: r.id, email: r.email, role: r.role, status: statusOf(r, now), invitedBy, createdAt: r.createdAt.toISOString(), lastSentAt: r.lastSentAt.toISOString(), expiresAt: r.expiresAt.toISOString(), acceptedAt: r.acceptedAt?.toISOString() ?? null };
}

/** Pending invitations, plus what happened to the ones from the last 30 days. */
export async function listInvitations(svc: Services, db: Db, orgId: string): Promise<InvitationView[]> {
  const now = svc.clock();
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const rows = await db
    .select({ r: invitations, inviter: users.displayName })
    .from(invitations)
    .leftJoin(users, eq(users.id, invitations.invitedBy))
    .where(and(eq(invitations.orgId, orgId), gt(invitations.createdAt, since)))
    .orderBy(desc(invitations.createdAt))
    .limit(100);
  return rows.map((x) => view(x.r, now, x.inviter));
}

export async function revokeInvitation(svc: Services, db: Db, orgId: string, actor: { userId: string; role: MemberRole }, invitationId: string): Promise<void> {
  if (!roleAtLeast(actor.role, 'admin')) throw new AuthError('Only owners and admins can revoke invitations.', 'forbidden', 403);
  const [r] = await db.select().from(invitations).where(and(eq(invitations.id, invitationId), eq(invitations.orgId, orgId)));
  if (!r) throw new AuthError('Invitation not found.', 'not_found', 404);
  if (r.role === 'owner' && actor.role !== 'owner') throw new AuthError('Only an owner can revoke an invitation to be an owner.', 'forbidden', 403);
  if (r.acceptedAt) throw new AuthError('This invitation was already accepted. Remove the member instead.', 'conflict', 409);
  if (r.revokedAt) return;
  await db.update(invitations).set({ revokedAt: svc.clock() }).where(eq(invitations.id, r.id));
  await withTenant(db, orgId, (tx) => tx.insert(auditEvents).values({ orgId, userId: actor.userId, action: 'invitation.revoke', target: r.id }));
}

export interface InvitationPreview {
  workspace: string;
  role: MemberRole;
  email: string;
  invitedBy: string | null;
  expiresAt: string;
}

const INVALID = () => new AuthError('This invitation is invalid, has expired, or was already used. Ask for a new one.', 'invalid_token', 404);

/** What an invitation link is for. Anyone holding the token may see this (it is addressed to them); a wrong, used, revoked or expired token all look the same. */
export async function previewInvitation(svc: Services, db: Db, token: string): Promise<InvitationPreview> {
  const now = svc.clock();
  const [row] = await db
    .select({ r: invitations, workspace: organizations.name, inviter: users.displayName })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .leftJoin(users, eq(users.id, invitations.invitedBy))
    .where(eq(invitations.tokenHash, sha256Hex(token)));
  if (!row || statusOf(row.r, now) !== 'pending') throw INVALID();
  return { workspace: row.workspace, role: row.r.role, email: row.r.email, invitedBy: row.inviter, expiresAt: row.r.expiresAt.toISOString() };
}

/**
 * Accepting: the signed-in person must be the invited address. The invitation is claimed atomically, so two simultaneous requests cannot
 * both use it, and the membership is created in the same step.
 */
export async function acceptInvitation(svc: Services, db: Db, user: SessionUser, token: string): Promise<{ orgId: string; role: MemberRole }> {
  const now = svc.clock();
  const hash = sha256Hex(token);
  const [row] = await db.select().from(invitations).where(eq(invitations.tokenHash, hash));
  if (!row || statusOf(row, now) !== 'pending') throw INVALID();
  if (normalizeEmail(user.email) !== row.email) {
    throw new AuthError(`This invitation was sent to ${maskEmail(row.email)}. Sign in with that address to accept it.`, 'wrong_account', 403);
  }
  if (svc.config.SMTP_URL && !user.emailVerified) throw new AuthError('Verify your email address first, then open the invitation again.', 'unverified', 403);

  const claimed = await db
    .update(invitations)
    .set({ acceptedAt: now, acceptedBy: user.id })
    .where(and(eq(invitations.id, row.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now)))
    .returning({ id: invitations.id });
  if (!claimed.length) throw INVALID(); // lost a race with a revoke, an expiry, or another request

  const [existing] = await db.select({ id: memberships.id, role: memberships.role }).from(memberships).where(and(eq(memberships.orgId, row.orgId), eq(memberships.userId, user.id)));
  let role = row.role;
  if (existing) role = existing.role; // already a member (added another way): never lower or change their role
  else await db.insert(memberships).values({ orgId: row.orgId, userId: user.id, role: row.role });
  await withTenant(db, row.orgId, (tx) => tx.insert(auditEvents).values({ orgId: row.orgId, userId: user.id, action: 'invitation.accept', target: row.id, meta: { role } }));
  return { orgId: row.orgId, role };
}

/** "j***@example.com" — enough for the right person to recognise their own address, not enough to harvest one. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

/** Housekeeping for retention: invitations are valid for 7 days, so anything older than a year has long been closed and is not history anyone needs. */
export async function purgeOldInvitations(db: Db, now: Date): Promise<number> {
  const r = await db.delete(invitations).where(lt(invitations.createdAt, new Date(now.getTime() - 365 * 86_400_000))).returning({ id: invitations.id });
  return r.length;
}
