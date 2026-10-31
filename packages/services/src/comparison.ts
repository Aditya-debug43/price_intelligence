import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { buildPriceView, roundMoney, unitPrice, type FxTable } from '@ci/core';
import { formatMoney, relationshipOfClass, type Availability, type ComparisonCell, type ComparisonRow, type MatchClass, type MatchRelationship, type MatchStatus, type PriceView, type UnitPriceView } from '@ci/shared';
import { offers, productMatches, products, sites, variants, type DbLike } from '@ci/database';
import { productPageLink } from './source-url.ts';

/**
 * Which relationships a comparison draws on. The default view holds only the same product (exact) and the same product in another pack, size or colour (variant). Substitutes and related
 * products have their own views and are never shown as identical products. By default only confirmed pairs (by a person, or automatically under a workspace's auto-confirmation setting)
 * are used; with `include: 'suggested'` the matcher's current suggestions are added, each carrying `confirmation: 'suggested'`, and they never count towards a price position.
 * Non-matches and pairs without enough evidence appear in no view.
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

function unitView(price: PriceView, v: Pick<VRow, 'qtyKind' | 'qtyTotal'>, reporting: string): UnitPriceView {
  if (price.normalized === null || !v.qtyKind || !v.qtyTotal) return { value: null, unit: null };
  const up = unitPrice(price.normalized, { kind: v.qtyKind as 'mass' | 'volume' | 'count', total: v.qtyTotal, unitAmount: null, packCount: null, baseUnit: null, label: null, source: '' });
  void reporting;
  return up ? { value: roundMoney(up.value, 4), unit: up.unit } : { value: null, unit: null };
}

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
    const sourceUnit = unitView(sourcePrice, sv, o.reportingCurrency);

    // Best match per competitor site: class, then reviewed status, then confidence.
    const bestBySite = new Map<string, (typeof matchRows)[number]>();
    for (const m of [...ms].sort((a, b) => CLASS_RANK[a.matchClass] - CLASS_RANK[b.matchClass] || STATUS_RANK[a.status] - STATUS_RANK[b.status] || (TIER_RANK[a.tier ?? ''] ?? 2) - (TIER_RANK[b.tier ?? ''] ?? 2) || b.confidence - a.confidence)) {
      if (!bestBySite.has(m.competitorSiteId)) bestBySite.set(m.competitorSiteId, m);
    }
    const cells: ComparisonCell[] = [];
    for (const m of bestBySite.values()) {
      const cv = vmap.get(m.competitorVariantId);
      if (!live(cv)) continue;
      const price = view(cv);
      const unit = unitView(price, cv, o.reportingCurrency);
      const confirmation: 'person' | 'automatic' | 'suggested' = m.status === 'accepted' ? (m.autoConfirmedAt ? 'automatic' : 'person') : 'suggested';
      const bothPriced = price.normalized !== null && sourcePrice.normalized !== null && sourcePrice.normalized > 0 && which !== 'related';
      const diffAbs = bothPriced ? roundMoney(price.normalized! - sourcePrice.normalized!, 4) : null;
      const diffPct = bothPriced ? roundMoney(((price.normalized! - sourcePrice.normalized!) / sourcePrice.normalized!) * 100, 2) : null;
      const unitDiffPct = which !== 'related' && unit.value !== null && sourceUnit.value !== null && unit.unit === sourceUnit.unit && sourceUnit.value > 0 ? roundMoney(((unit.value - sourceUnit.value) / sourceUnit.value) * 100, 2) : null;
      const relationship: MatchRelationship = m.relationship ?? relationshipOfClass(m.matchClass);
      // what differs, in the matcher's own words (older records carry only their reasons)
      const differences = (m.evidence?.items ?? []).filter((i) => i.effect === 'differs' || i.effect === 'conflicts').map((i) => i.text);
      const caveats: string[] = [];
      if (price.amount === null) caveats.push('Competitor price not available');
      else if (price.normalized === null) caveats.push(price.currency ? `No exchange rate for ${price.currency}` : 'Competitor currency unknown, so the price cannot be converted');
      if (sourcePrice.normalized === null && sourcePrice.amount !== null) caveats.push(sourcePrice.currency ? `No exchange rate for ${sourcePrice.currency}` : 'Your currency is unknown');
      if (price.stale) caveats.push('Competitor price is stale');
      if (m.needsReevaluation) caveats.push('A product changed after you confirmed this pair. Your confirmation stands; check that it still holds.');
      if (m.matchClass === 'different_pack') caveats.push(`Different pack size (${sv.qtyLabel ?? '?'} vs ${cv.qtyLabel ?? '?'}); compare unit prices`);
      if (m.matchClass === 'comparable') caveats.push('A substitute, not the same product: check the differences below');
      if (which === 'related') caveats.push('A related product that goes with yours: shown for context, not a replacement and not compared on price');
      if (confirmation === 'suggested') caveats.push('Suggested by the matcher; nobody has confirmed it yet');
      if (confirmation === 'automatic') caveats.push('Confirmed automatically by the matcher; you can overrule it in Match review');
      const offer = offerBy.get(cv.id);
      cells.push({
        siteId: cv.siteId, siteName: siteName.get(cv.siteId) ?? 'Competitor', variantId: cv.id, productId: cv.productId, title: cv.title, variantTitle: cv.variantTitle, url: pageLink(cv),
        matchId: m.id, matchClass: m.matchClass, matchStatus: m.status, relationship, tier: m.tier, confidence: m.confidence, reasons: m.reasons, differences, needsReevaluation: m.needsReevaluation, price, availability: cv.availability, unitPrice: unit,
        diffAbs, diffPct, unitDiffPct, directlyComparable: relationship === 'exact' && bothPriced && confirmation !== 'suggested', confirmation,
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
      sourcePrice, sourceAvailability: sv.availability, sourceUnitPrice: sourceUnit, cells, position,
    });
  }
  rows.sort((a, b) => a.title.localeCompare(b.title));
  return rows;
}
