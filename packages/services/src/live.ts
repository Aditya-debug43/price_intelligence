import { and, desc, eq, gte, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { assortmentBasis, assortmentNote, summariseMarketing, type MarketingSummary } from '@ci/core';
import { DEFAULTS, type AssortmentBasis, type AssortmentEntry, type Availability, type MarketingRow, type OfferRow, type SiteCoverage, type StockRow, type StockState } from '@ci/shared';
import { marketingActivities, offers, orgSettings, productMatches, products, scanRuns, sites, socialAccounts, stockStates, users, variants, type DbLike } from '@ci/database';

/**
 * Live (current-state) views of offers, own stock and marketing. The report builder snapshots exactly these
 * functions, and the API serves them for the interactive pages, so both always agree on definitions.
 */

export interface SiteMaps {
  rows: (typeof sites.$inferSelect)[];
  source: typeof sites.$inferSelect | undefined;
  name: Map<string, string>;
  role: Map<string, 'source' | 'competitor'>;
}

export async function loadSiteMaps(db: DbLike, orgId: string): Promise<SiteMaps> {
  const rows = await db.select().from(sites).where(and(eq(sites.orgId, orgId), eq(sites.active, true)));
  return { rows, source: rows.find((s) => s.role === 'source'), name: new Map(rows.map((s) => [s.id, s.name])), role: new Map(rows.map((s) => [s.id, s.role])) };
}

/** Offers seen recently. Ones a person has dismissed as misreadings are not offers, so they are left out unless asked for. */
export async function loadOffers(db: DbLike, orgId: string, now: Date, maps: SiteMaps, opts: { days?: number; limit?: number; includeDismissed?: boolean } = {}): Promise<OfferRow[]> {
  const since = new Date(now.getTime() - (opts.days ?? 14) * 86_400_000);
  const conds = [eq(offers.orgId, orgId), gte(offers.lastSeenAt, since)];
  if (!opts.includeDismissed) conds.push(ne(offers.reviewStatus, 'dismissed'));
  const rows = await db.select().from(offers).where(and(...conds)).orderBy(desc(offers.lastSeenAt)).limit(opts.limit ?? 600);
  const reviewerIds = [...new Set(rows.map((o) => o.reviewedBy).filter((x): x is string => !!x))];
  const reviewers = new Map(reviewerIds.length ? (await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, reviewerIds))).map((u) => [u.id, u.name]) : []);
  return rows
    .filter((o) => maps.name.has(o.siteId))
    .map((o) => ({
      id: o.id, siteId: o.siteId, siteName: maps.name.get(o.siteId)!, siteRole: maps.role.get(o.siteId)!, kind: o.kind, title: o.title, description: o.description, conditions: o.conditions, conditional: o.conditional,
      code: o.code, productTitle: o.productTitle, variantId: o.variantId, originalPrice: o.originalPrice, salePrice: o.salePrice, currency: o.currency, claimedDiscountPct: o.claimedDiscountPct,
      historicalDiscountPct: o.historicalDiscountPct, verification: o.verification, validFrom: o.validFrom?.toISOString() ?? null, validTo: o.validTo?.toISOString() ?? null,
      firstSeenAt: o.firstSeenAt.toISOString(), lastSeenAt: o.lastSeenAt.toISOString(), status: o.status, sourceUrl: o.sourceUrl, needsReview: o.needsReview, confidence: o.confidence, provenance: o.provenance,
      evidenceId: o.evidenceId,
      review: { status: o.reviewStatus, by: o.reviewedBy ? (reviewers.get(o.reviewedBy) ?? null) : null, at: o.reviewedAt?.toISOString() ?? null, note: o.reviewNote, originalReading: o.originalReading },
    }));
}

export interface StockView {
  rows: StockRow[];
  counts: { low: number; out: number; unknown: number; in: number };
  /** Items — variants, the things a customer can buy. The counts above are per item. */
  total: number;
  /** The distinct products those items belong to (a product can have several variants, e.g. a gift card in five amounts). */
  products: number;
  /**
   * What the counts cover. Shelfwatch reads the PUBLIC website: `listedPublicly` is how many products the website itself lists (its product sitemaps / feed) at the last collection,
   * and `complete` says whether that collection reached all of them. A store's own admin total can be higher (drafts, archived products and products not sold on the website are not published).
   * Null when the website has not been collected yet.
   */
  coverage: { listedPublicly: number | null; complete: boolean; checkedAt: string | null } | null;
}

/**
 * The customer's OWN stock. Quantities appear only when they came from an authorised source or an explicit public
 * claim; otherwise `quantity` is null. In-stock rows are omitted unless `includeInStock` is set.
 */
export async function loadStock(db: DbLike, now: Date, maps: SiteMaps, threshold: number, opts: { includeInStock?: boolean; limit?: number; staleHours?: number } = {}): Promise<StockView> {
  const out: StockView = { rows: [], counts: { low: 0, out: 0, unknown: 0, in: 0 }, total: 0, products: 0, coverage: null };
  const source = maps.source;
  if (!source) return out;
  const staleHours = opts.staleHours ?? DEFAULTS.staleAfterHours;
  const rows = await db
    .select({
      id: variants.id, productId: variants.productId, title: products.title, vTitle: variants.title, sku: variants.sku, url: variants.url, availability: variants.availability, observedAt: variants.observedAt,
      vThreshold: variants.lowStockThreshold, state: stockStates.state, stateQty: stockStates.quantity, stateQtySource: stockStates.quantitySource, lastChangeAt: stockStates.lastChangeAt,
    })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(stockStates, eq(stockStates.variantId, variants.id))
    .where(and(eq(variants.siteId, source.id), isNull(products.delistedAt)));
  out.total = rows.length;
  out.products = new Set(rows.map((r) => r.productId)).size;
  // what the website lists publicly, as recorded by its latest finished collection (the same figure the collection result reports)
  const [last] = await db.select({ estimatedTotal: scanRuns.estimatedTotal, isComplete: scanRuns.isComplete, finishedAt: scanRuns.finishedAt }).from(scanRuns)
    .where(and(eq(scanRuns.siteId, source.id), eq(scanRuns.kind, 'discovery'), isNotNull(scanRuns.finishedAt))).orderBy(desc(scanRuns.createdAt)).limit(1);
  if (last) out.coverage = { listedPublicly: last.estimatedTotal ?? null, complete: last.isComplete === true, checkedAt: last.finishedAt?.toISOString() ?? null };
  for (const r of rows) {
    const state: StockState = (r.state as StockState | null) ?? 'unknown';
    out.counts[state === 'low_stock' ? 'low' : state === 'out_of_stock' ? 'out' : state === 'unknown' ? 'unknown' : 'in']++;
    const qty = r.stateQtySource === 'authorised_inventory' || r.stateQtySource === 'public_claim' ? r.stateQty : null;
    // An authorised quantity outranks the public flag, but when the two disagree the owner needs to know (e.g. the product page says sold out while inventory holds units).
    const fromInventory = r.stateQtySource === 'authorised_inventory';
    const conflict = fromInventory && qty !== null && ((qty > 0 && r.availability === 'out_of_stock') || (qty <= 0 && r.availability === 'in_stock'));
    if (state === 'in_stock' && !opts.includeInStock && !conflict) continue;
    const obs = r.observedAt?.toISOString() ?? null;
    out.rows.push({
      variantId: r.id, productId: r.productId, title: r.vTitle && r.vTitle !== 'Default Title' ? `${r.title} (${r.vTitle})` : r.title, variantTitle: r.vTitle, sku: r.sku, url: r.url, state,
      availability: r.availability as Availability, quantity: qty, quantitySource: qty !== null ? r.stateQtySource : null, threshold: r.vThreshold ?? threshold, observedAt: obs,
      stale: !obs || now.getTime() - new Date(obs).getTime() > staleHours * 3_600_000, lastChangeAt: r.lastChangeAt?.toISOString() ?? null,
      conflict,
      note: conflict ? `Your public page says "${r.availability === 'out_of_stock' ? 'out of stock' : 'in stock'}" but your inventory shows ${qty} unit${qty === 1 ? '' : 's'}. Check that the product page matches your stock.` : state === 'unknown' ? 'Availability not published by your site' : qty === null && state === 'low_stock' ? 'Limited availability flagged by your site; unit count unknown' : null,
    });
  }
  const order: Record<StockState, number> = { out_of_stock: 0, low_stock: 1, unknown: 2, in_stock: 3 };
  out.rows.sort((a, b) => order[a.state] - order[b.state] || a.title.localeCompare(b.title));
  if (opts.limit) out.rows.splice(opts.limit);
  return out;
}

export async function loadMarketing(db: DbLike, orgId: string, now: Date, maps: SiteMaps, opts: { days?: number; limit?: number } = {}): Promise<MarketingRow[]> {
  const since = new Date(now.getTime() - (opts.days ?? 30) * 86_400_000);
  const rows = await db.select().from(marketingActivities).where(and(eq(marketingActivities.orgId, orgId), gte(marketingActivities.lastSeenAt, since))).orderBy(desc(marketingActivities.lastSeenAt)).limit(opts.limit ?? 300);
  return rows
    .filter((m) => maps.name.has(m.siteId))
    .map((m) => ({
      id: m.id, siteId: m.siteId, siteName: maps.name.get(m.siteId)!, platform: m.platform, kind: m.kind, title: m.title, excerpt: m.excerpt, url: m.url, publishedAt: m.publishedAt?.toISOString() ?? null,
      firstSeenAt: m.firstSeenAt.toISOString(), lastSeenAt: m.lastSeenAt.toISOString(), classification: m.classification, confidence: m.confidence, provenance: m.provenance, paidStatus: 'not_determined' as const,
      engagement: m.engagement ? { ...m.engagement, observedAt: m.engagementObservedAt?.toISOString() ?? m.lastSeenAt.toISOString() } : null,
      note: 'Publicly observed content. This is not evidence that a paid advertising campaign is running.',
    }));
}

/**
 * Products with no confirmed-or-pending equivalent on the other side. "Unmatched" means no equivalent was FOUND among the
 * collected catalogues — it does not prove the product is absent from the market.
 */
export async function loadAssortment(db: DbLike, orgId: string, maps: SiteMaps, coverage: SiteCoverage[]): Promise<{ competitorOnly: AssortmentEntry[]; sourceOnly: AssortmentEntry[]; basis: AssortmentBasis; note: string }> {
  const competitorIds = maps.rows.filter((s) => s.role === 'competitor').map((s) => s.id);
  // only the sites of this workspace that are being tracked count: a removed or paused competitor says nothing either way
  const basis = assortmentBasis(coverage.filter((c) => maps.rows.some((s) => s.id === c.siteId)));
  const matched = await db
    .select({ s: productMatches.sourceVariantId, c: productMatches.competitorVariantId })
    .from(productMatches)
    .where(and(eq(productMatches.orgId, orgId), ne(productMatches.status, 'rejected'), ne(productMatches.matchClass, 'not_comparable'), isNull(productMatches.supersededAt)));
  const matchedSource = new Set(matched.map((m) => m.s));
  const matchedComp = new Set(matched.map((m) => m.c));
  const all = await db
    .select({ id: variants.id, siteId: variants.siteId, title: products.title, category: products.category, price: variants.price, currency: variants.currency, firstSeenAt: variants.firstSeenAt, url: variants.url })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(and(eq(variants.orgId, orgId), isNull(products.delistedAt)));
  const entry = (v: (typeof all)[number]): AssortmentEntry => ({ siteId: v.siteId, siteName: maps.name.get(v.siteId) ?? '', variantId: v.id, title: v.title, category: v.category, price: v.price, currency: v.currency, firstSeenAt: v.firstSeenAt.toISOString(), url: v.url });
  return {
    competitorOnly: all.filter((v) => competitorIds.includes(v.siteId) && !matchedComp.has(v.id)).map(entry),
    sourceOnly: maps.source ? all.filter((v) => v.siteId === maps.source!.id && !matchedSource.has(v.id)).map(entry) : [],
    basis,
    note: assortmentNote(basis, competitorIds.length),
  };
}

/**
 * What the observed marketing activity shows, per competitor: volume, mix, recurring themes, brands mentioned in promotions, promotional
 * timing (only with enough dated items) and the most engaged posts — plus, for each competitor, exactly what could not be seen.
 */
export async function loadMarketingSummary(db: DbLike, orgId: string, now: Date, maps: SiteMaps, opts: { days?: number } = {}): Promise<MarketingSummary> {
  const days = opts.days ?? 30;
  const activity = await loadMarketing(db, orgId, now, maps, { days, limit: 1000 });
  const [settings] = await db.select({ tz: orgSettings.timezone }).from(orgSettings).where(eq(orgSettings.orgId, orgId));
  const brandRows = await db.selectDistinct({ brand: products.brand }).from(products).where(and(eq(products.orgId, orgId), isNotNull(products.brand)));
  const accounts = await db.select({ siteId: socialAccounts.siteId, platform: socialAccounts.platform, handle: socialAccounts.handle, confirmed: socialAccounts.confirmed, lastSyncStatus: socialAccounts.lastSyncStatus, lastSyncMessage: socialAccounts.lastSyncMessage }).from(socialAccounts).where(eq(socialAccounts.orgId, orgId));
  return summariseMarketing(
    activity.map((m) => ({ siteId: m.siteId, siteName: m.siteName, platform: m.platform, kind: m.kind, title: m.title, excerpt: m.excerpt, url: m.url, classification: m.classification, publishedAt: m.publishedAt, firstSeenAt: m.firstSeenAt, engagement: m.engagement ?? null })),
    { now, windowDays: days, timeZone: settings?.tz ?? 'America/Aruba', brands: brandRows.map((b) => b.brand!).filter(Boolean), accounts, competitors: maps.rows.filter((r) => r.role === 'competitor').map((r) => ({ id: r.id, name: r.name })) },
  );
}
