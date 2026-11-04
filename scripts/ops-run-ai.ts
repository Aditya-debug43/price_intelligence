/**
 * Start (or report on) an AI analysis for one workspace, exactly as the "Analyse with AI" button does: the run is created for the workspace's owner/admin and the background worker
 * picks up the `ai-match` job. It sends nothing to Gemini itself, prints no secret and changes no match, price or decision. Free tier only: the worker's own limits apply.
 *
 *   npx tsx scripts/ops-run-ai.ts <orgId> [limit=6] [perSite=3] [scope=sample|unmatched]   start a small run
 *   npx tsx scripts/ops-run-ai.ts <orgId> --status                                        show the latest run and today's use
 *
 * On the server (environment from the service's own file; nothing is printed from it):
 *   sudo bash -c 'cd /opt/shelfwatch/app && set -a && . /etc/shelfwatch/shelfwatch.env && node_modules/.bin/tsx scripts/ops-run-ai.ts <orgId> 6'
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '@ci/core';
import { aiMatchRuns, createDb, createPool, memberships } from '@ci/database';
import { PgBossQueue, aiStatus, consoleLogger, createAiRun, createProducerBoss, enqueueAiRun } from '@ci/services';

loadDotEnv();
const config = loadConfig();
const orgId = process.argv[2];
if (!orgId || !/^[0-9a-f-]{36}$/.test(orgId)) {
  console.error('usage: tsx scripts/ops-run-ai.ts <orgId> [limit] [perSite] [scope] | --status');
  process.exit(1);
}
const pool = createPool(config.workerDatabaseUrl, { applicationName: 'ci-ops', max: 2 });
const db = createDb(pool);

if (process.argv[3] === '--status') {
  const s = await aiStatus(db, config, orgId, new Date());
  const [run] = await db.select().from(aiMatchRuns).where(eq(aiMatchRuns.orgId, orgId)).orderBy(desc(aiMatchRuns.createdAt)).limit(1);
  console.log(JSON.stringify({ configured: s.configured, model: s.model, state: s.state, stopped: s.stopped, today: s.today, limits: s.limits, counts: s.counts, run: run ? { id: run.id, status: run.status, progress: run.progress, usage: run.usage, pauseReason: run.pauseReason, error: run.error } : null }, null, 1));
  await pool.end();
  process.exit(0);
}

const limit = Math.max(1, Math.min(50, Number(process.argv[3] ?? 6) || 6));
const perSite = Math.max(1, Math.min(6, Number(process.argv[4] ?? 3) || 3));
const scope = process.argv[5] === 'unmatched' ? 'unmatched' : 'sample';
const [admin] = await db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.role, 'owner'))).orderBy(asc(memberships.createdAt)).limit(1);
if (!admin) {
  console.error('this workspace has no owner to attribute the run to');
  process.exit(1);
}
const { run, selected } = await createAiRun(db, config, orgId, admin.userId, { scope, limit, perSite });
const boss = await createProducerBoss(config.DATABASE_URL, consoleLogger('warn', { app: 'ops' }));
await enqueueAiRun(new PgBossQueue(boss), orgId, run.id);
console.log(`queued AI analysis ${run.id}: ${selected} product${selected === 1 ? '' : 's'} (${scope}), model ${run.model}`);
await boss.stop({ graceful: true, timeout: 5000 });
await pool.end();
process.exit(0);
