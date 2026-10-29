import type { SiteStatusView, CapabilityStatus, ReportData, SiteProfileData, InsightRow, ReportKpis, SiteCoverage, ComparisonRow, OfferRow, StockRow, MarketingRow, SiteRole } from '@ci/shared';

export interface Me {
  user: { id: string; email: string; displayName: string; emailVerified: boolean };
  memberships: { orgId: string; name: string; slug: string; role: 'owner' | 'admin' | 'staff' }[];
}

export interface Meta {
  appBaseUrl: string;
  emailConfigured: boolean;
  aiProvider: string;
  browserRendering: boolean;
  shopifyConfigured: boolean;
  version: string;
}

export interface Settings {
  orgId: string;
  reportingCurrency: string;
  timezone: string;
  reportReadyTime: string;
  scheduleEnabled: boolean;
  lowStockThreshold: number;
  snapshotRetentionDays: number;
  historyRetentionDays: number;
  alertPrefs: { inApp: boolean; email: boolean; dailySummaryEmail: boolean; recipients: string[] };
  aiAdjudication: boolean;
  matchingEngine: 'v1' | 'v2_shadow' | 'v2';
}

export interface SiteItem {
  id: string;
  name: string;
  url: string;
  /** The page typed instead of the home page ("/shop"), or null. */
  entryPath: string | null;
  hostname: string;
  role: SiteRole;
  active: boolean;
  consentStatus: 'pending' | 'confirmed' | 'revoked';
  consentAt: string | null;
  /** The owner's written permission is recorded (needed when the website's terms forbid automated access). */
  writtenPermission: boolean;
  /** What the website's terms of use say about automated access, from its latest check; null = not checked yet. */
  termsLevel: 'prohibits_automation' | 'restricts_copying' | 'none_found' | 'not_found' | null;
  termsClause: { text: string; url: string } | null;
  platform: string | null;
  currency: string | null;
  currencySource: 'detected' | 'user';
  capabilityStatus: CapabilityStatus | null;
  lastProfiledAt: string | null;
  crawlDelayMs: number;
  maxRequestsPerRun: number;
  productCount: number;
  lastScan: { id: string; status: string; kind: string; finishedAt: string | null; productsSaved: number; isComplete: boolean } | null;
  /** The single honest collection state (not checked / awaiting permission / collecting / collected / failed / …). */
  status: SiteStatusView | null;
}

export interface SitesResponse {
  sites: SiteItem[];
  consentText: { version: string; source: string; competitor: string };
  limits: { maxCompetitors: number };
}

export interface ProfileResponse {
  profile: { id: string; createdAt: string; status: CapabilityStatus; summary: string; data: SiteProfileData } | null;
}

export interface ScanRun {
  id: string;
  siteId: string;
  kind: string;
  status: string;
  trigger: string;
  connector: string | null;
  requestsMade: number;
  requestBudget: number | null;
  urlsDiscovered: number;
  urlsFetched: number;
  productsSaved: number;
  errorsCount: number;
  estimatedTotal: number | null;
  isComplete: boolean;
  errorCode: string | null;
  error: string | null;
  notes: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ScanDetailData {
  run: ScanRun;
  siteName: string;
  queue: Record<string, number>;
  explanation: { summary: string; completeness: 'complete' | 'partial' | 'none'; reason: string | null; nextStep: string | null; scopeNote?: string | null; resumeAt?: string | null };
  failureReasons: { reason: string; count: number }[];
  failedUrls: { url: string; error: string | null }[];
  skippedUrls: { url: string; error: string | null }[];
}

export interface DashboardData {
  latestReport: null | {
    id: string;
    periodDate: string;
    generatedAt: string | null;
    isPartial: boolean;
    headline: string;
    readyBeforeDeadline: boolean | null;
    kpis: ReportKpis;
    topInsights: InsightRow[];
    warnings: string[];
  };
  coverage: SiteCoverage[];
  alerts: { unacknowledged: number; recent: AlertItem[] };
  activeScans: { id: string; siteId: string; status: string; kind: string; productsSaved: number; estimatedTotal: number | null }[];
  matchesNeedingReview: number;
  nextReport: null | { date: string; deadlineAt: string; plannedStartAt: string; basis: string; timezone: string; enabled: boolean };
  trend: { periodDate: string; averageDiffPct: number | null; matchedProducts: number; isPartial: boolean }[];
  freshness: { newest: string | null; oldest: string | null; staleProducts: number; staleAfterHours: number };
}

export interface AlertItem {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  reportId?: string | null;
  variantId?: string | null;
}

export interface AlertEvidence {
  id: string;
  url: string;
  observedAt: string;
  provenance: string;
  method: string | null;
  snippet: string | null;
  snapshotPurged: boolean;
}

/** An alert as the Alerts page shows it: status, what we looked at, and how it ended. */
export interface AlertDetail extends AlertItem {
  status: 'open' | 'acknowledged' | 'resolved';
  resolvable: boolean;
  siteId: string | null;
  siteName: string | null;
  productId: string | null;
  productTitle: string | null;
  data: Record<string, unknown>;
  evidence: AlertEvidence | null;
  acknowledgedBy: string | null;
  resolution: null | { at: string; kind: 'automatic' | 'manual'; by: string | null; note: string | null; evidence: AlertEvidence | null };
}

export interface ComparisonResponse {
  rows: ComparisonRow[];
  total: number;
  reportingCurrency: string;
  facets: { categories: string[]; competitors: { id: string; name: string; capability: CapabilityStatus | null; status: SiteStatusView | null }[] };
  fx: { from: string; to: string; rate: number; source: string; fetchedAt: string; isFixed: boolean }[];
  asOf: string;
  view: 'prices' | 'substitutes';
  /** What exists behind an empty or partial list: nothing suggested, suggested but unconfirmed, or confirmed. */
  matching: { state: 'no_competitors' | 'never_run' | 'shadow' | 'no_candidates' | 'none_confirmed' | 'ok'; awaiting: number; confirmedSame: number; confirmedSubstitutes: number; withoutCounterpart: number | null };
}

export interface StockResponse {
  rows: StockRow[];
  counts: { low: number; out: number; unknown: number; in: number };
  /** Items (variants — what a customer can buy); the counts above are per item. */
  total: number;
  /** The distinct products those items belong to. Absent from a backend older than the website (the two are deployed separately). */
  products?: number;
  threshold: number;
  mode: 'public' | 'authorised';
  connection: { id: string; provider: string; lastSyncAt: string | null; lastError: string | null; syncHealth: 'ok' | 'failed' | 'stale' | 'never' } | null;
  explanation: string;
}

export interface ReportListItem {
  id: string;
  title: string;
  status: string;
  kind: string;
  periodDate: string;
  isPartial: boolean;
  generatedAt: string | null;
  createdAt: string;
  readyBeforeDeadline: boolean | null;
  deadlineAt: string | null;
  summaryText: string | null;
}

export interface ReportRecord extends ReportListItem {
  data: ReportData | null;
  error: string | null;
}

export type { ReportData, SiteProfileData, InsightRow, ReportKpis, SiteCoverage, ComparisonRow, OfferRow, StockRow, MarketingRow, CapabilityStatus };
