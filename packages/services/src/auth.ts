import { randomBytes } from 'node:crypto';
import { and, eq, lt, sql } from 'drizzle-orm';
import { hashPassword, randomToken, sha256Hex, verifyPassword } from '@ci/core';
import { DEFAULTS, type MemberRole } from '@ci/shared';
import {
  alertRules,
  emailTokens,
  memberships,
  orgSettings,
  organizations,
  sessions,
  users,
  withTenant,
  type Db,
  type DbLike,
} from '@ci/database';
import type { Services } from './context.ts';
import { resetEmail, verificationEmail } from './mailer.ts';

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_credentials' | 'locked' | 'email_taken' | 'weak_password' | 'unverified' | 'invalid_token' | 'forbidden' | 'not_found' | 'conflict' | 'wrong_account',
    readonly status = 400,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;
const SESSION_TOUCH_MS = 5 * 60_000;
// Used to equalise timing when the account does not exist (so login does not reveal which emails are registered).
const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

const COMMON = ['password', '12345678', 'qwerty', 'letmein', 'welcome', 'competitor', 'iloveyou', 'admin'];
export function checkPasswordStrength(password: string, email?: string): string | null {
  if (password.length < 10) return 'Use at least 10 characters.';
  const lower = password.toLowerCase();
  if (email && lower.includes(normalizeEmail(email).split('@')[0]!) && normalizeEmail(email).split('@')[0]!.length >= 4) return 'The password must not contain your email name.';
  if (COMMON.some((c) => lower.includes(c))) return 'That password is too easy to guess.';
  if (/^(.)\1+$/.test(password)) return 'Use a mix of characters.';
  return null;
}

function slugify(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace';
  return `${base}-${randomBytes(3).toString('hex')}`;
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
}

export interface OrgMembership {
  orgId: string;
  name: string;
  slug: string;
  role: MemberRole;
}

export async function register(svc: Services, db: DbLike, input: { email: string; password: string; displayName: string }): Promise<SessionUser> {
  const email = normalizeEmail(input.email);
  const weak = checkPasswordStrength(input.password, email);
  if (weak) throw new AuthError(weak, 'weak_password');
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  // Same response shape either way would be ideal for enumeration resistance; registration necessarily reveals duplicates.
  if (existing.length) throw new AuthError('An account with this email already exists.', 'email_taken', 409);
  const passwordHash = await hashPassword(input.password);
  const [u] = await db.insert(users).values({ email, passwordHash, displayName: input.displayName.trim() }).returning();
  await sendVerification(svc, db, u!);
  return { id: u!.id, email: u!.email, displayName: u!.displayName, emailVerified: false };
}

async function sendVerification(svc: Services, db: DbLike, u: { id: string; email: string; displayName: string }) {
  const token = randomToken(32);
  await db.insert(emailTokens).values({ userId: u.id, kind: 'verify', tokenHash: sha256Hex(token), expiresAt: new Date(svc.clock().getTime() + 48 * 3_600_000) });
  const link = `${svc.config.APP_BASE_URL}/verify-email?token=${token}`;
  const m = verificationEmail(u.displayName, link);
  await svc.mailer.queue(db, { orgId: null, to: [u.email], subject: m.subject, html: m.html, text: m.text, kind: 'verify-email', relatedId: u.id });
}

export async function resendVerification(svc: Services, db: DbLike, userId: string): Promise<void> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (u && !u.emailVerifiedAt) await sendVerification(svc, db, u);
}

export async function verifyEmail(svc: Services, db: DbLike, token: string): Promise<void> {
  const [t] = await db.select().from(emailTokens).where(and(eq(emailTokens.tokenHash, sha256Hex(token)), eq(emailTokens.kind, 'verify')));
  if (!t || t.usedAt || t.expiresAt < svc.clock()) throw new AuthError('This verification link is invalid or has expired.', 'invalid_token');
  await db.update(emailTokens).set({ usedAt: svc.clock() }).where(eq(emailTokens.id, t.id));
  await db.update(users).set({ emailVerifiedAt: svc.clock() }).where(eq(users.id, t.userId));
}

export async function login(
  svc: Services,
  db: DbLike,
  input: { email: string; password: string; ip?: string | null; userAgent?: string | null },
): Promise<{ token: string; user: SessionUser; expiresAt: Date }> {
  const email = normalizeEmail(input.email);
  const [u] = await db.select().from(users).where(eq(users.email, email));
  const now = svc.clock();
  if (u?.lockedUntil && u.lockedUntil > now) throw new AuthError('Too many failed attempts. Try again in a few minutes.', 'locked', 429);
  const ok = await verifyPassword(input.password, u?.passwordHash ?? DUMMY_HASH);
  if (!u || !ok) {
    if (u) {
      const failed = u.failedLogins + 1;
      await db.update(users).set({ failedLogins: failed, lockedUntil: failed >= MAX_FAILED ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null }).where(eq(users.id, u.id));
    }
    throw new AuthError('Email or password is incorrect.', 'invalid_credentials', 401);
  }
  if (svc.config.SMTP_URL && !u.emailVerifiedAt) throw new AuthError('Please verify your email address first. Check your inbox.', 'unverified', 403);
  await db.update(users).set({ failedLogins: 0, lockedUntil: null, lastLoginAt: now }).where(eq(users.id, u.id));
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + svc.config.SESSION_TTL_DAYS * 86_400_000);
  await db.insert(sessions).values({ tokenHash: sha256Hex(token), userId: u.id, expiresAt, ip: input.ip ?? null, userAgent: input.userAgent?.slice(0, 300) ?? null });
  return { token, expiresAt, user: { id: u.id, email: u.email, displayName: u.displayName, emailVerified: !!u.emailVerifiedAt } };
}

export async function getSession(svc: Services, db: DbLike, token: string | undefined): Promise<{ user: SessionUser; sessionId: string } | null> {
  if (!token) return null;
  const now = svc.clock();
  const [s] = await db.select().from(sessions).where(eq(sessions.tokenHash, sha256Hex(token)));
  if (!s || s.expiresAt <= now) return null;
  const [u] = await db.select().from(users).where(eq(users.id, s.userId));
  if (!u) return null;
  if (now.getTime() - s.lastSeenAt.getTime() > SESSION_TOUCH_MS) await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, s.id));
  return { sessionId: s.id, user: { id: u.id, email: u.email, displayName: u.displayName, emailVerified: !!u.emailVerifiedAt } };
}

export async function logout(db: DbLike, token: string | undefined): Promise<void> {
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, sha256Hex(token)));
}

export async function requestPasswordReset(svc: Services, db: DbLike, emailRaw: string): Promise<void> {
  const [u] = await db.select().from(users).where(eq(users.email, normalizeEmail(emailRaw)));
  if (!u) return; // identical outcome for unknown emails: no enumeration
  const token = randomToken(32);
  await db.insert(emailTokens).values({ userId: u.id, kind: 'reset', tokenHash: sha256Hex(token), expiresAt: new Date(svc.clock().getTime() + 3_600_000) });
  const m = resetEmail(u.displayName, `${svc.config.APP_BASE_URL}/reset-password?token=${token}`);
  await svc.mailer.queue(db, { orgId: null, to: [u.email], subject: m.subject, html: m.html, text: m.text, kind: 'password-reset', relatedId: u.id });
}

export async function resetPassword(svc: Services, db: DbLike, token: string, newPassword: string): Promise<void> {
  const [t] = await db.select().from(emailTokens).where(and(eq(emailTokens.tokenHash, sha256Hex(token)), eq(emailTokens.kind, 'reset')));
  if (!t || t.usedAt || t.expiresAt < svc.clock()) throw new AuthError('This reset link is invalid or has expired.', 'invalid_token');
  const [u] = await db.select().from(users).where(eq(users.id, t.userId));
  const weak = checkPasswordStrength(newPassword, u?.email);
  if (weak) throw new AuthError(weak, 'weak_password');
  // Following the reset link proves the person controls the inbox — but only when email is really delivered. With no email service the
  // link only ever sat in the development outbox, which proves nothing, so the account stays unverified.
  const verifiedNow = u?.emailVerifiedAt ?? (svc.config.SMTP_URL ? svc.clock() : null);
  await db.update(users).set({ passwordHash: await hashPassword(newPassword), failedLogins: 0, lockedUntil: null, emailVerifiedAt: verifiedNow }).where(eq(users.id, t.userId));
  await db.update(emailTokens).set({ usedAt: svc.clock() }).where(eq(emailTokens.id, t.id));
  await db.delete(sessions).where(eq(sessions.userId, t.userId)); // sign out everywhere
}

export async function purgeExpiredAuth(db: DbLike, now: Date): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
  await db.delete(emailTokens).where(and(lt(emailTokens.expiresAt, now)));
}

// ───────────────────────────────────────────────────── organisations & membership

export const DEFAULT_ALERT_TYPES = ['low_stock', 'out_of_stock', 'restocked', 'collection_failure'] as const;

/** Creates an empty workspace owned by the user: default settings and alert rules, and nothing else. No websites, products or data are ever pre-filled. */
export async function createOrganization(db: Db, userId: string, name: string): Promise<{ id: string; name: string; slug: string }> {
  const [org] = await db.insert(organizations).values({ name: name.trim(), slug: slugify(name), createdBy: userId }).returning();
  await db.insert(memberships).values({ orgId: org!.id, userId, role: 'owner' });
  await withTenant(db, org!.id, async (tx) => {
    await tx.insert(orgSettings).values({
      orgId: org!.id,
      reportingCurrency: DEFAULTS.reportingCurrency,
      timezone: DEFAULTS.timezone,
      reportReadyTime: DEFAULTS.reportReadyTime,
      lowStockThreshold: DEFAULTS.lowStockThreshold,
      snapshotRetentionDays: DEFAULTS.snapshotRetentionDays,
      historyRetentionDays: DEFAULTS.historyRetentionDays,
    });
    await tx.insert(alertRules).values(DEFAULT_ALERT_TYPES.map((type) => ({ orgId: org!.id, type })));
  });
  return { id: org!.id, name: org!.name, slug: org!.slug };
}

export async function listMemberships(db: DbLike, userId: string): Promise<OrgMembership[]> {
  const rows = await db
    .select({ orgId: organizations.id, name: organizations.name, slug: organizations.slug, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, userId));
  return rows;
}

export async function getMembership(db: DbLike, userId: string, orgId: string): Promise<MemberRole | null> {
  const [m] = await db.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)));
  return m?.role ?? null;
}

/** The caller's role in a workspace, or null for non-members. */
export async function getOrgContext(db: DbLike, userId: string, orgId: string): Promise<{ role: MemberRole } | null> {
  const [m] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)));
  return m ?? null;
}

export async function listMembers(db: DbLike, orgId: string) {
  return db
    .select({ userId: users.id, email: users.email, displayName: users.displayName, role: memberships.role, joinedAt: memberships.createdAt, emailVerified: sql<boolean>`${users.emailVerifiedAt} is not null` })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.orgId, orgId));
}

const RANK: Record<MemberRole, number> = { owner: 3, admin: 2, staff: 1 };
export const roleAtLeast = (role: MemberRole, min: MemberRole) => RANK[role] >= RANK[min];

export async function addMember(db: DbLike, orgId: string, actor: { role: MemberRole }, email: string, role: MemberRole) {
  if (!roleAtLeast(actor.role, 'admin')) throw new AuthError('Only owners and admins can add members.', 'forbidden', 403);
  if (role === 'owner' && actor.role !== 'owner') throw new AuthError('Only an owner can add another owner.', 'forbidden', 403);
  const [u] = await db.select().from(users).where(eq(users.email, normalizeEmail(email)));
  if (!u) throw new AuthError('No account exists for that email yet. Ask them to register first.', 'not_found', 404);
  const [dup] = await db.select().from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, u.id)));
  if (dup) throw new AuthError('That person is already a member.', 'conflict', 409);
  await db.insert(memberships).values({ orgId, userId: u.id, role });
  return { userId: u.id, email: u.email, role };
}

async function ownerCount(db: DbLike, orgId: string) {
  const rows = await db.select().from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.role, 'owner')));
  return rows.length;
}

export async function updateMemberRole(db: DbLike, orgId: string, actor: { role: MemberRole; userId: string }, targetUserId: string, role: MemberRole) {
  if (actor.role !== 'owner') throw new AuthError('Only owners can change roles.', 'forbidden', 403);
  const [m] = await db.select().from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, targetUserId)));
  if (!m) throw new AuthError('Member not found.', 'not_found', 404);
  if (m.role === 'owner' && role !== 'owner' && (await ownerCount(db, orgId)) <= 1) throw new AuthError('A workspace needs at least one owner.', 'conflict', 409);
  await db.update(memberships).set({ role }).where(eq(memberships.id, m.id));
}

export async function removeMember(db: DbLike, orgId: string, actor: { role: MemberRole; userId: string }, targetUserId: string) {
  const [m] = await db.select().from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, targetUserId)));
  if (!m) throw new AuthError('Member not found.', 'not_found', 404);
  const self = actor.userId === targetUserId;
  if (!self && !roleAtLeast(actor.role, 'admin')) throw new AuthError('Only owners and admins can remove members.', 'forbidden', 403);
  if (m.role === 'owner' && !self && actor.role !== 'owner') throw new AuthError('Only an owner can remove an owner.', 'forbidden', 403);
  if (m.role === 'owner' && (await ownerCount(db, orgId)) <= 1) throw new AuthError('A workspace needs at least one owner.', 'conflict', 409);
  await db.delete(memberships).where(eq(memberships.id, m.id));
}
