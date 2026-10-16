import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

/**
 * Real PostgreSQL (not an emulation) started from npm-distributed binaries, so local development and the
 * automated tests need neither Docker nor a system installation. Production uses a managed/Docker Postgres.
 */
export interface EmbeddedPgHandle {
  port: number;
  adminPassword: string;
  /** Superuser connection string for the given database. */
  adminUrl(database?: string): string;
  createDatabase(name: string): Promise<void>;
  stop(): Promise<void>;
}

export interface EmbeddedPgOptions {
  dataDir: string;
  port: number;
  persistent: boolean;
  /** Reuse the password stored next to a persistent data dir instead of generating a new one. */
  passwordFile?: string;
  quiet?: boolean;
}

export async function startEmbeddedPostgres(opts: EmbeddedPgOptions): Promise<EmbeddedPgHandle> {
  let password: string;
  if (opts.passwordFile && existsSync(opts.passwordFile)) password = readFileSync(opts.passwordFile, 'utf8').trim();
  else {
    password = randomBytes(18).toString('base64url');
    if (opts.passwordFile) {
      mkdirSync(path.dirname(opts.passwordFile), { recursive: true });
      writeFileSync(opts.passwordFile, password, { mode: 0o600 });
    }
  }

  const server = new EmbeddedPostgres({
    databaseDir: opts.dataDir,
    user: 'postgres',
    password,
    port: opts.port,
    persistent: opts.persistent,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: opts.quiet ? () => {} : (m) => process.stdout.write(`[postgres] ${String(m)}`),
    onError: opts.quiet ? () => {} : (m) => process.stderr.write(`[postgres] ${String(m)}`),
  });

  if (!existsSync(path.join(opts.dataDir, 'PG_VERSION'))) await server.initialise();
  await server.start();

  const adminUrl = (database = 'postgres') =>
    `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${opts.port}/${database}`;

  return {
    port: opts.port,
    adminPassword: password,
    adminUrl,
    async createDatabase(name: string) {
      const c = new pg.Client({ connectionString: adminUrl('postgres') });
      await c.connect();
      try {
        const r = await c.query('select 1 from pg_database where datname = $1', [name]);
        if (!r.rowCount) await c.query(`CREATE DATABASE "${name.replace(/"/g, '')}" ENCODING 'UTF8' TEMPLATE template0`);
      } finally {
        await c.end();
      }
    },
    async stop() {
      await server.stop();
    },
  };
}

export async function findFreePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
