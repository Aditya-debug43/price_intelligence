import type {
  Provenance,
  Availability,
  InsightType,
  MarketingClassification,
  MarketingKind,
  MarketingPlatform,
  MatchClass,
  MatchStatus,
  OfferKind,
  OfferReviewStatus,
  OfferStatus,
  OfferVerification,
  ScanStatus,
  StockState,
  QuantitySource,
  CapabilityStatus,
  SiteRole,
  SiteState,
} from './constants.ts';

/** A price as displayed by the website, plus its normalised comparison value. Originals are always kept. */
export interface PriceView {
  amount: number | null;
  currency: string | null;
  compareAt: number | null;
  normalized: number | null;
  normalizedCurrency: string;
  fxRate: number | null;
  fxSource: string | null;
  fxAt: string | null;
  observedAt: string | null;
  stale: boolean;
  sourceUrl: string | null;
  observationId: string | null;
}

export interface UnitPriceView {
  /** Price per reference unit (per 100 g, per litre, per piece) in the reporting currency. */
  value: number | null;
  unit: string | null;
}

export interface ComparisonCell {
  siteId: string;
  siteName: string;
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string | null;
  /** The page this product was collected from, on its own website; `null` when none is stored or it cannot be verified (never a guess). */
  url: string | null;
  matchId: string;
  matchClass: MatchClass;
  matchStatus: MatchStatus;
  confidence: number;
  reasons: string[];
  price: PriceView;
  availability: Availability;
  unitPrice: UnitPriceView;
  /** Difference vs source in reporting currency (competitor minus source). Null if not computable. */
  diffAbs: number | null;
  diffPct: number | null;
  unitDiffPct: number | null;
  /** Same-pack direct comparison is only valid for identical matches. */
  directlyComparable: boolean;
  offerSummary: string | null;
  caveats: string[];
}

export interface ComparisonRow {
  sourceVariantId: string;
  sourceProductId: string;
  title: string;
  variantTitle: string | null;
  brand: string | null;
  category: string | null;
  sizeLabel: string | null;
  /** Your own product page (see `ComparisonCell.url`). */
  url: string | null;
  sourcePrice: PriceView;
  sourceAvailability: Availability;
  sourceUnitPrice: UnitPriceView;
  cells: ComparisonCell[];
  /** Position among directly comparable identical matches; "no_data" when nothing comparable. */
  position: 'cheapest' | 'middle' | 'highest' | 'tied' | 'no_data';
}

export interface OfferRow {
  id: string;
  siteId: string;
  siteName: string;
  siteRole: SiteRole;
  kind: OfferKind;
  title: string;
  description: string | null;
  conditions: string[];
  conditional: boolean;
  code: string | null;
  productTitle: string | null;
  variantId: string | null;
  originalPrice: number | null;
  salePrice: number | null;
  currency: string | null;
  claimedDiscountPct: number | null;
  historicalDiscountPct: number | null;
  verification: OfferVerification;
  validFrom: string | null;
  validTo: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  status: OfferStatus;
  sourceUrl: string | null;
  needsReview: boolean;
  confidence: number | null;
  /** Where this offer came from. Absent in report snapshots saved before provenance existed. */
  provenance?: Provenance;
  /** A person's verdict on the machine reading. Absent in report snapshots saved before offer review existed. */
  review?: {
    status: OfferReviewStatus;
    by: string | null;
    at: string | null;
    note: string | null;
    /** What the machine read before a person corrected it. */
    originalReading: Record<string, unknown> | null;
  };
  /** The page or flyer observation the offer was read from. */
  evidenceId?: string | null;
}

export interface StockRow {
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  url: string;
  state: StockState;
  availability: Availability;
  /** Only present when collected through an authorised source (or an explicit public claim). */
  quantity: number | null;
  quantitySource: QuantitySource | null;
  threshold: number;
  observedAt: string | null;
  stale: boolean;
  lastChangeAt: string | null;
  note: string | null;
  /** Authorised inventory and the public product page disagree (e.g. page says sold out, inventory holds units). */
  conflict?: boolean;
}

export interface MarketingEngagement {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  observedAt: string;
}

export interface EngagedItem {
  title: string;
  url: string | null;
  platform: string;
  value: number;
  observedAt: string;
}

export interface CompetitorMarketingSummary {
  siteId: string;
  siteName: string;
  total: number;
  byPlatform: Record<string, number>;
  byClassification: Record<string, number>;
  promotionCount: number;
  /** Words that recur across several different items, with example items. */
  themes: { term: string; items: number; examples: { title: string; url: string | null }[] }[];
  /** Brands from the catalogue mentioned in promotional items. A mention is not proof that the brand is discounted. */
  brandMentions: { brand: string; items: number }[];
  /** Day-of-week pattern of promotional items with a known publish time; null when there are too few to say anything. */
  timing: null | { basis: 'published'; items: number; byWeekday: { day: string; items: number }[]; busiest: { day: string; items: number }; sentence: string };
  timingNote: string | null;
  /** Ranked separately, because a view count and a like count are not comparable. */
  mostLiked: EngagedItem[];
  mostViewed: EngagedItem[];
  /** What we cannot see for this competitor, in plain language. */
  limitations: string[];
}

export interface MarketingSummary {
  windowDays: number;
  headline: string;
  competitors: CompetitorMarketingSummary[];
  note: string;
}

export interface MarketingRow {
  id: string;
  siteId: string;
  siteName: string;
  platform: MarketingPlatform;
  kind: MarketingKind;
  title: string | null;
  excerpt: string | null;
  url: string | null;
  publishedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  classification: MarketingClassification;
  confidence: number;
  /** Always explicit: observed content is not proof of paid advertising. */
  paidStatus: 'not_determined';
  note: string;
  provenance?: Provenance;
  /** Public counts from the platform's official API, when it provides them. Absent in snapshots saved before engagement existed. */
  engagement?: MarketingEngagement | null;
}

export interface InsightRow {
  id: string;
  type: InsightType;
  score: number;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  summary: string;
  /** Numeric facts, all derived from stored observations. */
  facts: Record<string, string | number | null>;
  evidence: InsightEvidence[];
  scoreBreakdown: Record<string, number>;
  siteId?: string | null;
}

export interface InsightEvidence {
  kind: 'observation' | 'variant' | 'offer' | 'marketing' | 'site' | 'match';
  id: string | null;
  url: string | null;
  observedAt: string | null;
  label: string;
}

/** The honest, human-readable collection state of one website (see core `deriveSiteStatus`). */
export interface SiteStatusView {
  state: SiteState;
  label: string;
  detail: string;
  severity: 'ok' | 'info' | 'warn' | 'bad';
  /** What the customer can do next, or null when nothing is needed. */
  nextAction: string | null;
}

export interface SiteCoverage {
  /** Absent in report snapshots saved before this field existed. */
  status?: SiteStatusView;
  /** Whether permission to collect from this website has been recorded. */
  consent?: 'pending' | 'confirmed' | 'revoked';
  siteId: string;
  name: string;
  hostname: string;
  role: SiteRole;
  capability: CapabilityStatus | null;
  connector: string | null;
  lastScanStatus: ScanStatus | null;
  lastScanAt: string | null;
  productsKnown: number;
  productsObservedFresh: number;
  productsStale: number;
  estimatedCatalogue: number | null;
  coveragePct: number | null;
  newestObservation: string | null;
  oldestObservation: string | null;
  complete: boolean;
  warnings: string[];
  failureReason: string | null;
}

export interface FxRateUsed {
  from: string;
  to: string;
  rate: number;
  source: string;
  fetchedAt: string;
  isFixed: boolean;
}

export interface BasketResult {
  siteId: string;
  siteName: string;
  itemsCompared: number;
  itemsAvailableInBoth: number;
  sourceTotal: number | null;
  competitorTotal: number | null;
  diffPct: number | null;
  currency: string;
  coveragePct: number;
  note: string;
}

/** What "no equivalent found" can honestly mean for this workspace right now (see `assortmentBasis` in core). */
export interface AssortmentBasis {
  /** At least one competitor is compared and every competitor's catalogue was read completely and recently. */
  competitorsComplete: boolean;
  /** Competitors whose catalogue is blocked, failed, not yet collected, stale or only partly read, with the reason in words. */
  competitorGaps: { siteId: string; name: string; reason: string }[];
  /** Whether your own catalogue was read completely and recently. */
  sourceComplete: boolean;
  sourceGap: string | null;
}

export interface AssortmentEntry {
  siteId: string;
  siteName: string;
  variantId: string;
  title: string;
  category: string | null;
  price: number | null;
  currency: string | null;
  firstSeenAt: string;
  url: string;
}

export interface ReportKpis {
  matchedProducts: number;
  identicalMatches: number;
  productsCheaperAtSource: number;
  productsPricierAtSource: number;
  productsAtParity: number;
  averageDiffPct: number | null;
  activeOffers: number;
  lowStockCount: number;
  outOfStockCount: number;
  newCompetitorProducts: number;
  marketingItems: number;
  sourceProducts: number;
  competitorProducts: number;
}

export interface ReportData {
  schemaVersion: 1;
  meta: {
    orgId: string;
    orgName: string;
    generatedAt: string;
    periodDate: string;
    timezone: string;
    reportingCurrency: string;
    deadlineAt: string | null;
    readyBeforeDeadline: boolean | null;
    isPartial: boolean;
    kind: 'scheduled' | 'manual';
    staleAfterHours: number;
  };
  fx: FxRateUsed[];
  sites: SiteCoverage[];
  kpis: ReportKpis;
  headline: string;
  warnings: string[];
  comparisons: ComparisonRow[];
  offers: OfferRow[];
  stock: StockRow[];
  marketing: MarketingRow[];
  insights: InsightRow[];
  assortment: { competitorOnly: AssortmentEntry[]; sourceOnly: AssortmentEntry[]; note: string; /** Absent in snapshots saved before it existed. */ basis?: AssortmentBasis };
  basket: BasketResult[];
  integrations: { provider: string; status: string; message: string }[];
  aiSummary: { text: string; validated: boolean; provider: string } | null;
  /** What the observed marketing activity shows, per competitor. Absent in snapshots saved before it existed. */
  marketingSummary?: MarketingSummary | null;
}
