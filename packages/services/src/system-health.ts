import { sql } from 'drizzle-orm';
import { expectedMigrationCount, type DbLike } from '@ci/database';
import type { Services } from './context.ts';

/**
 * Is this deployment actually able to do its job? Used by `GET /api/v1/ready` (for load balancers, orchestrators and operators).
 * Every check says what it found in plain words; nothing here exposes a secret, a tenant, or a connection string.
 *
 *  - NOT READY (HTTP 503): the database cannot be reached, its schema is older than this build, or the web tier connects with a
 *    role that bypasses row-level security (tenant isolation would not hold).
 *  - DEGRADED (HTTP 200): the site can serve pages, but something that matters is wrong — the background worker is silent or failing,
 *    the job queue is unreachable, or file storage is not usable. Collection and reports would not run.
 *  - READY: everything above is fine. Optional integrations that are simply not configured never make the service unready.
 */
export type CheckLevel = 'ok' | 'warn' | 'fail' | 'info';

export interface ReadinessCheck {
  level: CheckLevel;
  detail: string;
}

export interface SystemReadiness {
  status: 'ready' | 'degraded' | 'not_ready';
  time: string;
  version: string;
  checks: Record<string, ReadinessCheck>;
}

const STALE_TICK_MS = 3 * 60_000;
const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000}s`)), ms))]);

export async function checkSystemReadiness(svc: Pick<Services, 'config' | 'clock' | 'storage' | 'keyRing' | 'llm' | 'browser'>, db: DbLike, opts: { version?: string; migrationsFolder?: string; queueSchema?: string } = {}): Promise<SystemReadiness> {
  const checks: Record<string, ReadinessCheck> = {};
  const now = svc.clock();
  const prod = svc.config.isProduction;

  // database
  try {
    await withTimeout(db.execute(sql`select 1`), 3000, 'The database');
    checks['database'] = { level: 'ok', detail: 'The database answers.' };
  } catch (e) {
    checks['database'] = { level: 'fail', detail: `The database cannot be reached: ${safeReason(e)}` };
    return finish(checks, now, opts.version);
  }

  // schema version
  const expected = expectedMigrationCount(opts.migrationsFolder);
  try {
    const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    const applied = r.rows[0]?.n ?? 0;
    if (expected === null) checks['migrations'] = { level: 'info', detail: `${applied} migrations are applied; this build does not ship its migration list, so it cannot say whether that is current.` };
    else if (applied < expected) checks['migrations'] = { level: 'fail', detail: `The database schema is out of date: ${applied} of ${expected} migrations are applied. Run the migrations (npm run db:migrate) before serving traffic.` };
    else if (applied > expected) checks['migrations'] = { level: 'warn', detail: `The database has ${applied} migrations but this build knows ${expected}: a newer version has been deployed against it.` };
    else checks['migrations'] = { level: 'ok', detail: `All ${expected} migrations are applied.` };
  } catch (e) {
    checks['migrations'] = { level: 'warn', detail: `The applied migrations could not be read (${safeReason(e)}). Re-run the migrations so the application role may read them.` };
  }

  // tenant isolation really is enforced for this connection
  try {
    const r = await db.execute<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(sql`select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user`);
    const role = r.rows[0];
    if (!role) checks['tenant_isolation'] = { level: 'warn', detail: 'The database role of this connection could not be inspected.' };
    else if (role.rolsuper || role.rolbypassrls) {
      checks['tenant_isolation'] = { level: prod ? 'fail' : 'warn', detail: `The web tier connects as "${role.rolname}", which bypasses row-level security. Customer data would not be isolated by the database. Use the restricted application role (see docs/deployment.md).` };
    } else checks['tenant_isolation'] = { level: 'ok', detail: 'The web tier connects with a role that row-level security applies to.' };
  } catch (e) {
    checks['tenant_isolation'] = { level: 'warn', detail: `Could not check the database role: ${safeReason(e)}` };
  }

  // job queue + background worker
  try {
    const r = await db.execute<{ last_ok: Date | null; last_failed: Date | null; failed_recent: number; ticks: number }>(sql`
      select max(completed_on) filter (where state = 'completed') as last_ok,
             max(completed_on) filter (where state = 'failed') as last_failed,
             count(*) filter (where state = 'failed' and completed_on > now() - interval '10 minutes')::int as failed_recent,
             count(*)::int as ticks
      from ${sql.identifier(opts.queueSchema ?? 'pgboss')}.job where name = 'scheduler-tick' and created_on > now() - interval '1 day'`);
    checks['queue'] = { level: 'ok', detail: 'The job queue is reachable.' };
    const row = r.rows[0];
    const lastOk = row?.last_ok ? new Date(row.last_ok) : null;
    const lastFailed = row?.last_failed ? new Date(row.last_failed) : null;
    const age = (d: Date) => Math.max(0, Math.round((now.getTime() - d.getTime()) / 60_000));
    if (!row || row.ticks === 0) {
      checks['worker'] = { level: 'warn', detail: 'No heartbeat from the background worker has been seen in the last day. If it is not running, nothing is collected and no report is built. Start it with: npm run dev (or the worker container).' };
    } else if (lastOk && now.getTime() - lastOk.getTime() <= STALE_TICK_MS) {
      checks['worker'] = { level: 'ok', detail: `The background worker is running (last scheduler heartbeat ${age(lastOk)} min ago).` };
    } else if (lastFailed && now.getTime() - lastFailed.getTime() <= STALE_TICK_MS) {
      checks['worker'] = { level: 'warn', detail: `The background worker is running but its scheduler is failing (${row.failed_recent} failed ticks in the last 10 minutes). Scheduled collection and reports are not running. Check the worker log.` };
    } else {
      const last = lastOk ?? lastFailed;
      checks['worker'] = { level: 'warn', detail: `The background worker has been silent for ${last ? `${age(last)} minutes` : 'a long time'}. Scheduled collection and reports are not running.` };
    }
  } catch (e) {
    checks['queue'] = { level: 'warn', detail: `The job queue could not be read (${safeReason(e)}). Starting collections and reports will fail until the worker has set it up.` };
    checks['worker'] = { level: 'warn', detail: 'The background worker’s heartbeat could not be read.' };
  }

  // file storage (read-only probe: reachability and permission, nothing is written)
  try {
    await withTimeout(svc.storage.exists('.readiness-probe'), 3000, 'File storage');
    checks['storage'] = { level: 'ok', detail: `File storage (${svc.storage.driver}) is usable.` };
  } catch (e) {
    checks['storage'] = { level: 'warn', detail: `File storage (${svc.storage.driver}) is not usable: ${safeReason(e)}. Report exports and saved page copies will fail.` };
  }

  // optional capabilities — informational, never a reason to be unready
  checks['email'] = svc.config.SMTP_URL
    ? { level: 'ok', detail: 'Email delivery is configured; accounts must verify their address before signing in.' }
    : { level: prod ? 'warn' : 'info', detail: 'No email delivery is configured: report emails and alert emails go to the development outbox, and new accounts stay unverified. Set SMTP_URL for real delivery.' };
  checks['secrets'] = svc.keyRing
    ? { level: 'ok', detail: 'A token encryption key is configured, so authorised connections can be stored.' }
    : { level: prod ? 'fail' : 'info', detail: 'TOKEN_ENCRYPTION_KEY is not set: authorised connections (such as Shopify) cannot be stored.' };
  checks['browser_rendering'] = { level: 'info', detail: svc.browser?.available ? 'Browser rendering is available for JavaScript-only websites.' : 'Browser rendering is not enabled: websites that need JavaScript to show products cannot be collected.' };
  checks['ai'] = { level: 'info', detail: svc.llm.available ? 'An AI provider is configured for optional summaries; every number is still checked against the stored records.' : 'No AI provider is configured. Everything works without one.' };

  return finish(checks, now, opts.version);
}

function finish(checks: Record<string, ReadinessCheck>, now: Date, version = '0.1.0'): SystemReadiness {
  const levels = Object.values(checks).map((c) => c.level);
  const status = levels.includes('fail') ? 'not_ready' : levels.includes('warn') ? 'degraded' : 'ready';
  return { status, time: now.toISOString(), version, checks };
}

/**
 * A short, safe reason for a failure. Database libraries put the whole failed SQL statement into their error text; a public endpoint must
 * never repeat that, so only the database's own one-line message (or a generic phrase) is used.
 */
export function safeReason(e: unknown): string {
  const cause = (e as { cause?: { message?: unknown } } | null)?.cause;
  const first = (s: unknown) => (typeof s === 'string' ? (s.split('\n')[0] ?? '').trim().slice(0, 200) : '');
  const fromCause = first(cause?.message);
  if (fromCause) return fromCause;
  const m = first((e as Error | null)?.message);
  if (!m || /^failed query/i.test(m) || /\b(select|insert|update|delete)\b.+\bfrom\b/i.test(m)) return 'a database query failed';
  return m;
}
