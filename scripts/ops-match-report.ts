/**
 * READ-ONLY report of what matching has produced in each workspace and what the application shows for it: the counts by relationship and by who confirmed, the last run, and the
 * real Price comparison and Match review code run on the live records (every query runs in a read-only transaction; nothing is written, no exchange rates are fetched).
 *
 *   npx tsx scripts/ops-match-report.ts [--samples 3]
 *
 * On the server (environment from the service's own file; nothing is printed from it):
 *   sudo bash -c 'cd /opt/shelfwatch/app && set -a && . /etc/shelfwatch/shelfwatch.env && node_modules/.bin/tsx scripts/ops-match-report.ts'
 * Product titles and prices are printed (they are the workspace's own data); no identifiers, credentials or addresses are.
 */
import { sql } from 'drizzle-orm';
import { DEFAULTS } from '@ci/shared';
import { loadConfig, loadDotEnv } from '@ci/core';
import { createDb, createPool, type DbLike } from '@ci/database';
import { listMatches, loadComparison, loadFxTable, matchSummary, type ComparisonView } from '@ci/services';

loadDotEnv();
const config = loadConfig();
const samples = Number(process.argv[process.argv.indexOf('--samples') + 1] || 3);
const pool = createPool(config.workerDatabaseUrl, { applicationName: 'ci-report', max: 2 });
const db = createDb(pool);

async function readOnly<T>(fn: (tx: DbLike) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    return fn(tx as unknown as DbLike);
  });
}
const short = (s: string | null | undefined, n = 70) => (s ?? '').replace(/\s+/g, ' ').slice(0, n);

const orgs = await readOnly((tx) => tx.execute<{ id: string; name: string; engine: string; auto: boolean; currency: string }>(sql`
  select o.id, o.name, s.matching_engine as engine, s.matching_auto_confirm as auto, s.reporting_currency as currency
  from organizations o join org_settings s on s.org_id = o.id order by o.name`));
for (const o of orgs.rows) {
  console.log(`\n==================== workspace "${o.name}"  engine=${o.engine}  automatic confirmation=${o.auto ? 'on' : 'off'}`);
  await readOnly(async (tx) => {
    const by = await tx.execute<Record<string, string>>(sql`
      select coalesce(m.relationship, case m.match_class when 'identical' then 'exact' when 'different_pack' then 'variant' when 'comparable' then 'substitute' else 'non_match' end) as relationship,
             m.status, coalesce(m.tier, '-') as tier, case when m.status = 'accepted' then (case when m.auto_confirmed_at is not null then 'automatic' else 'person' end) else '-' end as by,
             (m.superseded_at is not null)::text as set_aside, count(*)::text as n
      from product_matches m where m.org_id = ${o.id} group by 1, 2, 3, 4, 5 order by 1, 2, 3, 4`);
    console.log('match rows by relationship / status / tier / confirmed by / set aside:');
    for (const r of by.rows) console.log(`  ${r['relationship']!.padEnd(11)} ${r['status']!.padEnd(12)} tier=${r['tier']!.padEnd(12)} by=${r['by']!.padEnd(9)} setAside=${r['set_aside']!.padEnd(5)} ${r['n']}`);
    const run = await tx.execute<{ engine: string; engine_version: string | null; started_at: Date; finished_at: Date | null; error: string | null; stats: Record<string, unknown> }>(sql`
      select engine, engine_version, started_at, finished_at, error, stats from match_runs where org_id = ${o.id} order by started_at desc limit 1`);
    const r0 = run.rows[0];
    if (r0) {
      const st = r0.stats as { ms?: number; rssMb?: number; heapMb?: number; sources?: number; competitors?: number; suggestions?: number; sourcesWithSuggestion?: number; byRelationship?: unknown; byTier?: unknown; persisted?: unknown };
      console.log(`last run: ${r0.engine} ${r0.engine_version ?? ''}  ${r0.finished_at ? `took ${st.ms} ms, rss ${st.rssMb} MB, heap ${st.heapMb} MB` : 'NOT FINISHED'}${r0.error ? `  ERROR: ${r0.error}` : ''}`);
      console.log(`  sources ${st.sources}, competitor variants ${st.competitors}, suggestions ${st.suggestions}, sources with a suggestion ${st.sourcesWithSuggestion}`);
      console.log(`  by relationship ${JSON.stringify(st.byRelationship)}  by tier ${JSON.stringify(st.byTier)}`);
      console.log(`  persisted ${JSON.stringify(st.persisted)}`);
    } else console.log('no matching run recorded');

    const sm = await matchSummary(tx, o.id);
    console.log(`Match review: to review ${sm.counts.awaiting} (${sm.counts.awaitingProductPairs} product pairs), suggested substitutes ${sm.counts.suggestedSubstitutes}, related/unclear ${sm.counts.unclear}, confirmed same ${sm.counts.confirmedSame} (automatically ${sm.counts.autoConfirmed}), confirmed substitutes ${sm.counts.confirmedSubstitutes}, rejected ${sm.counts.rejected}, look again ${sm.counts.needLookAgain}, set aside ${sm.counts.setAside}; state=${sm.state}`);
    const fx = await loadFxTable(tx);
    for (const [view, include] of [['prices', 'confirmed'], ['prices', 'suggested'], ['substitutes', 'suggested'], ['related', 'suggested']] as const) {
      const rows = await loadComparison(tx, { view: view as ComparisonView, include, orgId: o.id, reportingCurrency: o.currency, fx, now: new Date(), staleAfterHours: DEFAULTS.staleAfterHours });
      const cells = rows.flatMap((r) => r.cells);
      const tally = (f: (c: (typeof cells)[number]) => string) => JSON.stringify(cells.reduce<Record<string, number>>((m, c) => ((m[f(c)] = (m[f(c)] ?? 0) + 1), m), {}));
      console.log(`Price comparison, ${view} view, ${include}: ${rows.length} of your products, ${cells.length} competitor prices; by relationship ${tally((c) => c.relationship)}; by confirmation ${tally((c) => c.confirmation ?? '?')}; directly comparable ${cells.filter((c) => c.directlyComparable).length}`);
      for (const row of rows.filter((r) => r.cells.length).slice(0, include === 'suggested' || view !== 'prices' ? samples : 0)) {
        const c = row.cells[0]!;
        console.log(`    YOU  ${short(row.title)} ${row.sizeLabel ? `[${row.sizeLabel}] ` : ''}${row.sourcePrice.amount ?? '?'} ${row.sourcePrice.currency ?? ''}${row.sourceUnitPrice.value !== null ? ` (${row.sourceUnitPrice.value}/${row.sourceUnitPrice.unit})` : ''}`);
        console.log(`    ${c.relationship.toUpperCase()} [${c.confirmation}${c.tier ? `, ${c.tier}` : ''}] ${c.siteName}: ${short(c.title)} ${c.price.amount ?? '?'} ${c.price.currency ?? ''}${c.unitPrice.value !== null ? ` (${c.unitPrice.value}/${c.unitPrice.unit}${c.unitDiffPct !== null ? `, ${c.unitDiffPct}% per unit` : ''})` : ''}${c.differences.length ? `\n       differs: ${c.differences.slice(0, 2).map((d) => short(d, 90)).join(' | ')}` : ''}`);
      }
    }
    for (const bucket of ['review', 'substitutes'] as const) {
      const l = await listMatches(tx, o.id, { bucket, group: 'product', page: 1, pageSize: 3 });
      console.log(`Match review "${bucket}" list: ${l.total} item(s)${l.rows.length ? '; first: ' + l.rows.map((r: Record<string, unknown>) => `${r['relationship']}/${r['tier']} ${short(String(r['sourceTitle']), 40)} ~ ${short(String(r['competitorTitle']), 40)}`).join(' || ') : ''}`);
    }
  });
}
await pool.end();
