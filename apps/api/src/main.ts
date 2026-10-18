import { loadConfig, loadDotEnv } from '@ci/core';
import { createDb, createPool } from '@ci/database';
import { OutboxMailer, PgBossQueue, consoleLogger, createProducerBoss, createServices, installShutdown } from '@ci/services';
import { buildApp } from './app.ts';

loadDotEnv();
const config = loadConfig();
const log = consoleLogger(config.LOG_LEVEL, { app: 'api' });

// The API connects as the RLS-enforced role. It cannot read another tenant's rows, even with a buggy query.
const pool = createPool(config.DATABASE_URL, { applicationName: 'ci-api', max: 12 });
const rootDb = createDb(pool);

// Producer-only queue client: the API enqueues background work; the worker executes it.
const boss = await createProducerBoss(config.DATABASE_URL, log);
const queue = new PgBossQueue(boss);
const svc = createServices(config, rootDb, {
  queue,
  log,
  mailerFactory: (base) => new OutboxMailer(rootDb, () => queue, { smtpUrl: config.SMTP_URL, from: config.EMAIL_FROM }, base.log),
});

const app = await buildApp({ svc, rootDb });
await app.listen({ host: config.API_HOST, port: config.API_PORT });
log.info('API listening', { host: config.API_HOST, port: config.API_PORT, env: config.NODE_ENV });

installShutdown({
  name: 'api',
  log,
  forceAfterMs: 15_000,
  stop: async () => {
    await app.close(); // stops accepting connections and lets in-flight requests finish
    await boss.stop({ graceful: true, timeout: 5000 }).catch(() => {});
    await pool.end();
  },
});
