import type { Availability, ConnectorId, ExtractionMethod, QuantitySource, SiteProfileData } from '@ci/shared';
import type { LlmProvider } from '@ci/core';
import type { SafeFetcher } from './safe-fetch.ts';

/** A product variant exactly as observed. Unknown values are null — never 0, never "in stock" by default. */
export interface ExtractedVariant {
  variantKey: string;
  sku: string | null;
  gtin: string | null;
  title: string | null;
  options: Record<string, string>;
  price: number | null;
  compareAtPrice: number | null;
  currency: string | null;
  shippingCost: number | null;
  availability: Availability;
  /** Exact quantity: only from an explicit public claim ("Only 3 left") or authorised inventory. */
  quantity: number | null;
  quantitySource: QuantitySource | null;
  url: string;
}

export interface ExtractionQuality {
  /** 0..1 completeness of the fields a price comparison needs. */
  score: number;
  missingFields: string[];
  notes: string[];
}

export interface EvidenceDoc {
  url: string;
  fetchedAt: Date;
  httpStatus: number;
  contentType: string;
  contentHash: string;
  bytes: number;
  /** Short excerpt that supports the extraction (JSON-LD block, price element, API record). */
  snippet: string;
  /** Raw body, stored as a snapshot subject to retention. Omitted when not worth keeping. */
  body?: Buffer;
}

export interface ExtractedProduct {
  url: string;
  externalId: string | null;
  title: string;
  brand: string | null;
  manufacturer: string | null;
  model: string | null;
  mpn: string | null;
  description: string | null;
  category: string | null;
  imageUrl: string | null;
  attrs: Record<string, unknown>;
  variants: ExtractedVariant[];
  method: ExtractionMethod;
  methodVersion: string;
  observedAt: Date;
  /** Index into the batch's `evidence` array. */
  evidenceIndex: number;
  quality: ExtractionQuality;
}

export interface PromoFinding {
  text: string;
  kind: 'announcement_bar' | 'promo_banner' | 'sale_page' | 'campaign_landing' | 'flyer';
  url: string | null;
}

export interface ConnectorBatch {
  products: ExtractedProduct[];
  evidence: EvidenceDoc[];
  /** Opaque, JSON-serialisable resume token persisted by the runner after the batch is saved. */
  cursor: Record<string, unknown> | null;
  progress: { estimatedTotal: number | null; discovered: number };
  warnings: string[];
  /** Further pages found while reading this one (the next page of a listing, category pages). The runner queues them within the request budget. */
  discoveredUrls?: { url: string; kind: 'listing' | 'product'; priority: number }[];
}

export interface ConnectorContext {
  site: { id: string; origin: string; hostname: string };
  profile: SiteProfileData | null;
  fetcher: SafeFetcher;
  /** Currency detected for the site (used when a feed carries prices without a currency code). */
  siteCurrency: string | null;
  now: () => Date;
  signal?: AbortSignal;
  log: (msg: string, meta?: Record<string, unknown>) => void;
  /** Soft ceilings. The fetcher enforces `requestBudget`; connectors may also stop earlier. */
  limits: { maxProducts: number | null };
  browser?: BrowserRenderer | null;
  /** Optional AI provider for evidence-validated fallback extraction. Null/absent when AI is not configured. */
  llm?: LlmProvider | null;
}

export interface BrowserRenderer {
  readonly available: boolean;
  render(url: string, opts: { timeoutMs: number }): Promise<{ html: string; finalUrl: string } | null>;
  close(): Promise<void>;
}

export interface ConnectorApplicability {
  score: number;
  reason: string;
}

/**
 * A collection strategy for one family of websites. Implementations live in separate files and are selected
 * dynamically from the site profile. Adding a connector never requires changing the runner.
 */
export interface Connector {
  readonly id: ConnectorId;
  readonly version: string;
  readonly label: string;
  /** "feed": paginated machine API (cursor = page). "pages": URL frontier crawl (resumable via the crawl queue). */
  readonly kind: 'feed' | 'pages';
  applicability(profile: SiteProfileData): ConnectorApplicability;
}

/** What a feed cross-check against the site's own product sitemaps found. */
export interface ReconcileOutcome {
  /** Products the sitemaps list (unique). */
  listed: number;
  /** Listed products that are not among the known ones. */
  missing: number;
  /** The missing products that could be read from their own pages (to be saved by the runner). */
  batch: ConnectorBatch;
  /** Missing products that could not be read (not found, refused, or beyond the per-run cap), by handle. */
  unreadable: string[];
  /** True when no product sitemap could be read at all: nothing was checked. */
  failed: boolean;
}

export interface FeedConnector extends Connector {
  readonly kind: 'feed';
  /** Fetch one page of the catalogue. `cursor` null starts at the beginning. Returns `done` when exhausted. */
  fetchPage(ctx: ConnectorContext, cursor: Record<string, unknown> | null): Promise<ConnectorBatch & { done: boolean }>;
  /** Re-fetch specific known product URLs (rolling refresh / small live sample). */
  refresh(ctx: ConnectorContext, urls: string[]): Promise<ConnectorBatch>;
  /**
   * Optional cross-check used when a feed ends with fewer products than the site's own sitemaps suggest: a feed that stops early would otherwise
   * look like a complete catalogue. Reads the sitemaps and the pages of up to `max` listed products whose handle is not in `known`.
   */
  reconcile?(ctx: ConnectorContext, known: Set<string>, opts: { max: number }): Promise<ReconcileOutcome>;
}

export interface PageConnector extends Connector {
  readonly kind: 'pages';
  /** True when known product pages are not the unit of work (a listing crawl re-reads the listings instead), so a refresh runs discovery again. */
  readonly refreshByDiscovery?: boolean;
  /** Discover candidate product URLs (sitemaps etc.) with optional last-modified hints. */
  discover(ctx: ConnectorContext): Promise<{
    urls: { url: string; lastmod?: string | null; kind?: 'listing' | 'product'; priority?: number }[];
    warnings: string[];
    estimatedTotal: number | null;
    /** True when the connector finds the rest of the catalogue itself while reading pages (listing crawl): the run is complete when its queue runs dry. */
    crawlsToCompletion?: boolean;
  }>;
  /** Extract products from one page. Returns [] when the page is not a product page. */
  extractPage(ctx: ConnectorContext, url: string): Promise<ConnectorBatch>;
}

export type AnyConnector = FeedConnector | PageConnector;
