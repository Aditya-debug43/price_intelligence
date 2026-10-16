/**
 * Starts a persistent local PostgreSQL (embedded binaries — no Docker needed), provisions the database, the two
 * application roles, applies migrations, and generates a `.env` with random secrets if none exists.
 * Leave it running; Ctrl+C stops the database cleanly.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateKeyRingSpec } from '@ci/core';
import { runMigrations, setupRoles } from '@ci/database';
import { startEmbeddedPostgres } from './lib/embedded-pg.ts';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(root, '.data', 'postgres');
const PORT = Number(process.env.DEV_DB_PORT ?? 54329);
const DB = 'competitor_intel';

function ensureEnvFile(adminPassword: string) {
  const envPath = path.join(root, '.env');
  if (existsSync(envPath)) return { created: false, text: readFileSync(envPath, 'utf8') };
  const template = readFileSync(path.join(root, '.env.example'), 'utf8');
  const appPw = randomBytes(18).toString('base64url');
  const workerPw = randomBytes(18).toString('base64url');
  const set = (text: string, key: string, value: string) =>
    text.match(new RegExp(`^${key}=.*$`, 'm')) ? text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`) : `${text}\n${key}=${value}\n`;
  let text = template;
  text = set(text, 'DATABASE_URL', `postgres://ci_app:${appPw}@127.0.0.1:${PORT}/${DB}`);
  text = set(text, 'WORKER_DATABASE_URL', `postgres://ci_worker:${workerPw}@127.0.0.1:${PORT}/${DB}`);
  text = set(text, 'DATABASE_ADMIN_URL', `postgres://postgres:${encodeURIComponent(adminPassword)}@127.0.0.1:${PORT}/${DB}`);
  text = set(text, 'TOKEN_ENCRYPTION_KEY', generateKeyRingSpec('k1'));
  writeFileSync(envPath, text, { mode: 0o600 });
  return { created: true, text };
}

const pgHandle = await startEmbeddedPostgres({
  dataDir,
  port: PORT,
  persistent: true,
  passwordFile: path.join(root, '.data', 'postgres.admin-password'),
});
await pgHandle.createDatabase(DB);
const env = ensureEnvFile(pgHandle.adminPassword);
const get = (k: string) => env.text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
const appPw = decodeURIComponent(new URL(get('DATABASE_URL')).password);
const workerPw = decodeURIComponent(new URL(get('WORKER_DATABASE_URL')).password);

await setupRoles({ adminUrl: pgHandle.adminUrl(DB), appPassword: appPw, workerPassword: workerPw });
await runMigrations(pgHandle.adminUrl(DB));

console.log('\n──────────────────────────────────────────────');
console.log(`PostgreSQL ready on 127.0.0.1:${PORT}  (database "${DB}")`);
console.log(env.created ? 'Generated .env with random local secrets (not committed).' : 'Using existing .env.');
console.log('Next, in other terminals:  npm run demo:fixtures  (fictional demo data)  then  npm run dev:demo  — or  npm run dev  for your own websites.');
console.log('Press Ctrl+C to stop the database.');
console.log('──────────────────────────────────────────────\n');

const shutdown = async () => {
  console.log('Stopping PostgreSQL…');
  await pgHandle.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
setInterval(() => {}, 1 << 30);
