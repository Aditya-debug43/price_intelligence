/**
 * Provisions the application roles (ci_app: RLS-enforced, ci_worker: BYPASSRLS) and applies migrations using
 * DATABASE_ADMIN_URL. Run once per environment (and again after pulling new migrations: `npm run db:migrate`).
 */
import { loadDotEnv } from '@ci/core';
import { runMigrations, setupRoles } from '@ci/database';

loadDotEnv();
const admin = process.env.DATABASE_ADMIN_URL;
const app = process.env.DATABASE_URL;
const worker = process.env.WORKER_DATABASE_URL;
if (!admin || !app || !worker) {
  console.error('DATABASE_ADMIN_URL, DATABASE_URL and WORKER_DATABASE_URL must be set (see .env.example).');
  process.exit(1);
}
const pw = (u: string) => decodeURIComponent(new URL(u).password);

await setupRoles({ adminUrl: admin, appPassword: pw(app), workerPassword: pw(worker) });
await runMigrations(admin);
console.log('Roles ready and migrations applied.');
