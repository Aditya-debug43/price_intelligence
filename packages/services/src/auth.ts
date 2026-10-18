import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, ne, sql } from 'drizzle-orm';
import { hashPassword, randomToken, sha256Hex, verifyPassword } from '@ci/core';
import { DEFAULTS, type MemberRole } from '@ci/shared';
import {
  alertRules,
  emailOutbox,
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
import { accountExistsEmail, resetEmail, verificationEmail } from './mailer.ts';

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_credentials' | 'locked' | 'email_taken' | 'weak_password' | 'unverified' | 'invalid_token' | 'forbidden' | 'not_found' | 'conflict' | 'wrong_account' | 'email_not_configured',
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

const TOKEN_THROTTLE_MS = 60_000;
const VERIFY_TOKEN_TTL_MS = 48 * 3_600_000;
const RESET_TOKEN_TTL_MS = 3_600_000;

/** A real account cannot be created, verified or recovered without a working way to email its owner. Say so instead of pretending. */
function requireEmail(svc: Services): void {
  if (!svc.mailer.configured) {
    throw new AuthError(
      'This server cannot send email yet, and an account must be verified by email. The administrator needs to configure SMTP (see docs/integrations.md), then try again.',
      'email_not_configured',
      503,
    );
  }
}

export type RegisterOutcome = { created: true; user: SessionUser } | { created: false };

/**
 * Creates an unverified account and emails the verification link. The caller is told the same thing whether or not the address was already
 * registered (the real owner of an existing address gets an "you already have an account" email instead), so registration cannot be used to
 * find out who has an account.
 */
export async function registerAccount(svc: Services, db: DbLike, input: { email: string; password: string; displayName: string }): Promise<RegisterOutcome> {
  const email = normalizeEmail(input.email);
  const weak = checkPasswordStrength(input.password, email);
  if (weak) throw new AuthError(weak, 'weak_password');
  requireEmail(svc);
  const passwordHash = await hashPassword(input.password); // always done, so the response time does not reveal an existing account
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) {
    await notifyAccountExists(svc, db, existing);
    return { created: false };
  }
  let u;
  try {
    [u] = await db.insert(users).values({ email, passwordHash, displayName: input.displayName.trim() }).returning();
  } catch (e) {
    // Two registrations for one address raced: the loser behaves like any other duplicate.
    if ((e as { code?: string; cause?: { code?: string } }).code === '23505' || (e as { cause?: { code?: string } }).cause?.code === '23505') return { created: false };
    throw e;
  }
  await sendVerification(svc, db, u!);
  return { created: true, user: { id: u!.id, email: u!.email, displayName: u!.displayName, emailVerified: false } };
}

/** Same as registerAccount, but a duplicate address is an error. For code that needs the new user (tests, internal callers); the API uses registerAccount. */
export async function register(svc: Services, db: DbLike, input: { email: string; password: string; displayName: string }): Promise<SessionUser> {
  const r = await registerAccount(svc, db, input);
  if (!r.created) throw new AuthError('An account with this email already exists.', 'email_taken', 409);
  return r.user;
}

async function notifyAccountExists(svc: Services, db: DbLike, u: { id: string; email: string; displayName: string }): Promise<void> {
  // At most one such notice an hour per address, so registering over and over cannot be used to flood someone's inbox.
  const [recent] = await db
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(and(eq(emailOutbox.kind, 'account-exists'), eq(emailOutbox.relatedId, u.id), gt(emailOutbox.createdAt, sql`now() - interval '1 hour'`)));
  if (recent) return;
  const m = accountExistsEmail(u.displayName, `${svc.config.APP_BASE_URL}/login`, `${svc.config.APP_BASE_URL}/forgot`);
  await svc.mailer.queue(db, { orgId: null, to: [u.email], subject: m.subject, html: m.html, text: m.text, kind: 'account-exists', relatedId: u.id });
}

/** Issues a fresh single-use link (older unused ones stop working) and emails it. At most one a minute per account. */
async function issueToken(svc: Services, db: DbLike, userId: string, kind: 'verify' | 'reset'): Promise<string | null> {
  const now = svc.clock();
  const [recent] = await db
    .select({ id: emailTokens.id })
    .from(emailTokens)
    .where(and(eq(emailTokens.userId, userId), eq(emailTokens.kind, kind), gt(emailTokens.createdAt, new Date(now.getTime() - TOKEN_THROTTLE_MS))));
  if (recent) return null;
  await db.update(emailTokens).set({ usedAt: now }).where(and(eq(emailTokens.userId, userId), eq(emailTokens.kind, kind), isNull(emailTokens.usedAt)));
  const token = randomToken(32);
  await db.insert(emailTokens).values({ userId, kind, tokenHash: sha256Hex(token), createdAt: now, expiresAt: new Date(now.getTime() + (kind === 'verify' ? VERIFY_TOKEN_TTL_MS : RESET_TOKEN_TTL_MS)) });
  return token;
}

async function sendVerification(svc: Services, db: DbLike, u: { id: string; email: string; displayName: string }): Promise<void> {
  const token = await issueToken(svc, db, u.id, 'verify');
  if (!token) return;
  const m = verificationEmail(u.displayName, `${svc.config.APP_BASE_URL}/verify-email?token=${token}`);
  await svc.mailer.queue(db, { orgId: null, to: [u.email], subject: m.subject, html: m.html, text: m.text, kind: 'verify-email', relatedId: u.id });
}

/** "Send the verification email again". Answers the same way for unknown, verified and unverified addresses. */
export async function resendVerification(svc: Services, db: DbLike, emailRaw: string): Promise<void> {
  requireEmail(svc);
  const [u] = await db.select().from(users).where(eq(users.email, normalizeEmail(emailRaw)));
  if (u && !u.emailVerifiedAt) await sendVerification(svc, db, u);
}

export async function verifyEmail(svc: Services, db: DbLike, token: string): Promise<void> {
  const [t] = await db.select().from(emailTokens).where(and(eq(emailTokens.tokenHash, sha256Hex(token)), eq(emailTokens.kind, 'verify')));
  if (!t || t.usedAt || t.expiresAt < svc.clock()) throw new AuthError('This verification link is invalid or has expired. Request a new one from the sign-in page.', 'invalid_token');
  await db.update(emailTokens).set({ usedAt: svc.clock() }).where(eq(emailTokens.id, t.id));
  await db.update(users).set({ emailVerifiedAt: svc.clock() }).where(and(eq(users.id, t.userId), isNull(users.emailVerifiedAt)));
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
  // Signing in needs a verified address — always, whether or not this server can currently send the verification email.
  if (!u.emailVerifiedAt) throw new AuthError('Please verify your email address before signing in. Check your inbox for the verification link, or ask for a new one.', 'unverified', 403);
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
  requireEmail(svc);
  const [u] = await db.select().from(users).where(eq(users.email, normalizeEmail(emailRaw)));
  if (!u) return; // identical outcome for unknown emails: no enumeration
  const token = await issueToken(svc, db, u.id, 'reset');
  if (!token) return;
  const m = resetEmail(u.displayName, `${svc.config.APP_BASE_URL}/reset-password?token=${token}`);
  await svc.mailer.queue(db, { orgId: null, to: [u.email], subject: m.subject, html: m.html, text: m.text, kind: 'password-reset', relatedId: u.id });
}

export async function resetPassword(svc: Services, db: DbLike, token: string, newPassword: string): Promise<void> {
  const [t] = await db.select().from(emailTokens).where(and(eq(emailTokens.tokenHash, sha256Hex(token)), eq(emailTokens.kind, 'reset')));
  if (!t || t.usedAt || t.expiresAt < svc.clock()) throw new AuthError('This reset link is invalid or has expired. Request a new one.', 'invalid_token');
  const [u] = await db.select().from(users).where(eq(users.id, t.userId));
  const weak = checkPasswordStrength(newPassword, u?.email);
  if (weak) throw new AuthError(weak, 'weak_password');
  // The link only ever reached the person through their inbox, so using it also proves the address is theirs.
  await db.update(users).set({ passwordHash: await hashPassword(newPassword), failedLogins: 0, lockedUntil: null, emailVerifiedAt: u?.emailVerifiedAt ?? svc.clock() }).where(eq(users.id, t.userId));
  await db.update(emailTokens).set({ usedAt: svc.clock() }).where(eq(emailTokens.id, t.id));
  await db.delete(sessions).where(eq(sessions.userId, t.userId)); // sign out everywhere
}

/** Changes the password of a signed-in user (who must supply the current one) and signs every other session out. */
export async function changePassword(svc: Services, db: DbLike, userId: string, currentSessionId: string, current: string, next: string): Promise<void> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || !(await verifyPassword(current, u.passwordHash))) throw new AuthError('The current password is incorrect.', 'invalid_credentials', 403);
  const weak = checkPasswordStrength(next, u.email);
  if (weak) throw new AuthError(weak, 'weak_password');
  await db.update(users).set({ passwordHash: await hashPassword(next), failedLogins: 0, lockedUntil: null }).where(eq(users.id, userId));
  await db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, currentSessionId)));
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
