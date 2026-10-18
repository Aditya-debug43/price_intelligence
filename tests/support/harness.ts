import { inject } from 'vitest';
import { MemoryStorage, generateKeyRingSpec, loadConfig } from '@ci/core';
import { DomainLimiter, SafeFetcher } from '@ci/connectors';
import { emailOutbox, orgSettings, withTenant, type Db } from '@ci/database';
import {
  InlineQueue,
  OutboxMailer,
  consoleLogger,
  createServices,
  fetchPolicyFrom,
  register,
  verifyEmail,
  createOrganization,
  addSite,
  setConsent,
  silentLogger,
  type Services,
} from '@ci/services';
import { connectTestDb, type TestDb } from './db.ts';
import { startFixtureServer, type FixtureServer } from './fixtures/server.ts';
import { CaptureTransport } from './mail.ts';

/**
 * TEST-ONLY. Builds the product's real services against an isolated PostgreSQL, with fictional websites standing in for the internet.
 *
 * The product's own rules stay fully in force: the fetcher uses the production fetch policy (loopback refused), website addresses go
 * through the production public-host check, and the fictional sites are ordinary-looking public hostnames ("mine.test", "rival-woo.test").
 * Only the final network hop is replaced, by `fixtures.transport`.
 */
export interface Harness {
  db: TestDb;
  svc: Services;
  queue: InlineQueue;
  storage: MemoryStorage;
  fixtures: FixtureServer;
  /** The test mail server: every email the product sends lands here, like an inbox (after `queue.drain()` runs the send jobs). */
  mail: CaptureTransport;
  /** Move the shared clock. All services — and the fictional sites — read time through it. */
  setNow(d: Date | string): void;
  advance(ms: number): void;
  emails(): Promise<(typeof emailOutbox.$inferSelect)[]>;
  /** Registers a verified user, creates an organisation and returns RLS-scoped helpers. */
  newTenant(label?: string): Promise<Tenant>;
  close(): Promise<void>;
}

export interface Tenant {
  userId: string;
  email: string;
  orgId: string;
  /** Run a function inside the tenant's RLS-enforced transaction (what the API does). */
  tx<T>(fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>): Promise<T>;
  /** Adds one of the fictional sites (by its fixture key) to this tenant's workspace and, by default, records the customer's confirmation. */
  addFixtureSite(key: string, role: 'source' | 'competitor', consent?: boolean): Promise<string>;
}

let seq = 0;

export async function createHarness(opts: { now?: string; extraEnv?: Record<string, string>; /** 'none' = a server with no mail server configured. */ mail?: 'capture' | 'none'; /** The real internet: real DNS, the production fetch policy and pacing, the real clock — no fictional websites involved. Only for the live test procedure. */ real?: boolean } = {}): Promise<Harness> {
  const urls = inject('testDb');
  const db = connectTestDb();
  const storage = new MemoryStorage();
  let now = new Date(opts.now ?? '2026-10-14T12:00:00Z');
  const fixtures = await startFixtureServer({ now: () => now });
  const queue = new InlineQueue();
  const mail = new CaptureTransport();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: urls.appUrl,
    WORKER_DATABASE_URL: urls.workerUrl,
    TOKEN_ENCRYPTION_KEY: generateKeyRingSpec('t1'),
    APP_BASE_URL: 'http://localhost:5173',
    COLLECTOR_DEFAULT_DELAY_MS: opts.real ? '1500' : '250',
    LOG_LEVEL: process.env.TEST_LOG ? 'debug' : 'silent',
    ...(opts.extraEnv ?? {}),
  } as unknown as NodeJS.ProcessEnv);
  const log = process.env.TEST_LOG ? consoleLogger('debug') : silentLogger;
  const limiter = new DomainLimiter({ delayMs: 0, maxConcurrency: 4 }, Date.now, async () => {});
  const svc = createServices(config, db.worker, {
    storage,
    queue,
    log,
    ...(opts.real
      ? {} // real clock, real pacing, real DNS, the production fetch policy
      : {
          clock: () => now,
          limiter,
          // Every ".test" name is "public"; anything else resolves to a private address, so the production host screening refuses it.
          resolver: async (host: string) => (host.endsWith('.test') ? [{ address: '93.184.216.34' }] : [{ address: '10.0.0.7' }]),
          makeFetcher: (over: { maxRetries?: number } | undefined) => new SafeFetcher({ ...fetchPolicyFrom(config), maxRetries: 1, timeoutMs: 8000, ...(over ?? {}) }, { limiter, resolver: fixtures.resolver, transport: fixtures.transport }),
        }),
    mailerFactory: (base) => new OutboxMailer(db.worker, () => queue, { smtp: config.smtp, from: config.emailFrom, ...(opts.mail === 'none' ? {} : { transport: mail }) }, base.log),
  });
  queue.svc = svc;

  const h: Harness = {
    db,
    svc,
    queue,
    storage,
    fixtures,
    mail,
    setNow: (d) => void (now = new Date(d)),
    advance: (ms) => void (now = new Date(now.getTime() + ms)),
    emails: () => db.worker.select().from(emailOutbox),
    async newTenant(label = 'Shop') {
      const email = `${label.toLowerCase().replace(/\W+/g, '')}-${++seq}-${Date.now()}@example.test`;
      const password = 'Correct-Horse-9-Battery';
      const user = await register(svc, db.app, { email, password, displayName: `${label} Owner` });
      await queue.drain(); // delivers the verification email
      await verifyEmail(svc, db.app, mail.tokenIn(email, 'verify-email')!); // the person opens the emailed link
      const org = await createOrganization(db.app, user.id, `${label} Org ${seq}`);
      const tenant: Tenant = {
        userId: user.id,
        email,
        orgId: org.id,
        tx: (fn) => withTenant(db.app, org.id, fn),
        async addFixtureSite(key, role, consent = true) {
          const site = await tenant.tx((tx) => addSite(svc, tx, org.id, user.id, { url: fixtures.origin(key), role, name: fixtures.sites[key]!.spec.label }));
          if (consent) await tenant.tx((tx) => setConsent(svc, tx, org.id, user.id, site.id, { status: 'confirmed', attest: true, note: 'test' }));
          return site.id;
        },
      };
      return tenant;
    },
    async close() {
      // The scheduler is global: it visits every organisation in the (shared) test database. A finished test file must not leave
      // schedulable organisations behind for the next file's scheduler pass to start collections for.
      await db.worker.update(orgSettings).set({ scheduleEnabled: false });
      await fixtures.close();
      await db.close();
    },
  };
  return h;
}

export type { Db };
