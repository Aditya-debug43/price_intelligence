/**
 * Prepares the intended Aruba demonstration workspace: the source website plus the CANDIDATE competitors.
 *
 * It only creates the workspace and website entries. Consent for each website is left PENDING: live collection from
 * these businesses starts only after the owner records permission in the app (Websites → Consent). Profiling (a light
 * look at robots.txt, the homepage, sitemaps and a few sample pages) can be run from the app or with --profile.
 *
 *   npm run demo:setup            # workspace + websites (needs outbound DNS to validate domains)
 *   npm run demo:setup -- --profile
 */
import { withTenant } from '@ci/database';
import { addSite, listSites, runProfile } from '@ci/services';
import { ensureDevUser, ensureOrg, openCli } from './lib/cli.ts';

const cli = await openCli({ ALLOW_LOCAL_FIXTURES: process.env.ALLOW_LOCAL_FIXTURES ?? 'false' });
const user = await ensureDevUser(cli);
const orgId = await ensureOrg(cli, user.id, 'Groceries To Go Aruba');

const SITES = [
  { url: 'https://groceriestogoaruba.com/', role: 'source' as const, name: 'Groceries To Go Aruba' },
  { url: 'https://shop.lingandsons.com/', role: 'competitor' as const, name: 'Ling & Sons' },
  { url: 'https://shop.superfoodaruba.com/', role: 'competitor' as const, name: 'Super Food Aruba' },
  { url: 'https://doit.aw/', role: 'competitor' as const, name: 'Do-It Aruba' },
];
const have = await withTenant(cli.db, orgId, (tx) => listSites(tx, orgId));
const ids: string[] = [];
for (const s of SITES) {
  const host = new URL(s.url).host;
  const found = have.find((h) => h.hostname === host);
  if (found) {
    ids.push(found.id);
    console.log(`= ${s.name}: already added`);
    continue;
  }
  try {
    const row = await withTenant(cli.db, orgId, (tx) => addSite(cli.svc, tx, orgId, user.id, s));
    ids.push(row.id);
    console.log(`+ ${s.name}: added (consent pending)`);
  } catch (e) {
    console.log(`! ${s.name}: ${(e as Error).message}`);
  }
}
console.log('\nNote: no Cmart website URL has been established, so none was added. Add it in Websites when confirmed.');
console.log('Consent for each website is pending. Record it in the app before any product collection.');

if (process.argv.includes('--profile')) {
  console.log('\nProfiling (light, robots-respecting; ~10–20 requests per site)…');
  for (const id of ids) {
    const p = await runProfile(cli.svc, orgId, id);
    console.log(`  ${p.site.canonicalHost ?? id}: ${p.status.toUpperCase()} — ${p.summary}`);
  }
}
await cli.close();
