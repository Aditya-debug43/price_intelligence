import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveSmtp, SmtpConfigError, type SmtpSettings } from './smtp.ts';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().default(4000),
  CORS_ORIGIN: optionalString,
  SERVE_WEB: bool.default(false),

  // Database: the API connects as a role subject to Row-Level Security, the worker as a role that bypasses it.
  DATABASE_URL: z.string().min(1),
  WORKER_DATABASE_URL: optionalString,
  DATABASE_ADMIN_URL: optionalString,

  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  SESSION_COOKIE_SECURE: bool.optional(),
  TOKEN_ENCRYPTION_KEY: optionalString,

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('.data/storage'),
  S3_BUCKET: optionalString,
  S3_REGION: optionalString,
  S3_ENDPOINT: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,

  // Email delivery (verification, password reset, invitations, daily reports, alerts). Not configured = no email is sent and the product says so.
  // For Gmail: SMTP_HOST=smtp.gmail.com, SMTP_PORT=587 (or 465 with SMTP_SECURE=true), SMTP_USER=<the Gmail address>, SMTP_PASSWORD=<a Google App Password>.
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SMTP_SECURE: bool.optional(),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  /** The From header, "Display name <address>". Defaults to "Shelfwatch <SMTP_USER>". */
  EMAIL_FROM: optionalString,


  COLLECTOR_USER_AGENT: z.string().default('CompetitorIntelBot/1.0 (+https://example.invalid/bot; respects robots.txt)'),
  COLLECTOR_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  COLLECTOR_MAX_HTML_BYTES: z.coerce.number().int().default(3 * 1024 * 1024),
  COLLECTOR_MAX_JSON_BYTES: z.coerce.number().int().default(12 * 1024 * 1024),
  COLLECTOR_MAX_PDF_BYTES: z.coerce.number().int().default(20 * 1024 * 1024),
  COLLECTOR_DEFAULT_DELAY_MS: z.coerce.number().int().min(250).default(1500),
  COLLECTOR_DEFAULT_MAX_REQUESTS: z.coerce.number().int().min(10).default(2000),
  BROWSER_RENDERING_ENABLED: bool.default(false),
  /** Which installed browser to drive: "chrome" (default), "msedge", or an explicit executable path for Chromium. */
  BROWSER_CHANNEL: z.string().default('chrome'),
  BROWSER_EXECUTABLE_PATH: z.string().optional(),

  RETENTION_SNAPSHOT_DAYS: z.coerce.number().int().min(1).default(90),
  RETENTION_HISTORY_DAYS: z.coerce.number().int().min(30).default(365),

  FX_PROVIDER: z.enum(['peg', 'open-er-api']).default('peg'),

  AI_PROVIDER: z.enum(['none', 'anthropic']).default('none'),
  ANTHROPIC_API_KEY: optionalString,
  AI_MODEL: z.string().default('claude-haiku-5-5'),

  YOUTUBE_API_KEY: optionalString,
  META_APP_ID: optionalString,
  META_APP_SECRET: optionalString,
  META_ACCESS_TOKEN: optionalString,
  META_INSTAGRAM_BUSINESS_ACCOUNT_ID: optionalString,

  SHOPIFY_CLIENT_ID: optionalString,
  SHOPIFY_CLIENT_SECRET: optionalString,
  SHOPIFY_SCOPES: z.string().default('read_products,read_inventory,read_locations'),
  SHOPIFY_API_VERSION: z.string().default('2026-07'),
  SHOPIFY_REDIRECT_URI: optionalString,
});

export type AppConfig = z.infer<typeof envSchema> & {
  secureCookies: boolean;
  workerDatabaseUrl: string;
  isProduction: boolean;
  /** Resolved email settings, or null when email delivery is not configured. */
  smtp: SmtpSettings | null;
  /** The From header actually used (the configured one, or a placeholder shown when email is not configured). */
  emailFrom: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Loads `.env` from the repo root (if present) without overriding real environment variables. */
export function loadDotEnv(startDir = process.cwd()): void {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        /* ignore malformed .env; validation below reports missing values */
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // An empty value in .env ("KEY=") means "not set", so defaults and optional fields apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}\nSee .env.example for the full list.`);
  }
  const c = parsed.data;
  const isProduction = c.NODE_ENV === 'production';

  if (isProduction) {
    const problems: string[] = [];
    if (!c.TOKEN_ENCRYPTION_KEY) problems.push('TOKEN_ENCRYPTION_KEY is required in production');
    if (!c.WORKER_DATABASE_URL) problems.push('WORKER_DATABASE_URL is required in production (the worker needs a role that can span tenants)');
    // Verification, reset and invitation links in emails are built from this address: a localhost or plain-http link would be useless or unsafe.
    if (!/^https:\/\//i.test(c.APP_BASE_URL) || /^https:\/\/(localhost|127\.|\[::1\])/i.test(c.APP_BASE_URL)) {
      problems.push('APP_BASE_URL must be the public https:// address of the app in production (it is used inside verification, password-reset and invitation emails)');
    }
    if (problems.length) throw new ConfigError(`Unsafe production configuration:\n  - ${problems.join('\n  - ')}`);
  }
  if (c.STORAGE_DRIVER === 's3' && (!c.S3_BUCKET || !c.S3_REGION)) {
    throw new ConfigError('STORAGE_DRIVER=s3 requires S3_BUCKET and S3_REGION');
  }
  if (c.AI_PROVIDER === 'anthropic' && !c.ANTHROPIC_API_KEY) {
    throw new ConfigError('AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY (or set AI_PROVIDER=none)');
  }

  let smtp: SmtpSettings | null;
  try {
    smtp = resolveSmtp(c);
  } catch (e) {
    if (e instanceof SmtpConfigError) throw new ConfigError(`Invalid email configuration: ${e.message}`);
    throw e;
  }
  return {
    ...c,
    smtp,
    emailFrom: smtp?.from ?? c.EMAIL_FROM ?? 'Shelfwatch <not-configured@invalid>',
    isProduction,
    secureCookies: c.SESSION_COOKIE_SECURE ?? isProduction,
    workerDatabaseUrl: c.WORKER_DATABASE_URL ?? c.DATABASE_URL,
  };
}
