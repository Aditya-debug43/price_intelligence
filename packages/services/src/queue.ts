import { PgBoss, type Job } from 'pg-boss';
import { JOB_NAMES, type EnqueueOptions, type JobName, type JobQueue, type Logger, type Services } from './context.ts';
import { JOB_HANDLERS } from './jobs.ts';

/** Per-queue retry/timeout policy. `short` collapses duplicate queued jobs that share a singletonKey. */
const QUEUE_OPTIONS: Record<JobName, { expireInSeconds: number; retryLimit: number; retryDelay: number }> = {
  'profile-site': { expireInSeconds: 10 * 60, retryLimit: 1, retryDelay: 30 },
  'scan-site': { expireInSeconds: 6 * 3600, retryLimit: 3, retryDelay: 60 },
  'match-products': { expireInSeconds: 20 * 60, retryLimit: 2, retryDelay: 30 },
  'sync-inventory': { expireInSeconds: 20 * 60, retryLimit: 2, retryDelay: 60 },
  'sync-social': { expireInSeconds: 20 * 60, retryLimit: 1, retryDelay: 120 },
  'generate-report': { expireInSeconds: 30 * 60, retryLimit: 1, retryDelay: 30 },
  'send-email': { expireInSeconds: 5 * 60, retryLimit: 5, retryDelay: 60 },
  retention: { expireInSeconds: 60 * 60, retryLimit: 1, retryDelay: 300 },
  'scheduler-tick': { expireInSeconds: 5 * 60, retryLimit: 0, retryDelay: 0 },
  'daily-assemble': { expireInSeconds: 30 * 60, retryLimit: 2, retryDelay: 60 },
  'refresh-fx': { expireInSeconds: 5 * 60, retryLimit: 2, retryDelay: 300 },
  'integration-event': { expireInSeconds: 5 * 60, retryLimit: 3, retryDelay: 30 },
};

export class PgBossQueue implements JobQueue {
  constructor(private readonly boss: PgBoss) {}
  async enqueue(name: JobName, data: object, opts: EnqueueOptions = {}): Promise<string | null> {
    return this.boss.send(name, data, {
      ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}),
      ...(opts.startAfterSeconds ? { startAfter: opts.startAfterSeconds } : {}),
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    });
  }
}

export async function createBoss(connectionString: string, log: Logger, applicationName: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema: 'pgboss', application_name: applicationName, max: 6 });
  boss.on('error', (e: Error) => log.error('queue error', { error: e.message }));
  await boss.start();
  for (const name of JOB_NAMES) {
    await boss.createQueue(name, { policy: 'short', ...QUEUE_OPTIONS[name] });
  }
  return boss;
}

/** Registers a handler per queue and the recurring jobs (scheduler tick, retention, FX refresh). */
export async function registerWorkers(boss: PgBoss, svc: Services, opts: { concurrency?: Partial<Record<JobName, number>>; schedulerEnabled?: boolean } = {}): Promise<void> {
  const concurrency: Record<JobName, number> = {
    'profile-site': 3, 'scan-site': 3, 'match-products': 1, 'sync-inventory': 2, 'sync-social': 1, 'generate-report': 1, 'send-email': 3, retention: 1, 'scheduler-tick': 1, 'daily-assemble': 1, 'refresh-fx': 1, 'integration-event': 2,
    ...(opts.concurrency ?? {}),
  };
  for (const name of JOB_NAMES) {
    await boss.work(name, { localConcurrency: concurrency[name], pollingIntervalSeconds: name === 'scan-site' ? 2 : 3 }, async (jobs: Job<object>[]) => {
      for (const job of jobs) {
        const started = Date.now();
        try {
          await JOB_HANDLERS[name](svc, job.data as never);
          svc.log.debug('job done', { name, id: job.id, ms: Date.now() - started });
        } catch (e) {
          svc.log.error('job failed', { name, id: job.id, retry: job.retryCount, error: (e as Error).message });
          throw e;
        }
      }
    });
  }
  if (opts.schedulerEnabled !== false) {
    // Cron runs in UTC; the handler itself is timezone-aware per workspace, so a one-minute tick is all that is needed.
    await boss.schedule('scheduler-tick', '* * * * *', {}, { key: 'default' });
    await boss.schedule('retention', '17 6 * * *', {}, { key: 'default' });
    if (svc.config.FX_PROVIDER === 'open-er-api') await boss.schedule('refresh-fx', '5 */12 * * *', {}, { key: 'default' });
  }
}

// ───────────────────────────────────────────────────────────── in-memory queue (tests / dev scripts)

interface Pending {
  name: JobName;
  data: object;
  key?: string;
}

/**
 * Deterministic queue used by automated tests: jobs are recorded, de-duplicated by singletonKey while queued,
 * and run only when `drain()` is called, so a whole pipeline can be stepped through without timers.
 */
export class InlineQueue implements JobQueue {
  readonly pending: Pending[] = [];
  readonly history: { name: JobName; data: object; ok: boolean; error?: string }[] = [];
  svc: Services | null = null;
  async enqueue(name: JobName, data: object, opts: EnqueueOptions = {}): Promise<string | null> {
    if (opts.singletonKey && this.pending.some((p) => p.name === name && p.key === opts.singletonKey)) return null;
    this.pending.push({ name, data, key: opts.singletonKey });
    return `inline-${this.history.length + this.pending.length}`;
  }
  /** Runs queued jobs (including ones they enqueue) until none remain. Failures are recorded, not thrown. */
  async drain(limit = 500): Promise<void> {
    for (let i = 0; i < limit && this.pending.length; i++) {
      const job = this.pending.shift()!;
      try {
        await JOB_HANDLERS[job.name](this.svc!, job.data as never);
        this.history.push({ name: job.name, data: job.data, ok: true });
      } catch (e) {
        this.history.push({ name: job.name, data: job.data, ok: false, error: (e as Error).message });
      }
    }
  }
  ran(name: JobName) {
    return this.history.filter((h) => h.name === name);
  }
}

// ───────────────────────────────────────────────────────────── least-privilege queue access for the API

/**
 * The web tier must not hold the cross-tenant (BYPASSRLS) credential. Instead the worker, which owns the `pgboss`
 * schema, grants the RLS-enforced `ci_app` role just enough access to ENQUEUE jobs. Run by the worker at startup.
 */
export async function grantQueueAccess(workerPool: { query: (sql: string) => Promise<unknown> }, appRole = 'ci_app'): Promise<void> {
  const q = (s: string) => workerPool.query(s);
  await q(`GRANT USAGE ON SCHEMA pgboss TO ${appRole}`);
  await q(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ${appRole}`);
  await q(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO ${appRole}`);
  await q(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO ${appRole}`);
  await q(`ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole}`);
  await q(`ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO ${appRole}`);
  await q(`ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT EXECUTE ON FUNCTIONS TO ${appRole}`);
}

/** Producer-only pg-boss client for the API: it never migrates, maintains, schedules or works jobs. */
export async function createProducerBoss(connectionString: string, log: Logger, attempts = 30): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema: 'pgboss', application_name: 'ci-api', max: 3, migrate: false, supervise: false, schedule: false, createSchema: false });
  boss.on('error', (e: Error) => log.error('queue error', { error: e.message }));
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await boss.start();
      return boss;
    } catch (e) {
      lastErr = e;
      log.warn('queue not ready yet (is the worker running?)', { error: (e as Error).message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}
