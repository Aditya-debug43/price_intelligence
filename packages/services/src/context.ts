import dns from 'node:dns';
import path from 'node:path';
import { redact, LocalStorage, NullLlmProvider, parseKeyRing, type AppConfig, type KeyRing, type LlmProvider, type StorageAdapter } from '@ci/core';
import type { Db } from '@ci/database';
import { AnthropicProvider, DomainLimiter, SafeFetcher, type BrowserRenderer, type HttpJson } from '@ci/connectors';
import type { Mailer } from './mailer.ts';

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** JSON-lines logger that always passes metadata through secret redaction. */
export function consoleLogger(level: string = 'info', bindings: Record<string, unknown> = {}): Logger {
  const min = Math.max(0, LEVELS.indexOf(level as (typeof LEVELS)[number]));
  const make = (lvl: (typeof LEVELS)[number], i: number) => (msg: string, meta?: Record<string, unknown>) => {
    if (level === 'silent' || i < min) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...bindings, ...(meta ? (redact(meta) as object) : {}) });
    (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return { debug: make('debug', 0), info: make('info', 1), warn: make('warn', 2), error: make('error', 3) };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export const JOB_NAMES = [
  'profile-site',
  'scan-site',
  'match-products',
  'sync-inventory',
  'sync-social',
  'generate-report',
  'send-email',
  'retention',
  'scheduler-tick',
  'daily-assemble',
  'refresh-fx',
  'integration-event',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

export interface EnqueueOptions {
  /** Jobs with the same key are collapsed while one is queued/active (idempotent enqueue). */
  singletonKey?: string;
  startAfterSeconds?: number;
  priority?: number;
}

export interface JobQueue {
  enqueue(name: JobName, data: object, opts?: EnqueueOptions): Promise<string | null>;
}

export interface Services {
  config: AppConfig;
  /** Worker-role connection (BYPASSRLS). Request-time code uses the tenant transaction it is handed instead. */
  db: Db;
  storage: StorageAdapter;
  keyRing: KeyRing | null;
  clock: () => Date;
  queue: JobQueue;
  limiter: DomainLimiter;
  llm: LlmProvider;
  mailer: Mailer;
  log: Logger;
  browser: BrowserRenderer | null;
  /** DNS resolution used to vet customer-submitted hostnames (overridable in tests). */
  resolver: (host: string) => Promise<{ address: string }[]>;
  /** HTTP used for the official social-provider APIs (YouTube, Meta). Undefined = real network; tests inject local imitations. */
  socialHttp?: HttpJson;
  /** Creates an SSRF-safe, robots-respecting fetcher sharing the process-wide per-domain limiter. */
  makeFetcher(over?: { maxRetries?: number }): SafeFetcher;
}

export interface ServiceOverrides {
  storage?: StorageAdapter;
  clock?: () => Date;
  queue?: JobQueue;
  llm?: LlmProvider;
  log?: Logger;
  browser?: BrowserRenderer | null;
  limiter?: DomainLimiter;
  mailer?: Mailer;
  makeFetcher?: Services['makeFetcher'];
  resolver?: Services['resolver'];
  socialHttp?: HttpJson;
}

export function createLlm(config: AppConfig): LlmProvider {
  if (config.AI_PROVIDER === 'anthropic' && config.ANTHROPIC_API_KEY) return new AnthropicProvider(config.ANTHROPIC_API_KEY, config.AI_MODEL);
  return new NullLlmProvider();
}

export function createStorage(config: AppConfig, root = process.cwd()): StorageAdapter {
  if (config.STORAGE_DRIVER === 's3') {
    // Loaded lazily so local development never needs the AWS SDK.
    return new LazyS3Storage(config);
  }
  return new LocalStorage(path.resolve(root, config.STORAGE_LOCAL_DIR));
}

class LazyS3Storage implements StorageAdapter {
  readonly driver = 's3';
  private impl: Promise<StorageAdapter> | null = null;
  constructor(private readonly config: AppConfig) {}
  private load(): Promise<StorageAdapter> {
    this.impl ??= import('./s3-storage.ts').then((m) => new m.S3Storage(this.config));
    return this.impl;
  }
  async put(key: string, data: Buffer | string, contentType?: string) {
    return (await this.load()).put(key, data, contentType);
  }
  async get(key: string) {
    return (await this.load()).get(key);
  }
  async delete(key: string) {
    return (await this.load()).delete(key);
  }
  async exists(key: string) {
    return (await this.load()).exists(key);
  }
}

export function fetchPolicyFrom(config: AppConfig) {
  return {
    userAgent: config.COLLECTOR_USER_AGENT,
    timeoutMs: config.COLLECTOR_TIMEOUT_MS,
    maxHtmlBytes: config.COLLECTOR_MAX_HTML_BYTES,
    maxJsonBytes: config.COLLECTOR_MAX_JSON_BYTES,
    maxPdfBytes: config.COLLECTOR_MAX_PDF_BYTES,
    // Loopback, private and internal addresses are never reachable: no setting exists that allows them.
    allowLoopback: false,
  };
}

export function createServices(config: AppConfig, db: Db, overrides: ServiceOverrides & { mailerFactory?: (s: Omit<Services, 'mailer'>) => Mailer }): Services {
  const limiter = overrides.limiter ?? new DomainLimiter({ delayMs: config.COLLECTOR_DEFAULT_DELAY_MS, maxConcurrency: 2 });
  const base: Omit<Services, 'mailer'> = {
    config,
    db,
    storage: overrides.storage ?? createStorage(config),
    keyRing: config.TOKEN_ENCRYPTION_KEY ? parseKeyRing(config.TOKEN_ENCRYPTION_KEY) : null,
    clock: overrides.clock ?? (() => new Date()),
    queue: overrides.queue ?? { enqueue: async () => null },
    limiter,
    llm: overrides.llm ?? createLlm(config),
    log: overrides.log ?? consoleLogger(config.LOG_LEVEL),
    browser: overrides.browser ?? null,
    resolver: overrides.resolver ?? ((host) => dns.promises.lookup(host, { all: true, verbatim: true })),
    ...(overrides.socialHttp ? { socialHttp: overrides.socialHttp } : {}),
    makeFetcher: overrides.makeFetcher ?? ((over) => new SafeFetcher({ ...fetchPolicyFrom(config), ...(over ?? {}) }, { limiter })),
  };
  const mailer = overrides.mailer ?? overrides.mailerFactory?.(base);
  if (!mailer) throw new Error('createServices requires a mailer or mailerFactory');
  return { ...base, mailer };
}
