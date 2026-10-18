import { and, desc, eq, sql } from 'drizzle-orm';
import {
  collectAllowedNumbers,
  deterministicHeadline,
  findUnsupportedNumbers,
  generateInsights,
  localDate,
  roundMoney,
  sha256Hex,
  stableStringify,
  UNTRUSTED_PREAMBLE,
  wrapUntrusted,
  type AvailabilityChangeRecord,
  type DelistedRecord,
  type NewProductRecord,
  type PriceMovementRecord,
} from '@ci/core';
import {
  DEFAULTS,
  type Availability,
  type BasketResult,
  type ComparisonRow,
  type MarketingRow,
  type OfferRow,
  type ReportData,
  type ReportKpis,
  type StockRow,
} from '@ci/shared';
import { insights as insightsTable, integrationConnections, orgSettings, organizations, productMatches, reports, sites, type DbLike } from '@ci/database';
import { allSocialStatuses } from '@ci/connectors';
import type { Services } from './context.ts';
import { loadFxTable, ensureFxRates } from './fx.ts';
import { loadCoverage } from './coverage.ts';
import { loadComparison } from './comparison.ts';
import { loadAssortment, loadMarketing, loadMarketingSummary, loadOffers, loadSiteMaps, loadStock } from './live.ts';
import { raiseAlert, alertRecipients } from './alerts.ts';
import { layout } from './mailer.ts';

const NEW_PRODUCT_WINDOW_DAYS = 7;

/** drizzle expands JS arrays into tuples, so uuid lists are built explicitly. */
const uuidList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);

export interface AssembleOptions {
  kind: 'scheduled' | 'manual';
  deadlineAt: Date | null;
  /** Forces the partial flag (e.g. the assembly cut-off was reached before all sites finished). */
  forcePartial?: boolean;
  forcePartialReason?: string;
}

export async function assembleReportData(svc: Services, db: DbLike, orgId: string, opts: AssembleOptions): Promise<ReportData> {
  const now = svc.clock();
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  const [settings] = await db.select().from(orgSettings).where(eq(orgSettings.orgId, orgId));
  const reporting = settings?.reportingCurrency ?? DEFAULTS.reportingCurrency;
  const tz = settings?.timezone ?? DEFAULTS.timezone;
  const threshold = settings?.lowStockThreshold ?? DEFAULTS.lowStockThreshold;
  const staleHours = DEFAULTS.staleAfterHours;
  await ensureFxRates(svc);
  const fx = await loadFxTable(db, now);

  const siteRows = await db.select().from(sites).where(and(eq(sites.orgId, orgId), eq(sites.active, true)));
  const source = siteRows.find((s) => s.role === 'source');
  const siteName = new Map(siteRows.map((s) => [s.id, s.name]));

  const coverage = await loadCoverage(db, orgId, now, staleHours);
  const activeCoverage = coverage.filter((c) => siteRows.some((s) => s.id === c.siteId));
  const comparisons = await loadComparison(db, { orgId, reportingCurrency: reporting, fx, now, staleAfterHours: staleHours });

  // ── offers, own stock, marketing (the same live views the interactive pages use)
  const maps = await loadSiteMaps(db, orgId);
  const offerOut: OfferRow[] = await loadOffers(db, orgId, now, maps);
  const stockView = await loadStock(db, now, maps, threshold, { limit: 500, staleHours: staleHours });
  const stock: StockRow[] = stockView.rows;
  const stockCounts = stockView.counts;
  const sourceVariantCount = stockView.total;
  const marketing: MarketingRow[] = await loadMarketing(db, orgId, now, maps);
  const marketingSummary = await loadMarketingSummary(db, orgId, now, maps, { days: 30 });

  // ── change detection
  const competitorIds = siteRows.filter((s) => s.role === 'competitor').map((s) => s.id);
  const newProducts = await loadNewProducts(db, orgId, competitorIds, siteName, now);
  const delisted = await loadDelisted(db, orgId, competitorIds, siteName, now);
  const priceMovements = await loadPriceMovements(db, orgId, siteName, source?.id ?? null, now);
  const availabilityChanges = await loadAvailabilityChanges(db, orgId, competitorIds, siteName, now);

  // ── assortment (an unmatched product means "no equivalent found", not "absent from the market")
  const assortmentAll = await loadAssortment(db, orgId, maps);
  const competitorOnlyAll = assortmentAll.competitorOnly;
  const sourceOnlyAll = assortmentAll.sourceOnly;
  const assortment = {
    competitorOnly: competitorOnlyAll.slice(0, 60),
    sourceOnly: sourceOnlyAll.slice(0, 60),
    note: 'Unmatched means no equivalent product was found among collected catalogues; it does not prove the product is absent elsewhere. Counts depend on collection coverage and match quality.',
  };

  const basket = computeBasket(comparisons, siteName, reporting, sourceVariantCount);

  // ── KPIs
  const directCells = comparisons.flatMap((r) => r.cells.filter((c) => c.directlyComparable && c.diffPct !== null).map((c) => ({ r, c })));
  const cheaperAtSource = directCells.filter((x) => x.c.diffPct! > 0.5).length;
  const pricierAtSource = directCells.filter((x) => x.c.diffPct! < -0.5).length;
  const kpis: ReportKpis = {
    matchedProducts: comparisons.length,
    identicalMatches: comparisons.reduce((a, r) => a + r.cells.filter((c) => c.matchClass === 'identical').length, 0),
    productsCheaperAtSource: cheaperAtSource,
    productsPricierAtSource: pricierAtSource,
    productsAtParity: directCells.length - cheaperAtSource - pricierAtSource,
    averageDiffPct: directCells.length ? roundMoney(directCells.reduce((a, x) => a + (x.c.diffPct as number), 0) / directCells.length, 2) : null,
    activeOffers: offerOut.filter((o) => o.status === 'active').length,
    lowStockCount: stockCounts.low,
    outOfStockCount: stockCounts.out,
    newCompetitorProducts: newProducts.length,
    marketingItems: marketing.length,
    sourceProducts: sourceVariantCount,
    competitorProducts: activeCoverage.filter((c) => c.role === 'competitor').reduce((a, c) => a + c.productsKnown, 0),
  };

  const insights = generateInsights({
    now, reportingCurrency: reporting, staleAfterHours: staleHours, comparisons, offers: offerOut, stock, marketing, newProducts, delisted, priceMovements, availabilityChanges,
    assortment: { competitorOnly: competitorOnlyAll.slice(0, 200), sourceOnly: sourceOnlyAll.slice(0, 200) }, basket, coverage: activeCoverage,
  });

  // ── warnings & partial status
  const warnings: string[] = [];
  const collecting = activeCoverage.filter((c) => siteRows.find((s) => s.id === c.siteId)?.consentStatus === 'confirmed');
  const incomplete = collecting.filter((c) => !c.complete);
  for (const c of activeCoverage) {
    if (c.failureReason) warnings.push(`${c.name}: ${c.failureReason}`);
    for (const w of c.warnings) warnings.push(`${c.name}: ${w}`);
  }
  if (!source) warnings.push('No source website is configured, so price comparisons cannot be produced.');
  if (opts.forcePartialReason) warnings.push(opts.forcePartialReason);
  const unconvertible = comparisons.reduce((a, r) => a + r.cells.filter((c) => c.price.amount !== null && c.price.normalized === null).length, 0);
  if (unconvertible) warnings.push(`${unconvertible} competitor price(s) could not be converted to ${reporting} (missing currency or exchange rate) and are excluded from differences.`);
  const isPartial = !!opts.forcePartial || incomplete.length > 0;
  const needsReview = await db.select({ n: sql<number>`count(*)::int` }).from(productMatches).where(and(eq(productMatches.orgId, orgId), eq(productMatches.status, 'needs_review')));
  if ((needsReview[0]?.n ?? 0) > 0) warnings.push(`${needsReview[0]!.n} product match(es) are waiting for review and are not used for price conclusions.`);

  // ── integrations
  const conns = await db.select().from(integrationConnections).where(eq(integrationConnections.orgId, orgId));
  const integrations = [
    ...(conns.length
      ? conns.map((c) => ({ provider: c.provider, status: c.status, message: c.status === 'connected' ? `Read-only inventory connection${c.lastSyncAt ? `, last sync ${c.lastSyncAt.toISOString()}` : ''}` : (c.lastError ?? c.status) }))
      : [{ provider: 'inventory', status: 'not_connected', message: 'No authorised inventory connection: own-stock alerts use public availability only (no unit counts).' }]),
    ...allSocialStatuses({ youtubeApiKey: svc.config.YOUTUBE_API_KEY, metaAccessToken: svc.config.META_ACCESS_TOKEN, metaInstagramBusinessAccountId: svc.config.META_INSTAGRAM_BUSINESS_ACCOUNT_ID }).map((s) => ({ provider: s.provider, status: s.state, message: s.message })),
  ];

  const headline = deterministicHeadline(insights, isPartial, { hasSource: !!source, hasData: activeCoverage.some((c) => c.productsKnown > 0) });
  const data: ReportData = {
    schemaVersion: 1,
    meta: {
      orgId, orgName: org?.name ?? '', generatedAt: now.toISOString(), periodDate: localDate(now, tz), timezone: tz, reportingCurrency: reporting,
      deadlineAt: opts.deadlineAt?.toISOString() ?? null, readyBeforeDeadline: opts.deadlineAt ? now <= opts.deadlineAt : null, isPartial, kind: opts.kind, staleAfterHours: staleHours,
    },
    fx: fx.usedRates(),
    sites: activeCoverage,
    kpis,
    headline,
    warnings,
    comparisons,
    offers: offerOut,
    stock,
    marketing,
    marketingSummary,
    insights,
    assortment,
    basket,
    integrations,
    aiSummary: null,
  };
  data.aiSummary = await aiSummary(svc, data);
  return data;
}

// ───────────────────────────────────────────────────────────── helpers

function computeBasket(comparisons: ComparisonRow[], siteName: Map<string, string>, reporting: string, sourceCount: number): BasketResult[] {
  const bySite = new Map<string, { s: number; c: number; n: number; compared: number }>();
  for (const r of comparisons) {
    for (const cell of r.cells) {
      if (cell.matchClass !== 'identical' || !cell.directlyComparable) continue;
      const cur = bySite.get(cell.siteId) ?? { s: 0, c: 0, n: 0, compared: 0 };
      cur.compared++;
      const avail = r.sourceAvailability !== 'out_of_stock' && cell.availability !== 'out_of_stock';
      if (avail && r.sourcePrice.normalized !== null && cell.price.normalized !== null) {
        cur.s += r.sourcePrice.normalized;
        cur.c += cell.price.normalized;
        cur.n++;
      }
      bySite.set(cell.siteId, cur);
    }
  }
  return [...bySite.entries()].map(([siteId, b]) => ({
    siteId, siteName: siteName.get(siteId) ?? '', itemsCompared: b.compared, itemsAvailableInBoth: b.n,
    sourceTotal: b.n ? roundMoney(b.s, 2) : null, competitorTotal: b.n ? roundMoney(b.c, 2) : null,
    diffPct: b.n && b.s > 0 ? roundMoney(((b.c - b.s) / b.s) * 100, 2) : null, currency: reporting,
    coveragePct: sourceCount ? Math.round((b.n / sourceCount) * 100) : 0,
    note: `Only identical, confirmed matches that are in stock at both shops (${b.n} of ${b.compared}). Not a full-store comparison.`,
  }));
}

async function loadNewProducts(db: DbLike, orgId: string, siteIds: string[], names: Map<string, string>, now: Date): Promise<NewProductRecord[]> {
  if (!siteIds.length) return [];
  const since = new Date(now.getTime() - NEW_PRODUCT_WINDOW_DAYS * 86_400_000);
  // "New" only counts after a COMPLETE baseline scan exists; otherwise every product of a first scan would look new.
  const rows = await db.execute<{ site_id: string; variant_id: string; title: string; price: number | null; currency: string | null; first_seen_at: Date; url: string; category: string | null }>(sql`
    select p.site_id, v.id as variant_id, p.title, v.price, v.currency, p.first_seen_at, v.url, p.category
    from products p
    join variants v on v.product_id = p.id
    where p.org_id = ${orgId} and p.site_id in (${uuidList(siteIds)}) and p.first_seen_at >= ${since.toISOString()}::timestamptz
      and exists (select 1 from scan_runs s where s.site_id = p.site_id and s.status = 'succeeded' and s.is_complete and s.finished_at < p.first_seen_at - interval '1 minute')
    order by p.first_seen_at desc limit 300`);
  return rows.rows.map((r) => ({ siteId: r.site_id, siteName: names.get(r.site_id) ?? '', variantId: r.variant_id, title: r.title, price: r.price === null ? null : Number(r.price), currency: r.currency, firstSeenAt: new Date(r.first_seen_at).toISOString(), url: r.url, category: r.category }));
}

async function loadDelisted(db: DbLike, orgId: string, siteIds: string[], names: Map<string, string>, now: Date): Promise<DelistedRecord[]> {
  if (!siteIds.length) return [];
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const rows = await db.execute<{ site_id: string; variant_id: string; title: string; last_seen_at: Date; url: string; missed: number }>(sql`
    select p.site_id, v.id as variant_id, p.title, p.last_seen_at, v.url, p.missed_complete_scans as missed
    from products p join variants v on v.product_id = p.id
    where p.org_id = ${orgId} and p.site_id in (${uuidList(siteIds)}) and p.delisted_at >= ${since.toISOString()}::timestamptz
    order by p.delisted_at desc limit 300`);
  return rows.rows.map((r) => ({ siteId: r.site_id, siteName: names.get(r.site_id) ?? '', variantId: r.variant_id, title: r.title, lastSeenAt: new Date(r.last_seen_at).toISOString(), url: r.url, completeScansMissed: Math.max(2, Number(r.missed)) }));
}

async function loadPriceMovements(db: DbLike, orgId: string, names: Map<string, string>, sourceId: string | null, now: Date): Promise<PriceMovementRecord[]> {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const rows = await db.execute<{ site_id: string; variant_id: string; title: string; url: string; cur_price: number; cur_at: Date; cur_id: string; cur_cur: string; prev_price: number; prev_at: Date; prev_id: string; prev_cur: string }>(sql`
    select v.site_id, v.id as variant_id, p.title, v.url, cur.price as cur_price, cur.observed_at as cur_at, cur.id as cur_id, cur.currency as cur_cur,
           prev.price as prev_price, prev.observed_at as prev_at, prev.id as prev_id, prev.currency as prev_cur
    from variants v
    join products p on p.id = v.product_id
    join lateral (select id, price, currency, observed_at from price_observations where variant_id = v.id and price is not null order by observed_at desc limit 1) cur on true
    join lateral (select id, price, currency, observed_at from price_observations where variant_id = v.id and price is not null and price <> cur.price and observed_at < cur.observed_at order by observed_at desc limit 1) prev on true
    where v.org_id = ${orgId} and cur.observed_at >= ${since.toISOString()}::timestamptz and cur.currency is not distinct from prev.currency and cur.currency is not null and prev.price > 0
    limit 400`);
  return rows.rows
    .map((r) => {
      const cur = Number(r.cur_price);
      const prev = Number(r.prev_price);
      return {
        siteId: r.site_id, siteName: names.get(r.site_id) ?? '', isSource: r.site_id === sourceId, variantId: r.variant_id, title: r.title, previousPrice: prev, currentPrice: cur, currency: r.cur_cur,
        changePct: roundMoney(((cur - prev) / prev) * 100, 2), previousObservedAt: new Date(r.prev_at).toISOString(), currentObservedAt: new Date(r.cur_at).toISOString(), previousObservationId: r.prev_id, currentObservationId: r.cur_id, url: r.url,
      };
    })
    .filter((m) => names.has(m.siteId));
}

async function loadAvailabilityChanges(db: DbLike, orgId: string, siteIds: string[], names: Map<string, string>, now: Date): Promise<AvailabilityChangeRecord[]> {
  if (!siteIds.length) return [];
  const since = new Date(now.getTime() - 3 * 86_400_000);
  const rows = await db.execute<{ site_id: string; variant_id: string; title: string; url: string; cur_av: Availability; prev_av: Availability; cur_at: Date }>(sql`
    select v.site_id, v.id as variant_id, p.title, v.url, cur.availability as cur_av, prev.availability as prev_av, cur.observed_at as cur_at
    from variants v join products p on p.id = v.product_id
    join lateral (select availability, observed_at from stock_observations where variant_id = v.id order by observed_at desc limit 1) cur on true
    join lateral (select availability from stock_observations where variant_id = v.id and observed_at < cur.observed_at order by observed_at desc limit 1) prev on true
    where v.org_id = ${orgId} and v.site_id in (${uuidList(siteIds)}) and cur.observed_at >= ${since.toISOString()}::timestamptz
      and cur.availability <> prev.availability and cur.availability in ('in_stock','out_of_stock') and prev.availability in ('in_stock','out_of_stock')
    limit 300`);
  return rows.rows.map((r) => ({ siteId: r.site_id, siteName: names.get(r.site_id) ?? '', variantId: r.variant_id, title: r.title, from: r.prev_av, to: r.cur_av, at: new Date(r.cur_at).toISOString(), url: r.url }));
}

/** Optional AI-written summary. It is discarded unless every number in it comes from the computed facts. */
async function aiSummary(svc: Services, data: ReportData): Promise<ReportData['aiSummary']> {
  if (!svc.llm.available || !data.insights.length) return null;
  const top = data.insights.filter((i) => i.type !== 'coverage_warning').slice(0, 8);
  try {
    const text = (
      await svc.llm.complete({
        system: `${UNTRUSTED_PREAMBLE}\nWrite a 3-sentence business summary for a shop owner from the findings below. Use ONLY facts and numbers present in the findings; do not invent figures, causes or recommendations about prices.`,
        user: wrapUntrusted(JSON.stringify(top.map((i) => ({ title: i.title, summary: i.summary, facts: i.facts })))),
        maxTokens: 300,
      })
    ).trim();
    const allowed = collectAllowedNumbers([...top.map((i) => i.facts), ...top.map((i) => ({ t: i.title, s: i.summary })), data.kpis as unknown as Record<string, number | null>]);
    const bad = findUnsupportedNumbers(text, allowed);
    if (bad.length || !text) {
      svc.log.warn('AI summary discarded: unsupported numbers', { bad });
      return null;
    }
    return { text, validated: true, provider: svc.llm.id };
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────── persistence

export interface GenerateReportOptions extends AssembleOptions {
  createdBy?: string | null;
  dailyRunId?: string | null;
  sendSummaryEmail?: boolean;
  /** Fill a draft row the caller already created (so the UI can poll its id). */
  reportId?: string;
}

/** Builds, hashes and stores an immutable report snapshot, then raises the notification and (optionally) the summary email. */
export async function generateReport(svc: Services, db: DbLike, orgId: string, opts: GenerateReportOptions): Promise<typeof reports.$inferSelect> {
  const now = svc.clock();
  const [settings] = await db.select().from(orgSettings).where(eq(orgSettings.orgId, orgId));
  const tz = settings?.timezone ?? DEFAULTS.timezone;
  const [draft] = opts.reportId
    ? await db.select().from(reports).where(and(eq(reports.id, opts.reportId), eq(reports.orgId, orgId)))
    : await db
    .insert(reports)
    .values({ orgId, kind: opts.kind, status: 'generating', periodDate: localDate(now, tz), title: `Competitor report — ${localDate(now, tz)}`, createdBy: opts.createdBy ?? null, dailyRunId: opts.dailyRunId ?? null, deadlineAt: opts.deadlineAt ?? null })
    .returning();
  try {
    const data = await assembleReportData(svc, db, orgId, opts);
    const hash = sha256Hex(stableStringify(data));
    const status = data.meta.isPartial ? 'partial' : 'ready';
    const [row] = await db
      .update(reports)
      .set({ status, data, dataHash: hash, generatedAt: svc.clock(), isPartial: data.meta.isPartial, readyBeforeDeadline: data.meta.readyBeforeDeadline, summaryText: data.aiSummary?.text ?? data.headline })
      .where(eq(reports.id, draft!.id))
      .returning();
    if (data.insights.length) {
      await db.insert(insightsTable).values(data.insights.map((i) => ({ orgId, reportId: draft!.id, key: i.id, type: i.type, score: i.score, severity: i.severity, title: i.title, summary: i.summary, facts: i.facts, evidence: i.evidence, scoreBreakdown: i.scoreBreakdown }))).onConflictDoNothing();
    }
    await raiseAlert(db, {
      orgId, type: data.meta.isPartial ? 'report_partial' : 'report_ready', severity: data.meta.isPartial ? 'warning' : 'info',
      title: data.meta.isPartial ? `Partial report ready — ${data.meta.periodDate}` : `Report ready — ${data.meta.periodDate}`,
      body: data.headline, reportId: draft!.id, dedupeKey: `report:${draft!.id}`, data: { isPartial: data.meta.isPartial, warnings: data.warnings.slice(0, 5) },
    });
    if (opts.sendSummaryEmail) await emailReportSummary(svc, db, orgId, row!, data);
    return row!;
  } catch (e) {
    await db.update(reports).set({ status: 'failed', error: (e as Error).message.slice(0, 500) }).where(eq(reports.id, draft!.id));
    throw e;
  }
}

export async function emailReportSummary(svc: Services, db: DbLike, orgId: string, report: typeof reports.$inferSelect, data: ReportData): Promise<void> {
  const { recipients, prefs } = await alertRecipients(db, orgId);
  if (!prefs.dailySummaryEmail || !recipients.length) return;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const k = data.kpis;
  const top = data.insights.filter((i) => i.type !== 'coverage_warning').slice(0, 5);
  const link = `${svc.config.APP_BASE_URL}/reports/${report.id}`;
  const subject = `${data.meta.isPartial ? '[Partial] ' : ''}Competitor report — ${data.meta.periodDate}`;
  const lines = [
    data.headline,
    '',
    `Matched products: ${k.matchedProducts} · Cheaper at your shop: ${k.productsCheaperAtSource} · Pricier: ${k.productsPricierAtSource} · Active offers: ${k.activeOffers} · Low stock: ${k.lowStockCount} · Out of stock: ${k.outOfStockCount}`,
    ...top.map((t) => `• ${t.title}`),
    ...(data.warnings.length ? ['', 'Notes:', ...data.warnings.slice(0, 4).map((w) => `- ${w}`)] : []),
    '',
    `Open the full report: ${link}`,
  ];
  const html = layout(
    subject,
    `<p style="font-size:17px">${esc(data.headline)}</p>
     <table style="border-collapse:collapse;width:100%;font:14px Arial,sans-serif;margin:16px 0"><tr>
       ${[['Matched', k.matchedProducts], ['Cheaper here', k.productsCheaperAtSource], ['Pricier here', k.productsPricierAtSource], ['Offers', k.activeOffers], ['Low stock', k.lowStockCount], ['Out of stock', k.outOfStockCount]].map(([l, v]) => `<td style="padding:8px;border:1px solid #d9d2c3;text-align:center"><div style="font-size:20px;font-weight:700">${v}</div><div style="color:#5f7378;font-size:12px">${l}</div></td>`).join('')}
     </tr></table>
     <ul style="padding-left:18px">${top.map((t) => `<li style="margin-bottom:6px">${esc(t.title)}</li>`).join('')}</ul>
     ${data.warnings.length ? `<p style="background:#fff4c2;border:1px solid #e6bb1a;padding:10px;font:13px Arial,sans-serif"><strong>Data notes</strong><br>${data.warnings.slice(0, 4).map(esc).join('<br>')}</p>` : ''}
     <p><a href="${esc(link)}" style="background:#0e6e73;color:#fff;padding:10px 16px;text-decoration:none;font:600 14px Arial,sans-serif;border-radius:4px">Open the report</a></p>`,
  );
  await svc.mailer.queue(db, { orgId, to: recipients, subject, text: lines.join('\n'), html, kind: 'daily-summary', relatedId: report.id });
}

export async function getReport(db: DbLike, orgId: string, id: string) {
  const [r] = await db.select().from(reports).where(and(eq(reports.id, id), eq(reports.orgId, orgId)));
  return r ?? null;
}

export async function listReports(db: DbLike, orgId: string, limit = 60) {
  return db
    .select({ id: reports.id, title: reports.title, status: reports.status, kind: reports.kind, periodDate: reports.periodDate, isPartial: reports.isPartial, generatedAt: reports.generatedAt, createdAt: reports.createdAt, readyBeforeDeadline: reports.readyBeforeDeadline, deadlineAt: reports.deadlineAt, summaryText: reports.summaryText })
    .from(reports)
    .where(eq(reports.orgId, orgId))
    .orderBy(desc(reports.createdAt))
    .limit(limit);
}
