import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { isStale } from '@ci/core';
import { DEFAULTS, type EvidenceTier, type MatchClass, type MatchRelationship, type MatchStatus, type SettingsInput } from '@ci/shared';
import { alertRules, auditEvents, evidence, offers, orgSettings, priceObservations, productMatches, products, scanRuns, sites, stockStates, variants, type DbLike } from '@ci/database';
import { countAwaitingReview } from './match-queue.ts';
import { loadCoverage } from './coverage.ts';
import { DEFAULT_ALERT_TYPES } from './auth.ts';

const clampPage = (page: number, pageSize: number) => ({ limit: Math.min(Math.max(pageSize, 1), 500), offset: (Math.max(page, 1) - 1) * Math.min(Math.max(pageSize, 1), 500) });

// ───────────────────────────────────────────────────────────── settings & alert rules

export async function getSettings(db: DbLike, orgId: string) {
  const [s] = await db.select().from(orgSettings).where(eq(orgSettings.orgId, orgId));
  return s ?? null;
}

export async function updateSettings(db: DbLike, orgId: string, userId: string, patch: SettingsInput, now: Date) {
  const set: Partial<typeof orgSettings.$inferInsert> = { updatedAt: now };
  if (patch.reportingCurrency) set.reportingCurrency = patch.reportingCurrency;
  if (patch.timezone) set.timezone = patch.timezone;
  if (patch.reportReadyTime) set.reportReadyTime = patch.reportReadyTime;
  if (patch.scheduleEnabled !== undefined) set.scheduleEnabled = patch.scheduleEnabled;
  if (patch.lowStockThreshold !== undefined) set.lowStockThreshold = patch.lowStockThreshold;
  if (patch.snapshotRetentionDays !== undefined) set.snapshotRetentionDays = patch.snapshotRetentionDays;
  if (patch.historyRetentionDays !== undefined) set.historyRetentionDays = patch.historyRetentionDays;
  if (patch.alertPrefs) set.alertPrefs = patch.alertPrefs;
  if (patch.enabledAiAdjudication !== undefined) set.aiAdjudication = patch.enabledAiAdjudication;
  if (patch.matchingEngine) set.matchingEngine = patch.matchingEngine;
  const [row] = await db.update(orgSettings).set(set).where(eq(orgSettings.orgId, orgId)).returning();
  await db.insert(auditEvents).values({ orgId, userId, action: 'settings.update', meta: { fields: Object.keys(patch) } });
  return row!;
}

export async function getAlertRules(db: DbLike, orgId: string) {
  let rules = await db.select().from(alertRules).where(eq(alertRules.orgId, orgId));
  const have = new Set(rules.map((r) => r.type));
  const missing = DEFAULT_ALERT_TYPES.filter((t) => !have.has(t));
  if (missing.length) {
    await db.insert(alertRules).values(missing.map((type) => ({ orgId, type }))).onConflictDoNothing();
    rules = await db.select().from(alertRules).where(eq(alertRules.orgId, orgId));
  }
  return rules;
}

export async function upsertAlertRule(db: DbLike, orgId: string, r: { type: 'low_stock' | 'out_of_stock' | 'restocked' | 'collection_failure'; enabled: boolean; channelInApp: boolean; channelEmail: boolean }) {
  const [row] = await db
    .insert(alertRules)
    .values({ orgId, ...r })
    .onConflictDoUpdate({ target: [alertRules.orgId, alertRules.type], set: { enabled: r.enabled, channelInApp: r.channelInApp, channelEmail: r.channelEmail } })
    .returning();
  return row!;
}

export async function setVariantThreshold(db: DbLike, orgId: string, variantId: string, threshold: number | null): Promise<boolean> {
  const r = await db.update(variants).set({ lowStockThreshold: threshold }).where(and(eq(variants.id, variantId), eq(variants.orgId, orgId))).returning({ id: variants.id });
  return r.length > 0;
}

// ───────────────────────────────────────────────────────────── alerts

// ───────────────────────────────────────────────────────────── products

export interface ProductFilter {
  siteId?: string;
  q?: string;
  matched?: 'yes' | 'no';
  delisted?: boolean;
  stale?: boolean;
  page: number;
  pageSize: number;
}

export async function listProducts(db: DbLike, orgId: string, f: ProductFilter, now: Date) {
  const conds = [eq(variants.orgId, orgId)];
  if (f.siteId) conds.push(eq(variants.siteId, f.siteId));
  if (f.q) conds.push(ilike(products.title, `%${f.q.replace(/[%_]/g, (c) => `\\${c}`)}%`));
  conds.push(f.delisted ? isNotNull(products.delistedAt) : isNull(products.delistedAt));
  if (f.matched === 'yes') conds.push(sql`exists (select 1 from product_matches m where (m.source_variant_id = ${variants.id} or m.competitor_variant_id = ${variants.id}) and m.status <> 'rejected' and m.match_class <> 'not_comparable')`);
  if (f.matched === 'no') conds.push(sql`not exists (select 1 from product_matches m where (m.source_variant_id = ${variants.id} or m.competitor_variant_id = ${variants.id}) and m.status <> 'rejected' and m.match_class <> 'not_comparable')`);
  if (f.stale) conds.push(sql`(${variants.observedAt} is null or ${variants.observedAt} < ${new Date(now.getTime() - DEFAULTS.staleAfterHours * 3_600_000).toISOString()}::timestamptz)`);
  const { limit, offset } = clampPage(f.page, f.pageSize);
  const rows = await db
    .select({
      variantId: variants.id, productId: products.id, siteId: variants.siteId, siteName: sites.name, role: sites.role, title: products.title, variantTitle: variants.title, brand: products.brand, category: products.category,
      price: variants.price, compareAt: variants.compareAtPrice, currency: variants.currency, availability: variants.availability, observedAt: variants.observedAt, url: variants.url, sku: variants.sku, gtin: variants.gtin,
      sizeLabel: variants.qtyLabel, method: products.extractionMethod, firstSeenAt: products.firstSeenAt, delistedAt: products.delistedAt,
    })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .innerJoin(sites, eq(sites.id, variants.siteId))
    .where(and(...conds))
    .orderBy(asc(products.title))
    .limit(limit)
    .offset(offset);
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(and(...conds));
  return { rows: rows.map((r) => ({ ...r, stale: isStale(r.observedAt, now, DEFAULTS.staleAfterHours) })), total: n };
}

export async function getProductDetail(db: DbLike, orgId: string, productId: string, now: Date) {
  const [p] = await db.select({ p: products, siteName: sites.name, role: sites.role }).from(products).innerJoin(sites, eq(sites.id, products.siteId)).where(and(eq(products.id, productId), eq(products.orgId, orgId)));
  if (!p) return null;
  const vs = await db.select().from(variants).where(eq(variants.productId, productId));
  const vIds = vs.map((v) => v.id);
  const history = vIds.length
    ? await db.select().from(priceObservations).where(inArray(priceObservations.variantId, vIds)).orderBy(desc(priceObservations.observedAt)).limit(600)
    : [];
  const states = vIds.length ? await db.select().from(stockStates).where(inArray(stockStates.variantId, vIds)) : [];
  const matches = vIds.length
    ? await db
        .select()
        .from(productMatches)
        .where(and(eq(productMatches.orgId, orgId), sql`(${productMatches.sourceVariantId} in (${sql.join(vIds.map((i) => sql`${i}::uuid`), sql`, `)}) or ${productMatches.competitorVariantId} in (${sql.join(vIds.map((i) => sql`${i}::uuid`), sql`, `)}))`))
    : [];
  const otherVariantIds = [...new Set(matches.flatMap((m) => [m.sourceVariantId, m.competitorVariantId]).filter((i) => !vIds.includes(i)))];
  const others = otherVariantIds.length
    ? await db
        .select({ id: variants.id, title: products.title, variantTitle: variants.title, siteName: sites.name, price: variants.price, currency: variants.currency, availability: variants.availability, observedAt: variants.observedAt, url: variants.url, productId: products.id })
        .from(variants)
        .innerJoin(products, eq(products.id, variants.productId))
        .innerJoin(sites, eq(sites.id, variants.siteId))
        .where(inArray(variants.id, otherVariantIds))
    : [];
  const productOffers = vIds.length ? await db.select().from(offers).where(and(eq(offers.orgId, orgId), inArray(offers.variantId, vIds), ne(offers.reviewStatus, 'dismissed'))).orderBy(desc(offers.lastSeenAt)) : [];
  const evIds = [...new Set(history.map((h) => h.evidenceId).filter((i): i is string => !!i))].slice(0, 8);
  const ev = evIds.length ? await db.select().from(evidence).where(inArray(evidence.id, evIds)).orderBy(desc(evidence.fetchedAt)) : [];
  return {
    product: { ...p.p, siteName: p.siteName, role: p.role },
    variants: vs.map((v) => ({ ...v, stale: isStale(v.observedAt, now, DEFAULTS.staleAfterHours), stock: states.find((s) => s.variantId === v.id) ?? null })),
    priceHistory: history.map((h) => ({ id: h.id, variantId: h.variantId, observedAt: h.observedAt, price: h.price, compareAtPrice: h.compareAtPrice, currency: h.currency, availability: h.availability, sourceUrl: h.sourceUrl, method: h.extractionMethod, evidenceId: h.evidenceId, provenance: h.provenance })),
    matches: matches.map((m) => ({ ...m, other: others.find((o) => o.id === (vIds.includes(m.sourceVariantId) ? m.competitorVariantId : m.sourceVariantId)) ?? null, thisSideIsSource: vIds.includes(m.sourceVariantId) })),
    offers: productOffers,
    evidence: ev.map((e) => ({ id: e.id, url: e.url, fetchedAt: e.fetchedAt, httpStatus: e.httpStatus, contentHash: e.contentHash, snippet: e.snippet, method: e.extractionMethod, version: e.extractionVersion, snapshotAvailable: !!e.snapshotRef, snapshotPurgedAt: e.snapshotPurgedAt, provenance: e.provenance })),
  };
}

export async function getEvidence(db: DbLike, orgId: string, id: string) {
  const [e] = await db.select().from(evidence).where(and(eq(evidence.id, id), eq(evidence.orgId, orgId)));
  return e ?? null;
}

// ───────────────────────────────────────────────────────────── matches

export type MatchBucket = 'review' | 'unclear' | 'confirmed' | 'rejected' | 'look_again' | 'set_aside';

export interface MatchFilter {
  /** The tab of Match Review: what is waiting, what is only for reference, what a person decided, what needs a second look. */
  bucket?: MatchBucket;
  status?: MatchStatus;
  matchClass?: MatchClass;
  relationship?: MatchRelationship;
  tier?: EvidenceTier;
  minConfidence?: number;
  maxConfidence?: number;
  siteId?: string;
  page: number;
  pageSize: number;
}

/** The conditions of each bucket, written once against the table alias `m`. Pairs the matcher has set aside are in no bucket but their own. */
const BUCKET_SQL: Record<MatchBucket, ReturnType<typeof sql>> = {
  review: sql`m.status in ('needs_review','auto') and m.superseded_at is null and m.match_class <> 'not_comparable'`,
  unclear: sql`m.status in ('needs_review','auto') and m.superseded_at is null and m.match_class = 'not_comparable'`,
  confirmed: sql`m.status = 'accepted'`,
  rejected: sql`m.status = 'rejected'`,
  look_again: sql`m.needs_reevaluation`,
  set_aside: sql`m.superseded_at is not null and m.status in ('needs_review','auto')`,
};

export async function listMatches(db: DbLike, orgId: string, f: MatchFilter) {
  const w = [sql`m.org_id = ${orgId}`];
  if (f.bucket) w.push(BUCKET_SQL[f.bucket]);
  else w.push(sql`(m.superseded_at is null or m.status in ('accepted','rejected'))`);
  if (f.status) w.push(sql`m.status = ${f.status}`);
  if (f.matchClass) w.push(sql`m.match_class = ${f.matchClass}`);
  if (f.relationship) w.push(sql`coalesce(m.relationship, case m.match_class when 'identical' then 'exact' when 'different_pack' then 'variant' when 'comparable' then 'substitute' else 'non_match' end) = ${f.relationship}`);
  if (f.tier) w.push(sql`m.tier = ${f.tier}`);
  if (f.minConfidence !== undefined) w.push(sql`m.confidence >= ${f.minConfidence}`);
  if (f.maxConfidence !== undefined) w.push(sql`m.confidence <= ${f.maxConfidence}`);
  if (f.siteId) w.push(sql`m.competitor_site_id = ${f.siteId}::uuid`);
  const where = sql.join(w, sql` and `);
  const { limit, offset } = clampPage(f.page, f.pageSize);
  const rows = await db.execute<Record<string, unknown>>(sql`
    select m.id, m.match_class as "matchClass", m.confidence, m.status, m.method, m.reasons, m.components, m.decided_at as "decidedAt", m.decision_note as "decisionNote",
           coalesce(m.relationship, case m.match_class when 'identical' then 'exact' when 'different_pack' then 'variant' when 'comparable' then 'substitute' else 'non_match' end) as relationship,
           m.tier, m.evidence, m.engine_version as "engineVersion", m.needs_reevaluation as "needsReevaluation", m.superseded_at as "supersededAt",
           ps.title as "sourceTitle", vs.title as "sourceVariantTitle", vs.price as "sourcePrice", vs.currency as "sourceCurrency", vs.qty_label as "sourceSize", ps.brand as "sourceBrand", vs.url as "sourceUrl", ps.id as "sourceProductId",
           pc.title as "competitorTitle", vc.title as "competitorVariantTitle", vc.price as "competitorPrice", vc.currency as "competitorCurrency", vc.qty_label as "competitorSize", pc.brand as "competitorBrand", vc.url as "competitorUrl", pc.id as "competitorProductId",
           sc.name as "competitorSite", m.competitor_site_id as "competitorSiteId", m.source_variant_id as "sourceVariantId", m.competitor_variant_id as "competitorVariantId", m.decided_by is not null as "decidedByPerson",
           vs.availability as "sourceAvailability", vs.observed_at as "sourceObservedAt", vs.gtin as "sourceGtin", vs.sku as "sourceSku", ps.category as "sourceCategory",
           vc.availability as "competitorAvailability", vc.observed_at as "competitorObservedAt", vc.gtin as "competitorGtin", vc.sku as "competitorSku", pc.category as "competitorCategory"
    from product_matches m
    join variants vs on vs.id = m.source_variant_id join products ps on ps.id = vs.product_id
    join variants vc on vc.id = m.competitor_variant_id join products pc on pc.id = vc.product_id
    join sites sc on sc.id = m.competitor_site_id
    where ${where}
    order by (case when m.status in ('needs_review','auto') then 0 else 1 end), (case m.tier when 'strong' then 0 when 'medium' then 1 else 2 end), m.confidence desc, ps.title
    limit ${limit} offset ${offset}`);
  const total = await db.execute<{ n: string }>(sql`select count(*)::text as n from product_matches m where ${where}`);
  const counts = await db.select({ status: productMatches.status, matchClass: productMatches.matchClass, n: sql<number>`count(*)::int` }).from(productMatches).where(eq(productMatches.orgId, orgId)).groupBy(productMatches.status, productMatches.matchClass);
  // Raw SQL returns `numeric` as strings; the API contract is numbers (null stays null — never 0).
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return { rows: rows.rows.map((r) => ({ ...r, confidence: Number(r.confidence), sourcePrice: num(r.sourcePrice), competitorPrice: num(r.competitorPrice) })), total: Number(total.rows[0]?.n ?? 0), counts };
}

// ───────────────────────────────────────────────────────────── data quality

export async function dataQuality(db: DbLike, orgId: string, now: Date) {
  const coverage = await loadCoverage(db, orgId, now, DEFAULTS.staleAfterHours);
  const methods = await db.execute<{ site_id: string; method: string; n: string; avg_quality: string | null; missing_price: string; missing_currency: string }>(sql`
    select p.site_id, p.extraction_method as method, count(*)::text as n,
      avg((p.attrs->'quality'->>'score')::float)::text as avg_quality,
      count(*) filter (where exists (select 1 from variants v where v.product_id = p.id and v.price is null))::text as missing_price,
      count(*) filter (where exists (select 1 from variants v where v.product_id = p.id and v.currency is null))::text as missing_currency
    from products p where p.org_id = ${orgId} and p.delisted_at is null group by p.site_id, p.extraction_method`);
  const failedScans = await db.select().from(scanRuns).where(and(eq(scanRuns.orgId, orgId), inArray(scanRuns.status, ['failed', 'blocked', 'partial']))).orderBy(desc(scanRuns.createdAt)).limit(20);
  const reviewQueue = [{ n: await countAwaitingReview(db, orgId) }];
  const missingGtin = await db.execute<{ site_id: string; with_gtin: string; total: string }>(sql`select v.site_id, count(*) filter (where v.gtin is not null)::text as with_gtin, count(*)::text as total from variants v join products p on p.id = v.product_id where v.org_id = ${orgId} and p.delisted_at is null group by v.site_id`);
  return {
    coverage,
    extraction: methods.rows.map((r) => ({ siteId: r.site_id, method: r.method, products: Number(r.n), avgQuality: r.avg_quality === null ? null : Math.round(Number(r.avg_quality) * 100) / 100, missingPrice: Number(r.missing_price), missingCurrency: Number(r.missing_currency) })),
    identifiers: missingGtin.rows.map((r) => ({ siteId: r.site_id, withGtin: Number(r.with_gtin), total: Number(r.total) })),
    recentProblems: failedScans.map((s) => ({ id: s.id, siteId: s.siteId, status: s.status, kind: s.kind, errorCode: s.errorCode, error: s.error, notes: s.notes, createdAt: s.createdAt, finishedAt: s.finishedAt, productsSaved: s.productsSaved })),
    matchesNeedingReview: reviewQueue[0]?.n ?? 0,
  };
}
