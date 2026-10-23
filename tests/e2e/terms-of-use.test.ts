import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { products, scanRuns, sites } from '@ci/database';
import { listSites, runProfile, setConsent, startScan } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';

/**
 * A website's terms of use are read before anything is collected. Found while auditing four real Aruba shops: two of their public terms pages
 * forbid "spiders, robots… scrapers" outright and two restrict copying or commercial use; the product had only ever read robots.txt.
 *  • terms that forbid automated access → the capability check stops before any product page or feed is requested, collection is refused,
 *    and it proceeds only when the customer records the owner's written permission (and says where it is kept);
 *  • terms that restrict copying → a visible warning with the clause quoted; the customer decides;
 *  • the customer's own website is never blocked by its own terms; a site with no readable terms is said to be unchecked, never "allowed".
 */
let h: Harness;
const db = () => h.db.worker;
const catalogueRequests = (key: string) => h.fixtures.sites[key]!.requests.filter((r) => /products\.json|\/sitemap|\/collections|\/products\//.test(r.path)).map((r) => r.path);

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

async function oneCompetitor(label: string, key: string, consent = false): Promise<{ t: Tenant; siteId: string }> {
  const t = await h.newTenant(label);
  const siteId = await t.addFixtureSite(key, 'competitor', consent);
  return { t, siteId };
}

describe('terms of use that forbid automated access', () => {
  it('stop the capability check before any product page, feed or sitemap is requested, and quote the clause', async () => {
    const { t, siteId } = await oneCompetitor('Ban', 'termsban');
    const profile = await runProfile(h.svc, t.orgId, siteId);
    expect(profile.status).toBe('blocked');
    expect(profile.terms?.level).toBe('prohibits_automation');
    const lim = profile.limitations.find((l) => l.code === 'terms_prohibit_automation')!;
    expect(lim.severity).toBe('blocking');
    expect(lim.message).toMatch(/spiders, robots or scrapers/);
    expect(lim.message).toMatch(/rival-termsban\.test\/terms-of-use/);
    expect(profile.summary).toMatch(/Nothing was collected, and no product pages were read/);
    expect(catalogueRequests('termsban')).toEqual([]);
  });

  it('cannot be confirmed without the owner’s written permission and a note saying where it is kept', async () => {
    const { t, siteId } = await oneCompetitor('Ban2', 'termsban');
    await runProfile(h.svc, t.orgId, siteId);
    const confirm = (input: Parameters<typeof setConsent>[5]) => t.tx((tx) => setConsent(h.svc, tx, t.orgId, t.userId, siteId, input));
    await expect(confirm({ status: 'confirmed', attest: true })).rejects.toMatchObject({ code: 'terms_prohibit', status: 409 });
    await expect(confirm({ status: 'confirmed', attest: true, writtenPermission: true, note: 'yes' })).rejects.toMatchObject({ code: 'bad_request' });
    const [row] = await db().select().from(sites).where(eq(sites.id, siteId));
    expect(row!.consentStatus).toBe('pending');
    expect(row!.writtenPermission).toBe(false);

    const ok = await confirm({ status: 'confirmed', attest: true, writtenPermission: true, note: 'email from the owner, 20 Oct 2026' });
    expect(ok.writtenPermission).toBe(true);
    expect(ok.consentNote).toMatch(/written permission recorded/);
    expect(ok.consentNote).toMatch(/email from the owner/);
  });

  it('once the permission is recorded the website is re-checked, collected, and the review says permission was recorded; stopping collection withdraws it', async () => {
    const { t, siteId } = await oneCompetitor('Ban3', 'termsban');
    await runProfile(h.svc, t.orgId, siteId);
    await t.tx((tx) => setConsent(h.svc, tx, t.orgId, t.userId, siteId, { status: 'confirmed', attest: true, writtenPermission: true, note: 'letter from the owner, kept in the shared drive' }));
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    const [run] = await db().select().from(scanRuns).where(eq(scanRuns.siteId, siteId)).orderBy(desc(scanRuns.createdAt));
    expect(run!.status).toBe('succeeded');
    const n = await db().select().from(products).where(eq(products.siteId, siteId));
    expect(n.length).toBe(h.fixtures.sites.termsban!.products.length);

    const [list] = (await t.tx((tx) => listSites(tx, t.orgId))).filter((s) => s.id === siteId);
    expect(list).toMatchObject({ writtenPermission: true, termsLevel: 'prohibits_automation' });
    expect(list!.termsClause?.text).toMatch(/spiders, robots or scrapers/);

    await t.tx((tx) => setConsent(h.svc, tx, t.orgId, t.userId, siteId, { status: 'revoked' }));
    const [after] = await db().select().from(sites).where(eq(sites.id, siteId));
    expect(after!.writtenPermission).toBe(false);
  });

  it('stop a scheduled or manual collection even when the collection rules were confirmed before the terms were ever read', async () => {
    const { t, siteId } = await oneCompetitor('Ban4', 'termsban', true); // confirmed with no profile yet: the situation of every website added before this check existed
    const before = catalogueRequests('termsban').length;
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'scheduled' }));
    await h.queue.drain();
    const [run] = await db().select().from(scanRuns).where(eq(scanRuns.siteId, siteId)).orderBy(desc(scanRuns.createdAt));
    expect(run!.status).toBe('blocked');
    expect(run!.error).toMatch(/terms of use forbid automated collection/);
    expect(await db().select().from(products).where(eq(products.siteId, siteId))).toHaveLength(0);
    expect(catalogueRequests('termsban')).toHaveLength(before); // not a single product page, feed or sitemap was requested for it
  });
});

describe('terms of use that only restrict copying', () => {
  it('warn, quote the clause, and leave the decision to the customer', async () => {
    const { t, siteId } = await oneCompetitor('Copy', 'termscopy');
    const profile = await runProfile(h.svc, t.orgId, siteId);
    expect(profile.status).not.toBe('blocked');
    expect(profile.terms?.level).toBe('restricts_copying');
    const lim = profile.limitations.find((l) => l.code === 'terms_restrict_copying')!;
    expect(lim.severity).toBe('warning');
    expect(lim.message).toMatch(/without our written consent/);
    await t.tx((tx) => setConsent(h.svc, tx, t.orgId, t.userId, siteId, { status: 'confirmed', attest: true })); // no written-permission box is needed
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    expect((await db().select().from(products).where(eq(products.siteId, siteId))).length).toBe(h.fixtures.sites.termscopy!.products.length);
  });
});

describe('what terms never do', () => {
  it('never block the customer’s own website, even if its terms mention automation', async () => {
    const t = await h.newTenant('Own');
    const siteId = await t.addFixtureSite('termsban', 'source', false);
    const profile = await runProfile(h.svc, t.orgId, siteId);
    expect(profile.status).not.toBe('blocked');
    expect(profile.terms?.level).toBe('prohibits_automation');
    expect(profile.limitations.map((l) => l.code)).toContain('terms_own_site');
    expect(profile.limitations.map((l) => l.code)).not.toContain('terms_prohibit_automation');
  });

  it('say so plainly when no terms page could be read — that is not permission, and nothing is blocked for it', async () => {
    const t = await h.newTenant('NoTerms');
    const siteId = await t.addFixtureSite('woo', 'competitor', false);
    const profile = await runProfile(h.svc, t.orgId, siteId);
    expect(profile.terms).toMatchObject({ level: 'not_found', pages: [] });
    const lim = profile.limitations.find((l) => l.code === 'terms_not_found')!;
    expect(lim.severity).toBe('info');
    expect(lim.message).toMatch(/not permission/);
    expect(profile.status).not.toBe('blocked');
  });
});
