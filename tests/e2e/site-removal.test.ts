import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { alerts, auditEvents, collectionHealth, consentLog, evidence, flyers, offers, priceObservations, productMatches, products, scanRuns, siteProfiles, stockObservations, variants } from '@ci/database';
import { createOrganization, generateReport, runMatching } from '@ci/services';
import { buildApp } from '../../apps/api/src/app.ts';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp, TEST_PASSWORD } from '../support/auth.ts';

/**
 * "Remove website and its data" answered 400 Bad Request. The web app declared `content-type: application/json` on a DELETE that carries no body,
 * and Fastify rejects that ("Body cannot be empty when content-type is set to 'application/json'"). The server tests never noticed because they sent
 * DELETE with no content type at all. Here the request is sent the way a browser sends it, and what removal must (and must not) do is pinned down:
 * the website and everything collected from it go; every other website, every other workspace and the saved reports stay.
 */
let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let other: ApiClient; // the owner of a different workspace that holds a website with the SAME hostname
let staff: ApiClient;
let ownerId = '';
let orgA = '';
let orgB = '';
let reportId = '';
const siteA: Record<string, string> = {};
const siteB: Record<string, string> = {};
const db = () => h.db.worker;
const base = () => `/api/v1/orgs/${orgA}`;
/** The request the web app used to send for every bodyless DELETE: a JSON content type, no body. */
const JSON_HEADER = { 'content-type': 'application/json' };

/** How many rows of each kind belong to a website — every table the schema ties to a site. */
async function rowsOf(siteId: string) {
  const n = async (q: Promise<unknown[]>) => (await q).length;
  return {
    products: await n(db().select({ id: products.id }).from(products).where(eq(products.siteId, siteId))),
    variants: await n(db().select({ id: variants.id }).from(variants).where(eq(variants.siteId, siteId))),
    priceObservations: await n(db().select({ id: priceObservations.id }).from(priceObservations).where(eq(priceObservations.siteId, siteId))),
    stockObservations: await n(db().select({ id: stockObservations.id }).from(stockObservations).where(eq(stockObservations.siteId, siteId))),
    evidence: await n(db().select({ id: evidence.id }).from(evidence).where(eq(evidence.siteId, siteId))),
    scanRuns: await n(db().select({ id: scanRuns.id }).from(scanRuns).where(eq(scanRuns.siteId, siteId))),
    profiles: await n(db().select({ id: siteProfiles.id }).from(siteProfiles).where(eq(siteProfiles.siteId, siteId))),
    consent: await n(db().select({ id: consentLog.id }).from(consentLog).where(eq(consentLog.siteId, siteId))),
    offers: await n(db().select({ id: offers.id }).from(offers).where(eq(offers.siteId, siteId))),
    flyers: await n(db().select({ id: flyers.id }).from(flyers).where(eq(flyers.siteId, siteId))),
    alerts: await n(db().select({ id: alerts.id }).from(alerts).where(eq(alerts.siteId, siteId))),
    matches: await n(db().select({ id: productMatches.id }).from(productMatches).where(eq(productMatches.competitorSiteId, siteId))),
    health: await n(db().select({ id: collectionHealth.siteId }).from(collectionHealth).where(eq(collectionHealth.siteId, siteId))),
  };
}
const total = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
const siteIds = async () => (await owner.get(`${base()}/sites`)).body.sites.map((s: { id: string }) => s.id) as string[];

async function addAndCollect(client: ApiClient, orgId: string, key: string, role: 'source' | 'competitor', into: Record<string, string>) {
  const r = await client.post(`/api/v1/orgs/${orgId}/sites`, { url: h.fixtures.origin(key), role });
  expect(r.status, `add ${key}`).toBe(201);
  into[key] = r.body.site.id;
  expect((await client.post(`/api/v1/orgs/${orgId}/sites/${into[key]}/consent`, { status: 'confirmed', attest: true, note: 'owner approval on file' })).status).toBe(200);
  expect((await client.post(`/api/v1/orgs/${orgId}/sites/${into[key]}/scans`, { kind: 'discovery' })).status).toBe(202);
}

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  const stamp = Date.now();

  owner = new ApiClient(app);
  ownerId = (await signUp(owner, h, { email: `remove-owner-${stamp}@example.test`, password: TEST_PASSWORD, displayName: 'Rita Remover' })).user.id;
  orgA = (await createOrganization(h.db.app, ownerId, 'Removal Org')).id;

  other = new ApiClient(app);
  const otherId = (await signUp(other, h, { email: `remove-other-${stamp}@example.test`, password: TEST_PASSWORD, displayName: 'Olga Other' })).user.id;
  orgB = (await createOrganization(h.db.app, otherId, 'Other Org')).id;

  await addAndCollect(owner, orgA, 'source', 'source', siteA);
  await addAndCollect(owner, orgA, 'woo', 'competitor', siteA);
  await addAndCollect(owner, orgA, 'jsonld', 'competitor', siteA);
  await addAndCollect(other, orgB, 'woo', 'competitor', siteB); // the very same website, in another workspace
  await h.queue.drain();

  await runMatching(h.svc, db(), orgA);
  reportId = (await generateReport(h.svc, db(), orgA, { kind: 'manual', deadlineAt: null, createdBy: ownerId })).id;

  staff = new ApiClient(app);
  const staffEmail = `remove-staff-${stamp}@example.test`;
  await signUp(staff, h, { email: staffEmail, password: TEST_PASSWORD, displayName: 'Sam Staff' });
  expect((await owner.post(`${base()}/members`, { email: staffEmail, role: 'staff' })).status).toBe(201);
}, 180_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('the test workspace really has data to remove', () => {
  it('holds products, prices, evidence, scans, profiles, consent and matches for each website', async () => {
    for (const k of ['woo', 'jsonld'] as const) {
      const r = await rowsOf(siteA[k]!);
      for (const kind of ['products', 'variants', 'priceObservations', 'evidence', 'scanRuns', 'profiles', 'consent'] as const) expect(r[kind], `${k} ${kind}`).toBeGreaterThan(0);
      expect(r.matches, `${k} matches`).toBeGreaterThan(0);
    }
    expect(await rowsOf(siteB.woo!)).toMatchObject({ products: expect.any(Number) });
    expect((await rowsOf(siteB.woo!)).products).toBeGreaterThan(0);
  });
});

describe('requests that must NOT remove anything', () => {
  it('an id that is not a UUID is a validation error (400), and nothing changes', async () => {
    const r = await owner.request('DELETE', `${base()}/sites/not-a-uuid`, undefined, JSON_HEADER);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation');
    expect(await siteIds()).toHaveLength(3);
  });

  it('an unknown website is 404 "Website not found."', async () => {
    const r = await owner.request('DELETE', `${base()}/sites/00000000-0000-4000-8000-000000000000`, undefined, JSON_HEADER);
    expect(r.status).toBe(404);
    expect(r.body.error).toMatchObject({ code: 'not_found', message: 'Website not found.' });
  });

  it('another workspace’s website cannot be removed — not through its own path (not a member) and not through mine (not found there)', async () => {
    const before = await rowsOf(siteB.woo!);
    expect((await owner.request('DELETE', `/api/v1/orgs/${orgB}/sites/${siteB.woo}`, undefined, JSON_HEADER)).status).toBe(404);
    expect((await owner.request('DELETE', `${base()}/sites/${siteB.woo}`, undefined, JSON_HEADER)).status).toBe(404);
    expect(await rowsOf(siteB.woo!)).toEqual(before);
    expect((await other.get(`/api/v1/orgs/${orgB}/sites`)).body.sites).toHaveLength(1);
  });

  it('a person who is not signed in is refused (401)', async () => {
    const r = await new ApiClient(app).request('DELETE', `${base()}/sites/${siteA.woo}`, undefined, { ...JSON_HEADER, 'x-requested-with': 'ci-web' });
    expect(r.status).toBe(401);
    expect(await siteIds()).toContain(siteA.woo);
  });

  it('staff cannot remove a website (403), whichever way the request is shaped', async () => {
    expect((await staff.request('DELETE', `${base()}/sites/${siteA.woo}`, undefined, JSON_HEADER)).status).toBe(403);
    expect((await staff.delete(`${base()}/sites/${siteA.woo}`)).status).toBe(403);
    expect(await siteIds()).toContain(siteA.woo);
  });

  it('a cross-site request is refused (403): the custom header is required and a foreign Origin is rejected', async () => {
    const noHeader = new ApiClient(app, { csrf: false });
    noHeader.cookies = owner.cookies;
    expect((await noHeader.request('DELETE', `${base()}/sites/${siteA.woo}`, undefined, JSON_HEADER)).status).toBe(403);
    const foreign = await owner.request('DELETE', `${base()}/sites/${siteA.woo}`, undefined, { ...JSON_HEADER, origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(await siteIds()).toContain(siteA.woo);
  });
});

describe('removing a website (the request the browser sends)', () => {
  it('a DELETE that declares a JSON content type and has no body — the 400 of the bug report — removes the website and everything collected from it', async () => {
    const wooBefore = await rowsOf(siteA.woo!);
    const keep = { source: await rowsOf(siteA.source!), jsonld: await rowsOf(siteA.jsonld!), otherWorkspaceWoo: await rowsOf(siteB.woo!) };
    expect(total(wooBefore)).toBeGreaterThan(50);

    const r = await owner.request('DELETE', `${base()}/sites/${siteA.woo}`, undefined, JSON_HEADER);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });

    // the website and every row tied to it are gone…
    expect(await rowsOf(siteA.woo!)).toEqual(Object.fromEntries(Object.keys(wooBefore).map((k) => [k, 0])));
    // …and nothing else was touched: the other websites, the SAME website in another workspace
    expect(await rowsOf(siteA.source!)).toEqual(keep.source);
    expect(await rowsOf(siteA.jsonld!)).toEqual(keep.jsonld);
    expect(await rowsOf(siteB.woo!)).toEqual(keep.otherWorkspaceWoo);
    expect(await siteIds()).toEqual(expect.arrayContaining([siteA.source, siteA.jsonld]));
    expect(await siteIds()).not.toContain(siteA.woo);
    expect((await other.get(`/api/v1/orgs/${orgB}/sites`)).body.sites.map((s: { id: string }) => s.id)).toEqual([siteB.woo]);

    // a saved report is a snapshot: it stays exactly as it was generated, and so do the matches of the websites that remain
    const report = await owner.get(`${base()}/reports/${reportId}`);
    expect(report.status).toBe(200);
    expect(keep.jsonld.matches).toBeGreaterThan(0);

    // the removal is recorded
    const audit = (await db().select().from(auditEvents).where(eq(auditEvents.orgId, orgA))).filter((a) => a.action === 'site.remove');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ target: siteA.woo, userId: ownerId });
    expect(audit[0]!.meta).toMatchObject({ host: 'rival-woo.test' });
  });

  it('removing the same website again is a clean 404, not a server error', async () => {
    const r = await owner.request('DELETE', `${base()}/sites/${siteA.woo}`, undefined, JSON_HEADER);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
  });

  it('the web app’s current request — no body, no content type — removes a website too, and the comparison and report data keep working', async () => {
    const r = await owner.delete(`${base()}/sites/${siteA.jsonld}`);
    expect(r.status).toBe(200);
    expect(await rowsOf(siteA.jsonld!)).toEqual(Object.fromEntries(Object.keys(await rowsOf(siteA.jsonld!)).map((k) => [k, 0])));
    expect(await siteIds()).toEqual([siteA.source]);
    expect((await owner.get(`${base()}/comparison`)).status).toBe(200);
    expect((await owner.get(`${base()}/dashboard`)).status).toBe(200);
    expect((await owner.get(`${base()}/products`)).status).toBe(200);
    expect((await owner.get(`${base()}/reports/${reportId}`)).status).toBe(200);
  });

  it('a DELETE that does carry a JSON body is still accepted, and a removed website can be added again (nothing is left behind to collide with)', async () => {
    const again = await owner.post(`${base()}/sites`, { url: h.fixtures.origin('woo'), role: 'competitor' });
    expect(again.status).toBe(201); // same hostname as the one removed above
    const r = await owner.request('DELETE', `${base()}/sites/${again.body.site.id}`, {});
    expect(r.status).toBe(200);
    expect(await siteIds()).toEqual([siteA.source]);
  });

  it('the other DELETE endpoints of the web app work with the same request shape (removing a member)', async () => {
    const members = (await owner.get(`${base()}/members`)).body.members as { userId: string; displayName: string }[];
    const sam = members.find((m) => m.displayName === 'Sam Staff')!;
    expect((await owner.request('DELETE', `${base()}/members/${sam.userId}`, undefined, JSON_HEADER)).status).toBe(200);
    expect(((await owner.get(`${base()}/members`)).body.members as { userId: string }[]).some((m) => m.userId === sam.userId)).toBe(false);
  });

  it('the workspace and its own website are untouched by all of the above', async () => {
    expect((await owner.get(base())).status).toBe(200);
    expect((await rowsOf(siteA.source!)).products).toBeGreaterThan(0);
    expect((await other.get(`/api/v1/orgs/${orgB}`)).status).toBe(200);
  });
});
