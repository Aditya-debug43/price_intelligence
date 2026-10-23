import type { OfferStatus, OfferVerification } from '@ci/shared';
import { discountPct } from './price.ts';

export interface PricePoint {
  price: number;
  observedAt: string | Date;
  /** True when this observation itself was a sale price (compare-at present). Such points are excluded from "regular price" history. */
  onSale?: boolean;
}

export interface DiscountVerification {
  verification: OfferVerification;
  claimedDiscountPct: number | null;
  /** Discount measured against the product's OWN observed regular-price history; null unless history is adequate. */
  historicalDiscountPct: number | null;
  referencePrice: number | null;
  observationsUsed: number;
  historySpanDays: number;
  reason: string;
}

export interface VerifyOptions {
  /** Minimum number of regular-price observations needed. */
  minObservations: number;
  /** Minimum days spanned by those observations. */
  minSpanDays: number;
  /** Lookback window before the offer was first seen. */
  lookbackDays: number;
  /** A claimed original price this much above the observed reference is "contradicted". */
  inflationTolerance: number;
}

export const DEFAULT_VERIFY_OPTIONS: VerifyOptions = {
  minObservations: 3,
  minSpanDays: 7,
  lookbackDays: 90,
  inflationTolerance: 0.1,
};

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * A "was/now" claim is NOT trusted. We compare the claimed original price with what this product was
 * actually observed selling for BEFORE the offer first appeared.
 */
export function verifyDiscount(
  claimed: { original: number | null; sale: number | null },
  history: PricePoint[],
  offerFirstSeenAt: string | Date,
  opts: VerifyOptions = DEFAULT_VERIFY_OPTIONS,
): DiscountVerification {
  const claimedPct = discountPct(claimed.original, claimed.sale);
  const base = {
    claimedDiscountPct: claimedPct,
    historicalDiscountPct: null,
    referencePrice: null,
    observationsUsed: 0,
    historySpanDays: 0,
  };
  if (claimed.original === null || claimed.sale === null || claimedPct === null) {
    return { ...base, verification: 'unverified', reason: 'Offer does not state both an original and a sale price.' };
  }
  const start = new Date(offerFirstSeenAt).getTime();
  const lookbackStart = start - opts.lookbackDays * 86_400_000;
  const regular = history
    .filter((p) => !p.onSale)
    .map((p) => ({ price: p.price, t: new Date(p.observedAt).getTime() }))
    .filter((p) => p.t < start && p.t >= lookbackStart && Number.isFinite(p.price) && p.price > 0)
    .sort((a, b) => a.t - b.t);

  if (regular.length === 0) {
    return {
      ...base,
      verification: 'unverified',
      reason: 'No earlier price observations exist for this product, so the claimed discount cannot be checked.',
    };
  }
  const span = (regular[regular.length - 1]!.t - regular[0]!.t) / 86_400_000;
  if (regular.length < opts.minObservations || span < opts.minSpanDays) {
    return {
      ...base,
      observationsUsed: regular.length,
      historySpanDays: Math.round(span * 10) / 10,
      verification: 'insufficient_history',
      reason: `Only ${regular.length} earlier observation(s) over ${Math.round(span)} day(s); ${opts.minObservations}+ observations over ${opts.minSpanDays}+ days are needed.`,
    };
  }
  const reference = median(regular.map((p) => p.price));
  const historicalPct = discountPct(reference, claimed.sale);
  const inflated = claimed.original > reference * (1 + opts.inflationTolerance);
  return {
    claimedDiscountPct: claimedPct,
    historicalDiscountPct: historicalPct,
    referencePrice: Math.round(reference * 100) / 100,
    observationsUsed: regular.length,
    historySpanDays: Math.round(span * 10) / 10,
    verification: inflated ? 'contradicted' : historicalPct !== null && historicalPct > 0 ? 'verified' : 'contradicted',
    reason: inflated
      ? `The "original" price (${claimed.original}) is above the typical earlier price (${Math.round(reference * 100) / 100}); the claimed discount looks overstated.`
      : historicalPct !== null && historicalPct > 0
        ? `Consistent with earlier prices (typical earlier price ${Math.round(reference * 100) / 100}).`
        : 'The sale price is not below the typical earlier price.',
  };
}

export interface OfferLifecycleInput {
  status: OfferStatus;
  lastSeenAt: string | Date;
  validTo: string | Date | null;
  now: Date;
  /** Whether the latest collection for the offer's site completed with full coverage of where offers are found. */
  latestScanComplete: boolean;
  /** Consecutive successful, complete scans in which the offer was NOT found. */
  missedCompleteScans: number;
  /** How long after the last sighting (hours) before we presume an undated offer has ended. */
  presumeEndedAfterHours?: number;
  missedScansToEnd?: number;
}

/**
 * Defensible expiry policy:
 *  - a stated validity end in the past => `expired`;
 *  - a disappeared undated offer is only `presumed_ended` after BOTH enough time and enough complete scans without it;
 *  - an incomplete/failed collection never ends an offer.
 */
export function nextOfferStatus(i: OfferLifecycleInput): OfferStatus {
  if (i.status === 'ended') return 'ended';
  if (i.validTo && new Date(i.validTo).getTime() < i.now.getTime()) return 'expired';
  const hours = (i.now.getTime() - new Date(i.lastSeenAt).getTime()) / 3_600_000;
  if (!i.latestScanComplete) return i.status;
  if (hours < 1) return 'active';
  if (i.missedCompleteScans >= (i.missedScansToEnd ?? 2) && hours >= (i.presumeEndedAfterHours ?? 36)) return 'presumed_ended';
  return i.status === 'presumed_ended' ? 'presumed_ended' : 'active';
}

const OFFER_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'free_shipping', re: /\bfree\s+(?:shipping|delivery)\b/i },
  { kind: 'coupon', re: /\b(?:coupon|promo(?:tion)?\s*code|use\s+code|voucher|discount\s+code)\b/i },
  { kind: 'buy_x_get_y', re: /\b(?:buy\s+\d+\s*,?\s*get\s+\d+|bogo|buy\s+one\s+get\s+one|2\s*for\s*1|\d+\s*for\s*\$?\d+)/i },
  { kind: 'minimum_order', re: /\b(?:orders?\s+over|spend\s+(?:over\s+)?[$\w.]+|minimum\s+(?:order|purchase))/i },
  { kind: 'cashback', re: /\bcash\s?back\b/i },
  { kind: 'payment_offer', re: /\b(?:with\s+(?:visa|mastercard|amex|card)|bank\s+offer|pay\s+with)\b/i },
  { kind: 'bundle', re: /\b(?:bundle|combo|multi-?pack\s+deal|family\s+pack\s+deal)\b/i },
  { kind: 'time_limited', re: /\b(?:ends?\s+(?:today|tonight|soon|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|limited\s+time|this\s+week\s+only|today\s+only|flash\s+sale|while\s+supplies\s+last)\b/i },
];

/** Wording that advertises a price benefit. */
const PROMO_STRONG = /\b(?:sale|deals?|specials|promos?|promotions?|discounts?|clearance|coupons?|flyers?|weekly\s+ad|folleto|ofertas?|aanbieding(?:en)?|korting|bogo|free\s+(?:shipping|delivery)|buy\s+\d+\s+get|save\s+(?:up\s+to\s+)?[$€£]?\d+|save\s+big|\d+\s?%\s?off|\d+\s+for\s+[$€£]?\d+)\b/i;
/** "offer(s)" as a noun that means a promotion. The bare word is not enough: "We offer a pre-stocking service" is a service, not a promotion. */
const PROMO_OFFER_NOUN = /\b(?:special|exclusive|weekly|daily|today'?s|great|best|limited(?:[- ]time)?|latest|current|new|hot|member|bank|payment)\s+offers?\b|\boffers?\s+(?:ends?|valid|expires?|of\s+the\s+(?:day|week|month))\b|\bspecial\s+price\b/i;

/** Whether a banner / announcement text advertises a discount, sale, deal, coupon, free delivery or similar. */
export function isPromotionalText(text: string): boolean {
  const t = text.replace(/\s+/g, ' ');
  return PROMO_STRONG.test(t) || PROMO_OFFER_NOUN.test(t);
}

export const PROMO_KEYWORDS = /\b(?:sale|offer|offers|deal|deals|special|specials|promo|promotion|discount|clearance|save|% ?off|\d+\s?% ?off|weekly\s+ad|flyer|folleto|ofertas?|aanbieding(?:en)?|korting)\b/i;

export interface BannerClassification {
  kind: string;
  conditional: boolean;
  conditions: string[];
  code: string | null;
}

/** Heuristic classification of promotional banner / announcement text into an explicit offer kind with conditions. */
export function classifyPromoText(text: string): BannerClassification {
  const t = text.replace(/\s+/g, ' ').trim();
  const conditions: string[] = [];
  const minMatch = t.match(/(?:orders?\s+over|spend\s+(?:over\s+)?|minimum\s+(?:order|purchase)\s+(?:of\s+)?)\s*([A-Za-z$€£.]{0,6}\s?\d[\d.,]*)/i);
  if (minMatch) conditions.push(`Minimum spend ${minMatch[1]!.trim()}`);
  const codeMatch = t.match(/\b(?:use\s+)?(?:code|coupon)[:\s]+["“']?([A-Z0-9][A-Z0-9_-]{2,19})["”']?/);
  if (codeMatch) conditions.push(`Requires code ${codeMatch[1]}`);
  const dateMatch = t.match(/\b(?:until|through|ends?|valid\s+(?:until|through)|thru)\s+([A-Za-z]+\.?\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)/i);
  if (dateMatch) conditions.push(`Valid until ${dateMatch[1]}`);
  let kind = 'banner';
  for (const p of OFFER_PATTERNS) {
    if (p.re.test(t)) {
      kind = p.kind;
      break;
    }
  }
  return {
    kind,
    conditional: conditions.length > 0 || ['coupon', 'minimum_order', 'payment_offer', 'cashback', 'buy_x_get_y', 'bundle'].includes(kind),
    conditions,
    code: codeMatch ? codeMatch[1]! : null,
  };
}

export interface UniformCompareAt {
  /** Share of the priced products that show a higher "regular" price beside the selling price (0–1). */
  share: number;
  /** The typical markup of that regular price over the selling price, in percent. */
  medianMarkupPct: number;
  /** How far apart the markups are (10th to 90th percentile), in percentage points. */
  spreadPct: number;
  /** How many priced products were looked at. */
  products: number;
}

const MIN_PRODUCTS_FOR_PATTERN = 20;

/**
 * A shop can show a higher "regular price" beside nearly EVERY product at almost the same percentage (a live grocery shop showed one 7–8 %
 * above on 2,383 of 2,385 products). That is a standing display, not a promotion: counting each product as "on sale" would bury the real
 * offers and report thousands of discounts that were never advertised. Returns the pattern when at least 90 % of the priced products carry a
 * regular price and the markups sit within 3 percentage points of each other; null otherwise (a normal mix of a few sales at varied depths).
 * A genuinely catalogue-wide, uniform markdown looks the same on the first look — the run says what was seen so a person can tell.
 */
export function detectUniformCompareAt(items: { price: number | null; compareAt: number | null }[]): UniformCompareAt | null {
  const priced = items.filter((i) => i.price !== null && i.price > 0);
  if (priced.length < MIN_PRODUCTS_FOR_PATTERN) return null;
  const marked = priced.filter((i) => i.compareAt !== null && i.compareAt > (i.price as number));
  if (marked.length / priced.length < 0.9) return null;
  const markups = marked.map((i) => ((i.compareAt as number) / (i.price as number) - 1) * 100).sort((a, b) => a - b);
  const at = (q: number) => markups[Math.min(markups.length - 1, Math.floor(q * markups.length))]!;
  const spread = at(0.9) - at(0.1);
  if (spread > 3) return null;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return { share: Math.round((marked.length / priced.length) * 1000) / 1000, medianMarkupPct: r1(at(0.5)), spreadPct: r1(spread), products: priced.length };
}
