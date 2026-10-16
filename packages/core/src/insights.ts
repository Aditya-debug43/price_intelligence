import type {
  AssortmentEntry,
  Availability,
  BasketResult,
  ComparisonRow,
  InsightEvidence,
  InsightRow,
  InsightType,
  MarketingRow,
  OfferRow,
  SiteCoverage,
  StockRow,
} from '@ci/shared';
import { formatMoney, formatPct, round } from '@ci/shared';

/**
 * Deterministic insight engine. Pure: takes already-collected records and returns ranked, evidence-backed findings.
 * No model is involved; every number below originates from a stored observation.
 *
 * Ranking: score = 100 × typeWeight × (0.4 + 0.6 × magnitude) × confidence × freshness
 *   typeWeight  how actionable the finding type is (table below)
 *   magnitude   0..1 size of the effect (e.g. |price gap| / 30%, stock depletion, number of products)
 *   confidence  match confidence for price findings, 1 otherwise
 *   freshness   1 for data ≤ 24 h old, decaying linearly to 0.4 at 3× the stale threshold
 */

export const TYPE_WEIGHTS: Record<InsightType, number> = {
  price_above_competitor: 0.9,
  price_below_competitor: 0.5,
  large_price_gap: 0.95,
  price_movement: 0.7,
  new_competitor_product: 0.55,
  competitor_delisting: 0.4,
  assortment_gap_competitor_only: 0.5,
  assortment_gap_source_only: 0.35,
  new_offer: 0.65,
  offer_ended: 0.3,
  low_stock: 1.0,
  out_of_stock: 1.0,
  competitor_availability_change: 0.45,
  marketing_activity: 0.4,
  basket_comparison: 0.8,
  coverage_warning: 0.85,
};

export interface NewProductRecord {
  siteId: string;
  siteName: string;
  variantId: string;
  title: string;
  price: number | null;
  currency: string | null;
  firstSeenAt: string;
  url: string;
  category: string | null;
}

export interface DelistedRecord {
  siteId: string;
  siteName: string;
  variantId: string;
  title: string;
  lastSeenAt: string;
  url: string;
  completeScansMissed: number;
}

export interface PriceMovementRecord {
  siteId: string;
  siteName: string;
  isSource: boolean;
  variantId: string;
  title: string;
  previousPrice: number;
  currentPrice: number;
  currency: string;
  changePct: number;
  previousObservedAt: string;
  currentObservedAt: string;
  previousObservationId: string | null;
  currentObservationId: string | null;
  url: string;
}

export interface AvailabilityChangeRecord {
  siteId: string;
  siteName: string;
  variantId: string;
  title: string;
  from: Availability;
  to: Availability;
  at: string;
  url: string;
}

export interface InsightInputs {
  now: Date;
  reportingCurrency: string;
  staleAfterHours: number;
  comparisons: ComparisonRow[];
  offers: OfferRow[];
  stock: StockRow[];
  marketing: MarketingRow[];
  newProducts: NewProductRecord[];
  delisted: DelistedRecord[];
  priceMovements: PriceMovementRecord[];
  availabilityChanges: AvailabilityChangeRecord[];
  assortment: { competitorOnly: AssortmentEntry[]; sourceOnly: AssortmentEntry[] };
  basket: BasketResult[];
  coverage: SiteCoverage[];
  /** Minimum percentage gap before a price insight is emitted. */
  priceGapThresholdPct?: number;
  largeGapPct?: number;
  maxPerType?: number;
}

function freshnessFactor(observedAt: string | null, now: Date, staleAfterHours: number): number {
  if (!observedAt) return 0.4;
  const h = (now.getTime() - new Date(observedAt).getTime()) / 3_600_000;
  if (h <= 24) return 1;
  const limit = staleAfterHours * 3;
  if (h >= limit) return 0.4;
  return 1 - (0.6 * (h - 24)) / (limit - 24);
}

function scoreOf(type: InsightType, magnitude: number, confidence: number, freshness: number) {
  const mag = Math.min(1, Math.max(0, magnitude));
  const score = 100 * TYPE_WEIGHTS[type] * (0.4 + 0.6 * mag) * confidence * freshness;
  return {
    score: round(score, 1),
    breakdown: {
      typeWeight: TYPE_WEIGHTS[type],
      magnitude: round(mag, 3),
      confidence: round(confidence, 3),
      freshness: round(freshness, 3),
    },
  };
}

const sevFromScore = (s: number): 'info' | 'warning' | 'critical' => (s >= 70 ? 'critical' : s >= 40 ? 'warning' : 'info');

export function generateInsights(i: InsightInputs): InsightRow[] {
  const out: InsightRow[] = [];
  const gapMin = i.priceGapThresholdPct ?? 3;
  const largeGap = i.largeGapPct ?? 25;
  const cur = i.reportingCurrency;

  // ───────────── price position (per source product, cheapest comparable competitor)
  for (const row of i.comparisons) {
    const cells = row.cells.filter(
      (c) => c.matchClass !== 'not_comparable' && c.matchStatus !== 'rejected' && c.price.normalized !== null,
    );
    if (!cells.length) continue;
    const direct = cells.filter((c) => c.directlyComparable && c.diffPct !== null);
    const unitBased = cells.filter((c) => !c.directlyComparable && c.unitDiffPct !== null && c.matchStatus !== 'needs_review');
    const pool = direct.length ? direct : unitBased;
    if (!pool.length) continue;
    const useUnit = direct.length === 0;
    const pct = (c: (typeof pool)[number]) => (useUnit ? c.unitDiffPct! : c.diffPct!);
    // diffPct = (competitor − source)/source. Negative => competitor cheaper => source is more expensive.
    const cheapest = [...pool].sort((a, b) => pct(a) - pct(b))[0]!;
    const priciest = [...pool].sort((a, b) => pct(b) - pct(a))[0]!;
    const gapVsCheapest = -pct(cheapest);
    const evidence = (c: (typeof pool)[number]): InsightEvidence[] => [
      { kind: 'observation', id: row.sourcePrice.observationId, url: row.sourcePrice.sourceUrl, observedAt: row.sourcePrice.observedAt, label: `Source price ${formatMoney(row.sourcePrice.amount, row.sourcePrice.currency)}` },
      { kind: 'observation', id: c.price.observationId, url: c.price.sourceUrl, observedAt: c.price.observedAt, label: `${c.siteName} price ${formatMoney(c.price.amount, c.price.currency)}` },
      { kind: 'match', id: c.matchId, url: null, observedAt: null, label: `${c.matchClass} match (${Math.round(c.confidence * 100)}%)` },
    ];
    const worstObserved = [row.sourcePrice.observedAt, cheapest.price.observedAt].filter(Boolean).sort()[0] ?? null;
    const fresh = freshnessFactor(worstObserved, i.now, i.staleAfterHours);
    const basis = useUnit ? ` (unit price, ${cheapest.matchClass.replace('_', ' ')} match)` : '';
    const matchWeight = useUnit ? (cheapest.matchClass === 'different_pack' ? 0.8 : 0.5) : 1;

    if (Math.abs(pct(cheapest)) >= largeGap || Math.abs(pct(priciest)) >= largeGap) {
      const c = Math.abs(pct(cheapest)) >= Math.abs(pct(priciest)) ? cheapest : priciest;
      const mag = Math.abs(pct(c)) / 50;
      const s = scoreOf('large_price_gap', mag, c.confidence * matchWeight, fresh);
      out.push({
        id: `large_price_gap:${row.sourceVariantId}:${c.siteId}`,
        type: 'large_price_gap',
        ...s,
        severity: sevFromScore(s.score),
        title: `Large price gap on ${row.title}`,
        summary: `${row.title}: ${c.siteName} is ${formatPct(pct(c))} vs. your price${basis}.${c.price.stale || row.sourcePrice.stale ? ' Some data is stale.' : ''}`,
        facts: {
          sourcePrice: row.sourcePrice.normalized,
          competitorPrice: c.price.normalized,
          currency: cur,
          gapPct: round(pct(c), 2),
          competitor: c.siteName,
          basis: useUnit ? 'unit_price' : 'shelf_price',
        },
        evidence: evidence(c),
        siteId: c.siteId,
        scoreBreakdown: s.breakdown,
      });
    } else if (gapVsCheapest >= gapMin) {
      const s = scoreOf('price_above_competitor', gapVsCheapest / 30, cheapest.confidence * matchWeight, fresh);
      out.push({
        id: `price_above_competitor:${row.sourceVariantId}`,
        type: 'price_above_competitor',
        ...s,
        severity: sevFromScore(s.score),
        title: `You are priced above ${cheapest.siteName} on ${row.title}`,
        summary: `${row.title}: you charge ${formatMoney(row.sourcePrice.normalized, cur)}; ${cheapest.siteName} charges ${formatMoney(cheapest.price.normalized, cur)} (${formatPct(pct(cheapest))})${basis}.`,
        facts: {
          sourcePrice: row.sourcePrice.normalized,
          competitorPrice: cheapest.price.normalized,
          currency: cur,
          gapPct: round(pct(cheapest), 2),
          competitor: cheapest.siteName,
          competitorsCompared: pool.length,
        },
        evidence: evidence(cheapest),
        siteId: cheapest.siteId,
        scoreBreakdown: s.breakdown,
      });
    } else if (pct(cheapest) >= gapMin) {
      // Source is cheaper than every comparable competitor.
      const s = scoreOf('price_below_competitor', pct(cheapest) / 30, cheapest.confidence * matchWeight, fresh);
      out.push({
        id: `price_below_competitor:${row.sourceVariantId}`,
        type: 'price_below_competitor',
        ...s,
        severity: 'info',
        title: `You are the cheapest on ${row.title}`,
        summary: `${row.title}: ${formatMoney(row.sourcePrice.normalized, cur)} vs. the next-lowest ${formatMoney(cheapest.price.normalized, cur)} at ${cheapest.siteName} (${formatPct(pct(cheapest))})${basis}. A headroom opportunity if margin allows.`,
        facts: {
          sourcePrice: row.sourcePrice.normalized,
          competitorPrice: cheapest.price.normalized,
          currency: cur,
          headroomPct: round(pct(cheapest), 2),
          competitor: cheapest.siteName,
        },
        evidence: evidence(cheapest),
        siteId: cheapest.siteId,
        scoreBreakdown: s.breakdown,
      });
    }
  }

  // ───────────── price movements
  for (const m of i.priceMovements) {
    if (Math.abs(m.changePct) < 5) continue;
    const s = scoreOf('price_movement', Math.abs(m.changePct) / 40, 1, freshnessFactor(m.currentObservedAt, i.now, i.staleAfterHours));
    out.push({
      id: `price_movement:${m.variantId}:${m.currentObservationId ?? m.currentObservedAt}`,
      type: 'price_movement',
      ...s,
      severity: sevFromScore(s.score),
      title: `${m.siteName} ${m.changePct > 0 ? 'raised' : 'cut'} the price of ${m.title}`,
      summary: `${m.title} at ${m.siteName}: ${formatMoney(m.previousPrice, m.currency)} → ${formatMoney(m.currentPrice, m.currency)} (${formatPct(m.changePct)}).`,
      facts: { previousPrice: m.previousPrice, currentPrice: m.currentPrice, currency: m.currency, changePct: round(m.changePct, 2), site: m.siteName },
      evidence: [
        { kind: 'observation', id: m.previousObservationId, url: m.url, observedAt: m.previousObservedAt, label: 'Earlier price' },
        { kind: 'observation', id: m.currentObservationId, url: m.url, observedAt: m.currentObservedAt, label: 'Current price' },
      ],
      siteId: m.siteId,
      scoreBreakdown: s.breakdown,
    });
  }

  // ───────────── new products / delistings (grouped per site)
  const groupBy = <T,>(arr: T[], key: (t: T) => string) => {
    const m = new Map<string, T[]>();
    for (const t of arr) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
    return m;
  };
  for (const [siteId, list] of groupBy(i.newProducts, (p) => p.siteId)) {
    const site = list[0]!;
    const s = scoreOf('new_competitor_product', list.length / 20, 1, freshnessFactor(list[0]!.firstSeenAt, i.now, i.staleAfterHours));
    out.push({
      id: `new_competitor_product:${siteId}`,
      type: 'new_competitor_product',
      ...s,
      severity: 'info',
      title: `${site.siteName} listed ${list.length} new product${list.length === 1 ? '' : 's'}`,
      summary: `Newly discovered at ${site.siteName}: ${list.slice(0, 4).map((p) => p.title).join('; ')}${list.length > 4 ? ` and ${list.length - 4} more` : ''}.`,
      facts: { count: list.length, site: site.siteName },
      evidence: list.slice(0, 10).map((p) => ({ kind: 'variant', id: p.variantId, url: p.url, observedAt: p.firstSeenAt, label: p.title })),
      siteId,
      scoreBreakdown: s.breakdown,
    });
  }
  for (const [siteId, list] of groupBy(i.delisted, (p) => p.siteId)) {
    const site = list[0]!;
    const s = scoreOf('competitor_delisting', list.length / 20, 0.8, 1);
    out.push({
      id: `competitor_delisting:${siteId}`,
      type: 'competitor_delisting',
      ...s,
      severity: 'info',
      title: `${list.length} product${list.length === 1 ? '' : 's'} no longer listed at ${site.siteName}`,
      summary: `Apparent delistings (not found in ${list[0]!.completeScansMissed}+ complete scans): ${list.slice(0, 4).map((p) => p.title).join('; ')}. This may also mean a URL change.`,
      facts: { count: list.length, site: site.siteName },
      evidence: list.slice(0, 10).map((p) => ({ kind: 'variant', id: p.variantId, url: p.url, observedAt: p.lastSeenAt, label: `${p.title} (last seen)` })),
      siteId,
      scoreBreakdown: s.breakdown,
    });
  }

  // ───────────── assortment gaps (only with enough reliable matched data)
  const matchedCount = i.comparisons.filter((r) => r.cells.some((c) => c.matchClass === 'identical')).length;
  if (matchedCount >= 5) {
    for (const [siteId, list] of groupBy(i.assortment.competitorOnly, (p) => p.siteId)) {
      const cats = [...groupBy(list, (p) => p.category ?? 'Uncategorised').entries()].sort((a, b) => b[1].length - a[1].length);
      const s = scoreOf('assortment_gap_competitor_only', list.length / 50, 0.8, 1);
      out.push({
        id: `assortment_gap_competitor_only:${siteId}`,
        type: 'assortment_gap_competitor_only',
        ...s,
        severity: 'info',
        title: `${list[0]!.siteName} lists ${list.length} products with no match in your catalogue`,
        summary: `Largest categories: ${cats.slice(0, 3).map(([c, l]) => `${c} (${l.length})`).join(', ')}. "No match" means no equivalent was found, not that you cannot source it.`,
        facts: { count: list.length, site: list[0]!.siteName },
        evidence: list.slice(0, 10).map((p) => ({ kind: 'variant', id: p.variantId, url: p.url, observedAt: p.firstSeenAt, label: p.title })),
        siteId,
        scoreBreakdown: s.breakdown,
      });
    }
    if (i.assortment.sourceOnly.length) {
      const list = i.assortment.sourceOnly;
      const s = scoreOf('assortment_gap_source_only', list.length / 50, 0.8, 1);
      out.push({
        id: 'assortment_gap_source_only',
        type: 'assortment_gap_source_only',
        ...s,
        severity: 'info',
        title: `${list.length} of your products have no match at any competitor`,
        summary: `These are candidates for unique-assortment positioning or listing gaps in the matching data: ${list.slice(0, 4).map((p) => p.title).join('; ')}.`,
        facts: { count: list.length },
        evidence: list.slice(0, 10).map((p) => ({ kind: 'variant', id: p.variantId, url: p.url, observedAt: p.firstSeenAt, label: p.title })),
        scoreBreakdown: s.breakdown,
      });
    }
  }

  // ───────────── offers
  const dayAgo = i.now.getTime() - 48 * 3_600_000;
  for (const o of i.offers) {
    const isNew = new Date(o.firstSeenAt).getTime() >= dayAgo;
    if (o.status === 'active' && isNew && o.siteRole === 'competitor') {
      const disc = o.claimedDiscountPct ?? 0;
      const s = scoreOf('new_offer', disc / 50 || 0.3, 1, freshnessFactor(o.lastSeenAt, i.now, i.staleAfterHours));
      out.push({
        id: `new_offer:${o.id}`,
        type: 'new_offer',
        ...s,
        severity: 'info',
        title: `${o.siteName}: new offer — ${o.title}`,
        summary: `${o.siteName} is showing "${o.title}"${o.claimedDiscountPct ? ` (claimed ${o.claimedDiscountPct}% off, ${o.verification === 'verified' ? 'verified against price history' : 'not historically verified'})` : ''}${o.conditions.length ? `; conditions: ${o.conditions.join(', ')}` : ''}.`,
        facts: { claimedDiscountPct: o.claimedDiscountPct, historicalDiscountPct: o.historicalDiscountPct, verification: o.verification, site: o.siteName },
        evidence: [{ kind: 'offer', id: o.id, url: o.sourceUrl, observedAt: o.lastSeenAt, label: o.title }],
        siteId: o.siteId,
        scoreBreakdown: s.breakdown,
      });
    } else if ((o.status === 'presumed_ended' || o.status === 'expired' || o.status === 'ended') && new Date(o.lastSeenAt).getTime() >= i.now.getTime() - 7 * 86_400_000) {
      const s = scoreOf('offer_ended', 0.3, 0.8, 1);
      out.push({
        id: `offer_ended:${o.id}`,
        type: 'offer_ended',
        ...s,
        severity: 'info',
        title: `${o.siteName}: offer appears to have ended — ${o.title}`,
        summary: `"${o.title}" at ${o.siteName} was last seen ${o.lastSeenAt.slice(0, 10)} (${o.status.replace('_', ' ')}).`,
        facts: { site: o.siteName },
        evidence: [{ kind: 'offer', id: o.id, url: o.sourceUrl, observedAt: o.lastSeenAt, label: o.title }],
        siteId: o.siteId,
        scoreBreakdown: s.breakdown,
      });
    }
  }

  // ───────────── own stock
  for (const st of i.stock) {
    if (st.state === 'low_stock') {
      const depletion = st.quantity !== null && st.threshold > 0 ? 1 - st.quantity / (st.threshold + 1) : 0.7;
      const s = scoreOf('low_stock', depletion, 1, freshnessFactor(st.observedAt, i.now, i.staleAfterHours));
      out.push({
        id: `low_stock:${st.variantId}`,
        type: 'low_stock',
        ...s,
        severity: 'warning',
        title: `Low stock: ${st.title}`,
        summary:
          st.quantity !== null
            ? `${st.title} has ${st.quantity} unit${st.quantity === 1 ? '' : 's'} left (threshold ${st.threshold}; source: ${st.quantitySource === 'authorised_inventory' ? 'authorised inventory' : st.quantitySource === 'simulated' ? 'SIMULATED inventory' : 'public claim'}).`
            : `${st.title} is marked as limited availability on your site. No unit count is published, so the remaining quantity is unknown.`,
        facts: { quantity: st.quantity, threshold: st.threshold },
        evidence: [{ kind: 'variant', id: st.variantId, url: st.url, observedAt: st.observedAt, label: st.title }],
        scoreBreakdown: s.breakdown,
      });
    } else if (st.state === 'out_of_stock') {
      const s = scoreOf('out_of_stock', 1, 1, freshnessFactor(st.observedAt, i.now, i.staleAfterHours));
      out.push({
        id: `out_of_stock:${st.variantId}`,
        type: 'out_of_stock',
        ...s,
        severity: 'critical',
        title: `Out of stock: ${st.title}`,
        summary: `${st.title} is shown as unavailable on your site.`,
        facts: { quantity: st.quantity },
        evidence: [{ kind: 'variant', id: st.variantId, url: st.url, observedAt: st.observedAt, label: st.title }],
        scoreBreakdown: s.breakdown,
      });
    }
  }

  // ───────────── competitor availability changes
  for (const a of i.availabilityChanges) {
    const s = scoreOf('competitor_availability_change', a.to === 'out_of_stock' ? 0.8 : 0.4, 1, freshnessFactor(a.at, i.now, i.staleAfterHours));
    out.push({
      id: `competitor_availability_change:${a.variantId}:${a.at}`,
      type: 'competitor_availability_change',
      ...s,
      severity: 'info',
      title: `${a.siteName}: ${a.title} is now ${a.to.replace('_', ' ')}`,
      summary: `${a.title} at ${a.siteName} changed from ${a.from.replace('_', ' ')} to ${a.to.replace('_', ' ')}.`,
      facts: { site: a.siteName, from: a.from, to: a.to },
      evidence: [{ kind: 'variant', id: a.variantId, url: a.url, observedAt: a.at, label: a.title }],
      siteId: a.siteId,
      scoreBreakdown: s.breakdown,
    });
  }

  // ───────────── marketing
  const weekAgo = i.now.getTime() - 7 * 86_400_000;
  const recentMarketing = i.marketing.filter((m) => new Date(m.firstSeenAt).getTime() >= weekAgo);
  for (const [siteId, list] of groupBy(recentMarketing, (m) => m.siteId)) {
    const weight = list.some((m) => m.classification === 'promotion' || m.classification === 'product_launch') ? 0.7 : 0.4;
    const s = scoreOf('marketing_activity', weight + Math.min(0.3, list.length / 20), Math.min(1, list.reduce((a, m) => a + m.confidence, 0) / list.length), 1);
    out.push({
      id: `marketing_activity:${siteId}`,
      type: 'marketing_activity',
      ...s,
      severity: 'info',
      title: `${list[0]!.siteName}: ${list.length} marketing item${list.length === 1 ? '' : 's'} observed`,
      summary: `Observed (not proof of paid advertising): ${list.slice(0, 3).map((m) => m.title ?? m.kind).join('; ')}.`,
      facts: { count: list.length, site: list[0]!.siteName },
      evidence: list.slice(0, 8).map((m) => ({ kind: 'marketing', id: m.id, url: m.url, observedAt: m.firstSeenAt, label: m.title ?? m.kind })),
      siteId,
      scoreBreakdown: s.breakdown,
    });
  }

  // ───────────── basket
  for (const b of i.basket) {
    if (b.diffPct === null || b.itemsAvailableInBoth < 3) continue;
    const s = scoreOf('basket_comparison', Math.abs(b.diffPct) / 15, Math.min(1, b.coveragePct / 100 + 0.2), 1);
    out.push({
      id: `basket_comparison:${b.siteId}`,
      type: 'basket_comparison',
      ...s,
      severity: Math.abs(b.diffPct) >= 8 ? 'warning' : 'info',
      title: `Basket vs ${b.siteName}: ${formatPct(b.diffPct)}`,
      summary: `Across ${b.itemsAvailableInBoth} identical products available at both shops, your basket costs ${formatMoney(b.sourceTotal, b.currency)} vs ${formatMoney(b.competitorTotal, b.currency)} at ${b.siteName} (${formatPct(b.diffPct)}). These items are ${b.coveragePct}% of your catalogue.`,
      facts: { sourceTotal: b.sourceTotal, competitorTotal: b.competitorTotal, diffPct: b.diffPct, items: b.itemsAvailableInBoth, coveragePct: b.coveragePct, currency: b.currency },
      evidence: [{ kind: 'site', id: b.siteId, url: null, observedAt: null, label: b.siteName }],
      siteId: b.siteId,
      scoreBreakdown: s.breakdown,
    });
  }

  // ───────────── coverage warnings
  for (const c of i.coverage) {
    if (c.complete && c.warnings.length === 0) continue;
    const severity = c.capability === 'blocked' || c.capability === 'failed' || c.failureReason ? 1 : 0.5;
    const s = scoreOf('coverage_warning', severity, 1, 1);
    out.push({
      id: `coverage_warning:${c.siteId}`,
      type: 'coverage_warning',
      ...s,
      severity: severity === 1 ? 'warning' : 'info',
      title: `${c.name}: incomplete data`,
      summary: [c.failureReason, ...c.warnings].filter(Boolean).join(' ') || 'Collection was partial.',
      facts: { productsKnown: c.productsKnown, coveragePct: c.coveragePct, stale: c.productsStale },
      evidence: [{ kind: 'site', id: c.siteId, url: null, observedAt: c.newestObservation, label: c.name }],
      siteId: c.siteId,
      scoreBreakdown: s.breakdown,
    });
  }

  // Cap per type to keep the report readable, then rank.
  const cap = i.maxPerType ?? 15;
  const perType = new Map<InsightType, number>();
  const ranked = out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return ranked.filter((ins) => {
    const n = (perType.get(ins.type) ?? 0) + 1;
    perType.set(ins.type, n);
    return n <= cap;
  });
}

/** Deterministic one-paragraph headline from the top insights. The AI summariser may rephrase it but never add numbers. */
export function deterministicHeadline(insights: InsightRow[], isPartial: boolean, ctx: { hasSource?: boolean; hasData?: boolean } = {}): string {
  const top = insights.filter((i) => i.type !== 'coverage_warning').slice(0, 3);
  const prefix = isPartial ? 'Partial report — some sites were incomplete. ' : '';
  // "Nothing noteworthy" is a finding about collected data. With no data there is no finding, and the report says so plainly.
  if (ctx.hasSource === false) return `${prefix}This report has no findings: no website of yours has been added yet.`;
  if (ctx.hasData === false) return `${prefix}This report has no findings: no products have been collected from any website yet. See the notes below for what is missing.`;
  if (!top.length) return `${prefix}No significant changes or price gaps were detected in the collected data.`;
  return `${prefix}${top.map((t) => t.title).join(' · ')}`;
}
