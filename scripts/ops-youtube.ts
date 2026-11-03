/**
 * Operator tool for the YouTube integration of ONE named workspace. It uses the same service functions as the "Manage social connections" screen, so nothing is saved that the
 * screen would not save: a channel is checked with the official YouTube API first, and only an exact match is connected. The API key comes from the service's own environment and is
 * never printed. Other workspaces are never touched.
 *
 *   list    <workspace>                         the YouTube mappings of the workspace (nothing is asked of YouTube)
 *   verify  <workspace>                         asks YouTube about each mapping (1 quota unit each) and prints what it says; changes nothing
 *   confirm <workspace> <hostname>              checks the website's mapping(s) with YouTube and connects the ones that match exactly, then lists them
 *   sync    <workspace> [hostname]              reads the connected channels now (not queued) and prints what each read found
 *
 * On the server:
 *   sudo bash -c 'cd /opt/shelfwatch/app && set -a && . /etc/shelfwatch/shelfwatch.env && node_modules/.bin/tsx scripts/ops-youtube.ts list "Aditya"'
 */
import { and, eq } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '@ci/core';
import { verifyYouTubeChannel } from '@ci/connectors';
import { auditEvents, createDb, createPool, memberships, organizations, sites, socialAccounts } from '@ci/database';
import { OutboxMailer, confirmSocialAccount, consoleLogger, createServices, socialConfigOf, syncSocial } from '@ci/services';

loadDotEnv();
const config = loadConfig();
const [command, workspace, hostname] = process.argv.slice(2);
if (!command || !workspace || !['list', 'verify', 'confirm', 'sync'].includes(command) || (command === 'confirm' && !hostname)) {
  console.error('usage: tsx scripts/ops-youtube.ts <list|verify|confirm|sync> "<workspace name>" [website hostname]   (confirm needs the hostname)');
  process.exit(1);
}

const log = consoleLogger('warn', { app: 'ops' });
const pool = createPool(config.workerDatabaseUrl, { applicationName: 'ci-ops', max: 2 });
const db = createDb(pool);
const queue = { enqueue: async () => null };
const svc = createServices(config, db, { queue, log, mailerFactory: (base) => new OutboxMailer(db, () => queue, { smtp: config.smtp, from: config.emailFrom }, base.log) });

const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, workspace));
if (!org) {
  console.error('no such workspace');
  process.exit(1);
}

const mappings = async () =>
  db
    .select({ id: socialAccounts.id, siteId: socialAccounts.siteId, host: sites.hostname, role: sites.role, handle: socialAccounts.handle, url: socialAccounts.url, from: socialAccounts.discoveredFrom, confirmed: socialAccounts.confirmed, externalId: socialAccounts.externalId, title: socialAccounts.externalTitle, verifiedAt: socialAccounts.verifiedAt, lastSyncStatus: socialAccounts.lastSyncStatus, lastSyncMessage: socialAccounts.lastSyncMessage })
    .from(socialAccounts)
    .innerJoin(sites, eq(sites.id, socialAccounts.siteId))
    .where(and(eq(socialAccounts.orgId, org.id), eq(socialAccounts.platform, 'youtube')))
    .orderBy(sites.hostname);

const show = async () => {
  const rows = await mappings();
  if (rows.length === 0) console.log('(no YouTube mappings)');
  for (const m of rows) console.log(`${m.host} [${m.role}] ${m.handle}  found:${m.from}  ${m.confirmed ? 'CONNECTED' : 'not connected'}${m.externalId ? `  channel ${m.externalId} “${m.title}”` : ''}${m.lastSyncStatus ? `  last read: ${m.lastSyncStatus}` : ''}`);
};

if (command === 'list') await show();

if (command === 'verify') {
  for (const m of await mappings()) {
    const v = await verifyYouTubeChannel(socialConfigOf(svc), { handle: m.handle, url: m.url, externalId: m.externalId }, svc.socialHttp);
    console.log(`${m.host} ${m.handle}: ${v.ok ? `OK — “${v.channel.title}” ${v.channel.customUrl ?? ''} ${v.channel.channelId}` : `NOT CONNECTABLE — ${v.message}`}`);
  }
}

if (command === 'confirm') {
  const [owner] = await db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.orgId, org.id), eq(memberships.role, 'owner')));
  const targets = (await mappings()).filter((m) => m.host === hostname && !m.confirmed);
  if (targets.length === 0) console.log('nothing to connect for that website');
  for (const m of targets) {
    try {
      // confirmed on the owner's instruction, through the same checks as the screen; the audit entry says it was done from the operator tool
      await confirmSocialAccount(svc, db, org.id, owner!.userId, m.id, true);
      await db.insert(auditEvents).values({ orgId: org.id, userId: owner!.userId, action: 'social.confirmed', target: m.id, meta: { platform: 'youtube', handle: m.handle, via: 'operator tool, on the owner’s instruction' } });
      console.log(`${m.host} ${m.handle}: connected`);
    } catch (e) {
      console.log(`${m.host} ${m.handle}: NOT connected — ${(e as Error).message}`);
    }
  }
  await show();
}

if (command === 'sync') {
  let siteId: string | undefined;
  if (hostname) {
    const [site] = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.orgId, org.id), eq(sites.hostname, hostname)));
    if (!site) {
      console.error('no such website in that workspace');
      process.exit(1);
    }
    siteId = site.id;
  }
  const results = await syncSocial(svc, db, org.id, { siteId, platform: 'youtube', manual: true }); // only YouTube: nothing is asked of any other platform
  for (const r of results.filter((x) => x.platform === 'youtube')) console.log(`${r.site} ${r.handle}: ${r.state} — ${r.message} (${r.posts} stored/refreshed)`);
  if (results.filter((x) => x.platform === 'youtube').length === 0) console.log('no connected YouTube channel to read');
}

await pool.end();
process.exit(0);
