import type { CapabilityStatus, ConnectorId, PlatformId } from './constants.ts';

export type FieldKey =
  | 'title'
  | 'price'
  | 'compare_at_price'
  | 'currency'
  | 'availability'
  | 'brand'
  | 'sku'
  | 'gtin'
  | 'description'
  | 'category'
  | 'image'
  | 'variants'
  | 'size_or_weight'
  | 'shipping_cost'
  | 'stock_quantity';

export type FieldAvailability = 'available' | 'partial' | 'missing' | 'unknown';

export interface FieldCapability {
  availability: FieldAvailability;
  /** Share (0..1) of sampled products exposing the field, or null when not measured. */
  coverage: number | null;
  /** Where the evidence came from (e.g. "JSON-LD on sampled product pages"). */
  source: string | null;
  note?: string;
}

export interface ProfileLimitation {
  code: string;
  severity: 'info' | 'warning' | 'blocking';
  /** Plain-language explanation for a non-technical business owner. */
  message: string;
}

export interface PublicApiProbe {
  kind: 'shopify_products_json' | 'woocommerce_store_api';
  url: string;
  usable: boolean;
  /** Total catalogue size if the API discloses it. */
  total: number | null;
  notes: string;
}

export interface SitemapSummary {
  url: string;
  kind: 'index' | 'products' | 'collections' | 'pages' | 'other';
  urlCount: number | null;
  /** True when the document could not be fetched or parsed. */
  failed?: boolean;
}

export interface SampledProduct {
  url: string;
  title: string | null;
  price: number | null;
  currency: string | null;
  availability: string | null;
  gtin: string | null;
  brand: string | null;
  method: string | null;
}

/** What a website's terms of use say about automated access and copying (a screening aid, not legal advice). "not_found" = no readable terms page, which is never read as permission. */
export type TermsLevel = 'prohibits_automation' | 'restricts_copying' | 'none_found' | 'not_found';
export interface TermsClause {
  kind: 'automation' | 'copying';
  text: string;
}
export interface TermsPageReview {
  url: string;
  level: Exclude<TermsLevel, 'not_found'>;
  clauses: TermsClause[];
}
export interface TermsReview {
  level: TermsLevel;
  /** When the pages were read (ISO time). */
  checkedAt: string;
  pages: TermsPageReview[];
  /** True when the customer had recorded the owner's written permission when this review was made. */
  permissionRecorded: boolean;
}

export interface SiteProfileData {
  status: CapabilityStatus;
  /** One or two plain-language sentences. */
  summary: string;
  site: {
    requestedUrl: string;
    /** The page the customer pointed at when it was not the home page ("/shop"); null for a bare address. Absent in profiles made before this existed. */
    entryPath?: string | null;
    finalUrl: string | null;
    origin: string | null;
    canonicalHost: string | null;
    title: string | null;
    httpStatus: number | null;
    reachable: boolean;
    responseTimeMs: number | null;
    redirectChain: string[];
  };
  platform: { id: PlatformId; confidence: number; evidence: string[] };
  access: {
    robots: {
      fetched: boolean;
      httpStatus: number | null;
      allowsHome: boolean;
      /** Whether robots.txt permits the page the customer pointed at (only when it was not the home page). */
      entryAllowed?: boolean;
      disallowsAll: boolean;
      crawlDelaySeconds: number | null;
      sitemaps: string[];
      note: string | null;
    };
    loginRequired: boolean;
    challengeDetected: boolean;
    challengeKind: string | null;
    barriers: string[];
  };
  catalogue: {
    sitemaps: SitemapSummary[];
    productUrlSample: string[];
    estimatedProducts: number | null;
    estimateBasis: string;
    publicApis: PublicApiProbe[];
    /** Product listing pages (grids of product cards), found by reading the site's own pages. Absent in profiles made before this existed. */
    listing?: { found: boolean; pageUrl: string | null; cardsOnPage: number; hasPagination: boolean; categoryLinks: number; totalHint: number | null };
  };
  fields: Record<FieldKey, FieldCapability>;
  currency: { detected: string | null; candidates: string[]; evidence: string[]; conflicting: boolean };
  rendering: { requiresJavaScript: boolean; evidence: string };
  promotions: {
    bannerTexts: string[];
    saleLinks: string[];
    flyerLinks: string[];
    couponMentions: string[];
  };
  social: { facebook: string | null; instagram: string | null; youtube: string | null; other: string[] };
  strategy: { recommended: ConnectorId[]; primary: ConnectorId | null; reason: string };
  effort: {
    requestsEstimate: number | null;
    minutesEstimate: number | null;
    crawlDelayMs: number;
    maxRequestsPerRun: number;
    notes: string;
  };
  /** The terms-of-use review. Absent in profiles made before it existed (those are re-profiled before the next collection). */
  terms?: TermsReview;
  sampledProducts: SampledProduct[];
  limitations: ProfileLimitation[];
  conflicts: string[];
  requestsMade: number;
  durationMs: number;
}
