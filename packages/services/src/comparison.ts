import { and, eq, inArray, ne } from 'drizzle-orm';
import { buildPriceView, roundMoney, unitPrice, type FxTable } from '@ci/core';
import { formatMoney, type Availability, type ComparisonCell, type ComparisonRow, type MatchClass, type MatchStatus, type PriceView, type UnitPriceView } from '@ci/shared';
import { offers, productMatches, products, sites, variants, type DbLike } from '@ci/database';

export interface ComparisonOptions {
  orgId: string;
  reportingCurrency: string;
  fx: FxTable;
  now: Date;
  staleAfterHours: number;
}

const CLASS_RANK: Record<MatchClass, number> = { identical: 0, different_pack: 1, comparable: 2, not_comparable: 3 };
const STATUS_RANK: Record<MatchStatus, number> = { accepted: 0, auto: 1, needs_review: 2, rejected: 3 };

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

  const matchRows = await db
    .select()
    .from(productMatches)
    .where(and(eq(productMatches.orgId, o.orgId), ne(productMatches.status, 'rejected'), ne(productMatches.matchClass, 'not_comparable')));
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
    buildPriceView({ amount: v.price, compareAt: v.compareAt, currency: v.currency, observedAt: v.observedAt, sourceUrl: v.url, observationId: v.obsId }, o.reportingCurrency, o.fx, o.now, o.staleAfterHours);

  const rows: ComparisonRow[] = [];
  for (const [sourceVariantId, ms] of bySource) {
    const sv = vmap.get(sourceVariantId);
    if (!live(sv) || sv.siteId !== source.id) continue;
    const sourcePrice = view(sv);
    const sourceUnit = unitView(sourcePrice, sv, o.reportingCurrency);

    // Best match per competitor site: class, then reviewed status, then confidence.
    const bestBySite = new Map<string, (typeof matchRows)[number]>();
    for (const m of [...ms].sort((a, b) => CLASS_RANK[a.matchClass] - CLASS_RANK[b.matchClass] || STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.confidence - a.confidence)) {
      if (!bestBySite.has(m.competitorSiteId)) bestBySite.set(m.competitorSiteId, m);
    }
    const cells: ComparisonCell[] = [];
    for (const m of bestBySite.values()) {
      const cv = vmap.get(m.competitorVariantId);
      if (!live(cv)) continue;
      const price = view(cv);
      const unit = unitView(price, cv, o.reportingCurrency);
      const bothPriced = price.normalized !== null && sourcePrice.normalized !== null && sourcePrice.normalized > 0;
      const diffAbs = bothPriced ? roundMoney(price.normalized! - sourcePrice.normalized!, 4) : null;
      const diffPct = bothPriced ? roundMoney(((price.normalized! - sourcePrice.normalized!) / sourcePrice.normalized!) * 100, 2) : null;
      const unitDiffPct = unit.value !== null && sourceUnit.value !== null && unit.unit === sourceUnit.unit && sourceUnit.value > 0 ? roundMoney(((unit.value - sourceUnit.value) / sourceUnit.value) * 100, 2) : null;
      const confirmed = m.status === 'auto' || m.status === 'accepted';
      const caveats: string[] = [];
      if (price.amount === null) caveats.push('Competitor price not available');
      else if (price.normalized === null) caveats.push(price.currency ? `No exchange rate for ${price.currency}` : 'Competitor currency unknown, so the price cannot be converted');
      if (sourcePrice.normalized === null && sourcePrice.amount !== null) caveats.push(sourcePrice.currency ? `No exchange rate for ${sourcePrice.currency}` : 'Your currency is unknown');
      if (price.stale) caveats.push('Competitor price is stale');
      if (!confirmed && m.matchClass === 'identical') caveats.push('Match not yet confirmed');
      if (m.matchClass === 'different_pack') caveats.push(`Different pack size (${sv.qtyLabel ?? '?'} vs ${cv.qtyLabel ?? '?'}); compare unit prices`);
      if (m.matchClass === 'comparable') caveats.push('Different product or brand; compare unit prices only');
      const offer = offerBy.get(cv.id);
      cells.push({
        siteId: cv.siteId, siteName: siteName.get(cv.siteId) ?? 'Competitor', variantId: cv.id, productId: cv.productId, title: cv.title, variantTitle: cv.variantTitle, url: cv.url,
        matchId: m.id, matchClass: m.matchClass, matchStatus: m.status, confidence: m.confidence, reasons: m.reasons, price, availability: cv.availability, unitPrice: unit,
        diffAbs, diffPct, unitDiffPct, directlyComparable: m.matchClass === 'identical' && confirmed && bothPriced,
        offerSummary: offer ? `On sale: was ${formatMoney(offer.originalPrice, offer.currency)}, now ${formatMoney(offer.salePrice, offer.currency)}${offer.claimedDiscountPct ? ` (claims ${offer.claimedDiscountPct}% off; ${offer.verification === 'verified' ? 'verified by history' : 'not historically verified'})` : ''}` : null,
        caveats,
      });
    }
    if (!cells.length) continue;
    cells.sort((a, b) => a.siteName.localeCompare(b.siteName));
    // Position among directly comparable identical prices only.
    const comparable = [sourcePrice.normalized, ...cells.filter((c) => c.directlyComparable).map((c) => c.price.normalized)].filter((x): x is number => x !== null);
    let position: ComparisonRow['position'] = 'no_data';
    if (sourcePrice.normalized !== null && cells.some((c) => c.directlyComparable)) {
      const min = Math.min(...comparable);
      const max = Math.max(...comparable);
      position = min === max ? 'tied' : sourcePrice.normalized === min ? 'cheapest' : sourcePrice.normalized === max ? 'highest' : 'middle';
    }
    rows.push({
      sourceVariantId, sourceProductId: sv.productId, title: sv.title, variantTitle: sv.variantTitle, brand: sv.brand, category: sv.category, sizeLabel: sv.qtyLabel, url: sv.url,
      sourcePrice, sourceAvailability: sv.availability, sourceUnitPrice: sourceUnit, cells, position,
    });
  }
  rows.sort((a, b) => a.title.localeCompare(b.title));
  return rows;
}
