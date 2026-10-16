import { loadDotEnv } from '@ci/core';
import { runMigrations } from '@ci/database';

loadDotEnv();
const admin = process.env.DATABASE_ADMIN_URL;
if (!admin) {
  console.error('DATABASE_ADMIN_URL must be set (see .env.example).');
  process.exit(1);
}
await runMigrations(admin);
console.log('Migrations applied.');
