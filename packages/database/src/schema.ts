import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  date,
} from 'drizzle-orm/pg-core';
import type {
  AlertSeverity,
  AlertType,
  Availability,
  CapabilityStatus,
  ConsentStatus,
  InsightType,
  IntegrationProvider,
  IntegrationStatus,
  MarketingClassification,
  MarketingKind,
  MarketingPlatform,
  MatchClass,
  MatchStatus,
  MemberRole,
  OfferKind,
  OfferReviewStatus,
  OfferStatus,
  OfferVerification,
  Provenance,
  QuantitySource,
  ReportFormat,
  ReportStatus,
  ScanKind,
  ScanStatus,
  SiteProfileData,
  SiteRole,
  StockState,
} from '@ci/shared';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const money = (name: string) => numeric(name, { precision: 14, scale: 4, mode: 'number' });
const pk = () => uuid('id').primaryKey().defaultRandom();

// ═══════════════════════════════════════════════════════ identity (not tenant-scoped; protected at the application layer)

export const users = pgTable(
  'users',
  {
    id: pk(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    emailVerifiedAt: ts('email_verified_at'),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: ts('locked_until'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastLoginAt: ts('last_login_at'),
  },
  (t) => [uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`)],
);

export const organizations = pgTable(
  'organizations',
  {
    id: pk(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('organizations_slug_uq').on(t.slug)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: pk(),
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [uniqueIndex('sessions_token_hash_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

export const emailTokens = pgTable(
  'email_tokens',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'verify' | 'reset'>().notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('email_tokens_hash_uq').on(t.tokenHash)],
);

/** Membership rows carry org_id but are read before a tenant context exists (e.g. "which orgs am I in?"), so they are RLS-exempt. */
export const memberships = pgTable(
  'memberships',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<MemberRole>().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('memberships_org_user_uq').on(t.orgId, t.userId), index('memberships_user_idx').on(t.userId)],
);

// ═══════════════════════════════════════════════════════ tenant-scoped tables (RLS enforced on every table with org_id)

const orgId = () =>
  uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

export interface AlertPrefs {
  inApp: boolean;
  email: boolean;
  dailySummaryEmail: boolean;
  recipients: string[];
}

export const orgSettings = pgTable('org_settings', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  reportingCurrency: text('reporting_currency').notNull().default('USD'),
  timezone: text('timezone').notNull().default('America/Aruba'),
  reportReadyTime: text('report_ready_time').notNull().default('09:00'),
  scheduleEnabled: boolean('schedule_enabled').notNull().default(true),
  lowStockThreshold: integer('low_stock_threshold').notNull().default(5),
  snapshotRetentionDays: integer('snapshot_retention_days').notNull().default(90),
  historyRetentionDays: integer('history_retention_days').notNull().default(365),
  alertPrefs: jsonb('alert_prefs')
    .$type<AlertPrefs>()
    .notNull()
    .default(sql`'{"inApp":true,"email":true,"dailySummaryEmail":true,"recipients":[]}'::jsonb`),
  aiAdjudication: boolean('ai_adjudication').notNull().default(false),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const sites = pgTable(
  'sites',
  {
    id: pk(),
    orgId: orgId(),
    url: text('url').notNull(),
    origin: text('origin').notNull(),
    hostname: text('hostname').notNull(),
    name: text('name').notNull(),
    role: text('role').$type<SiteRole>().notNull(),
    consentStatus: text('consent_status').$type<ConsentStatus>().notNull().default('pending'),
    consentNote: text('consent_note'),
    consentAt: ts('consent_at'),
    consentBy: uuid('consent_by').references(() => users.id, { onDelete: 'set null' }),
    active: boolean('active').notNull().default(true),
    platform: text('platform'),
    currency: text('currency'),
    /** "user" once the owner has confirmed/overridden the currency; profiling then never overwrites it. */
    currencySource: text('currency_source').$type<'detected' | 'user'>().notNull().default('detected'),
    capabilityStatus: text('capability_status').$type<CapabilityStatus>(),
    lastProfiledAt: ts('last_profiled_at'),
    crawlDelayMs: integer('crawl_delay_ms').notNull().default(1500),
    maxRequestsPerRun: integer('max_requests_per_run').notNull().default(2000),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sites_org_host_uq').on(t.orgId, t.hostname),
    uniqueIndex('sites_one_active_source_uq').on(t.orgId).where(sql`${t.role} = 'source' and ${t.active}`),
  ],
);

export const consentLog = pgTable(
  'consent_log',
  {
    id: pk(),
    orgId: orgId(),
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // collect_site | inventory_access
    status: text('status').$type<ConsentStatus>().notNull(),
    note: text('note'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('consent_log_org_idx').on(t.orgId, t.createdAt)],
);

export const siteProfiles = pgTable(
  'site_profiles',
  {
    id: pk(),
    orgId: orgId(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    status: text('status').$type<CapabilityStatus>().notNull(),
    summary: text('summary').notNull(),
    platform: text('platform'),
    data: jsonb('data').$type<SiteProfileData>().notNull(),
    durationMs: integer('duration_ms'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('site_profiles_site_idx').on(t.siteId, t.createdAt)],
);

export const dailyRuns = pgTable(
  'daily_runs',
  {
    id: pk(),
    orgId: orgId(),
    periodDate: date('period_date', { mode: 'string' }).notNull(),
    status: text('status').$type<'collecting' | 'assembling' | 'done' | 'failed'>().notNull().default('collecting'),
    trigger: text('trigger').$type<'scheduled' | 'manual' | 'dev'>().notNull().default('scheduled'),
    plannedStartAt: ts('planned_start_at'),
    startedAt: ts('started_at'),
    assembleAt: ts('assemble_at'),
    deadlineAt: ts('deadline_at'),
    assembledAt: ts('assembled_at'),
    reportId: uuid('report_id'),
    plan: jsonb('plan').$type<Record<string, unknown>>(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('daily_runs_org_date_uq').on(t.orgId, t.periodDate)],
);

export const scanRuns = pgTable(
  'scan_runs',
  {
    id: pk(),
    orgId: orgId(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    dailyRunId: uuid('daily_run_id').references(() => dailyRuns.id, { onDelete: 'set null' }),
    kind: text('kind').$type<ScanKind>().notNull(),
    status: text('status').$type<ScanStatus>().notNull().default('queued'),
    trigger: text('trigger').$type<'manual' | 'scheduled' | 'dev'>().notNull().default('manual'),
    connector: text('connector'),
    connectorVersion: text('connector_version'),
    limitProducts: integer('limit_products'),
    requestBudget: integer('request_budget'),
    requestsMade: integer('requests_made').notNull().default(0),
    urlsDiscovered: integer('urls_discovered').notNull().default(0),
    urlsFetched: integer('urls_fetched').notNull().default(0),
    productsSaved: integer('products_saved').notNull().default(0),
    variantsSaved: integer('variants_saved').notNull().default(0),
    errorsCount: integer('errors_count').notNull().default(0),
    estimatedTotal: integer('estimated_total'),
    /** Resumable connector cursor (page number, queue position, etc.). */
    cursor: jsonb('cursor').$type<Record<string, unknown>>(),
    /** True only when the catalogue was fully enumerated; partial runs never claim completeness. */
    isComplete: boolean('is_complete').notNull().default(false),
    errorCode: text('error_code'),
    error: text('error'),
    notes: jsonb('notes').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    deadlineAt: ts('deadline_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    heartbeatAt: ts('heartbeat_at'),
    /** How many times recovery has re-queued this run after its worker went silent. Capped, so a run that keeps dying is abandoned. */
    resumeCount: integer('resume_count').notNull().default(0),
  },
  (t) => [index('scan_runs_site_idx').on(t.siteId, t.createdAt), index('scan_runs_org_idx').on(t.orgId, t.createdAt)],
);

export const crawlQueue = pgTable(
  'crawl_queue',
  {
    id: pk(),
    orgId: orgId(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    scanRunId: uuid('scan_run_id')
      .notNull()
      .references(() => scanRuns.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    kind: text('kind').$type<'product' | 'sitemap' | 'listing'>().notNull().default('product'),
    priority: integer('priority').notNull().default(0),
    status: text('status').$type<'pending' | 'done' | 'failed' | 'skipped'>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('crawl_queue_run_url_uq').on(t.scanRunId, t.url), index('crawl_queue_pending_idx').on(t.scanRunId, t.status, t.priority)],
);

export const evidence = pgTable(
  'evidence',
  {
    id: pk(),
    orgId: orgId(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
    httpStatus: integer('http_status'),
    contentType: text('content_type'),
    contentHash: text('content_hash'),
    bytes: integer('bytes'),
    /** Raw snapshot lives in object storage and is purged after the snapshot retention window; this row remains. */
    snapshotRef: text('snapshot_ref'),
    snapshotPurgedAt: ts('snapshot_purged_at'),
    snippet: text('snippet'),
    extractionMethod: text('extraction_method'),
    extractionVersion: text('extraction_version'),
    provenance: text('provenance').$type<Provenance>().notNull().default('public_web'),
  },
  (t) => [index('evidence_site_idx').on(t.siteId, t.fetchedAt), index('evidence_purge_idx').on(t.fetchedAt)],
);

export const products = pgTable(
  'products',
  {
    id: pk(),
    orgId: orgId(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    canonicalUrl: text('canonical_url').notNull(),
    externalId: text('external_id'),
    title: text('title').notNull(),
    brand: text('brand'),
    manufacturer: text('manufacturer'),
    model: text('model'),
    mpn: text('mpn'),
    description: text('description'),
    category: text('category'),
    imageUrl: text('image_url'),
    attrs: jsonb('attrs').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    extractionMethod: text('extraction_method').notNull(),
    extractionVersion: text('extraction_version').notNull(),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    lastScanRunId: uuid('last_scan_run_id'),
    /** Consecutive COMPLETE scans in which the product was not found. Incomplete scans never increment this. */
    missedCompleteScans: integer('missed_complete_scans').notNull().default(0),
    delistedAt: ts('delisted_at'),
  },
  (t) => [
    uniqueIndex('products_site_url_uq').on(t.siteId, t.canonicalUrl),
    index('products_org_site_idx').on(t.orgId, t.siteId),
    index('products_first_seen_idx').on(t.siteId, t.firstSeenAt),
  ],
);

export const variants = pgTable(
  'variants',
  {
    id: pk(),
    orgId: orgId(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** Stable key within the product: platform variant id, else SKU, else "default". */
    variantKey: text('variant_key').notNull(),
    sku: text('sku'),
    gtin: text('gtin'),
    title: text('title'),
    options: jsonb('options').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    qtyKind: text('qty_kind'),
    qtyTotal: numeric('qty_total', { precision: 14, scale: 4, mode: 'number' }),
    qtyLabel: text('qty_label'),
    // ── current state (latest observation); history lives in the observation tables
    price: money('price'),
    compareAtPrice: money('compare_at_price'),
    currency: text('currency'),
    shippingCost: money('shipping_cost'),
    availability: text('availability').$type<Availability>().notNull().default('unknown'),
    quantity: integer('quantity'),
    quantitySource: text('quantity_source').$type<QuantitySource>(),
    observedAt: ts('observed_at'),
    lastPriceChangeAt: ts('last_price_change_at'),
    currentPriceObservationId: uuid('current_price_observation_id'),
    url: text('url').notNull(),
    lowStockThreshold: integer('low_stock_threshold'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('variants_product_key_uq').on(t.productId, t.variantKey),
    index('variants_site_idx').on(t.siteId),
    index('variants_gtin_idx').on(t.orgId, t.gtin),
    index('variants_observed_idx').on(t.siteId, t.observedAt),
  ],
);

export const priceObservations = pgTable(
  'price_observations',
  {
    id: pk(),
    orgId: orgId(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'cascade' }),
    observedAt: ts('observed_at').notNull(),
    price: money('price'),
    compareAtPrice: money('compare_at_price'),
    currency: text('currency'),
    shippingCost: money('shipping_cost'),
    availability: text('availability').$type<Availability>().notNull().default('unknown'),
    sourceUrl: text('source_url').notNull(),
    evidenceId: uuid('evidence_id').references(() => evidence.id, { onDelete: 'set null' }),
    scanRunId: uuid('scan_run_id').references(() => scanRuns.id, { onDelete: 'set null' }),
    extractionMethod: text('extraction_method').notNull(),
    extractionVersion: text('extraction_version').notNull(),
    provenance: text('provenance').$type<Provenance>().notNull().default('public_web'),
  },
  (t) => [index('price_obs_variant_idx').on(t.variantId, t.observedAt), index('price_obs_org_time_idx').on(t.orgId, t.observedAt)],
);

export const stockObservations = pgTable(
  'stock_observations',
  {
    id: pk(),
    orgId: orgId(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'cascade' }),
    observedAt: ts('observed_at').notNull(),
    availability: text('availability').$type<Availability>().notNull(),
    /** Null unless collected from an authorised source or an explicit public claim. Never estimated. */
    quantity: integer('quantity'),
    quantitySource: text('quantity_source').$type<QuantitySource>(),
    tracked: boolean('tracked').notNull().default(true),
    locationId: text('location_id'),
    locationName: text('location_name'),
    connectionId: uuid('connection_id'),
    evidenceId: uuid('evidence_id').references(() => evidence.id, { onDelete: 'set null' }),
    scanRunId: uuid('scan_run_id').references(() => scanRuns.id, { onDelete: 'set null' }),
    provenance: text('provenance').$type<Provenance>().notNull().default('public_web'),
  },
  (t) => [index('stock_obs_variant_idx').on(t.variantId, t.observedAt), index('stock_obs_org_time_idx').on(t.orgId, t.observedAt)],
);

export const stockStates = pgTable(
  'stock_states',
  {
    variantId: uuid('variant_id')
      .primaryKey()
      .references(() => variants.id, { onDelete: 'cascade' }),
    orgId: orgId(),
    state: text('state').$type<StockState>().notNull().default('unknown'),
    lastKnownState: text('last_known_state').$type<StockState>(),
    episode: integer('episode').notNull().default(0),
    quantity: integer('quantity'),
    quantitySource: text('quantity_source').$type<QuantitySource>(),
    basis: text('basis'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    lastChangeAt: ts('last_change_at'),
  },
  (t) => [index('stock_states_org_idx').on(t.orgId, t.state)],
);

export const collectionHealth = pgTable('collection_health', {
  siteId: uuid('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  orgId: orgId(),
  failing: boolean('failing').notNull().default(false),
  episode: integer('episode').notNull().default(0),
  lastOkAt: ts('last_ok_at'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const offers = pgTable(
  'offers',
  {
    id: pk(),
    orgId: orgId(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<OfferKind>().notNull(),
    title: text('title').notNull(),
    description: text('description'),
    conditions: jsonb('conditions').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    conditional: boolean('conditional').notNull().default(false),
    code: text('code'),
    variantId: uuid('variant_id').references(() => variants.id, { onDelete: 'set null' }),
    productTitle: text('product_title'),
    originalPrice: money('original_price'),
    salePrice: money('sale_price'),
    currency: text('currency'),
    claimedDiscountPct: numeric('claimed_discount_pct', { precision: 6, scale: 2, mode: 'number' }),
    historicalDiscountPct: numeric('historical_discount_pct', { precision: 6, scale: 2, mode: 'number' }),
    verification: text('verification').$type<OfferVerification>().notNull().default('unverified'),
    verificationReason: text('verification_reason'),
    validFrom: ts('valid_from'),
    validTo: ts('valid_to'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    status: text('status').$type<OfferStatus>().notNull().default('active'),
    missedCompleteScans: integer('missed_complete_scans').notNull().default(0),
    sourceUrl: text('source_url'),
    evidenceId: uuid('evidence_id').references(() => evidence.id, { onDelete: 'set null' }),
    extractionMethod: text('extraction_method').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3, mode: 'number' }),
    needsReview: boolean('needs_review').notNull().default(false),
    provenance: text('provenance').$type<Provenance>().notNull().default('public_web'),
    dedupeKey: text('dedupe_key').notNull(),
    /** A person's verdict on an uncertain reading. Re-collecting the same item never overwrites it. */
    reviewStatus: text('review_status').$type<OfferReviewStatus>().notNull().default('unreviewed'),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: ts('reviewed_at'),
    reviewNote: text('review_note'),
    /** What the machine read before a person corrected it (kept for audit; only the first correction records it). */
    originalReading: jsonb('original_reading').$type<Record<string, unknown>>(),
  },
  (t) => [uniqueIndex('offers_dedupe_uq').on(t.orgId, t.siteId, t.dedupeKey), index('offers_site_status_idx').on(t.siteId, t.status)],
);

export const flyers = pgTable(
  'flyers',
  {
    id: pk(),
    orgId: orgId(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    contentHash: text('content_hash').notNull(),
    title: text('title'),
    pageCount: integer('page_count'),
    status: text('status').$type<'extracted' | 'no_text_layer' | 'failed'>().notNull(),
    itemsFound: integer('items_found').notNull().default(0),
    needsReview: integer('needs_review').notNull().default(0),
    message: text('message'),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
    evidenceId: uuid('evidence_id').references(() => evidence.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('flyers_site_hash_uq').on(t.siteId, t.contentHash)],
);

export const productMatches = pgTable(
  'product_matches',
  {
    id: pk(),
    orgId: orgId(),
    sourceVariantId: uuid('source_variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'cascade' }),
    competitorVariantId: uuid('competitor_variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'cascade' }),
    competitorSiteId: uuid('competitor_site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    matchClass: text('match_class').$type<MatchClass>().notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3, mode: 'number' }).notNull(),
    status: text('status').$type<MatchStatus>().notNull(),
    method: text('method').notNull(),
    reasons: jsonb('reasons').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    components: jsonb('components').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: ts('decided_at'),
    decisionNote: text('decision_note'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('matches_pair_uq').on(t.sourceVariantId, t.competitorVariantId),
    index('matches_org_status_idx').on(t.orgId, t.status, t.matchClass),
    index('matches_competitor_idx').on(t.competitorVariantId),
  ],
);

export const socialAccounts = pgTable(
  'social_accounts',
  {
    id: pk(),
    orgId: orgId(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    platform: text('platform').$type<'facebook' | 'instagram' | 'youtube'>().notNull(),
    handle: text('handle').notNull(),
    url: text('url'),
    /** Where the mapping came from: official site link, structured data, or manual entry. */
    discoveredFrom: text('discovered_from').$type<'site_link' | 'structured_data' | 'manual'>().notNull(),
    confirmed: boolean('confirmed').notNull().default(false),
    confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    externalId: text('external_id'),
    lastSyncAt: ts('last_sync_at'),
    lastSyncStatus: text('last_sync_status'),
    lastSyncMessage: text('last_sync_message'),
    /** Why the last attempt failed, and when asking again is allowed (null = only after the credential changes). */
    failureKind: text('failure_kind').$type<'quota' | 'rate_limit' | 'transient' | 'permission' | 'not_found' | 'auth'>(),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at'),
    /** A short one-way fingerprint of the credential used for the failed attempt, so changing the credential resets the backoff. Never the credential itself. */
    credentialFingerprint: text('credential_fingerprint'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('social_accounts_uq').on(t.siteId, t.platform, t.handle)],
);

export const marketingActivities = pgTable(
  'marketing_activities',
  {
    id: pk(),
    orgId: orgId(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    platform: text('platform').$type<MarketingPlatform>().notNull(),
    kind: text('kind').$type<MarketingKind>().notNull(),
    title: text('title'),
    excerpt: text('excerpt'),
    url: text('url'),
    publishedAt: ts('published_at'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    classification: text('classification').$type<MarketingClassification>().notNull().default('unclassified'),
    confidence: numeric('confidence', { precision: 4, scale: 3, mode: 'number' }).notNull().default(0.5),
    evidenceId: uuid('evidence_id').references(() => evidence.id, { onDelete: 'set null' }),
    extractionMethod: text('extraction_method').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    provenance: text('provenance').$type<Provenance>().notNull().default('public_web'),
    /** Public counts as of `engagementObservedAt`. A count the platform did not provide is absent, never zero. */
    engagement: jsonb('engagement').$type<{ views: number | null; likes: number | null; comments: number | null; shares: number | null }>(),
    engagementObservedAt: ts('engagement_observed_at'),
  },
  (t) => [uniqueIndex('marketing_dedupe_uq').on(t.orgId, t.siteId, t.dedupeKey), index('marketing_site_idx').on(t.siteId, t.firstSeenAt)],
);

export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: pk(),
    orgId: orgId(),
    provider: text('provider').$type<IntegrationProvider>().notNull(),
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
    status: text('status').$type<IntegrationStatus>().notNull().default('pending'),
    shopDomain: text('shop_domain'),
    scopes: text('scopes'),
    /** AES-256-GCM ciphertext (see core/crypto). Never logged, never returned by the API. */
    accessTokenEnc: text('access_token_enc'),
    refreshTokenEnc: text('refresh_token_enc'),
    accessTokenExpiresAt: ts('access_token_expires_at'),
    refreshTokenExpiresAt: ts('refresh_token_expires_at'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    connectedBy: uuid('connected_by').references(() => users.id, { onDelete: 'set null' }),
    connectedAt: ts('connected_at'),
    revokedAt: ts('revoked_at'),
    lastSyncAt: ts('last_sync_at'),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('integration_org_idx').on(t.orgId, t.provider)],
);

export const oauthStates = pgTable(
  'oauth_states',
  {
    id: pk(),
    orgId: orgId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    state: text('state').notNull(),
    shop: text('shop'),
    siteId: uuid('site_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
  },
  (t) => [uniqueIndex('oauth_states_state_uq').on(t.state)],
);

/**
 * An offer to join a workspace, addressed to an email address. Only a hash of the single-use token is stored. This table is exempt from
 * row-level security (see RLS_EXEMPT_TABLES): accepting happens before the person belongs to any workspace, so the token itself is the
 * capability; everything that lists or changes invitations is explicitly scoped to the caller's workspace.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: pk(),
    orgId: orgId(),
    /** Normalised (trimmed, lower-case). Acceptance requires signing in as exactly this address. */
    email: text('email').notNull(),
    role: text('role').$type<MemberRole>().notNull().default('staff'),
    tokenHash: text('token_hash').notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    /** When the current link was last sent (a resend rotates the token and extends the expiry). */
    lastSentAt: ts('last_sent_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    acceptedAt: ts('accepted_at'),
    acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    uniqueIndex('invitations_token_uq').on(t.tokenHash),
    uniqueIndex('invitations_pending_uq').on(t.orgId, t.email).where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    index('invitations_org_idx').on(t.orgId, t.createdAt),
  ],
);

export const alertRules = pgTable(
  'alert_rules',
  {
    id: pk(),
    orgId: orgId(),
    type: text('type').$type<AlertType>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    channelInApp: boolean('channel_in_app').notNull().default(true),
    channelEmail: boolean('channel_email').notNull().default(true),
  },
  (t) => [uniqueIndex('alert_rules_org_type_uq').on(t.orgId, t.type)],
);

export const alerts = pgTable(
  'alerts',
  {
    id: pk(),
    orgId: orgId(),
    type: text('type').$type<AlertType>().notNull(),
    severity: text('severity').$type<AlertSeverity>().notNull().default('info'),
    title: text('title').notNull(),
    body: text('body'),
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references(() => variants.id, { onDelete: 'cascade' }),
    reportId: uuid('report_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** Unique per (org, transition): replays of the same transition insert nothing. */
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    acknowledgedAt: ts('acknowledged_at'),
    acknowledgedBy: uuid('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
    emailedAt: ts('emailed_at'),
    /** The page observation that raised the alert (absent when the source was an authorised connection rather than a page). */
    evidenceId: uuid('evidence_id').references(() => evidence.id, { onDelete: 'set null' }),
    /** Lifecycle: open → acknowledged → resolved. Resolved means the condition cleared (automatic) or a person closed it (manual). */
    resolvedAt: ts('resolved_at'),
    resolutionKind: text('resolution_kind').$type<'automatic' | 'manual'>(),
    /** Null for an automatic resolution. */
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolutionNote: text('resolution_note'),
    /** The observation that showed the condition had cleared. */
    resolutionEvidenceId: uuid('resolution_evidence_id').references(() => evidence.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('alerts_dedupe_uq').on(t.orgId, t.dedupeKey),
    index('alerts_org_time_idx').on(t.orgId, t.createdAt),
    index('alerts_unresolved_idx').on(t.orgId, t.variantId).where(sql`${t.resolvedAt} is null`),
  ],
);

export const reports = pgTable(
  'reports',
  {
    id: pk(),
    orgId: orgId(),
    status: text('status').$type<ReportStatus>().notNull().default('generating'),
    kind: text('kind').$type<'scheduled' | 'manual'>().notNull(),
    periodDate: date('period_date', { mode: 'string' }).notNull(),
    title: text('title').notNull(),
    isPartial: boolean('is_partial').notNull().default(false),
    readyBeforeDeadline: boolean('ready_before_deadline'),
    deadlineAt: ts('deadline_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    generatedAt: ts('generated_at'),
    schemaVersion: integer('schema_version').notNull().default(1),
    dataHash: text('data_hash'),
    /** The immutable snapshot (ReportData). Dashboard and every export format render from this single document. */
    data: jsonb('data'),
    summaryText: text('summary_text'),
    error: text('error'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    dailyRunId: uuid('daily_run_id'),
  },
  (t) => [index('reports_org_period_idx').on(t.orgId, t.periodDate, t.createdAt)],
);

export const reportExports = pgTable(
  'report_exports',
  {
    id: pk(),
    orgId: orgId(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    format: text('format').$type<ReportFormat>().notNull(),
    dataset: text('dataset').notNull().default('all'),
    storageKey: text('storage_key').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    checksum: text('checksum').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('report_exports_uq').on(t.reportId, t.format, t.dataset)],
);

export const insights = pgTable(
  'insights',
  {
    id: pk(),
    orgId: orgId(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    type: text('type').$type<InsightType>().notNull(),
    score: numeric('score', { precision: 7, scale: 1, mode: 'number' }).notNull(),
    severity: text('severity').$type<AlertSeverity>().notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    facts: jsonb('facts').$type<Record<string, unknown>>().notNull(),
    evidence: jsonb('evidence').$type<unknown[]>().notNull(),
    scoreBreakdown: jsonb('score_breakdown').$type<Record<string, number>>().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('insights_report_key_uq').on(t.reportId, t.key), index('insights_org_score_idx').on(t.orgId, t.createdAt)],
);

export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: pk(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    toAddresses: text('to_addresses').array().notNull(),
    subject: text('subject').notNull(),
    html: text('html').notNull(),
    text: text('text').notNull(),
    kind: text('kind').notNull(),
    /** queued → sent | retrying → sent | failed (gave up) | not_configured (no mail server: never sent). 'sent' means the mail server accepted it. */
    status: text('status').$type<'queued' | 'sent' | 'retrying' | 'failed' | 'not_configured'>().notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    relatedId: uuid('related_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastAttemptAt: ts('last_attempt_at'),
    sentAt: ts('sent_at'),
    /** The mail server's Message-ID and final response line for an accepted message. */
    providerMessageId: text('provider_message_id'),
    providerResponse: text('provider_response'),
  },
  (t) => [index('email_outbox_org_idx').on(t.orgId, t.createdAt)],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: pk(),
    orgId: orgId(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    target: text('target'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('audit_org_idx').on(t.orgId, t.createdAt)],
);

// ═══════════════════════════════════════════════════════ global reference data

export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: pk(),
    base: text('base').notNull(),
    quote: text('quote').notNull(),
    rate: numeric('rate', { precision: 24, scale: 8, mode: 'number' }).notNull(),
    source: text('source').notNull(),
    isFixed: boolean('is_fixed').notNull().default(false),
    /** 'configuration' for the explicit peg, 'exchange_rate_service' for fetched market rates. */
    provenance: text('provenance').$type<Provenance>().notNull().default('exchange_rate_service'),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
  },
  (t) => [index('fx_pair_idx').on(t.base, t.quote, t.fetchedAt)],
);

