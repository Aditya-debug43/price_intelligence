/**
 * Offline end-to-end demo on FIXTURE sites. Sets up a workspace, profiles and collects every fixture site (including
 * blocked / failed / partial outcomes), matches products, simulates inventory, builds two reports with real history
 * between them, then keeps the fixture sites running so evidence links and live refreshes keep working.
 *
 *   npm run dev:db       (terminal 1)
 *   npm run demo:fixtures (terminal 2)   then   npm run dev   (API + worker + web)
 */
import { eq } from 'drizzle-orm';
import { orgSettings, withTenant } from '@ci/database';
import { addSite, createDevInventory, generateReport, listSites, runMatching, runProfile, setConsent, simulateQuantity, startScan, updateSite } from '@ci/services';
import { ensureDevUser, ensureOrg, openCli, root } from './lib/cli.ts';
import { serveFixtures } from './fixtures-serve.ts';
import path from 'node:path';

const cli = await openCli({ ALLOW_LOCAL_FIXTURES: 'true' });
const { svc, db, queue } = cli;
const user = await ensureDevUser(cli);
const orgId = await ensureOrg(cli, user.id, 'Fixture Demo — Groceries To Go (not live data)', 'demo');
const s = await serveFixtures();
const fx = s.fx;
console.log('Fixture sites are running. Building the demo workspace…');

const ids: Record<string, string> = {};
const existing = await withTenant(db, orgId, async (tx) => listSites(tx, orgId));
for (const [key, role] of [['source', 'source'], ['woo', 'competitor'], ['jsonld', 'competitor'], ['html', 'competitor'], ['blocked', 'competitor'], ['failing', 'competitor']] as const) {
  const url = fx.origin(key);
  const found = existing.find((e) => e.hostname === new URL(url).host);
  ids[key] = found?.id ?? (await withTenant(db, orgId, (tx) => addSite(svc, tx, orgId, user.id, { url, role, name: fx.sites[key]!.spec.label }))).id;
  await withTenant(db, orgId, (tx) => setConsent(svc, tx, orgId, user.id, ids[key]!, { status: 'confirmed', attest: true, note: 'Fixture demo: fictional data' }));
  // These are local fictional sites, so the polite 1.5 s default would only make the demo slow; real sites keep their delay.
  await withTenant(db, orgId, (tx) => updateSite(svc, tx, orgId, user.id, ids[key]!, { crawlDelayMs: 250 }));
}
await db.update(orgSettings).set({ alertPrefs: { inApp: true, email: true, dailySummaryEmail: true, recipients: [user.email] } }).where(eq(orgSettings.orgId, orgId));

for (const k of Object.keys(ids)) await runProfile(svc, orgId, ids[k]!);
const scanAll = async (kind: 'discovery' | 'refresh' = 'discovery') => {
  for (const k of Object.keys(ids)) await withTenant(db, orgId, (tx) => startScan(svc, tx, orgId, ids[k]!, { kind, trigger: 'dev' }));
  await queue.drain();
};

console.log('Day 1 (yesterday): first collection…');
svc.clock = () => new Date(Date.now() - 24 * 3_600_000);
await scanAll();
await runMatching(svc, db, orgId);
const inv = await withTenant(db, orgId, (tx) => createDevInventory(svc, tx, orgId, user.id));
await withTenant(db, orgId, (tx) => simulateQuantity(svc, tx, orgId, inv.connectionId, { sku: fx.sites.source!.find(1)!.sku, locationName: 'Main warehouse (simulated)', quantity: 30 }));
await generateReport(svc, db, orgId, { kind: 'manual', deadlineAt: null, createdBy: user.id });

console.log('Day 2 (today): prices move, stock changes, a product is delisted…');
svc.clock = () => new Date();
fx.sites.woo!.setPrice(0, Math.round(fx.sites.woo!.find(0)!.price * 0.8 * 100) / 100);
fx.sites.jsonld!.setPrice(9, Math.round(fx.sites.jsonld!.find(9)!.price * 1.12 * 100) / 100);
fx.sites.source!.setAvailability(0, false);
await withTenant(db, orgId, (tx) => simulateQuantity(svc, tx, orgId, inv.connectionId, { sku: fx.sites.source!.find(0)!.sku, locationName: 'Main warehouse (simulated)', quantity: 0 })); // the inventory system sells out together with the page
fx.sites.woo!.setAvailability(12, false);
fx.sites.jsonld!.remove(5);
await scanAll();
await runMatching(svc, db, orgId);
await withTenant(db, orgId, (tx) => simulateQuantity(svc, tx, orgId, inv.connectionId, { sku: fx.sites.source!.find(1)!.sku, locationName: 'Main warehouse (simulated)', quantity: 4 }));
await generateReport(svc, db, orgId, { kind: 'manual', deadlineAt: null, createdBy: user.id });

console.log('\n✔ Demo workspace ready.');
console.log(`  Sign in as ${user.email}  (password in ${path.join(root, '.data', 'dev-credentials.json')})`);
console.log(`  Workspace: "Fixture Demo — Groceries To Go (not live data)"`);
console.log('  Open the app (npm run dev:demo) → Dashboard, Price comparison, Offers, My stock, Reports.');
console.log('  Fixture sites stay up for evidence links. Change them live: curl -X POST localhost:4100/mutate -d \'{"site":"woo","item":0,"price":0.99}\'');
console.log('  Press Ctrl+C to stop the fixture sites.\n');
await cli.close();
const stop = async () => {
  await s.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
