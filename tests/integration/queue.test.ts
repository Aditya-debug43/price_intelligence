import { CaptureTransport } from '../support/mail.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { MemoryStorage, generateKeyRingSpec, loadConfig } from '@ci/core';
import { emailOutbox } from '@ci/database';
import { OutboxMailer, PgBossQueue, createBoss, createProducerBoss, createServices, grantQueueAccess, registerWorkers, silentLogger, type Services } from '@ci/services';
import { connectTestDb, seedOrg, type TestDb } from '../support/db.ts';

let db: TestDb;
let worker: PgBoss;
let producer: PgBoss;
let svc: Services;
let queue: PgBossQueue;

const until = async (fn: () => Promise<boolean>, ms = 15_000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

beforeAll(async () => {
  const urls = inject('testDb');
  db = connectTestDb();
  // worker owns the queue schema and grants the API role enqueue-only access
  worker = await createBoss(urls.workerUrl, silentLogger, 'test-worker');
  await grantQueueAccess(db.admin);
  // the API-side producer connects as the RLS-enforced role: no BYPASSRLS credential in the web tier
  producer = await createProducerBoss(urls.appUrl, silentLogger, 5);
  queue = new PgBossQueue(worker);
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: urls.appUrl, WORKER_DATABASE_URL: urls.workerUrl, TOKEN_ENCRYPTION_KEY: generateKeyRingSpec('q1'), LOG_LEVEL: 'silent' } as unknown as NodeJS.ProcessEnv);
  svc = createServices(config, db.worker, { storage: new MemoryStorage(), queue, log: silentLogger, mailerFactory: (b) => new OutboxMailer(db.worker, () => queue, { smtp: null, from: config.emailFrom, transport: new CaptureTransport() }, b.log) });
  await registerWorkers(worker, svc, { schedulerEnabled: false });
}, 120_000);

afterAll(async () => {
  await producer?.stop({ graceful: false, close: true }).catch(() => {});
  await worker?.stop({ graceful: false, close: true }).catch(() => {});
  await db.close();
});

describe('background queue (pg-boss on PostgreSQL)', () => {
  it('creates one queue per job type', async () => {
    const names = (await worker.getQueues()).map((q) => q.name);
    for (const n of ['scan-site', 'profile-site', 'generate-report', 'daily-assemble', 'send-email', 'scheduler-tick', 'retention']) expect(names).toContain(n);
  });

  it('a job enqueued by the RLS-only API role is executed by the worker', async () => {
    const { org } = await seedOrg(db.worker, 'Queue');
    const [mail] = await db.worker.insert(emailOutbox).values({ orgId: org.id, toAddresses: ['x@example.test'], subject: 'queued', html: '<p>x</p>', text: 'x', kind: 'test' }).returning();
    const id = await new PgBossQueue(producer).enqueue('send-email', { id: mail!.id }, { singletonKey: `email:${mail!.id}` });
    expect(id).toBeTruthy();
    const done = await until(async () => (await db.worker.select().from(emailOutbox).where(eq(emailOutbox.id, mail!.id)))[0]!.status === 'sent');
    expect(done).toBe(true);
  });

  it('collapses duplicate jobs that share a singleton key while one is queued', async () => {
    const q = new PgBossQueue(producer);
    const key = `dup:${Date.now()}`;
    // far-future start so the job stays queued while we try to enqueue its twin
    const first = await q.enqueue('retention', {}, { singletonKey: key, startAfterSeconds: 3600 });
    const second = await q.enqueue('retention', {}, { singletonKey: key, startAfterSeconds: 3600 });
    expect(first).toBeTruthy();
    expect(second).toBeNull();
  });

  it('the API role can enqueue but still cannot read tenant data (row-level security holds)', async () => {
    const { org } = await seedOrg(db.worker, 'Hidden');
    const { sites } = await import('@ci/database');
    await db.worker.insert(sites).values({ orgId: org.id, url: 'https://hidden.example.test/', origin: 'https://hidden.example.test', hostname: 'hidden.example.test', name: 'Hidden', role: 'competitor' });
    expect(await db.app.select().from(sites)).toEqual([]);
  });

  it('failed jobs are retried with the queue policy rather than lost', async () => {
    const q = await worker.getQueue('send-email');
    expect(q).toMatchObject({ retryLimit: 5 });
  });
});
