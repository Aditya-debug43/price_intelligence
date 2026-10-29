import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { flyers, marketingActivities, offers, priceObservations, productMatches, products, scanRuns, siteProfiles, sites, variants, evidence } from '@ci/database';
import { ConsentRequiredError, SiteError, addSite, loadComparison, loadFxTable, ensureFxRates, runMatching, runProfile, startScan, decideMatch, getSite } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';
import { confirmSuggestions } from '../support/confirm.ts';

let h: Harness;
let t: Tenant;
const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await createHarness();
  t = await h.newTenant('Pipeline');
});
afterAll(async () => {
  await h.close();
});

const readDb = () => h.db.worker;
const runStatus = async (siteId: string) => (await readDb().select().from(scanRuns).where(eq(scanRuns.siteId, siteId)).orderBy(scanRuns.createdAt)).at(-1)!;

describe('1. workspace and website management', () => {
  it('accepts one source and up to five competitors, and rejects a sixth', async () => {
    ids.source = await t.addFixtureSite('source', 'source');
    for (const k of ['woo', 'jsonld', 'html', 'blocked', 'failing']) ids[k] = await t.addFixtureSite(k, 'competitor');
    await expect(t.tx((tx) => addSite(h.svc, tx, t.orgId, t.userId, { url: h.fixtures.origin('challenge'), role: 'competitor' }))).rejects.toMatchObject({ code: 'limit' });
    await expect(t.tx((tx) => addSite(h.svc, tx, t.orgId, t.userId, { url: h.fixtures.origin('login'), role: 'source' }))).rejects.toBeInstanceOf(SiteError);
  });

  it('rejects unsafe or malformed URLs at the API boundary', async () => {
    for (const url of ['http://169.254.169.254/', 'http://10.0.0.5/', 'ftp://shop.example.test', 'javascript:alert(1)', 'http://localhost.internal/']) {
      await expect(t.tx((tx) => addSite(h.svc, tx, t.orgId, t.userId, { url, role: 'competitor' }))).rejects.toBeInstanceOf(SiteError);
    }
    // A public-looking name that resolves to a private address (DNS rebinding style) is also refused.
    await expect(t.tx((tx) => addSite(h.svc, tx, t.orgId, t.userId, { url: 'https://sneaky.example', role: 'competitor' }))).rejects.toMatchObject({ code: 'unsafe' });
  });

  it('stores the website under its public hostname, with the customer’s confirmation', async () => {
    const [s] = await readDb().select().from(sites).where(eq(sites.id, ids.source!));
    expect(s!.hostname).toBe('mine.test');
    expect(s!.consentStatus).toBe('confirmed');
  });
});

describe('2. consent gate', () => {
  it('refuses to collect from a site until consent is recorded', async () => {
    const other = await h.newTenant('NoConsent');
    const siteId = await other.addFixtureSite('woo', 'competitor', false);
    await expect(other.tx((tx) => startScan(h.svc, tx, other.orgId, siteId, { kind: 'discovery', trigger: 'manual' }))).rejects.toBeInstanceOf(ConsentRequiredError);
    // profiling (a light, polite look) is still possible and clearly separate from collection
    const profile = await runProfile(h.svc, other.orgId, siteId);
    expect(profile.status).toBe('full');
    expect(await readDb().select().from(products).where(eq(products.siteId, siteId))).toHaveLength(0);
  });
});

describe('3. profiling persists a capability report per site', () => {
  it('stores timestamped profiles with the expected plain-language statuses', async () => {
    const expected: Record<string, string> = { source: 'full', woo: 'full', jsonld: 'full', html: 'partial', blocked: 'blocked', failing: 'failed' };
    for (const [key, status] of Object.entries(expected)) {
      const p = await runProfile(h.svc, t.orgId, ids[key]!);
      expect(p.status, key).toBe(status);
      const [site] = await readDb().select().from(sites).where(eq(sites.id, ids[key]!));
      expect(site!.capabilityStatus).toBe(status);
      expect(site!.lastProfiledAt).toBeTruthy();
    }
    const stored = await readDb().select().from(siteProfiles).where(eq(siteProfiles.siteId, ids.jsonld!));
    expect(stored).toHaveLength(1);
    expect(stored[0]!.data.strategy.primary).toBe('sitemap-structured-data');
    const [src] = await readDb().select().from(sites).where(eq(sites.id, ids.source!));
    expect(src!.currency).toBe('AWG'); // detected, not assumed
    const [woo] = await readDb().select().from(sites).where(eq(sites.id, ids.woo!));
    expect(woo!.currency).toBe('USD');
  });
});

describe('4. collection', () => {
  it('collects every supported site, and reports blocked / failed sites as such (never as empty catalogues)', async () => {
    for (const key of ['source', 'woo', 'jsonld', 'html', 'blocked', 'failing']) {
      await t.tx((tx) => startScan(h.svc, tx, t.orgId, ids[key]!, { kind: 'discovery', trigger: 'manual' }));
    }
    await h.queue.drain();

    const src = await runStatus(ids.source!);
    expect(src).toMatchObject({ status: 'succeeded', isComplete: true, connector: 'shopify-products-json' });
    expect(src.productsSaved).toBe(32);

    expect(await runStatus(ids.woo!)).toMatchObject({ status: 'succeeded', isComplete: true, connector: 'woocommerce-store-api' });
    const jsonld = await runStatus(ids.jsonld!);
    expect(jsonld).toMatchObject({ status: 'succeeded', isComplete: true, connector: 'sitemap-structured-data' });
    expect(jsonld.productsSaved).toBe(h.fixtures.sites.jsonld!.products.length);
    expect(await runStatus(ids.html!)).toMatchObject({ status: 'succeeded', connector: 'html-generic' });

    const blocked = await runStatus(ids.blocked!);
    expect(blocked.status).toBe('blocked');
    expect(blocked.productsSaved).toBe(0);
    expect(blocked.error).toMatch(/robots/i);
    const failing = await runStatus(ids.failing!);
    expect(failing.status).toBe('failed');
    expect(failing.error).toMatch(/not an empty catalogue|temporary|technical/i);
  });

  it('stores products, variants and append-only observations with provenance', async () => {
    const prods = await readDb().select().from(products).where(eq(products.siteId, ids.jsonld!));
    expect(prods.length).toBe(h.fixtures.sites.jsonld!.products.length);
    const [obs] = await readDb().select().from(priceObservations).where(eq(priceObservations.siteId, ids.jsonld!)).limit(1);
    expect(obs!.sourceUrl).toMatch(/^http:\/\/rival-ld\.test\/p\//);
    expect(obs!.extractionMethod).toBe('json_ld');
    expect(obs!.provenance).toBe('public_web');
    expect(obs!.evidenceId).toBeTruthy();
    const [ev] = await readDb().select().from(evidence).where(eq(evidence.id, obs!.evidenceId!));
    expect(ev!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev!.snapshotRef).toBeTruthy();
    expect(await h.storage.exists(ev!.snapshotRef!)).toBe(true);
    // unknown values are null — nothing silently became 0 or "in stock"
    const unknown = await readDb().select().from(variants).where(and(eq(variants.siteId, ids.woo!), eq(variants.availability, 'unknown')));
    expect(unknown.every((v) => v.price === null || v.price > 0)).toBe(true);
  });

  it('re-collecting keeps history instead of overwriting prices, and de-duplicates products', async () => {
    const before = await readDb().select().from(priceObservations).where(eq(priceObservations.siteId, ids.woo!));
    const target = h.fixtures.sites.woo!.products[2]!;
    const oldPrice = target.price;
    h.fixtures.sites.woo!.setPrice(target.itemId, oldPrice + 1);
    h.advance(24 * 3_600_000);
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, ids.woo!, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    const after = await readDb().select().from(priceObservations).where(eq(priceObservations.siteId, ids.woo!));
    expect(after.length).toBe(before.length * 2);
    const prods = await readDb().select().from(products).where(eq(products.siteId, ids.woo!));
    expect(prods.length).toBe(h.fixtures.sites.woo!.products.length); // no duplicate products
    const [v] = await readDb().select().from(variants).innerJoin(products, eq(products.id, variants.productId)).where(and(eq(variants.siteId, ids.woo!), eq(products.title, target.title)));
    expect(v!.variants.price).toBeCloseTo(oldPrice + 1, 2);
    expect(v!.variants.lastPriceChangeAt).toBeTruthy();
    h.fixtures.sites.woo!.setPrice(target.itemId, oldPrice); // restore
    h.advance(-24 * 3_600_000);
  });

  it('a small live refresh fetches a handful of products without claiming a full catalogue', async () => {
    const { run } = await t.tx((tx) => startScan(h.svc, tx, t.orgId, ids.source!, { kind: 'sample', trigger: 'manual', limit: 5 }));
    await h.queue.drain();
    const [r] = await readDb().select().from(scanRuns).where(eq(scanRuns.id, run.id));
    expect(r!.status).toBe('partial');
    expect(r!.isComplete).toBe(false);
    expect(r!.productsSaved).toBe(5);
    expect(r!.notes.join(' ')).toMatch(/small live refresh/i);
  });
});

describe('5. product matching and price comparison', () => {
  let matchResult: Awaited<ReturnType<typeof runMatching>>;
  it('matches products across sites into the four classes with confidence and reasons', async () => {
    matchResult = await runMatching(h.svc, readDb(), t.orgId);
    await confirmSuggestions(readDb(), t.orgId);
    expect(matchResult.byClass.identical).toBeGreaterThan(20);
    expect(matchResult.byClass.different_pack).toBeGreaterThan(0);
    const rows = await readDb().select().from(productMatches).where(eq(productMatches.orgId, t.orgId));
    expect(rows.every((m) => m.confidence > 0 && m.confidence <= 1 && m.reasons.length > 0)).toBe(true);
    // name-only identity is never as certain as an identifier match
    const nameOnly = rows.filter((m) => m.method === 'attributes');
    expect(Math.max(...nameOnly.map((m) => m.confidence))).toBeLessThanOrEqual(0.9);
    // GTIN-based matches exist where the competitor publishes a valid GTIN... only when both sides have one; source has none here
    expect(rows.filter((m) => m.method === 'gtin')).toHaveLength(0);
    // nothing from the blocked/failing sites
    expect(rows.some((m) => m.competitorSiteId === ids.blocked || m.competitorSiteId === ids.failing)).toBe(false);
  });

  it('never calls products from different brands identical', async () => {
    const rows = await readDb()
      .select({ cls: productMatches.matchClass, a: products.brand })
      .from(productMatches)
      .innerJoin(variants, eq(variants.id, productMatches.sourceVariantId))
      .innerJoin(products, eq(products.id, variants.productId))
      .where(eq(productMatches.orgId, t.orgId));
    expect(rows.length).toBeGreaterThan(0);
    const pairs = await readDb().execute(`
      select m.match_class, ps.brand as sb, pc.brand as cb
      from product_matches m
      join variants vs on vs.id = m.source_variant_id join products ps on ps.id = vs.product_id
      join variants vc on vc.id = m.competitor_variant_id join products pc on pc.id = vc.product_id
      where m.org_id = '${t.orgId}' and m.match_class = 'identical' and ps.brand is not null and pc.brand is not null and lower(ps.brand) <> lower(pc.brand)` as never);
    expect((pairs as unknown as { rows: unknown[] }).rows).toHaveLength(0);
  });

  it('computes price differences in the backend with original and normalised amounts and FX provenance', async () => {
    await ensureFxRates(h.svc);
    const fx = await loadFxTable(readDb());
    const cmp = await loadComparison(readDb(), { orgId: t.orgId, reportingCurrency: 'USD', fx, now: h.svc.clock(), staleAfterHours: 36 });
    expect(cmp.length).toBeGreaterThan(15);
    const row = cmp.find((r) => r.title === 'Heinz Tomato Ketchup 397g')!;
    expect(row).toBeTruthy();
    const sourceFix = h.fixtures.sites.source!.find(9)!;
    expect(row.sourcePrice).toMatchObject({ amount: sourceFix.price, currency: 'AWG', normalizedCurrency: 'USD', fxSource: expect.stringContaining('Central Bank of Aruba') });
    expect(row.sourcePrice.normalized).toBeCloseTo(sourceFix.price / 1.79, 3);

    const woo = row.cells.find((c) => c.siteName.includes('Mart'))!;
    const wooFix = h.fixtures.sites.woo!.find(9)!;
    expect(woo.price).toMatchObject({ amount: wooFix.price, currency: 'USD' });
    const expectedPct = ((wooFix.price - sourceFix.price / 1.79) / (sourceFix.price / 1.79)) * 100;
    expect(woo.diffPct).toBeCloseTo(expectedPct, 1);
    expect(woo.matchClass).toBe('identical');
    expect(woo.url).toMatch(/\/product\//); // evidence link

    const json = row.cells.find((c) => c.siteName.includes('Superstore'))!;
    const jsonFix = h.fixtures.sites.jsonld!.find(9)!;
    expect(json.diffPct).toBeCloseTo(((jsonFix.price - sourceFix.price) / sourceFix.price) * 100, 1); // same currency: ratio unaffected by FX
    expect(row.position).not.toBe('no_data');

    // different pack sizes are compared by unit price, never as a shelf-price difference
    const pack = cmp.flatMap((r) => r.cells.filter((c) => c.matchClass === 'different_pack'));
    expect(pack.length).toBeGreaterThan(0);
    expect(pack.every((c) => !c.directlyComparable && c.caveats.some((x) => /unit price/i.test(x)))).toBe(true);
    expect(pack.some((c) => c.unitDiffPct !== null)).toBe(true);
  });

  it('keeps human decisions across re-matching', async () => {
    const accepted = await readDb().select().from(productMatches).where(and(eq(productMatches.orgId, t.orgId), eq(productMatches.status, 'accepted'), eq(productMatches.matchClass, 'identical')));
    expect(accepted.length).toBeGreaterThan(10);
    const m = accepted[0]!;
    await t.tx((tx) => decideMatch(tx, t.orgId, m.id, t.userId, { decision: 'reject' }, h.svc.clock()));
    await runMatching(h.svc, readDb(), t.orgId);
    const [after] = await readDb().select().from(productMatches).where(eq(productMatches.id, m.id));
    expect(after).toMatchObject({ status: 'rejected', matchClass: 'not_comparable', decidedBy: t.userId });
    // every other confirmation is still there after the run
    const still = await readDb().select().from(productMatches).where(and(eq(productMatches.orgId, t.orgId), eq(productMatches.status, 'accepted')));
    expect(still.length).toBeGreaterThanOrEqual(accepted.length - 1);
    const other = await h.newTenant('Intruder');
    await expect(other.tx((tx) => decideMatch(tx, other.orgId, m.id, other.userId, { decision: 'accept' }, h.svc.clock()))).rejects.toThrow(/not found/i);
  });
});

describe('6. offers, promotions and flyers', () => {
  it('tracks sale prices with explicit, honest history verification', async () => {
    const sale = await readDb().select().from(offers).where(and(eq(offers.siteId, ids.source!), eq(offers.kind, 'sale_price')));
    expect(sale.length).toBe(2);
    for (const o of sale) {
      expect(o.originalPrice).toBeGreaterThan(o.salePrice!);
      expect(o.claimedDiscountPct).toBeGreaterThan(0);
      expect(o.verification).toBe('unverified'); // no earlier history ⇒ the claim is not called "verified"
      expect(o.historicalDiscountPct).toBeNull();
      expect(o.verificationReason).toBeTruthy();
    }
    const wooSale = await readDb().select().from(offers).where(and(eq(offers.siteId, ids.woo!), eq(offers.kind, 'sale_price')));
    expect(wooSale.length).toBe(2);
  });

  it('detects banner offers with conditions and discount codes', async () => {
    const jsonld = await readDb().select().from(offers).where(and(eq(offers.siteId, ids.jsonld!), eq(offers.extractionMethod, 'public_banner')));
    const code = jsonld.find((o) => o.code === 'FRESH10')!;
    expect(code).toBeTruthy();
    expect(code.conditional).toBe(true);
    expect(code.conditions.join(' ')).toMatch(/FRESH10/);
    const src = await readDb().select().from(offers).where(and(eq(offers.siteId, ids.source!), eq(offers.extractionMethod, 'public_banner')));
    expect(src.some((o) => o.kind === 'free_shipping' && o.conditional)).toBe(true);
  });

  it('reads the text-layer flyer PDF into reviewable offers with validity dates', async () => {
    const f = await readDb().select().from(flyers).where(eq(flyers.siteId, ids.jsonld!));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ status: 'extracted' });
    expect(f[0]!.itemsFound).toBeGreaterThanOrEqual(4);
    const items = await readDb().select().from(offers).where(and(eq(offers.siteId, ids.jsonld!), eq(offers.kind, 'flyer')));
    expect(items.length).toBe(f[0]!.itemsFound);
    expect(items.every((i) => i.confidence !== null && i.confidence < 1 && i.sourceUrl?.endsWith('.pdf'))).toBe(true);
    expect(items.every((i) => i.validTo !== null)).toBe(true);
    expect(items.some((i) => i.originalPrice !== null && i.salePrice !== null)).toBe(true);
    // re-reading the same unchanged flyer creates nothing new
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, ids.jsonld!, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    expect(await readDb().select().from(flyers).where(eq(flyers.siteId, ids.jsonld!))).toHaveLength(1);
  });

  it('records observed marketing content without calling it a paid campaign', async () => {
    const m = await readDb().select().from(marketingActivities).where(eq(marketingActivities.orgId, t.orgId));
    expect(m.length).toBeGreaterThan(3);
    expect(m.some((x) => x.kind === 'announcement_bar')).toBe(true);
    expect(m.some((x) => x.kind === 'flyer')).toBe(true);
    expect(m.every((x) => x.provenance === 'public_web')).toBe(true);
  });

  it('a product missing from a COMPLETE feed scan is only called delisted after two misses', async () => {
    const victim = h.fixtures.sites.source!.products[5]!;
    h.fixtures.sites.source!.remove(victim.itemId);
    const scan = async () => {
      await t.tx((tx) => startScan(h.svc, tx, t.orgId, ids.source!, { kind: 'discovery', trigger: 'manual' }));
      await h.queue.drain();
    };
    await scan();
    let [p] = await readDb().select().from(products).where(and(eq(products.siteId, ids.source!), eq(products.title, victim.title)));
    expect(p!.missedCompleteScans).toBe(1);
    expect(p!.delistedAt).toBeNull(); // one miss is not enough to claim a delisting
    await scan();
    [p] = await readDb().select().from(products).where(and(eq(products.siteId, ids.source!), eq(products.title, victim.title)));
    expect(p!.missedCompleteScans).toBe(2);
    expect(p!.delistedAt).toBeTruthy();
    // it reappears: counters reset, no longer delisted
    h.fixtures.sites.source!.restore(victim.itemId);
    await scan();
    [p] = await readDb().select().from(products).where(and(eq(products.siteId, ids.source!), eq(products.title, victim.title)));
    expect(p).toMatchObject({ missedCompleteScans: 0, delistedAt: null });
  });

  it('a 404 on a known product page is direct evidence of delisting; a PARTIAL scan never infers one', async () => {
    const victim = h.fixtures.sites.jsonld!.products[3]!;
    h.fixtures.sites.jsonld!.remove(victim.itemId);
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, ids.jsonld!, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    const [p] = await readDb().select().from(products).where(and(eq(products.siteId, ids.jsonld!), eq(products.title, victim.title)));
    expect(p!.delistedAt).toBeTruthy();
    h.fixtures.sites.jsonld!.restore(victim.itemId);

    // a sample (partial) run over the feed never advances missed-scan counters
    const other = h.fixtures.sites.source!.products[7]!;
    const [before] = await readDb().select().from(products).where(and(eq(products.siteId, ids.source!), eq(products.title, other.title)));
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, ids.source!, { kind: 'sample', trigger: 'manual', limit: 3 }));
    await h.queue.drain();
    const [after] = await readDb().select().from(products).where(and(eq(products.siteId, ids.source!), eq(products.title, other.title)));
    expect(after!.missedCompleteScans).toBe(before!.missedCompleteScans);
  });
});

describe('7. tenant isolation of everything above', () => {
  it('another workspace sees none of it, at the service and the database level', async () => {
    const other = await h.newTenant('Neighbour');
    await expect(other.tx((tx) => getSite(tx, other.orgId, ids.source!))).rejects.toMatchObject({ code: 'not_found' });
    for (const table of [sites, products, variants, offers, productMatches, marketingActivities, priceObservations, scanRuns]) {
      expect(await other.tx((tx) => tx.select().from(table))).toHaveLength(0);
    }
  });
});
