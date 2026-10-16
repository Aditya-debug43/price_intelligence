import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import { POST_MIGRATE_SQL } from './post-migrate.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_FOLDER = path.resolve(here, '../migrations');

/** How many migrations this build expects to be applied; null when the migrations folder is not shipped alongside the code. */
export function expectedMigrationCount(folder?: string): number | null {
  // From source the folder sits next to src/; from a bundled build (apps/*/dist/main.js) it does not, so the repository layout is tried too.
  const candidates = folder ? [folder] : [MIGRATIONS_FOLDER, path.resolve(process.cwd(), 'packages/database/migrations'), path.resolve(process.cwd(), 'migrations')];
  for (const c of candidates) {
    try {
      const journal = JSON.parse(fs.readFileSync(path.join(c, 'meta', '_journal.json'), 'utf8')) as { entries?: unknown[] };
      if (Array.isArray(journal.entries)) return journal.entries.length;
    } catch {
      /* try the next place */
    }
  }
  return null;
}

/** Applies versioned Drizzle migrations, then the idempotent RLS/grant SQL. Uses an owner/admin connection. */
export async function runMigrations(adminUrl: string, opts: { migrationsFolder?: string } = {}): Promise<void> {
  const pool = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    const db = drizzle(pool);
    await drizzleMigrate(db, { migrationsFolder: opts.migrationsFolder ?? MIGRATIONS_FOLDER });
    await pool.query(POST_MIGRATE_SQL);
  } finally {
    await pool.end();
  }
}

export interface RoleSetupOptions {
  adminUrl: string;
  appPassword: string;
  workerPassword: string;
}

/**
 * Creates (or updates the passwords of) the two application roles. Requires a role that can CREATE ROLE and
 * BYPASSRLS (a superuser in local dev). Safe to run repeatedly.
 */
export async function setupRoles(opts: RoleSetupOptions): Promise<void> {
  const pool = new pg.Pool({ connectionString: opts.adminUrl, max: 1 });
  const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  try {
    for (const [name, password, bypass] of [
      ['ci_app', opts.appPassword, false],
      ['ci_worker', opts.workerPassword, true],
    ] as const) {
      const exists = await pool.query('select 1 from pg_roles where rolname = $1', [name]);
      const attrs = `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ${bypass ? 'BYPASSRLS' : 'NOBYPASSRLS'} PASSWORD ${quote(password)}`;
      await pool.query(exists.rowCount ? `ALTER ROLE ${name} ${attrs}` : `CREATE ROLE ${name} ${attrs}`);
    }
    const { rows } = await pool.query<{ db: string }>('select current_database() as db');
    for (const role of ['ci_app', 'ci_worker']) {
      await pool.query(`GRANT CONNECT ON DATABASE "${rows[0]!.db}" TO ${role}`);
      // pg-boss creates its own schema; the worker/API roles need to be able to do that.
      if (role === 'ci_worker') await pool.query(`GRANT CREATE ON DATABASE "${rows[0]!.db}" TO ${role}`);
    }
  } finally {
    await pool.end();
  }
}
