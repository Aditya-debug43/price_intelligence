import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { flyers, offers } from '@ci/database';
import { buildApp } from '../../apps/api/src/app.ts';
import { createOrganization, startScan } from '@ci/services';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp } from '../support/auth.ts';

/**
 * Reviewing uncertain flyer/banner readings: a person can confirm, correct or dismiss an offer; the machine's original reading is kept;
 * collecting the same flyer again never overwrites the verdict; structured sale prices are not "readings" and cannot be edited.
 */
let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let org: string;
let flyerSite: string;
const PASSWORD = 'Correct-Horse-9-Battery';
const base = () => `/api/v1/orgs/${org}`;

interface OfferView {
  id: string; kind: string; title: string; salePrice: number | null; originalPrice: number | null; claimedDiscountPct: number | null; currency: string | null; validTo: string | null; confidence: number | null;
  needsReview: boolean; verification: string; sourceUrl: string | null; evidenceId?: string | null; provenance?: string;
  review?: { status: string; by: string | null; at: string | null; note: string | null; originalReading: Record<string, unknown> | null };
}

const flyerOffers = async (qs = '') => (await owner.get(`${base()}/offers?kind=flyer&days=90${qs}`)).body.offers as OfferView[];

async function scan(siteId: string) {
  await startScan(h.svc, h.db.worker, org, siteId, { kind: 'discovery', trigger: 'manual' });
  await h.queue.drain();
}

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
  await signUp(owner, h, { email: `offers-${Date.now()}@example.test`, password: PASSWORD, displayName: 'Offer Reviewer' });
  const me = (await owner.get('/api/v1/auth/me')).body;
  org = (await createOrganization(h.db.app, me.user.id, 'Offer Review')).id;
  const ids: Record<string, string> = {};
  for (const [key, role] of [['source', 'source'], ['jsonld', 'competitor']] as const) {
    ids[key] = (await owner.post(`${base()}/sites`, { url: h.fixtures.origin(key), role, name: h.fixtures.sites[key]!.spec.label })).body.site.id as string;
    await owner.post(`${base()}/sites/${ids[key]}/consent`, { status: 'confirmed', attest: true });
  }
  flyerSite = ids.jsonld!;
  await scan(ids.source!);
  await scan(flyerSite);
}, 180_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('what a reviewer sees', () => {
  it('every flyer reading shows its source document, its evidence and that nobody has reviewed it yet', async () => {
    const rows = await flyerOffers();
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const o of rows) {
      expect(o.sourceUrl).toMatch(/\.pdf$/);
      expect(o.evidenceId).toBeTruthy();
      expect(o.provenance).toBe('public_web');
      expect(o.confidence).toBeLessThan(1); // a machine reading is never presented as certain
      expect(o.review).toMatchObject({ status: 'unreviewed', by: null, originalReading: null });
    }
  });
});

describe('confirming, correcting and dismissing', () => {
  let confirmId: string;
  let correctId: string;
  let dismissId: string;
  let before: OfferView;

  it('picks three readings to work with', async () => {
    const rows = (await flyerOffers()).filter((o) => o.salePrice !== null);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    [confirmId, correctId, dismissId] = [rows[0]!.id, rows[1]!.id, rows[2]!.id];
    before = rows[1]!;
  });

  it('confirming keeps the reading and records who confirmed it', async () => {
    const r = await owner.post(`${base()}/offers/${confirmId}/review`, { action: 'confirm', note: 'Matches the printed flyer' });
    expect(r.status).toBe(200);
    expect(r.body.offer).toMatchObject({ id: confirmId, reviewStatus: 'confirmed', needsReview: false });
    const o = (await flyerOffers()).find((x) => x.id === confirmId)!;
    expect(o.review).toMatchObject({ status: 'confirmed', by: 'Offer Reviewer', note: 'Matches the printed flyer' });
  });

  it('correcting replaces what was misread, recomputes the discount, and keeps the machine’s original reading', async () => {
    const r = await owner.post(`${base()}/offers/${correctId}/review`, { action: 'correct', title: 'Corrected title', salePrice: 3.5, originalPrice: 5, validTo: '2031-01-31T23:59:59.000Z', note: 'Price was cut off in the PDF' });
    expect(r.status).toBe(200);
    const o = (await flyerOffers()).find((x) => x.id === correctId)!;
    expect(o).toMatchObject({ title: 'Corrected title', salePrice: 3.5, originalPrice: 5, claimedDiscountPct: 30, verification: 'unverified', needsReview: false });
    expect(o.review).toMatchObject({ status: 'corrected', by: 'Offer Reviewer' });
    expect(o.review!.originalReading).toMatchObject({ title: before.title, salePrice: before.salePrice, originalPrice: before.originalPrice });
    expect(o.validTo).toBe('2031-01-31T23:59:59.000Z');
  });

  it('a second correction does not overwrite the machine’s original reading', async () => {
    await owner.post(`${base()}/offers/${correctId}/review`, { action: 'correct', salePrice: 3 });
    const o = (await flyerOffers()).find((x) => x.id === correctId)!;
    expect(o.salePrice).toBe(3);
    expect(o.review!.originalReading).toMatchObject({ title: before.title, salePrice: before.salePrice });
  });

  it('refuses impossible corrections with a reason', async () => {
    const notDiscount = await owner.post(`${base()}/offers/${correctId}/review`, { action: 'correct', salePrice: 9, originalPrice: 5 });
    expect(notDiscount.status).toBe(400);
    expect(notDiscount.body.error.code).toBe('invalid_prices');
    const dates = await owner.post(`${base()}/offers/${correctId}/review`, { action: 'correct', validFrom: '2031-02-01T00:00:00.000Z', validTo: '2031-01-01T00:00:00.000Z' });
    expect(dates.status).toBe(400);
    expect(dates.body.error.code).toBe('invalid_dates');
    expect((await owner.post(`${base()}/offers/${correctId}/review`, { action: 'correct', salePrice: -2 })).status).toBe(400);
    expect((await owner.post(`${base()}/offers/${correctId}/review`, { action: 'explode' })).status).toBe(400);
  });

  it('dismissing says "this is not an offer": it disappears from the offers list but stays findable', async () => {
    expect((await owner.post(`${base()}/offers/${dismissId}/review`, { action: 'dismiss', note: 'Not a price — a weight' })).status).toBe(200);
    expect((await flyerOffers()).some((o) => o.id === dismissId)).toBe(false);
    const dismissed = await flyerOffers('&review=dismissed');
    expect(dismissed.map((o) => o.id)).toEqual([dismissId]);
    expect(dismissed[0]!.review).toMatchObject({ status: 'dismissed', note: 'Not a price — a weight' });
  });

  it('collecting the same flyer again never overwrites a person’s verdict, and creates no duplicates', async () => {
    const count = async () => (await h.db.worker.select().from(offers).where(eq(offers.siteId, flyerSite))).filter((o) => o.kind === 'flyer').length;
    const total = await count();
    await h.db.worker.delete(flyers).where(eq(flyers.siteId, flyerSite)); // forces the flyer to be read again
    await scan(flyerSite);
    expect(await count()).toBe(total);
    const rows = await flyerOffers();
    expect(rows.find((o) => o.id === confirmId)!.review!.status).toBe('confirmed');
    const corrected = rows.find((o) => o.id === correctId)!;
    expect(corrected).toMatchObject({ title: 'Corrected title', salePrice: 3 });
    expect(corrected.review!.status).toBe('corrected');
    expect(rows.some((o) => o.id === dismissId)).toBe(false); // still dismissed
  });

  it('the "needs review" filter lists only readings nobody has looked at', async () => {
    const needs = await flyerOffers('&review=needs_review');
    expect(needs.every((o) => o.needsReview && o.review!.status === 'unreviewed')).toBe(true);
    expect(needs.some((o) => [confirmId, correctId, dismissId].includes(o.id))).toBe(false);
    const reviewed = await flyerOffers('&review=reviewed');
    expect(reviewed.map((o) => o.id).sort()).toEqual([confirmId, correctId].sort());
  });
});

describe('what cannot be reviewed, and who cannot review', () => {
  it('a sale price taken from the product’s own price is a catalogue fact, not a reading: no editing', async () => {
    const sale = (await owner.get(`${base()}/offers?kind=sale_price&days=90`)).body.offers as OfferView[];
    expect(sale.length).toBeGreaterThan(0);
    const r = await owner.post(`${base()}/offers/${sale[0]!.id}/review`, { action: 'dismiss' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('not_reviewable');
  });

  it('unknown offers are 404, and another workspace can neither see nor review these', async () => {
    expect((await owner.post(`${base()}/offers/00000000-0000-4000-8000-000000000000/review`, { action: 'confirm' })).status).toBe(404);
    const stranger = new ApiClient(app);
    await signUp(stranger, h, { email: `offers-stranger-${Date.now()}@example.test`, password: PASSWORD, displayName: 'S' });
    const strangerOrg = (await stranger.post('/api/v1/orgs', { name: 'Stranger Co' })).body.organization.id as string;
    const any = (await flyerOffers())[0]!;
    expect((await stranger.post(`/api/v1/orgs/${strangerOrg}/offers/${any.id}/review`, { action: 'dismiss' })).status).toBe(404);
    expect((await stranger.post(`${base()}/offers/${any.id}/review`, { action: 'dismiss' })).status).toBe(404);
    expect((await flyerOffers()).some((o) => o.id === any.id)).toBe(true);
  });
});
