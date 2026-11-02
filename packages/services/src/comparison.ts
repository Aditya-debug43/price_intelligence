import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { assessQuantities, buildPriceView, measureStored, roundMoney, type FxTable } from '@ci/core';
import { formatMoney, relationshipOfClass, type Availability, type ComparisonCell, type ComparisonRow, type MatchClass, type MatchRelationship, type MatchStatus, type PriceView, type QuantityCheck, type UnitPriceView } from '@ci/shared';
import { offers, productMatches, products, sites, variants, type DbLike } from '@ci/database';
import { productPageLink } from './source-url.ts';

/**
 * Which relationships a comparison draws on. The default view holds only the same product (exact) and the same product in another pack, size or colour (variant). Substitutes and related
 * products have their own views and are never shown as identical products. By default only confirmed pairs (by a person, or automatically under a workspace's auto-confirmation setting)
 * are used; with `include: 'suggested'` the matcher's current suggestions are added, each carrying `confirmation: 'suggested'`, and they never count towards a price position.
 * Non-matches and pairs without enough evidence appear in no view.
 *
 * The quantity-compatibility policy (core/quantity-policy.ts) is enforced here, before any price is read: a pair whose two products hold DIFFERENT actual quantities (10 L against 20 L, 500 g
 * against 1 kg, a pack of 6 against 12) is left out of the price and substitute views whatever its status, a person’s confirmation included (the confirmation itself is untouched). Prices are
 * never converted into a price per litre, per kilogram or per item to make such products comparable. A pair whose quantity is not stated on one side is not treated as a match: an automatic
 * confirmation is not a direct comparison, a person’s own confirmation still is.
 *
 * The bundle-contents policy (core/match/bundle.ts) works through the same marker: two bundles (combos, kits) whose contents differ are left out; bundles whose contents are not established are
 * labelled, and an automatic confirmation of them is not a direct comparison either.
 */
export type ComparisonView = 'prices' | 'substitutes' | 'related';

export interface ComparisonOptions {
  view?: ComparisonView;
  /** 'confirmed' (default): only pairs a person or the matcher's auto-confirmation policy confirmed. 'suggested': also the matcher's suggestions nobody has confirmed, each labelled as such. */
  include?: 'confirmed' | 'suggested';
  orgId: string;
  reportingCurrency: string;
  fx: FxTable;
  now: Date;
  staleAfterHours: number;
}

const CLASS_RANK: Record<MatchClass, number> = { identical: 0, different_pack: 1, comparable: 2, not_comparable: 3 };
const STATUS_RANK: Record<MatchStatus, number> = { accepted: 0, auto: 1, needs_review: 2, rejected: 3 };
const TIER_RANK: Record<string, number> = { strong: 0, medium: 1 };

type VRow = {
  id: string; productId: string; siteId: string; title: string; variantTitle: string | null; brand: string | null; category: string | null; url: string; productUrl: string;
  price: number | null; compareAt: number | null; currency: string | null; availability: Availability; observedAt: Date | null; obsId: string | null; qtyKind: string | null; qtyTotal: number | null; qtyLabel: string | null;
  quantity: number | null; sku: string | null; delistedAt: Date | null;
};

/** Prices are not converted into a price per unit: the field stays (older saved reports carry it) but is never filled. */
const NO_UNIT_PRICE: UnitPriceView = { value: null, unit: null };

/** Variant + product rows for the given variant ids (current state). */
async function loadVariants(db: DbLike, ids: string[]): Promise<Map<string, VRow>> {
  const out = new Map<string, VRow>();
  for (let i = 0; i < ids.length; i += 800) {
    const part = ids.slice(i, i + 800);
    const rows = await db
      .select({
        id: variants.id, productId: variants.productId, siteId: variants.siteId, title: products.title, variantTitle: variants.title, brand: products.brand, category: products.category, url: variants.url,
        productUrl: products.canonicalUrl, price: variants.price, compareAt: variants.compareAtPrice, currency: variants.currency, availability: variants.availability, observedAt: variants.observedAt,
        obsId: variants.currentPriceObservationId, qtyKind: variants.qtyKind, qtyTotal: variants.qtyTotal, qtyLabel: variants.qtyLabel, quantity: variants.quantity, sku: variants.sku, delistedAt: products.delistedAt,
      })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(inArray(variants.id, part));
    for (const r of rows) out.set(r.id, r as VRow);
  }
  return out;
}

export async function loadComparison(db: DbLike, o: ComparisonOptions): Promise<ComparisonRow[]> {
  const siteRows = await db.select().from(sites).where(and(eq(sites.orgId, o.orgId), eq(sites.active, true)));
  const source = siteRows.find((s) => s.role === 'source');
  if (!source) return [];
  const siteName = new Map(siteRows.map((s) => [s.id, s.name]));
  const siteHost = new Map(siteRows.map((s) => [s.id, s.hostname]));
  // The link a customer may click to check this product at its own shop: the page it was collected from, or nothing.
  const pageLink = (v: VRow): string | null => productPageLink(v.url, siteHost.get(v.siteId));

  const which = o.view ?? 'prices';
  const classes: MatchClass[] = which === 'prices' ? ['identical', 'different_pack'] : which === 'substitutes' ? ['comparable'] : ['not_comparable'];
  const relationships: MatchRelationship[] = which === 'prices' ? ['exact', 'variant'] : which === 'substitutes' ? ['substitute'] : ['related'];
  const withSuggestions = o.include === 'suggested';
  // a pair is used when it is confirmed, or (only when suggestions are asked for) when it is a current suggestion with real evidence behind it (not one set aside, not an old record without evidence)
  const usable = withSuggestions
    ? or(eq(productMatches.status, 'accepted'), and(inArray(productMatches.status, ['needs_review', 'auto']), isNull(productMatches.supersededAt), inArray(productMatches.tier, ['strong', 'medium'])))
    : eq(productMatches.status, 'accepted');
  const matchRows = await db
    .select()
    .from(productMatches)
    .where(
      and(
        eq(productMatches.orgId, o.orgId),
        usable,
        inArray(productMatches.matchClass, classes),
        which === 'related' ? inArray(productMatches.relationship, relationships) : or(isNull(productMatches.relationship), inArray(productMatches.relationship, relationships)),
      ),
    );
  if (!matchRows.length) return [];
  const vmap = await loadVariants(db, [...new Set(matchRows.flatMap((m) => [m.sourceVariantId, m.competitorVariantId]))]);
  // what the quantity policy found for a pair: as recorded when it was judged, else from the sizes stored with the two products (a pair nobody has assessed in full)
  const qtyOf = (m: (typeof matchRows)[number]): QuantityCheck => {
    if (m.quantityCheck) return m.quantityCheck;
    const s = vmap.get(m.sourceVariantId);
    const c = vmap.get(m.competitorVariantId);
    return assessQuantities(measureStored(s?.qtyKind ?? null, s?.qtyTotal ?? null, s?.qtyLabel ?? null), measureStored(c?.qtyKind ?? null, c?.qtyTotal ?? null, c?.qtyLabel ?? null));
  };
  const leftOut = (m: (typeof matchRows)[number]): boolean => which !== 'related' && (m.priceExclusion !== null || qtyOf(m).exclusion !== null);

  // Active sale offers per variant, for the "offer" column.
  const saleOffers = await db.select().from(offers).where(and(eq(offers.orgId, o.orgId), eq(offers.status, 'active'), eq(offers.kind, 'sale_price')));
  const offerBy = new Map(saleOffers.filter((x) => x.variantId).map((x) => [x.variantId!, x]));

  // Delisted products are excluded from the live matrix.
  const live = (v: VRow | undefined): v is VRow => !!v && v.delistedAt === null;

  const bySource = new Map<string, typeof matchRows>();
  for (const m of matchRows) bySource.set(m.sourceVariantId, [...(bySource.get(m.sourceVariantId) ?? []), m]);

  const view = (v: VRow): PriceView =>
    buildPriceView({ amount: v.price, compareAt: v.compareAt, currency: v.currency, observedAt: v.observedAt, sourceUrl: pageLink(v), observationId: v.obsId }, o.reportingCurrency, o.fx, o.now, o.staleAfterHours);

  const rows: ComparisonRow[] = [];
  for (const [sourceVariantId, ms] of bySource) {
    const sv = vmap.get(sourceVariantId);
    if (!live(sv) || sv.siteId !== source.id) continue;
    const sourcePrice = view(sv);

    // Best match per competitor site: class, then reviewed status, then confidence.
    const bestBySite = new Map<string, (typeof matchRows)[number]>();
    for (const m of ms.filter((x) => !leftOut(x)).sort((a, b) => CLASS_RANK[a.matchClass] - CLASS_RANK[b.matchClass] || STATUS_RANK[a.status] - STATUS_RANK[b.status] || (TIER_RANK[a.tier ?? ''] ?? 2) - (TIER_RANK[b.tier ?? ''] ?? 2) || b.confidence - a.confidence)) {
      if (!bestBySite.has(m.competitorSiteId)) bestBySite.set(m.competitorSiteId, m);
    }
    const cells: ComparisonCell[] = [];
    for (const m of bestBySite.values()) {
      const cv = vmap.get(m.competitorVariantId);
      if (!live(cv)) continue;
      const price = view(cv);
      const q = qtyOf(m);
      const confirmation: 'person' | 'automatic' | 'suggested' = m.status === 'accepted' ? (m.autoConfirmedAt ? 'automatic' : 'person') : 'suggested';
      const bothPriced = price.normalized !== null && sourcePrice.normalized !== null && sourcePrice.normalized > 0 && which !== 'related';
      const diffAbs = bothPriced ? roundMoney(price.normalized! - sourcePrice.normalized!, 4) : null;
      const diffPct = bothPriced ? roundMoney(((price.normalized! - sourcePrice.normalized!) / sourcePrice.normalized!) * 100, 2) : null;
      const relationship: MatchRelationship = m.relationship ?? relationshipOfClass(m.matchClass);
      // a price conclusion needs the quantities shown equal; a person’s own confirmation also stands where a quantity is simply not stated (they could see the products)
      const quantityOk = q.verdict === 'same' || (q.verdict === 'unknown' && confirmation === 'person');
      const bc = m.bundleCheck ?? null;
      const bundleOk = !bc || bc.verdict === 'equivalent' || (bc.verdict === 'unknown' && confirmation === 'person');
      const directlyComparable = relationship === 'exact' && bothPriced && confirmation !== 'suggested' && quantityOk && bundleOk;
      // for a pair that is not a direct comparison the difference is shown only between equal quantities (so it is the plain price difference, never a per-unit one)
      const unitDiffPct = which !== 'related' && !directlyComparable && q.verdict === 'same' && bundleOk ? diffPct : null;
      // what differs, in the matcher's own words (older records carry only their reasons)
      const differences = (m.evidence?.items ?? []).filter((i) => i.effect === 'differs' || i.effect === 'conflicts').map((i) => i.text);
      const caveats: string[] = [];
      if (price.amount === null) caveats.push('Competitor price not available');
      else if (price.normalized === null) caveats.push(price.currency ? `No exchange rate for ${price.currency}` : 'Competitor currency unknown, so the price cannot be converted');
      if (sourcePrice.normalized === null && sourcePrice.amount !== null) caveats.push(sourcePrice.currency ? `No exchange rate for ${sourcePrice.currency}` : 'Your currency is unknown');
      if (price.stale) caveats.push('Competitor price is stale');
      if (m.needsReevaluation) caveats.push('A product changed after you confirmed this pair. Your confirmation stands; check that it still holds.');
      if (q.verdict === 'same' && q.packaging.differs) caveats.push(`The same total quantity, packaged differently (${q.a.label ?? '?'} vs ${q.b.label ?? '?'})`);
      if (q.verdict === 'unknown' && which !== 'related') caveats.push(`Quantity not verified: ${q.note.replace(/^Quantity (unknown|unclear): /, '')}. The price difference may not be like for like.`);
      if (bc?.verdict === 'unknown' && which !== 'related') caveats.push(`Bundle contents not verified: ${bc.note}. The price difference may not be like for like.`);
      if (confirmation === 'automatic' && (q.verdict !== 'same' || !bundleOk)) caveats.push('Not counted as a direct price comparison: the matcher confirmed it automatically but the quantities or the bundle contents are not shown to be equal.');
      if (m.matchClass === 'comparable') caveats.push('A substitute, not the same product: check the differences below');
      if (which === 'related') caveats.push('A related product that goes with yours: shown for context, not a replacement and not compared on price');
      if (confirmation === 'suggested') caveats.push('Suggested by the matcher; nobody has confirmed it yet');
      if (confirmation === 'automatic') caveats.push('Confirmed automatically by the matcher; you can overrule it in Match review');
      const offer = offerBy.get(cv.id);
      cells.push({
        siteId: cv.siteId, siteName: siteName.get(cv.siteId) ?? 'Competitor', variantId: cv.id, productId: cv.productId, title: cv.title, variantTitle: cv.variantTitle, url: pageLink(cv),
        matchId: m.id, matchClass: m.matchClass, matchStatus: m.status, relationship, tier: m.tier, confidence: m.confidence, reasons: m.reasons, differences, needsReevaluation: m.needsReevaluation, price, availability: cv.availability, unitPrice: NO_UNIT_PRICE,
        diffAbs, diffPct, unitDiffPct, directlyComparable, confirmation, quantity: { verdict: q.verdict, note: q.note, packagingDiffers: q.packaging.differs }, ...(bc ? { bundle: { verdict: bc.verdict, note: bc.note } } : {}),
        offerSummary: offer ? `On sale: was ${formatMoney(offer.originalPrice, offer.currency)}, now ${formatMoney(offer.salePrice, offer.currency)}${offer.claimedDiscountPct ? ` (claims ${offer.claimedDiscountPct}% off; ${offer.verification === 'verified' ? 'verified by history' : 'not historically verified'})` : ''}` : null,
        caveats,
      });
    }
    if (!cells.length) continue;
    cells.sort((a, b) => a.siteName.localeCompare(b.siteName));
    // Position among directly comparable identical prices only.
    const comparable = [sourcePrice.normalized, ...cells.filter((c) => c.directlyComparable).map((c) => c.price.normalized)].filter((x): x is number => x !== null);
    let position: ComparisonRow['position'] = 'no_data';
    if (which === 'prices' && sourcePrice.normalized !== null && cells.some((c) => c.directlyComparable)) {
      const min = Math.min(...comparable);
      const max = Math.max(...comparable);
      position = min === max ? 'tied' : sourcePrice.normalized === min ? 'cheapest' : sourcePrice.normalized === max ? 'highest' : 'middle';
    }
    rows.push({
      sourceVariantId, sourceProductId: sv.productId, title: sv.title, variantTitle: sv.variantTitle, brand: sv.brand, category: sv.category, sizeLabel: sv.qtyLabel, url: pageLink(sv),
      sourcePrice, sourceAvailability: sv.availability, sourceUnitPrice: NO_UNIT_PRICE, cells, position,
    });
  }
  rows.sort((a, b) => a.title.localeCompare(b.title));
  return rows;
}
