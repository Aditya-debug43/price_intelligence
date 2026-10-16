import { loadConfig, loadDotEnv } from '@ci/core';
import { createDb, createPool } from '@ci/database';
import { PlaywrightRenderer, SafeFetcher } from '@ci/connectors';
import { OutboxMailer, PgBossQueue, consoleLogger, createBoss, createServices, ensureFxRates, fetchPolicyFrom, grantQueueAccess, installShutdown, registerWorkers, releaseActiveScans } from '@ci/services';

loadDotEnv();
const config = loadConfig();
const log = consoleLogger(config.LOG_LEVEL, { app: 'worker' });

// The worker is the only process with the cross-tenant (BYPASSRLS) role. It always passes organisation ids explicitly.
const pool = createPool(config.workerDatabaseUrl, { applicationName: 'ci-worker', max: 12 });
const db = createDb(pool);
const boss = await createBoss(config.workerDatabaseUrl, log, 'ci-worker');
await grantQueueAccess(pool).catch((e) => log.warn('could not grant queue access to the API role (does ci_app exist?)', { error: (e as Error).message }));
const queue = new PgBossQueue(boss);

const svc = createServices(config, db, {
  queue,
  log,
  mailerFactory: (base) => new OutboxMailer(db, () => queue, { smtpUrl: config.SMTP_URL, from: config.EMAIL_FROM }, base.log),
});

// Optional headless-browser rendering for JavaScript-only sites. Expensive work like this stays in the worker.
if (config.BROWSER_RENDERING_ENABLED) {
  const renderer = new PlaywrightRenderer(new SafeFetcher(fetchPolicyFrom(config), { limiter: svc.limiter }), { allowLoopback: false /* a headless browser never reaches loopback, not even for demo fixtures */, channel: config.BROWSER_CHANNEL, executablePath: config.BROWSER_EXECUTABLE_PATH });
  const ok = await renderer.init();
  if (ok) svc.browser = renderer;
  log[ok ? 'info' : 'warn'](ok ? 'browser rendering enabled' : 'browser rendering requested but no browser could be launched (install Chrome/Edge or run `npx playwright-core install chromium`)');
}

await ensureFxRates(svc);
await registerWorkers(boss, svc, { schedulerEnabled: true });
log.info('worker ready', { env: config.NODE_ENV, schedulerMode: config.SCHEDULER_MODE, ai: svc.llm.available ? svc.llm.id : 'none', browser: !!svc.browser?.available });

installShutdown({
  name: 'worker',
  log,
  forceAfterMs: 35_000,
  stop: async () => {
    // Stop taking new jobs and give running ones a moment; a collection can take hours, so whatever is still running is handed back to
    // the scheduler (it resumes from its saved cursor within about a minute) rather than being left to time out.
    await boss.stop({ graceful: true, timeout: 20_000 }).catch(() => {});
    const released = await releaseActiveScans(svc).catch(() => []);
    if (released.length) log.info('released in-flight collections for resumption', { scans: released.length });
    await svc.browser?.close().catch(() => {});
    await pool.end();
  },
});
