/**
 * Operate the matching evaluation for one workspace from the server, exactly as the Evaluation tab does. It reads nothing secret and changes no match, price or decision: `prepare` selects the
 * cases for people to label; `run` queues the measurement in the worker; `status` and `counts` print numbers. Labels themselves can only be made by a person, in the Evaluation tab.
 *
 *   tsx scripts/ops-eval.ts <orgId> prepare [size=300]
 *   tsx scripts/ops-eval.ts <orgId> run
 *   tsx scripts/ops-eval.ts <orgId> status
 *   tsx scripts/ops-eval.ts <orgId> counts
 *   tsx scripts/ops-eval.ts <orgId> embed        (queue the background semantic index, when an embedding model is configured)
 *
 * On the server:  sudo bash -c 'cd /opt/shelfwatch/app && set -a && . /etc/shelfwatch/shelfwatch.env && node_modules/.bin/tsx scripts/ops-eval.ts <orgId> status'
 */
import { loadConfig, loadDotEnv } from '@ci/core';
import { createDb, createPool } from '@ci/database';
import { PgBossQueue, consoleLogger, createProducerBoss, embeddingStatus, evalProgress, loadMatchCounts, prepareEvalSet } from '@ci/services';

loadDotEnv();
const config = loadConfig();
const [orgId, cmd, arg] = process.argv.slice(2);
if (!orgId || !/^[0-9a-f-]{36}$/.test(orgId) || !['prepare', 'run', 'status', 'counts', 'embed'].includes(cmd ?? '')) {
  console.error('usage: tsx scripts/ops-eval.ts <orgId> prepare|run|status|counts|embed [size]');
  process.exit(1);
}
const pool = createPool(config.workerDatabaseUrl, { applicationName: 'ci-ops', max: 2 });
const db = createDb(pool);
if (cmd === 'prepare') console.log(JSON.stringify(await prepareEvalSet(db, orgId, { size: arg ? Number(arg) : 300 })));
else if (cmd === 'status') {
  const s = await evalProgress(db, orgId);
  console.log(JSON.stringify({ development: s.development, holdout: s.holdout, target: s.target, latestReport: s.latestReport ? { createdAt: s.latestReport.createdAt, cases: s.latestReport.cases, gates: (s.latestReport.gates as { domain: string; autoClass: string; result: { passed: boolean } }[]).map((g) => `${g.domain}/${g.autoClass}: ${g.result.passed ? 'passed' : 'closed'}`) } : null, autoApproval: s.autoApproval, embeddings: await embeddingStatus(db, orgId, config.GEMINI_EMBEDDING_MODEL) }, null, 1));
} else if (cmd === 'counts') console.log(JSON.stringify(await loadMatchCounts(db, orgId), null, 1));
else {
  const boss = await createProducerBoss(config.DATABASE_URL, consoleLogger('warn', { app: 'ops' }));
  const q = new PgBossQueue(boss);
  const id = cmd === 'run' ? await q.enqueue('ai-match', { orgId, task: 'evaluate', userId: null }, { singletonKey: `eval:${orgId}` }) : await q.enqueue('ai-match', { orgId, task: 'embed' }, { singletonKey: `embed:${orgId}` });
  console.log(id ? `queued ${cmd}: ${id}` : `${cmd} is already queued or running`);
  await boss.stop({ graceful: true, timeout: 5000 });
}
await pool.end();
process.exit(0);
