/**
 * REHEARSAL of migrations 0021 (continuous matching, per-key quota, family key, truths, work items) and 0022 (truth_complete) on a scratch database that already holds the kind of rows production
 * has: it applies 0000–0020, seeds rows, applies the rest, and proves that nothing was lost or moved and that the new columns hold what they should. It never touches a real database.
 *
 *   npx tsx scripts/migration-rehearsal-ai.ts
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { runMigrations } from '@ci/database';
import { startEmbeddedPostgres } from './lib/embedded-pg.ts';
import { root } from './lib/root.ts';

const MIGRATIONS = path.resolve(root, 'packages/database/migrations');
const work = mkdtempSync(path.join(tmpdir(), 'ci-rehearsal-'));
const partial = path.join(work, 'upto-0020');
mkdirSync(path.join(partial, 'meta'), { recursive: true });
const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
const keep = journal.entries.filter((e) => e.idx <= 20);
writeFileSync(path.join(partial, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: keep }, null, 2));
for (const e of keep) cpSync(path.join(MIGRATIONS, `${e.tag}.sql`), path.join(partial, `${e.tag}.sql`));

const handle = await startEmbeddedPostgres({ dataDir: path.join(work, 'pg'), port: 54340 + Math.floor(Math.random() * 500), persistent: false, quiet: true });
await handle.createDatabase('rehearsal');
const url = handle.adminUrl('rehearsal');
const client = new pg.Client({ connectionString: url });
const results: string[] = [];
const check = (name: string, ok: boolean, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
let failed = false;
try {
  await runMigrations(url, { migrationsFolder: partial });
  await client.connect();
  const ORG = '00000000-0000-4000-8000-000000000001';
  const SRC = '00000000-0000-4000-8000-0000000000a1';
  const COMP = '00000000-0000-4000-8000-0000000000b1';
  const p1 = '00000000-0000-4000-8000-0000000000c1';
  const p2 = '00000000-0000-4000-8000-0000000000c2';
  const v1 = '00000000-0000-4000-8000-0000000000d1';
  const v2 = '00000000-0000-4000-8000-0000000000d2';
  // rows only: the foreign keys are not what is being rehearsed, so the seeded rows need not reference a real organisation (this applies to every connection, including the migration's)
  await client.query(`alter database rehearsal set session_replication_role = replica`);
  await client.query(`set session_replication_role = replica`);
  await client.query(`insert into products (id, org_id, site_id, canonical_url, title, extraction_method, extraction_version) values ($1,$2,$3,'https://a.example/p1','Sealight H11 LED Headlight Bulb','t','t'), ($4,$2,$3,'https://a.example/p2','Sealight H7 LED Headlight Bulb','t','t')`, [p1, ORG, SRC, p2]);
  await client.query(`insert into variants (id, org_id, site_id, product_id, variant_key, url) values ($1,$2,$3,$4,'default','https://a.example/p1'), ($5,$2,$3,$6,'default','https://a.example/p2')`, [v1, ORG, SRC, p1, v2, p2]);
  await client.query(`insert into ai_quota_state (model, learned_rpm, learned_rpd, paused_until, stopped) values ('gemini-3.5-flash-lite', 15, 250, null, null), ('gemini-embedding-001', null, null, null, 'refused')`);
  await client.query(`insert into ai_usage_daily (day, model, requests, successes) values ('2026-11-04','gemini-3.5-flash-lite', 41, 40), ('2026-11-05','gemini-3.5-flash-lite', 12, 12)`);
  await client.query(`insert into match_eval_cases (org_id, source_variant_id, competitor_site_id, domain, stratum, split, status) values ($1,$2,$3,'automotive','ai','development','pending'), ($1,$4,$3,'automotive','ai','holdout','pending')`, [ORG, v1, COMP, v2]);
  await client.query(`insert into match_eval_cases (org_id, source_variant_id, competitor_site_id, domain, stratum, split, status, truth_relationship, labelled_at) values ($1,$2,$3,'automotive','random','holdout','labelled','none', now())`, [ORG, v1, '00000000-0000-4000-8000-0000000000b2']);
  await client.query(`insert into match_auto_approval (org_id, domain, auto_class, enabled) values ($1,'automotive','compatible_equivalent', true)`, [ORG]);
  const tables = (await client.query(`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1`)).rows.map((r) => r.table_name as string);
  const count = async (t: string) => Number((await client.query(`select count(*) n from "${t}"`)).rows[0].n);
  const before = Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(t)] as const)));
  const labelledBefore = (await client.query(`select id, split from match_eval_cases where status='labelled'`)).rows[0] as { id: string; split: string };

  await runMigrations(url); // 0021 and 0022
  for (const t of tables) check(`row count unchanged: ${t}`, (await count(t)) === before[t], `${before[t]}`);
  const q = async (sql: string) => (await client.query(sql)).rows;
  const quota = await q(`select model, key_id, learned_rpm, learned_rpd, stopped from ai_quota_state order by model`);
  check('quota rows kept and given key k1', quota.length === 2 && quota.every((r) => r.key_id === 'k1') && quota[0].learned_rpd === 250 && quota[1].stopped === 'refused');
  const pk = await q(`select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = 'ai_quota_state'::regclass and i.indisprimary order by a.attname`);
  check('quota primary key is (key_id, model)', pk.map((r) => r.attname).join(',') === 'key_id,model');
  const usage = await q(`select key_id, requests from ai_usage_daily order by day`);
  check('usage rows kept and given key k1', usage.length === 2 && usage.every((r) => r.key_id === 'k1') && usage[0].requests === 41);
  check('a second key can have its own row for the same day and model', await client.query(`insert into ai_usage_daily (day, model, key_id, requests) values ('2026-11-05','gemini-3.5-flash-lite','k2',3)`).then(() => true, () => false));
  const cases = await q(`select status, split, family_key, truth_complete from match_eval_cases order by status, split`);
  check('every case with a product has a family key', cases.every((r) => !!r.family_key));
  const labelledAfter = (await q(`select id, split, truth_complete from match_eval_cases where status='labelled'`))[0];
  check('a labelled case never moves between development and holdout', labelledAfter.id === labelledBefore.id && labelledAfter.split === labelledBefore.split);
  check('a label that said "none" is a complete answer', labelledAfter.truth_complete === true);
  const pending = await q(`select split, family_key from match_eval_cases where status='pending'`);
  const expected = await q(`select case when abs(('x' || substr(md5(lower(regexp_replace(title, '[^a-zA-Z0-9]+', '', 'g'))), 1, 8))::bit(32)::bigint) % 100 < 40 then 'holdout' else 'development' end as split from products where id in ('${p1}','${p2}') order by id`);
  check('unlabelled cases are split by the family rule', pending.length === 2 && pending.map((r) => r.split).sort().join() === expected.map((r) => r.split).sort().join());
  const auto = await q(`select enabled, policy_version from match_auto_approval`);
  check('an enabled policy keeps its flag but has NO policy version, so it approves nothing until it is measured for the current rules', auto[0].enabled === true && auto[0].policy_version === null);
  for (const t of ['ai_match_work', 'match_eval_truths']) {
    const rls = await q(`select relrowsecurity, relforcerowsecurity from pg_class where relname = '${t}'`);
    check(`row-level security is on for ${t}`, rls[0]?.relrowsecurity === true && rls[0]?.relforcerowsecurity === true);
  }
  check('org_settings has the automatic-matching switch, off', (await q(`select count(*) n from information_schema.columns where table_name='org_settings' and column_name='ai_continuous' and column_default = 'false'`))[0].n === '1');
} catch (e) {
  failed = true;
  results.push(`FAIL  rehearsal stopped: ${(e as Error).message} :: ${((e as { cause?: Error }).cause?.message) ?? ''}`);
} finally {
  await client.end().catch(() => undefined);
  // a scratch server: stopped hard, with its whole process tree (on Windows a graceful stop can leave helper processes holding the port)
  try {
    const pid = Number(/^\d+/.exec(readFileSync(path.join(work, 'pg', 'postmaster.pid'), 'utf8'))?.[0]);
    if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)]);
    else process.kill(pid, 'SIGTERM');
  } catch {
    await handle.stop().catch(() => undefined);
  }
  await new Promise((res) => setTimeout(res, 1500));
  rmSync(work, { recursive: true, force: true });
}
console.log(results.join('\n'));
if (failed || results.some((r) => r.startsWith('FAIL'))) process.exit(1);
console.log('\nmigrations 0021 and 0022 are safe on production-like data');
process.exit(0);
