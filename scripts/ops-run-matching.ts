/**
 * Queue a matching run for one workspace, exactly as the "Run matching again" button does: the background worker picks up the same `match-products` job.
 * It reads no catalogue data and changes nothing itself; the run happens in the worker with the workspace's own settings (engine, automatic confirmation).
 *
 *   npx tsx scripts/ops-run-matching.ts <orgId>
 *
 * On the server (environment from the service's own file; nothing is printed from it):
 *   sudo bash -c 'cd /opt/shelfwatch/app && set -a && . /etc/shelfwatch/shelfwatch.env && node_modules/.bin/tsx scripts/ops-run-matching.ts <orgId>'
 */
import { loadConfig, loadDotEnv } from '@ci/core';
import { PgBossQueue, consoleLogger, createProducerBoss } from '@ci/services';

loadDotEnv();
const config = loadConfig();
const orgId = process.argv[2];
if (!orgId || !/^[0-9a-f-]{36}$/.test(orgId)) {
  console.error('usage: tsx scripts/ops-run-matching.ts <orgId>');
  process.exit(1);
}
const boss = await createProducerBoss(config.DATABASE_URL, consoleLogger('warn', { app: 'ops' }));
const jobId = await new PgBossQueue(boss).enqueue('match-products', { orgId }, { singletonKey: `match:${orgId}` });
console.log(jobId ? `queued match-products job ${jobId}` : 'a matching run for this workspace is already queued or running');
await boss.stop({ graceful: true, timeout: 5000 });
process.exit(0);
