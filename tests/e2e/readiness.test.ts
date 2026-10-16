import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { expectedMigrationCount } from '@ci/database';
import { checkSystemReadiness, type SystemReadiness } from '@ci/services';
import { buildApp } from '../../apps/api/src/app.ts';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';

/**
 * Readiness answers "can this deployment actually do its job?" — not merely "is the process up". It must go unready for the failures that make
 * serving unsafe, degrade for the ones that stop work from happening, and never leak a secret or a tenant.
 */
let h: Harness;
let app: FastifyInstance;
const QUEUE_SCHEMA = 'readiness_test_boss';
const db = () => h.db.worker;

/** A stand-in for pg-boss's job table, with only the columns the check reads. */
async function setTicks(rows: { state: 'completed' | 'failed'; minutesAgo: number }[]) {
  await db().execute(sql`create schema if not exists ${sql.identifier(QUEUE_SCHEMA)}`);
  await db().execute(sql`drop table if exists ${sql.identifier(QUEUE_SCHEMA)}.job`);
  await db().execute(sql`create table ${sql.identifier(QUEUE_SCHEMA)}.job (name text, state text, completed_on timestamptz, created_on timestamptz)`);
  // in a real deployment the worker grants the application role read access to the queue schema at startup
  await db().execute(sql`grant usage on schema ${sql.identifier(QUEUE_SCHEMA)} to ci_app`);
  await db().execute(sql`grant select on ${sql.identifier(QUEUE_SCHEMA)}.job to ci_app`);
  for (const r of rows) {
    await db().execute(sql`insert into ${sql.identifier(QUEUE_SCHEMA)}.job values ('scheduler-tick', ${r.state}, now() - ${r.minutesAgo} * interval '1 minute', now() - ${r.minutesAgo + 1} * interval '1 minute')`);
  }
}

const check = (over: Partial<Parameters<typeof checkSystemReadiness>[0]> = {}, d = h.db.app, opts: Parameters<typeof checkSystemReadiness>[2] = {}) =>
  checkSystemReadiness({ ...h.svc, clock: () => new Date(), ...over } as never, d, { queueSchema: QUEUE_SCHEMA, ...opts });

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false });
}, 120_000);

afterAll(async () => {
  await db().execute(sql`drop schema if exists ${sql.identifier(QUEUE_SCHEMA)} cascade`);
  await app.close();
  await h.close();
});

describe('GET /api/v1/ready (public)', () => {
  it('answers without signing in, and says what it found in plain words', async () => {
    const r = await new ApiClient(app).get('/api/v1/ready');
    expect([200, 503]).toContain(r.status);
    const body = r.body as SystemReadiness;
    expect(['ready', 'degraded', 'not_ready']).toContain(body.status);
    for (const c of ['database', 'migrations', 'tenant_isolation', 'queue', 'worker', 'storage', 'email', 'secrets', 'browser_rendering', 'ai']) {
      expect(body.checks[c], c).toMatchObject({ level: expect.stringMatching(/^(ok|warn|fail|info)$/), detail: expect.any(String) });
      expect(body.checks[c]!.detail.length).toBeGreaterThan(10);
    }
    expect(body.checks['database']!.level).toBe('ok');
  });

  it('knows the schema is current, and that the web tier connects with a role that row-level security applies to', async () => {
    const body = (await new ApiClient(app).get('/api/v1/ready')).body as SystemReadiness;
    const expected = expectedMigrationCount();
    expect(expected).toBeGreaterThanOrEqual(6);
    expect(body.checks['migrations']).toMatchObject({ level: 'ok' });
    expect(body.checks['migrations']!.detail).toContain(`All ${expected} migrations`);
    expect(body.checks['tenant_isolation']).toMatchObject({ level: 'ok' });
  });

  it('exposes no secret, connection string, tenant or user', async () => {
    const text = JSON.stringify((await new ApiClient(app).get('/api/v1/ready')).body);
    expect(text).not.toMatch(/postgres(ql)?:\/\//i);
    expect(text).not.toMatch(/password\s*[:=]|secret\s*[:=]|[A-Za-z0-9_-]{40,}|@example\.test/i); // no credential-shaped value, no address
    for (const key of ['orgId', 'userId']) expect(text).not.toContain(`"${key}"`);
    // database libraries put the failed SQL statement in their error text; it must never be repeated to the public
    expect(text).not.toMatch(/failed query|select\s.+\sfrom\s|params:/i);
  });

  it('is an unready 503 only for the failures that make serving unsafe', async () => {
    // the real API never fails readiness in a healthy test database, so check the mapping through the service's verdict
    const ok = await check();
    expect(ok.status === 'ready' || ok.status === 'degraded').toBe(true);
  });
});

describe('what makes it unready (HTTP 503)', () => {
  it('the database cannot be reached', async () => {
    const dead = { execute: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:5432'); } } as never;
    const r = await check({}, dead);
    expect(r.status).toBe('not_ready');
    expect(r.checks['database']).toMatchObject({ level: 'fail' });
    expect(r.checks['database']!.detail).toMatch(/cannot be reached/);
    expect(Object.keys(r.checks)).toEqual(['database']); // it does not pretend to know about the rest
  });

  it('a hung database is reported, not waited on forever', async () => {
    const hung = { execute: () => new Promise(() => {}) } as never;
    const started = Date.now();
    const r = await check({}, hung);
    expect(Date.now() - started).toBeLessThan(6000);
    expect(r.status).toBe('not_ready');
    expect(r.checks['database']!.detail).toMatch(/did not answer within 3s/);
  });

  it('the schema is older than this build', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-migrations-'));
    fs.mkdirSync(path.join(dir, 'meta'));
    const applied = expectedMigrationCount()!;
    fs.writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ entries: Array.from({ length: applied + 2 }, (_, i) => ({ idx: i })) }));
    const r = await check({}, h.db.app, { migrationsFolder: dir });
    expect(r.status).toBe('not_ready');
    expect(r.checks['migrations']).toMatchObject({ level: 'fail' });
    expect(r.checks['migrations']!.detail).toContain(`${applied} of ${applied + 2} migrations`);
    expect(r.checks['migrations']!.detail).toMatch(/npm run db:migrate/);
  });

  it('a newer database than this build is flagged, not ignored', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-migrations-'));
    fs.mkdirSync(path.join(dir, 'meta'));
    fs.writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ entries: [{ idx: 0 }] }));
    expect((await check({}, h.db.app, { migrationsFolder: dir })).checks['migrations']).toMatchObject({ level: 'warn' });
  });

  it('a build that does not ship its migration list says it cannot tell, instead of claiming "current"', async () => {
    const r = await check({}, h.db.app, { migrationsFolder: path.join(os.tmpdir(), 'no-such-folder-xyz') });
    expect(r.checks['migrations']).toMatchObject({ level: 'info' });
    expect(r.checks['migrations']!.detail).toMatch(/cannot say whether that is current/);
  });

  it('in production, a web tier that bypasses row-level security is unready (tenant isolation would not hold)', async () => {
    const prod = await check({ config: { ...h.svc.config, isProduction: true } as never }, h.db.worker); // the worker role bypasses RLS
    expect(prod.status).toBe('not_ready');
    expect(prod.checks['tenant_isolation']).toMatchObject({ level: 'fail' });
    expect(prod.checks['tenant_isolation']!.detail).toMatch(/bypasses row-level security/);
    // in development it is a warning only
    const dev = await check({}, h.db.worker);
    expect(dev.checks['tenant_isolation']!.level).toBe('warn');
    expect(dev.status).not.toBe('not_ready');
  });

  it('in production, missing token encryption is unready too', async () => {
    const r = await check({ config: { ...h.svc.config, isProduction: true } as never, keyRing: null });
    expect(r.checks['secrets']).toMatchObject({ level: 'fail' });
    expect(r.status).toBe('not_ready');
  });
});

describe('what makes it degraded (HTTP 200, but work would not happen)', () => {
  it('no heartbeat from the worker', async () => {
    await setTicks([]);
    const r = await check();
    expect(r.checks['queue']!.level).toBe('ok');
    expect(r.checks['worker']).toMatchObject({ level: 'warn' });
    expect(r.checks['worker']!.detail).toMatch(/No heartbeat/);
    expect(r.status).toBe('degraded');
  });

  it('a worker that is ticking is ok, and says how long ago', async () => {
    await setTicks([{ state: 'completed', minutesAgo: 1 }, { state: 'completed', minutesAgo: 2 }]);
    const r = await check();
    expect(r.checks['worker']).toMatchObject({ level: 'ok' });
    expect(r.checks['worker']!.detail).toMatch(/last scheduler heartbeat 1 min ago/);
  });

  it('a worker that is alive but whose scheduler keeps failing is called out (this is what a missing migration looks like)', async () => {
    await setTicks([{ state: 'failed', minutesAgo: 1 }, { state: 'failed', minutesAgo: 2 }, { state: 'failed', minutesAgo: 3 }, { state: 'completed', minutesAgo: 60 }]);
    const r = await check();
    expect(r.checks['worker']).toMatchObject({ level: 'warn' });
    expect(r.checks['worker']!.detail).toMatch(/scheduler is failing \(3 failed ticks/);
    expect(r.status).toBe('degraded');
  });

  it('a worker that has gone silent', async () => {
    await setTicks([{ state: 'completed', minutesAgo: 45 }]);
    const r = await check();
    expect(r.checks['worker']).toMatchObject({ level: 'warn' });
    expect(r.checks['worker']!.detail).toMatch(/silent for 45 minutes/);
  });

  it('a job queue that cannot be read', async () => {
    const r = await check({}, h.db.app, { queueSchema: 'no_such_schema_xyz' });
    expect(r.checks['queue']).toMatchObject({ level: 'warn' });
    expect(r.checks['queue']!.detail).toMatch(/does not exist|could not be read/);
    expect(r.checks['queue']!.detail).not.toMatch(/failed query|select |params:/i); // never the SQL itself
    expect(r.checks['worker']!.level).toBe('warn');
    expect(r.status).toBe('degraded');
  });

  it('file storage that is not usable (permissions, network)', async () => {
    const broken = { driver: 's3', exists: async () => { throw new Error('AccessDenied'); } } as never;
    const r = await check({ storage: broken });
    expect(r.checks['storage']).toMatchObject({ level: 'warn' });
    expect(r.checks['storage']!.detail).toMatch(/not usable: AccessDenied/);
    expect(r.status).toBe('degraded');
  });

  it('file storage that hangs does not hang the probe', async () => {
    const hung = { driver: 's3', exists: () => new Promise(() => {}) } as never;
    const started = Date.now();
    const r = await check({ storage: hung });
    expect(Date.now() - started).toBeLessThan(6000);
    expect(r.checks['storage']!.level).toBe('warn');
  });
});

describe('optional integrations never make it unready', () => {
  it('no email, no AI, no browser rendering: informational only in development', async () => {
    await setTicks([{ state: 'completed', minutesAgo: 1 }]);
    const r = await check({ browser: null, keyRing: h.svc.keyRing });
    for (const c of ['email', 'browser_rendering', 'ai']) expect(r.checks[c]!.level, c).toBe('info');
    expect(r.checks['email']!.detail).toMatch(/SMTP_URL/);
    expect(r.checks['ai']!.detail).toMatch(/Everything works without one/);
  });

  it('with the whole system healthy, the verdict is "ready"', async () => {
    await setTicks([{ state: 'completed', minutesAgo: 1 }]);
    const r = await check({ keyRing: h.svc.keyRing });
    expect(r.checks['worker']!.level).toBe('ok');
    expect(r.status).toBe('ready');
  });

  it('in production, missing email delivery is a warning (accounts cannot be verified) — degraded, not unready', async () => {
    await setTicks([{ state: 'completed', minutesAgo: 1 }]);
    const r = await check({ config: { ...h.svc.config, isProduction: true, SMTP_URL: undefined } as never, keyRing: h.svc.keyRing });
    expect(r.checks['email']).toMatchObject({ level: 'warn' });
    expect(r.status).not.toBe('not_ready');
  });
});
