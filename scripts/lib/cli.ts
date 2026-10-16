import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { MemoryStorage, loadConfig, loadDotEnv, type AppConfig } from '@ci/core';
import { createDb, createPool, type Db } from '@ci/database';
import { InlineQueue, OutboxMailer, consoleLogger, createServices, register, createOrganization, type Services } from '@ci/services';
import { eq } from 'drizzle-orm';
import { users, memberships, organizations } from '@ci/database';

export const root = path.resolve(import.meta.dirname, '..', '..');
const CRED_FILE = path.join(root, '.data', 'dev-credentials.json');

export interface Cli {
  config: AppConfig;
  db: Db;
  svc: Services;
  queue: InlineQueue;
  close(): Promise<void>;
}

/** Services for scripts: worker-role DB, in-process queue (jobs run when `queue.drain()` is called), real storage. */
export async function openCli(overrides: Record<string, string> = {}): Promise<Cli> {
  loadDotEnv(root);
  Object.assign(process.env, { ALLOW_LOCAL_FIXTURES: process.env.ALLOW_LOCAL_FIXTURES ?? 'true', ...overrides });
  const config = loadConfig();
  const pool = createPool(config.workerDatabaseUrl, { applicationName: 'ci-script', max: 6 });
  const db = createDb(pool);
  const queue = new InlineQueue();
  const log = consoleLogger(process.env.LOG_LEVEL ?? 'warn');
  const svc = createServices(config, db, { queue, log, mailerFactory: (b) => new OutboxMailer(db, () => queue, { smtpUrl: config.SMTP_URL, from: config.EMAIL_FROM }, b.log) });
  queue.svc = svc;
  void MemoryStorage;
  return { config, db, svc, queue, close: () => pool.end() };
}

export interface DevCredentials {
  email: string;
  password: string;
  createdAt: string;
}

export function readCredentials(): DevCredentials | null {
  return existsSync(CRED_FILE) ? (JSON.parse(readFileSync(CRED_FILE, 'utf8')) as DevCredentials) : null;
}

/**
 * Creates the local development user once, with a RANDOM password written to a git-ignored file.
 * No default or hard-coded administrator password exists anywhere in the code.
 */
export async function ensureDevUser(cli: Cli): Promise<{ id: string; email: string; password: string | null; created: boolean }> {
  const existing = readCredentials();
  const email = existing?.email ?? 'owner@localhost.test';
  const [u] = await cli.db.select().from(users).where(eq(users.email, email));
  if (u) return { id: u.id, email, password: existing?.password ?? null, created: false };
  const password = `${randomBytes(9).toString('base64url')}-${randomBytes(3).toString('hex')}Aa1`;
  const created = await register(cli.svc, cli.db, { email, password, displayName: 'Local Owner' });
  mkdirSync(path.dirname(CRED_FILE), { recursive: true });
  writeFileSync(CRED_FILE, JSON.stringify({ email, password, createdAt: new Date().toISOString() } satisfies DevCredentials, null, 2), { mode: 0o600 });
  await cli.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, created.id));
  return { id: created.id, email, password, created: true };
}

/** `mode` is fixed at creation: the fictional fixture demo uses 'demo'; anything meant for real use stays 'live' (the default). */
export async function ensureOrg(cli: Cli, userId: string, name: string, mode: 'live' | 'demo' = 'live'): Promise<string> {
  const rows = await cli.db.select({ id: organizations.id }).from(organizations).innerJoin(memberships, eq(memberships.orgId, organizations.id)).where(eq(memberships.userId, userId));
  const found = await cli.db.select().from(organizations).where(eq(organizations.name, name));
  const mine = found.find((o) => rows.some((r) => r.id === o.id));
  if (mine) return mine.id;
  return (await createOrganization(cli.db, userId, name, { mode })).id;
}
