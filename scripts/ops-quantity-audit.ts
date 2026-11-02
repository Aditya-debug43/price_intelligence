/**
 * The quantity-compatibility policy against the pairs already stored (core/quantity-policy.ts). Products that hold different actual quantities are left out of price comparison.
 *
 *   npx tsx scripts/ops-quantity-audit.ts                   read-only report for every workspace: how many stored pairs differ, which of them a person or the matcher confirmed
 *   npx tsx scripts/ops-quantity-audit.ts --apply           also record the result on each pair (price_exclusion, price_excluded_at, quantity_check) and in the pair's history
 *   npx tsx scripts/ops-quantity-audit.ts --before-migration  read-only on a database that does not have the policy columns yet
 *   add  --org "<workspace name>"  to look at one workspace
 *
 * `--apply` writes ONLY those policy fields. A pair's status, relationship, decision, decision note, author and time are never touched, and no pair is created or deleted. Running it twice
 * changes nothing the second time. On the server (environment from the service's own file; nothing is printed from it):
 *   sudo bash -c 'cd /opt/shelfwatch/app && set -a && . /etc/shelfwatch/shelfwatch.env && node_modules/.bin/tsx scripts/ops-quantity-audit.ts'
 */
import { sql } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '@ci/core';
import { createDb, createPool, organizations } from '@ci/database';
import { auditStoredPairs } from '@ci/services';

loadDotEnv();
const config = loadConfig();
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const legacy = args.includes('--before-migration');
const only = args.includes('--org') ? args[args.indexOf('--org') + 1] : undefined;
if (apply && legacy) {
  console.error('--apply needs the policy columns: run it after the migration');
  process.exit(1);
}

const pool = createPool(config.workerDatabaseUrl, { applicationName: 'ci-quantity-audit', max: 2 });
const db = createDb(pool);
const orgs = (await db.select({ id: organizations.id, name: organizations.name }).from(organizations)).filter((o) => !only || o.name === only);
for (const o of orgs) {
  // a read-only audit runs in a read-only transaction: the database itself refuses a write
  const audit = await db.transaction(async (tx) => {
    if (!apply) await tx.execute(sql`set transaction read only`);
    return auditStoredPairs(tx as never, o.id, { apply, markers: !legacy });
  });
  console.log(`\n== ${o.name}`);
  console.log(JSON.stringify({ ...audit, examples: undefined }, null, 1));
  for (const e of audit.examples) console.log(`  [${e.status}${e.relationship ? ', ' + e.relationship : ''}] ${e.a}  <->  ${e.b}\n      ${e.note}`);
}
await pool.end();
