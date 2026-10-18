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
  maxCompetitors: 5,
  minCompetitors: 3,
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
  awaiting_permission: 'Awaiting permission',
  access_denied: 'Access denied',
  unsupported: 'Not supported by this website',
  not_collected: 'Not yet collected',
  collecting: 'Collection in progress',
  failed: 'Collection failed',
  partial: 'Partially collected',
  collected: 'Collected',
  stale: 'Stale data',
};
