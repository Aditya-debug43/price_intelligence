/**
 * Operate automatic matching for one workspace from the server, exactly as the AI tab does. Nothing here sends a request to Gemini by itself and nothing changes a match, a price or a
 * person's decision except the explicit actions named below.
 *
 *   tsx scripts/ops-funnel.ts <orgId> funnel                  read-only: where the catalogue stands (distinct products through every stage), coverage against the targets, why each is not approved
 *   tsx scripts/ops-funnel.ts <orgId> examples [perReason=4]  read-only: real pairs behind each outcome of the policy (titles, codes, what the policy established), for an audit by a person
 *   tsx scripts/ops-funnel.ts <orgId> keys                    read-only: both Gemini keys by label (state and today's use)
 *   tsx scripts/ops-funnel.ts <orgId> reconcile               queue the re-check of every stored answer against the current rules (uses stored answers only; no Gemini request)
 *   tsx scripts/ops-funnel.ts <orgId> sweep                   queue one whole-catalogue sweep (uses the free quota of the configured keys)
 *   tsx scripts/ops-funnel.ts <orgId> continuous on|off       switch automatic matching for the workspace
 *
 * On the server:  sudo bash -c 'cd /opt/shelfwatch/app && set -a && . /etc/shelfwatch/shelfwatch.env && node_modules/.bin/tsx scripts/ops-funnel.ts <orgId> funnel'
 */
import { sql } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '@ci/core';
import { createDb, createPool } from '@ci/database';
import { PgBossQueue, aiStatus, consoleLogger, createAiRun, createProducerBoss, enqueueAiRun, loadMatchFunnel, setContinuousMatching } from '@ci/services';

loadDotEnv();
const config = loadConfig();
const [orgId, cmd, arg] = process.argv.slice(2);
const COMMANDS = ['funnel', 'examples', 'keys', 'reconcile', 'sweep', 'continuous'];
if (!orgId || !/^[0-9a-f-]{36}$/.test(orgId) || !COMMANDS.includes(cmd ?? '')) {
  console.error(`usage: tsx scripts/ops-funnel.ts <orgId> ${COMMANDS.join('|')} [arg]`);
  process.exit(1);
}
const pool = createPool(config.workerDatabaseUrl, { applicationName: 'ci-ops', max: 2 });
const db = createDb(pool);
const now = new Date();

if (cmd === 'funnel') {
  const f = await loadMatchFunnel(db, orgId, { now });
  console.log(JSON.stringify({ ...f, notApproved: f.notApproved.slice(0, 14) }, null, 1));
} else if (cmd === 'keys') {
  const s = await aiStatus(db, config, orgId, now);
  console.log(JSON.stringify({ configured: s.configured, model: s.model, state: s.state, continuous: s.continuous, limits: s.limits, today: s.today, keys: s.keys }, null, 1));
} else if (cmd === 'examples') {
  // what the policy established for real pairs, grouped by outcome: for a knowledgeable person to audit, not a measurement
  const per = Math.min(Math.max(Number(arg ?? 4) || 4, 1), 20);
  const rows = await db.execute<Record<string, unknown>>(sql`
    with ranked as (
      select a.id, a.match_type, a.auto_class, a.guards, a.policy->'compat' as compat, sp.title as stitle, cp.title as ctitle, ss.name as sname, cs.name as cname,
        coalesce(a.auto_class, a.policy->'compat'->>'blocker', 'not_a_candidate') as outcome,
        row_number() over (partition by coalesce(a.auto_class, a.policy->'compat'->>'blocker', 'not_a_candidate') order by md5(a.id::text)) as rn
      from ai_match_suggestions a
      join variants sv on sv.id = a.source_variant_id join products sp on sp.id = sv.product_id join sites ss on ss.id = sp.site_id
      join variants cv on cv.id = a.competitor_variant_id join products cp on cp.id = cv.product_id join sites cs on cs.id = cp.site_id
      where a.org_id = ${orgId} and a.match_type in ('exact_item','close_equivalent','substitute','same_product_different_pack'))
    select * from ranked where rn <= ${per} order by outcome, rn`);
  const by = new Map<string, unknown[]>();
  for (const r of rows.rows) {
    const k = String(r['outcome']);
    const compat = r['compat'] as { sharedCode?: string | null; fields?: unknown; reasons?: string[] } | null;
    (by.get(k) ?? by.set(k, []).get(k)!).push({ yours: r['stitle'], theirs: r['ctitle'], competitor: r['cname'], aiSaid: r['match_type'], guards: (r['guards'] as { code: string }[]).map((g) => g.code), sharedCode: compat?.sharedCode ?? null, fields: compat?.fields ?? null, why: compat?.reasons?.[0] ?? null });
  }
  console.log(JSON.stringify(Object.fromEntries(by), null, 1));
} else if (cmd === 'continuous') {
  if (arg !== 'on' && arg !== 'off') { console.error('usage: continuous on|off'); await pool.end(); process.exit(1); }
  await setContinuousMatching(db, orgId, null, arg === 'on', now);
  console.log(`automatic matching is now ${arg}`);
} else {
  const boss = await createProducerBoss(config.DATABASE_URL, consoleLogger('warn', { app: 'ops' }));
  const q = new PgBossQueue(boss);
  if (cmd === 'reconcile') {
    const id = await q.enqueue('ai-match', { orgId, task: 'reconcile' }, { singletonKey: `reconcile:${orgId}` });
    console.log(id ? `queued reconcile: ${id}` : 'a reconcile is already queued');
  } else {
    const { run, selected } = await createAiRun(db, config, orgId, null, { scope: 'sweep', perSite: 3 }, now);
    await enqueueAiRun(q, orgId, run.id);
    console.log(`queued sweep ${run.id} over ${selected} products`);
  }
  await boss.stop({ graceful: true, timeout: 5000 });
}
await pool.end();
process.exit(0);
