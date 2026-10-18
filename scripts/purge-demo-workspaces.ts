/**
 * ONE-OFF UPGRADE TOOL for databases created before migration 0008, which removed the demonstration-workspace concept.
 *
 * Earlier versions could create "demo" workspaces holding fictional fixture websites and invented data. Migration 0008 refuses to run while
 * such workspaces exist (it never deletes data on its own). This tool lists them and, only when you pass --yes, deletes them together with
 * everything they own (websites, products, observations, reports, alerts, connections) and their stored page snapshots.
 *
 *   npm run db:purge-demo              # list what would be deleted; changes nothing
 *   npm run db:purge-demo -- --yes     # delete it
 *
 * Real (live) workspaces and user accounts are never touched. On a database without the demo concept it does nothing.
 */
import path from 'node:path';
import pg from 'pg';
import { LocalStorage, loadDotEnv } from '@ci/core';
import { root } from './lib/root.ts';

loadDotEnv(root);
const admin = process.env.DATABASE_ADMIN_URL;
if (!admin) {
  console.error('DATABASE_ADMIN_URL must be set (see .env.example).');
  process.exit(1);
}
const confirmed = process.argv.includes('--yes');
const client = new pg.Client({ connectionString: admin });
await client.connect();
try {
  const hasMode = (await client.query(`select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'mode'`)).rowCount;
  if (!hasMode) {
    console.log('This database has no demo concept (migration 0008 or later is applied). Nothing to do.');
    process.exit(0);
  }

  const orgs = (
    await client.query<{ id: string; name: string; created_at: Date; sites: string; products: string; observations: string; reports: string; members: string }>(`
      select o.id, o.name, o.created_at,
        (select count(*) from sites s where s.org_id = o.id) as sites,
        (select count(*) from products p where p.org_id = o.id) as products,
        (select count(*) from price_observations po where po.org_id = o.id) as observations,
        (select count(*) from reports r where r.org_id = o.id) as reports,
        (select count(*) from memberships m where m.org_id = o.id) as members
      from organizations o where o.mode = 'demo' order by o.created_at`)
  ).rows;

  if (!orgs.length) {
    console.log('No demonstration workspaces exist. Nothing to delete.');
    process.exit(0);
  }

  console.log(`\n${orgs.length} demonstration workspace(s) — fictional data only:\n`);
  for (const o of orgs) {
    console.log(`  • "${o.name}"  created ${o.created_at.toISOString().slice(0, 10)}  —  ${o.sites} websites, ${o.products} products, ${o.observations} price observations, ${o.reports} reports, ${o.members} member(s)`);
  }
  const snapshots = (await client.query<{ ref: string }>(`select e.snapshot_ref as ref from evidence e join organizations o on o.id = e.org_id where o.mode = 'demo' and e.snapshot_ref is not null`)).rows.map((r) => r.ref);
  console.log(`\nStored page snapshots belonging to them: ${snapshots.length}`);
  console.log('User accounts and every non-demo workspace are left untouched.\n');

  if (!confirmed) {
    console.log('Nothing was changed. To delete the workspaces above run:  npm run db:purge-demo -- --yes');
    process.exit(0);
  }

  await client.query('begin');
  const del = await client.query(`delete from organizations where mode = 'demo'`);
  await client.query('commit');
  console.log(`Deleted ${del.rowCount} workspace(s) and everything they owned.`);

  if (process.env.STORAGE_DRIVER === 's3') {
    console.log(`Storage driver is S3: ${snapshots.length} snapshot object(s) were NOT removed. Delete them in the bucket if you need to.`);
  } else {
    const storage = new LocalStorage(path.resolve(root, process.env.STORAGE_LOCAL_DIR ?? '.data/storage'));
    let removed = 0;
    for (const ref of snapshots) {
      try {
        await storage.delete(ref);
        removed++;
      } catch {
        /* a missing or unremovable file is not fatal */
      }
    }
    console.log(`Removed ${removed} stored snapshot file(s).`);
  }
  console.log('You can now run:  npm run db:migrate');
} catch (e) {
  await client.query('rollback').catch(() => {});
  console.error('Failed:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
