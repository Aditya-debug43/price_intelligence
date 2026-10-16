import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations, setupRoles } from '@ci/database';
import { findFreePort, startEmbeddedPostgres } from '../../scripts/lib/embedded-pg.ts';

export interface TestDbUrls {
  adminUrl: string;
  appUrl: string;
  workerUrl: string;
  embedded: boolean;
}

declare module 'vitest' {
  export interface ProvidedContext {
    testDb: TestDbUrls;
  }
}

/**
 * Integration tests run against a REAL PostgreSQL with the real migrations and the real RLS-enforcing role.
 * By default an embedded Postgres is started on a free port; set TEST_DATABASE_ADMIN_URL to use an external server
 * (a throw-away database is created inside it and dropped afterwards).
 */
export default async function setup(project: TestProject) {
  const appPw = randomBytes(12).toString('hex');
  const workerPw = randomBytes(12).toString('hex');
  let stop: () => Promise<void> = async () => {};
  let adminBase: (db: string) => string;
  const dbName = `ci_test_${randomBytes(4).toString('hex')}`;
  let embedded = true;
  let hostPort: string;

  const external = process.env.TEST_DATABASE_ADMIN_URL;
  if (external) {
    embedded = false;
    const u = new URL(external);
    hostPort = u.host;
    adminBase = (db) => {
      const x = new URL(external);
      x.pathname = `/${db}`;
      return x.toString();
    };
    const c = new pg.Client({ connectionString: adminBase('postgres') });
    await c.connect();
    await c.query(`CREATE DATABASE "${dbName}"`);
    await c.end();
    stop = async () => {
      const d = new pg.Client({ connectionString: adminBase('postgres') });
      await d.connect();
      await d.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await d.end();
    };
  } else {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ci-pg-'));
    const port = await findFreePort();
    const handle = await startEmbeddedPostgres({ dataDir: path.join(dir, 'data'), port, persistent: true, quiet: true });
    await handle.createDatabase(dbName);
    hostPort = `127.0.0.1:${port}`;
    adminBase = (db) => handle.adminUrl(db);
    stop = async () => {
      await handle.stop();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      } catch {
        /* temp dir cleanup is best-effort on Windows */
      }
    };
  }

  const adminUrl = adminBase(dbName);
  await setupRoles({ adminUrl, appPassword: appPw, workerPassword: workerPw });
  await runMigrations(adminUrl);

  project.provide('testDb', {
    adminUrl,
    appUrl: `postgres://ci_app:${appPw}@${hostPort}/${dbName}`,
    workerUrl: `postgres://ci_worker:${workerPw}@${hostPort}/${dbName}`,
    embedded,
  });

  return async () => {
    await stop();
  };
}
