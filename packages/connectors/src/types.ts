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

export interface FeedConnector extends Connector {
  readonly kind: 'feed';
  /** Fetch one page of the catalogue. `cursor` null starts at the beginning. Returns `done` when exhausted. */
  fetchPage(ctx: ConnectorContext, cursor: Record<string, unknown> | null): Promise<ConnectorBatch & { done: boolean }>;
  /** Re-fetch specific known product URLs (rolling refresh / small live sample). */
  refresh(ctx: ConnectorContext, urls: string[]): Promise<ConnectorBatch>;
}

export interface PageConnector extends Connector {
  readonly kind: 'pages';
  /** Discover candidate product URLs (sitemaps etc.) with optional last-modified hints. */
  discover(ctx: ConnectorContext): Promise<{ urls: { url: string; lastmod?: string | null }[]; warnings: string[]; estimatedTotal: number | null }>;
  /** Extract products from one page. Returns [] when the page is not a product page. */
  extractPage(ctx: ConnectorContext, url: string): Promise<ConnectorBatch>;
}

export type AnyConnector = FeedConnector | PageConnector;
