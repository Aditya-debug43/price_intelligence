/**
 * Start ONE collection (a full discovery scan) of one website, exactly as the "Collect" button does: it creates the scan run and queues the same background job. Nothing is
 * collected by this script itself; the worker does it, with the website's own consent record, request budget and rate-limit handling. Other websites are not touched.
 *
 *   npx tsx scripts/ops-collect-site.ts "<workspace name>" <website hostname>
 *
 * On the server (environment from the service's own file; nothing is printed from it):
 *   sudo bash -c 'cd /opt/shelfwatch/app && set -a && . /etc/shelfwatch/shelfwatch.env && node_modules/.bin/tsx scripts/ops-collect-site.ts "Aditya" groceriestogoaruba.com'
 */
import { and, eq } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '@ci/core';
import { createDb, createPool, organizations, sites } from '@ci/database';
import { OutboxMailer, PgBossQueue, consoleLogger, createProducerBoss, createServices, startScan } from '@ci/services';

loadDotEnv();
const config = loadConfig();
const [workspace, hostname] = process.argv.slice(2);
if (!workspace || !hostname) {
  console.error('usage: tsx scripts/ops-collect-site.ts "<workspace name>" <website hostname>');
  process.exit(1);
}
const log = consoleLogger('warn', { app: 'ops' });
const pool = createPool(config.workerDatabaseUrl, { applicationName: 'ci-ops', max: 2 });
const db = createDb(pool);
const boss = await createProducerBoss(config.DATABASE_URL, log);
const queue = new PgBossQueue(boss);
// (a collection sends no email; the service context just needs its mailer, as in the API and the worker)
const svc = createServices(config, db, { queue, log, mailerFactory: (base) => new OutboxMailer(db, () => queue, { smtp: config.smtp, from: config.emailFrom }, base.log) });
const [site] = await db.select({ id: sites.id, orgId: sites.orgId }).from(sites).innerJoin(organizations, eq(organizations.id, sites.orgId)).where(and(eq(organizations.name, workspace), eq(sites.hostname, hostname)));
if (!site) {
  console.error('no such website in that workspace');
  process.exit(1);
}
const { run, created } = await startScan(svc, db, site.orgId, site.id, { kind: 'discovery', trigger: 'manual' });
console.log(created ? `queued collection (scan run ${run.id})` : `a collection of this website is already running (scan run ${run.id})`);
await boss.stop({ graceful: true, timeout: 5000 });
await pool.end();
process.exit(0);
