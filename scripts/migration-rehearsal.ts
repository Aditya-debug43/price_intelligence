/**
 * MIGRATION REHEARSAL on a COPY of a local database. The original is never opened, started or changed.
 *
 *   npx tsx scripts/migration-rehearsal.ts --out <directory> [--source .data/postgres] [--export]
 *
 * It copies the data directory, starts the copy on its own port, applies every pending migration, and then proves that the migration was
 * additive: row counts of every table are the same before and after, every existing match decision is byte-for-byte unchanged, and the new columns
 * are empty (null / false) on old rows. With --export it also writes one JSON dataset per workspace (the rows the matcher reads, plus the decisions
 * people made) for scripts/match-eval.ts. The copy is deleted at the end unless --keep is given.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { runMigrations } from '@ci/database';
import { startEmbeddedPostgres } from './lib/embedded-pg.ts';
import { root } from './lib/root.ts';

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const out = arg('out');
if (!out) { console.error('usage: tsx scripts/migration-rehearsal.ts --out <directory> [--source .data/postgres] [--export] [--keep]'); process.exit(1); }
const source = path.resolve(root, arg('source', '.data/postgres')!);
const copy = path.resolve(out, 'pgcopy');
const DB = 'competitor_intel';
if (!existsSync(path.join(source, 'PG_VERSION'))) { console.error(`No PostgreSQL data directory at ${source}`); process.exit(1); }
mkdirSync(out, { recursive: true });
if (existsSync(path.join(source, 'postmaster.pid'))) { console.error('The source database appears to be running (postmaster.pid exists). Stop it first, so the copy is consistent.'); process.exit(1); }

console.log(`copying ${source} → ${copy} …`);
rmSync(copy, { recursive: true, force: true });
cpSync(source, copy, { recursive: true });
const passwordFile = path.resolve(root, '.data', 'postgres.admin-password');
const port = 54330;
const handle = await startEmbeddedPostgres({ dataDir: copy, port, persistent: true, passwordFile: existsSync(passwordFile) ? passwordFile : undefined, quiet: true });
const client = new pg.Client({ connectionString: handle.adminUrl(DB) });
let ok: boolean | undefined;
try {
  await client.connect();
  const tables = (await client.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`)).rows.map((r) => r.table_name as string);
  const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, Number((await client.query(`select count(*) n from "${t}"`)).rows[0].n)] as const)));
  const decisionDigest = async () => (await client.query(`select md5(string_agg(concat_ws('|', id, org_id, source_variant_id, competitor_variant_id, match_class, confidence, status, method, decided_by, decided_at, decision_note), ',' order by id)) d, count(*)::int n from product_matches`)).rows[0];
  const applied = async () => Number((await client.query(`select count(*) n from drizzle.__drizzle_migrations`)).rows[0].n);
  const before = await counts();
  const digestBefore = await decisionDigest();
  const migBefore = await applied();
  console.log(`before: ${migBefore} migrations applied; ${tables.length} tables; product_matches ${before['product_matches']} rows`);

  const t0 = Date.now();
  await runMigrations(handle.adminUrl(DB));
  const ms = Date.now() - t0;
  const after = await counts();
  const digestAfter = await decisionDigest();
  console.log(`after:  ${await applied()} migrations applied (took ${ms} ms)`);

  const lost = tables.filter((t) => after[t] !== before[t]);
  console.log(lost.length ? `ROW COUNTS CHANGED in: ${lost.map((t) => `${t} ${before[t]}→${after[t]}`).join(', ')}` : 'every existing table has exactly the same number of rows');
  console.log(digestBefore.d === digestAfter.d ? `every match row (${digestAfter.n}) is unchanged (digest ${String(digestAfter.d).slice(0, 12)}…)` : 'MATCH ROWS CHANGED');
  const nul = (await client.query(`select count(*) filter (where relationship is not null or tier is not null or evidence is not null or engine_version is not null or pair_hash is not null or superseded_at is not null or needs_reevaluation)::int dirty from product_matches`)).rows[0];
  console.log(`old rows with any new field set: ${nul.dirty} (expected 0)`);
  const eng = (await client.query(`select matching_engine, count(*)::int n from org_settings group by 1`)).rows;
  console.log(`matching engine per workspace after migration: ${JSON.stringify(eng)} (expected all v1)`);
  const statuses = (await client.query(`select status, match_class, count(*)::int n from product_matches group by 1,2 order by 1,2`)).rows;
  console.log('existing match rows by status/class:', JSON.stringify(statuses));
  ok = !lost.length && digestBefore.d === digestAfter.d && nul.dirty === 0 && eng.every((e) => e.matching_engine === 'v1');

  if (process.argv.includes('--export')) {
    const orgs = (await client.query(`select o.id, o.name from organizations o where exists (select 1 from sites s where s.org_id = o.id and s.role = 'competitor') and exists (select 1 from variants v where v.org_id = o.id)`)).rows;
    for (const o of orgs) {
      const rows = (await client.query(
        `select v.id as "variantId", p.id as "productId", p.site_id as "siteId", s.role, s.hostname as site, p.title, v.title as "variantTitle", p.brand, p.category, v.gtin, v.sku, p.mpn, p.model, v.qty_label as "qtyLabel",
                jsonb_build_object('tags', p.attrs->'tags', 'size', p.attrs->'size') as attrs, v.options, v.price::float, v.currency
         from variants v join products p on p.id = v.product_id join sites s on s.id = p.site_id where v.org_id = $1 and s.active and p.delisted_at is null`, [o.id])).rows;
      const decisions = (await client.query(`select source_variant_id as source, competitor_variant_id as competitor, status, match_class as "matchClass" from product_matches where org_id = $1 and status in ('accepted','rejected')`, [o.id])).rows;
      const file = path.join(out, `dataset-${String(o.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`);
      writeFileSync(file, JSON.stringify({ rows, decisions }));
      const roles = rows.reduce((m: Record<string, number>, r) => ((m[r.role] = (m[r.role] ?? 0) + 1), m), {});
      console.log(`exported ${file}: ${rows.length} variants ${JSON.stringify(roles)}, ${decisions.length} human decisions`);
    }
  }
} finally {
  await client.end().catch(() => {});
  await handle.stop();
  if (!process.argv.includes('--keep')) rmSync(copy, { recursive: true, force: true });
}
console.log(ok ? '\nREHEARSAL PASSED: the migration is additive and changed no existing data.' : '\nREHEARSAL FAILED: see above.');
process.exit(ok ? 0 : 2);
