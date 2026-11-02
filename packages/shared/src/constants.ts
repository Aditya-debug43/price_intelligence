// Shared enumerations. Plain `as const` arrays so they can feed zod enums, pg enums and UI selects alike.

export const MEMBER_ROLES = ['owner', 'admin', 'staff'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const SITE_ROLES = ['source', 'competitor'] as const;
export type SiteRole = (typeof SITE_ROLES)[number];

/** Plain-language capability statuses shown to customers. */
export const CAPABILITY_STATUSES = ['full', 'partial', 'limited', 'blocked', 'failed'] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/** Consent / authorisation to collect from a site. Collection never starts while `pending`. */
export const CONSENT_STATUSES = ['pending', 'confirmed', 'revoked'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export const PLATFORMS = [
  'shopify',
  'woocommerce',
  'magento',
  'bigcommerce',
  'prestashop',
  'wix',
  'squarespace',
  'opencart',
  'freshop',
  'custom',
  'unknown',
] as const;
export type PlatformId = (typeof PLATFORMS)[number];

export const CONNECTOR_IDS = [
  'shopify-products-json',
  'woocommerce-store-api',
  'sitemap-structured-data',
  'html-generic',
  'listing-crawl',
  'browser-rendered',
  'llm-fallback',
] as const;
export type ConnectorId = (typeof CONNECTOR_IDS)[number];

export const EXTRACTION_METHODS = [
  'shopify_products_json',
  'woocommerce_store_api',
  'json_ld',
  'microdata',
  'opengraph',
  'html_heuristic',
  'listing_card',
  'site_rule',
  'browser_rendered',
  'llm_fallback',
  'flyer_pdf',
  'authorised_inventory',
  'public_banner',
  'official_api',
] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

/** Public availability states. `unknown` is never silently converted to `in_stock`. */
export const AVAILABILITY_STATES = ['in_stock', 'out_of_stock', 'limited', 'low_quantity_claim', 'unknown'] as const;
export type Availability = (typeof AVAILABILITY_STATES)[number];

export const QUANTITY_SOURCES = ['public_claim', 'authorised_inventory'] as const;
export type QuantitySource = (typeof QUANTITY_SOURCES)[number];

export const MATCH_CLASSES = ['identical', 'different_pack', 'comparable', 'not_comparable'] as const;
export type MatchClass = (typeof MATCH_CLASSES)[number];

export const MATCH_STATUSES = ['auto', 'needs_review', 'accepted', 'rejected'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/**
 * What two products are to each other (matching engine v2). These are kept apart on purpose: they are never folded into one similarity score.
 *  exact        the same underlying product from different sellers
 *  variant      the same product with a meaningful difference in pack quantity, size, colour or another variant attribute
 *  substitute   a different product that can stand in for the other, with the important differences stated
 *  related      associated (an adapter for a bulb, a lid for a pot) but not interchangeable
 *  non_match    genuinely different, or decisively incompatible
 *  insufficient the information available does not support a reliable conclusion
 */
export const MATCH_RELATIONSHIPS = ['exact', 'variant', 'substitute', 'related', 'non_match', 'insufficient'] as const;
export type MatchRelationship = (typeof MATCH_RELATIONSHIPS)[number];

/** How much independent evidence stands behind a suggestion. Deliberately not a percentage: no number is shown until scores are calibrated on reviewed pairs. */
export const EVIDENCE_TIERS = ['strong', 'medium', 'insufficient'] as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

export const EVIDENCE_KINDS = ['identifier', 'brand', 'identity_code', 'fitment', 'product_type', 'size', 'pack', 'colour', 'spec', 'name', 'exclusion', 'bundle', 'variant'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** One fact behind a suggestion, in the order a reviewer reads it. `conflicts` is a decisive incompatibility; `differs` is a difference that matters but does not decide. */
export interface EvidenceItem {
  kind: EvidenceKind;
  effect: 'supports' | 'conflicts' | 'differs' | 'missing';
  strength: 'strong' | 'moderate' | 'weak';
  text: string;
  /** The two values, as written in each product, when there are values to show. */
  a?: string | null;
  b?: string | null;
}

export interface MatchEvidence {
  items: EvidenceItem[];
  /** One plain sentence: why this was suggested and what weakens it. */
  summary: string;
  /** Independent agreeing signals (identifiers, identity codes, fitment, specs, product type, name). */
  signals: number;
}

/**
 * The quantity-compatibility policy (core/quantity-policy.ts): products that hold different actual quantities are incomparable for price comparison, whatever their names say.
 * A pair keeps its relationship (it can still be "the same product in another pack"); the policy adds a recorded reason it is not compared on price.
 */
export const INCOMPARABLE_QUANTITY_MISMATCH = 'INCOMPARABLE_QUANTITY_MISMATCH' as const;
/**
 * The bundle-contents policy (core/match/bundle.ts): two automotive bundles (combos, kits) that do not hold the same contents are not comparable on price, however similar their
 * main product, brand or vehicle fit. A bundle with an extra or a missing component, or a combo against a single item, is a verified mismatch; contents that cannot be established are "unknown", never assumed equal.
 */
export const INCOMPARABLE_BUNDLE_CONTENT_MISMATCH = 'INCOMPARABLE_BUNDLE_CONTENT_MISMATCH' as const;
/** Why a pair is left out of price comparison (stored on the pair). */
export type PriceExclusion = typeof INCOMPARABLE_QUANTITY_MISMATCH | typeof INCOMPARABLE_BUNDLE_CONTENT_MISMATCH;
export type QuantityDimension = 'volume' | 'mass' | 'count' | 'length' | 'area';
export type QuantityVerdict = 'same' | 'different' | 'unknown';
/** What one product says it holds, in the base unit of its dimension (ml, g, pieces, mm, mm²). */
export interface QuantitySide {
  dimension: QuantityDimension | null;
  total: number | null;
  unit: 'ml' | 'g' | 'pcs' | 'mm' | 'mm²' | null;
  label: string | null;
  /** Where it was read from. */
  source: 'title' | 'option' | 'size_hint' | 'description' | null;
}
/** The recorded outcome of comparing the quantities of the two products of a pair: the evidence behind the exclusion. */
export interface QuantityCheck {
  policy: string;
  verdict: QuantityVerdict;
  /** Set only when the products hold different actual quantities. */
  exclusion: typeof INCOMPARABLE_QUANTITY_MISMATCH | null;
  note: string;
  a: QuantitySide;
  b: QuantitySide;
  /** The pack configuration, kept apart from the total (2 × 1 L and 1 × 2 L are the same quantity packaged differently). */
  packaging: { a: string | null; b: string | null; differs: boolean };
}

export type BundleVerdict = 'equivalent' | 'mismatch' | 'unknown';
/** What one listing includes, as read from its variant and title: the parts (with counts) and the bulb codes. */
export interface BundleSide {
  /** The listing is sold as several items together (a combo, a kit, "A + B"). */
  bundle: boolean;
  /** The components it names, e.g. "headlight", "2 × turn signal". */
  items: string[];
  /** Components it explicitly leaves out ("W/o fog lights"). */
  without: string[];
  /** The bulb codes it names. */
  codes: string[];
  /** Where the contents were read: the variant’s own option/title, or the product title. */
  basis: 'variant' | 'title' | null;
  /** The text the contents were read from. */
  text: string | null;
}
/** The recorded outcome of comparing the contents of the two bundles of a pair: the evidence behind the exclusion. */
export interface BundleCheck {
  policy: string;
  verdict: BundleVerdict;
  /** Set only when the contents are shown to differ. */
  exclusion: typeof INCOMPARABLE_BUNDLE_CONTENT_MISMATCH | null;
  note: string;
  a: BundleSide;
  b: BundleSide;
  /** What your bundle has that the other lacks, and the reverse. */
  onlyA: string[];
  onlyB: string[];
}

/** The relationships a person can state when they decide (the machine never states "non_match" as a suggestion; a rejection records it). */
export const DECIDABLE_RELATIONSHIPS = ['exact', 'variant', 'substitute', 'related'] as const;
export type DecidableRelationship = (typeof DECIDABLE_RELATIONSHIPS)[number];

/** Rows written before engine v2 carry only a class: this is what each class meant. */
export function relationshipOfClass(c: MatchClass): MatchRelationship {
  return c === 'identical' ? 'exact' : c === 'different_pack' ? 'variant' : c === 'comparable' ? 'substitute' : 'non_match';
}

/** The class older readers understand. A relationship they have no place for ("related", "insufficient") is stored as not_comparable, so it can never be shown as a comparison. */
export function classOfRelationship(r: MatchRelationship): MatchClass {
  return r === 'exact' ? 'identical' : r === 'variant' ? 'different_pack' : r === 'substitute' ? 'comparable' : 'not_comparable';
}

/** Which relationships feed the default Price Comparison (only after a person confirms them) and which feed the separate substitute view. */
export const PRICE_COMPARISON_RELATIONSHIPS: readonly MatchRelationship[] = ['exact', 'variant'];
export const SUBSTITUTE_RELATIONSHIPS: readonly MatchRelationship[] = ['substitute'];

export const MATCHING_ENGINES = ['v1', 'v2_shadow', 'v2'] as const;
export type MatchingEngine = (typeof MATCHING_ENGINES)[number];

export const SCAN_STATUSES = ['queued', 'running', 'succeeded', 'partial', 'failed', 'blocked', 'cancelled'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const SCAN_KINDS = ['discovery', 'refresh', 'sample'] as const;
export type ScanKind = (typeof SCAN_KINDS)[number];

export const OFFER_KINDS = [
  'sale_price',
  'banner',
  'coupon',
  'minimum_order',
  'bundle',
  'buy_x_get_y',
  'payment_offer',
  'cashback',
  'free_shipping',
  'time_limited',
  'flyer',
] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];

export const OFFER_VERIFICATION = ['unverified', 'verified', 'contradicted', 'insufficient_history'] as const;
export type OfferVerification = (typeof OFFER_VERIFICATION)[number];

export const OFFER_STATUSES = ['active', 'presumed_ended', 'ended', 'expired'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** A person's verdict on a machine reading of an offer (flyer line, banner…). */
export const OFFER_REVIEW_STATUSES = ['unreviewed', 'confirmed', 'corrected', 'dismissed'] as const;
export type OfferReviewStatus = (typeof OFFER_REVIEW_STATUSES)[number];

/** Offers derived from structured product prices are facts about the catalogue, not readings to review. */
export const REVIEWABLE_OFFER_KINDS = ['flyer', 'banner', 'coupon', 'minimum_order', 'bundle', 'buy_x_get_y', 'payment_offer', 'cashback', 'free_shipping', 'time_limited'] as const;

export const ALERT_TYPES = [
  'low_stock',
  'out_of_stock',
  'restocked',
  'collection_failure',
  'report_ready',
  'report_partial',
  'integration_issue',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** Alerts about a condition that can clear (and be resolved). The rest are one-off notices: acknowledging them is all there is to do. */
export const RESOLVABLE_ALERT_TYPES: readonly AlertType[] = ['low_stock', 'out_of_stock', 'collection_failure', 'integration_issue'];

export const ALERT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const STOCK_STATES = ['in_stock', 'low_stock', 'out_of_stock', 'unknown'] as const;
export type StockState = (typeof STOCK_STATES)[number];

export const REPORT_STATUSES = ['generating', 'ready', 'partial', 'failed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_FORMATS = ['pdf', 'csv', 'xlsx'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** The tables of a saved report that can be downloaded as CSV (one file per table). The export service, the API and the Reports page all use this one list. */
export const CSV_DATASETS = ['comparison', 'offers', 'stock', 'marketing', 'marketing_summary', 'insights', 'coverage', 'assortment'] as const;
export type CsvDataset = (typeof CSV_DATASETS)[number];

export const INSIGHT_TYPES = [
  'price_above_competitor',
  'price_below_competitor',
  'large_price_gap',
  'price_movement',
  'new_competitor_product',
  'competitor_delisting',
  'assortment_gap_competitor_only',
  'assortment_gap_source_only',
  'new_offer',
  'offer_ended',
  'low_stock',
  'out_of_stock',
  'competitor_availability_change',
  'marketing_activity',
  'basket_comparison',
  'coverage_warning',
] as const;
export type InsightType = (typeof INSIGHT_TYPES)[number];

export const SOCIAL_PLATFORMS = ['facebook', 'instagram', 'youtube'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const MARKETING_PLATFORMS = ['facebook', 'instagram', 'youtube', 'site'] as const;
export type MarketingPlatform = (typeof MARKETING_PLATFORMS)[number];

export const MARKETING_KINDS = [
  'social_post',
  'video',
  'promo_banner',
  'announcement_bar',
  'sale_page',
  'campaign_landing',
  'launch_announcement',
  'flyer',
] as const;
export type MarketingKind = (typeof MARKETING_KINDS)[number];

export const MARKETING_CLASSIFICATIONS = [
  'promotion',
  'product_launch',
  'seasonal',
  'brand_content',
  'unclassified',
] as const;
export type MarketingClassification = (typeof MARKETING_CLASSIFICATIONS)[number];

export const INTEGRATION_PROVIDERS = [
  'shopify',
  'youtube',
  'instagram',
  'facebook',
] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_STATUSES = ['connected', 'pending', 'revoked', 'error'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const CURRENCY_CODES_HINT = ['AWG', 'USD', 'EUR', 'ANG', 'CAD', 'GBP', 'COP', 'MXN'] as const;

/** Where a stored fact came from. Every observation, evidence record, offer, marketing item and exchange rate carries one. */
export const PROVENANCE = ['public_web', 'authorised_api', 'official_api', 'user_input', 'exchange_rate_service', 'configuration'] as const;
export type Provenance = (typeof PROVENANCE)[number];

export const PROVENANCE_LABELS: Record<Provenance, string> = {
  public_web: 'Public web page',
  authorised_api: 'Authorised connection',
  official_api: 'Official platform API',
  user_input: 'Entered by a person',
  exchange_rate_service: 'Exchange-rate service',
  configuration: 'Configured value',
};

export const PROVENANCE_HELP: Record<Provenance, string> = {
  public_web: 'Read from a publicly accessible web page, feed or document.',
  authorised_api: 'Returned by an integration the store owner authorised (for example Shopify inventory).',
  official_api: 'Returned by an official platform API such as the YouTube Data API.',
  user_input: 'Typed or decided by a person using the app.',
  exchange_rate_service: 'Fetched from an exchange-rate provider; the provider and time are stored.',
  configuration: 'An explicit, timestamped setting such as a fixed currency peg.',
};

export const DEFAULTS = {
  lowStockThreshold: 5,
  timezone: 'America/Aruba',
  reportReadyTime: '09:00',
  reportingCurrency: 'USD',
  snapshotRetentionDays: 90,
  historyRetentionDays: 365,
  /** The most competitor websites one workspace tracks. There is deliberately no minimum: one competitor is enough, more can be added any time. */
  maxCompetitors: 5,
  /** An observation older than this is shown as stale, never as freshly observed. */
  staleAfterHours: 36,
} as const;

/**
 * The single, honest answer to "what is the state of collection for this website?". Used by every screen so they never disagree.
 * A failure is never an empty success: "failed", "access_denied" and "unsupported" are different from "collected, 0 matches".
 */
export const SITE_STATES = [
  'inactive',
  'not_profiled',
  'awaiting_permission',
  'access_denied',
  'unsupported',
  'not_collected',
  'collecting',
  'failed',
  'partial',
  'collected',
  'stale',
] as const;
export type SiteState = (typeof SITE_STATES)[number];

export const SITE_STATE_LABELS: Record<SiteState, string> = {
  inactive: 'Not in use',
  not_profiled: 'Not checked yet',
  awaiting_permission: 'Collection rules not confirmed',
  access_denied: 'Access denied',
  unsupported: 'Not supported by this website',
  not_collected: 'Not yet collected',
  collecting: 'Collection in progress',
  failed: 'Collection failed',
  partial: 'Partially collected',
  collected: 'Collected',
  stale: 'Stale data',
};
