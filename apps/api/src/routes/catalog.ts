import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DEFAULTS, EVIDENCE_TIERS, MATCH_CLASSES, MATCH_RELATIONSHIPS, bulkAcceptSchema, connectionSyncHealth, MATCH_STATUSES, manualMatchSchema, matchDecisionSchema, offerReviewSchema, paginationSchema, variantThresholdSchema, type ComparisonRow, type ReportData } from '@ci/shared';
import { integrationConnections, matchEvents, productMatches, reports, sites } from '@ci/database';
import {
  bulkAcceptMatches, dataQuality, decideMatch, rejectProductPair, ensureFxRates, getEvidence, getProductDetail, getSettings, listMatches, listProducts, loadAssortment, loadComparison, loadCoverage, loadDashboard, loadFxTable, loadMarketing, loadMarketingSummary, loadOffers, loadSiteMaps,
  loadStock, setVariantThreshold, assertCanMatch, loadReadiness, loadJourney, searchMatchCandidates, setManualMatch, reviewOffer, matchSummary,
} from '@ci/services';
import { HttpError, parse, requireRole } from '../app.ts';

const uuid = z.uuid();

export async function catalogRoutes(app: FastifyInstance) {
  /** The guided path from an empty workspace to a first report, computed from what really exists. */
  app.get('/journey', async (req) => req.tx((tx) => loadJourney(app.svc, tx, req.orgId!)));

  // ── dashboard & data quality
  app.get('/dashboard', async (req) => req.tx((tx) => loadDashboard(app.svc, tx, req.orgId!)));
  app.get('/quality', async (req) => req.tx((tx) => dataQuality(tx, req.orgId!, app.svc.clock())));

  // ── products
  app.get('/products', async (req) => {
    const q = parse(
      paginationSchema.extend({
        siteId: uuid.optional(),
        q: z.string().max(200).optional(),
        matched: z.enum(['yes', 'no']).optional(),
        delisted: z.enum(['true', 'false']).optional(),
        stale: z.enum(['true', 'false']).optional(),
      }),
      req.query,
    );
    return req.tx((tx) => listProducts(tx, req.orgId!, { siteId: q.siteId, q: q.q, matched: q.matched, delisted: q.delisted === 'true', stale: q.stale === 'true', page: q.page, pageSize: q.pageSize }, app.svc.clock()));
  });

  app.get('/products/:productId', async (req) => {
    const { productId } = parse(z.object({ productId: uuid }), req.params);
    const d = await req.tx((tx) => getProductDetail(tx, req.orgId!, productId, app.svc.clock()));
    if (!d) throw new HttpError(404, 'not_found', 'Product not found.');
    return d;
  });

  app.put('/variants/:variantId/threshold', async (req) => {
    requireRole(req, 'admin');
    const { variantId } = parse(z.object({ variantId: uuid }), req.params);
    const { threshold } = parse(variantThresholdSchema, req.body);
    const ok = await req.tx((tx) => setVariantThreshold(tx, req.orgId!, variantId, threshold));
    if (!ok) throw new HttpError(404, 'not_found', 'Product variant not found.');
    return { ok: true };
  });

  // ── evidence (source URL, time, hash, snippet) and the retained raw snapshot
  app.get('/evidence/:evidenceId', async (req) => {
    const { evidenceId } = parse(z.object({ evidenceId: uuid }), req.params);
    const e = await req.tx((tx) => getEvidence(tx, req.orgId!, evidenceId));
    if (!e) throw new HttpError(404, 'not_found', 'Evidence not found.');
    return { evidence: { id: e.id, url: e.url, fetchedAt: e.fetchedAt, httpStatus: e.httpStatus, contentType: e.contentType, contentHash: e.contentHash, bytes: e.bytes, snippet: e.snippet, method: e.extractionMethod, version: e.extractionVersion, snapshotAvailable: !!e.snapshotRef, snapshotPurgedAt: e.snapshotPurgedAt, provenance: e.provenance } };
  });

  app.get('/evidence/:evidenceId/snapshot', async (req, reply) => {
    const { evidenceId } = parse(z.object({ evidenceId: uuid }), req.params);
    const e = await req.tx((tx) => getEvidence(tx, req.orgId!, evidenceId));
    if (!e) throw new HttpError(404, 'not_found', 'Evidence not found.');
    if (!e.snapshotRef) throw new HttpError(410, 'snapshot_expired', e.snapshotPurgedAt ? 'The raw snapshot passed its retention period and was removed. The evidence record (URL, time, hash) is kept.' : 'No raw snapshot was stored for this record.');
    const body = await app.svc.storage.get(e.snapshotRef);
    if (!body) throw new HttpError(410, 'snapshot_missing', 'The stored snapshot could not be found.');
    // Scraped markup is untrusted: it is delivered as an attachment of plain text and can never run in our origin.
    return reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('content-disposition', `attachment; filename="snapshot-${e.id}.txt"`)
      .header('content-security-policy', "sandbox; default-src 'none'")
      .send(body);
  });

  // ── matches
  app.get('/matches', async (req) => {
    const q = parse(
      paginationSchema.extend({
        bucket: z.enum(['review', 'substitutes', 'unclear', 'confirmed', 'rejected', 'look_again', 'set_aside']).optional(),
        status: z.enum(MATCH_STATUSES).optional(),
        class: z.enum(MATCH_CLASSES).optional(),
        relationship: z.enum(MATCH_RELATIONSHIPS).optional(),
        tier: z.enum(EVIDENCE_TIERS).optional(),
        minConfidence: z.coerce.number().min(0).max(1).optional(),
        maxConfidence: z.coerce.number().min(0).max(1).optional(),
        siteId: uuid.optional(),
        group: z.enum(['product']).optional(),
        sourceProductId: uuid.optional(),
        competitorProductId: uuid.optional(),
      }),
      req.query,
    );
    return req.tx((tx) => listMatches(tx, req.orgId!, { bucket: q.bucket, status: q.status, matchClass: q.class, relationship: q.relationship, tier: q.tier, minConfidence: q.minConfidence, maxConfidence: q.maxConfidence, siteId: q.siteId, group: q.group, sourceProductId: q.sourceProductId, competitorProductId: q.competitorProductId, page: q.page, pageSize: q.pageSize }));
  });

  /** "These two products are not the same": rejects every variant pair of one product pair that still waits for a person (each as an ordinary, recorded decision). */
  app.post('/matches/product-pair/reject', async (req) => {
    const body = parse(z.object({ sourceProductId: uuid, competitorProductId: uuid, note: z.string().max(500).optional() }), req.body);
    return req.tx((tx) => rejectProductPair(tx, req.orgId!, body.sourceProductId, body.competitorProductId, req.user!.id, body.note, app.svc.clock()));
  });

  /** What exists, what waits, what is confirmed and what the last run did: the facts the empty states and the tab counts are built from. */
  app.get('/matches/summary', async (req) => req.tx((tx) => matchSummary(tx, req.orgId!)));

  /** Everything that ever happened to one pair: each suggestion, each change, each decision, with the evidence at the time. */
  app.get('/matches/:matchId/history', async (req) => {
    const { matchId } = parse(z.object({ matchId: uuid }), req.params);
    return req.tx(async (tx) => {
      const [m] = await tx.select({ id: productMatches.id }).from(productMatches).where(and(eq(productMatches.id, matchId), eq(productMatches.orgId, req.orgId!)));
      if (!m) throw new HttpError(404, 'not_found', 'Match not found.');
      const events = await tx.select().from(matchEvents).where(and(eq(matchEvents.matchId, matchId), eq(matchEvents.orgId, req.orgId!))).orderBy(desc(matchEvents.createdAt)).limit(100);
      return { events: events.map((e) => ({ id: e.id, kind: e.kind, relationship: e.relationship, tier: e.tier, status: e.status, decision: e.decision, evidence: e.evidence, engineVersion: e.engineVersion, note: e.note, actorId: e.actorId, createdAt: e.createdAt })) };
    });
  });

  app.post('/matches/run', async (req, reply) => {
    requireRole(req, 'admin');
    assertCanMatch(await req.tx((tx) => loadReadiness(tx, req.orgId!)));
    const jobId = await app.svc.queue.enqueue('match-products', { orgId: req.orgId }, { singletonKey: `match:${req.orgId}` });
    return reply.status(202).send({ queued: true, jobId });
  });

  /** Competitor products a person could choose as the equivalent of one of their own, best suggestions first. */
  app.get('/matches/candidates', async (req) => {
    const q = parse(z.object({ sourceVariantId: uuid, q: z.string().max(120).optional(), siteId: uuid.optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }), req.query);
    return { candidates: await req.tx((tx) => searchMatchCandidates(tx, req.orgId!, q)) };
  });

  /** A person's own choice of the matching product. Stored as accepted/manual and preserved by every later matching run. */
  app.post('/matches/manual', async (req, reply) => {
    requireRole(req, 'admin');
    const body = parse(manualMatchSchema, req.body);
    const r = await req.tx((tx) => setManualMatch(tx, req.orgId!, req.user!.id, body, app.svc.clock()));
    return reply.status(201).send(r);
  });

  /** A person accepts every waiting proposal of one class at or above a confidence in one decision (after a dry run that counts and samples them). */
  app.post('/matches/bulk', async (req) => {
    requireRole(req, 'admin');
    const body = parse(bulkAcceptSchema, req.body);
    return req.tx((tx) => bulkAcceptMatches(tx, req.orgId!, req.user!.id, body, app.svc.clock()));
  });

  app.post('/matches/:matchId/decision', async (req) => {
    const { matchId } = parse(z.object({ matchId: uuid }), req.params);
    const body = parse(matchDecisionSchema, req.body);
    return { match: await req.tx((tx) => decideMatch(tx, req.orgId!, matchId, req.user!.id, body, app.svc.clock())) };
  });

  // ── live price comparison matrix (filter / sort / paginate on the server)
  app.get('/comparison', async (req) => {
    const q = parse(
      paginationSchema.extend({
        q: z.string().max(200).optional(),
        category: z.string().max(200).optional(),
        siteId: uuid.optional(),
        view: z.enum(['prices', 'substitutes', 'related']).default('prices'),
        include: z.enum(['confirmed', 'suggested']).default('confirmed'),
        matchClass: z.enum(MATCH_CLASSES).optional(),
        freshness: z.enum(['fresh', 'stale', 'any']).default('any'),
        position: z.enum(['cheapest', 'middle', 'highest', 'tied', 'no_data']).optional(),
        sort: z.enum(['title', 'gap', 'freshness', 'category']).default('title'),
        dir: z.enum(['asc', 'desc']).default('asc'),
      }),
      req.query,
    );
    const result = await req.tx(async (tx) => {
      const settings = await getSettings(tx, req.orgId!);
      await ensureFxRates({ db: tx as never, clock: app.svc.clock });
      const fx = await loadFxTable(tx, app.svc.clock());
      const now = app.svc.clock();
      const rows = await loadComparison(tx, { view: q.view, include: q.include, orgId: req.orgId!, reportingCurrency: settings?.reportingCurrency ?? DEFAULTS.reportingCurrency, fx, now, staleAfterHours: DEFAULTS.staleAfterHours });
      const maps = await loadSiteMaps(tx, req.orgId!);
      const coverage = await loadCoverage(tx, req.orgId!, now, DEFAULTS.staleAfterHours);
      const summary = await matchSummary(tx, req.orgId!);
      return { rows, settings, fx, maps, coverage, summary };
    });
    const filtered = filterComparison(result.rows, q);
    const total = filtered.length;
    const start = (q.page - 1) * q.pageSize;
    return {
      rows: filtered.slice(start, start + q.pageSize),
      total,
      reportingCurrency: result.settings?.reportingCurrency ?? DEFAULTS.reportingCurrency,
      facets: {
        categories: [...new Set(result.rows.map((r) => r.category).filter((c): c is string => !!c))].sort(),
        competitors: result.maps.rows.filter((s) => s.role === 'competitor').map((s) => ({ id: s.id, name: s.name, capability: s.capabilityStatus, status: result.coverage.find((c) => c.siteId === s.id)?.status ?? null })),
      },
      view: q.view,
      // the facts the empty states are built from (nothing suggested yet / suggested but nothing confirmed / confirmed)
      matching: { state: result.summary.state, awaiting: result.summary.counts.awaiting, confirmedSame: result.summary.counts.confirmedSame, confirmedSubstitutes: result.summary.counts.confirmedSubstitutes, withoutCounterpart: result.summary.withoutCounterpart },
      fx: result.fx.usedRates(),
      asOf: app.svc.clock().toISOString(),
    };
  });

  // ── offers, stock, marketing, assortment (live views; reports snapshot the same definitions)
  app.get('/offers', async (req) => {
    const q = parse(z.object({ siteId: uuid.optional(), kind: z.string().optional(), status: z.string().optional(), verification: z.string().optional(), review: z.enum(['needs_review', 'reviewed', 'dismissed']).optional(), days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    return req.tx(async (tx) => {
      const maps = await loadSiteMaps(tx, req.orgId!);
      const rows = (await loadOffers(tx, req.orgId!, app.svc.clock(), maps, { days: q.days, limit: 1000, includeDismissed: q.review === 'dismissed' })).filter(
        (o) =>
          (!q.siteId || o.siteId === q.siteId) && (!q.kind || o.kind === q.kind) && (!q.status || o.status === q.status) && (!q.verification || o.verification === q.verification) &&
          (!q.review || (q.review === 'needs_review' ? o.needsReview : q.review === 'dismissed' ? o.review?.status === 'dismissed' : o.review?.status === 'confirmed' || o.review?.status === 'corrected')),
      );
      return { offers: rows, note: 'A claimed discount is verified only against the product’s own earlier prices. “Unverified” means there is not enough history yet.' };
    });
  });

  /** Confirm, correct or dismiss an offer the machine read from a flyer or page. The verdict is kept every time the flyer is collected again. */
  app.post('/offers/:offerId/review', async (req) => {
    requireRole(req, 'admin');
    const { offerId } = parse(z.object({ offerId: uuid }), req.params);
    const body = parse(offerReviewSchema, req.body);
    return { offer: await req.tx((tx) => reviewOffer(tx, req.orgId!, req.user!.id, offerId, body, app.svc.clock())) };
  });

  app.get('/stock', async (req) => {
    const q = parse(z.object({ includeInStock: z.enum(['true', 'false']).default('false') }), req.query);
    return req.tx(async (tx) => {
      const settings = await getSettings(tx, req.orgId!);
      const maps = await loadSiteMaps(tx, req.orgId!);
      const view = await loadStock(tx, app.svc.clock(), maps, settings?.lowStockThreshold ?? DEFAULTS.lowStockThreshold, { includeInStock: q.includeInStock === 'true', limit: 2000 });
      const [conn] = await tx.select().from(integrationConnections).where(and(eq(integrationConnections.orgId, req.orgId!), eq(integrationConnections.status, 'connected'))).orderBy(desc(integrationConnections.createdAt)).limit(1);
      return {
        ...view,
        threshold: settings?.lowStockThreshold ?? DEFAULTS.lowStockThreshold,
        mode: conn ? 'authorised' : 'public',
        connection: conn ? { id: conn.id, provider: conn.provider, lastSyncAt: conn.lastSyncAt, lastError: conn.lastError, syncHealth: connectionSyncHealth(conn, app.svc.clock(), DEFAULTS.staleAfterHours) } : null,
        explanation: conn
          ? 'Quantities come from your authorised, read-only inventory connection.'
          : 'Your website only publishes available / unavailable. Exact unit counts are shown only when you connect your store inventory; nothing is estimated.',
      };
    });
  });

  app.get('/marketing', async (req) => {
    const q = parse(z.object({ siteId: uuid.optional(), platform: z.string().optional(), days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    return req.tx(async (tx) => {
      const maps = await loadSiteMaps(tx, req.orgId!);
      const rows = (await loadMarketing(tx, req.orgId!, app.svc.clock(), maps, { days: q.days, limit: 500 })).filter((m) => (!q.siteId || m.siteId === q.siteId) && (!q.platform || m.platform === q.platform));
      const summary = await loadMarketingSummary(tx, req.orgId!, app.svc.clock(), maps, { days: q.days });
      return { activity: rows, summary, note: 'Observed public content. It is not evidence that a paid advertising campaign is running.' };
    });
  });

  app.get('/assortment', async (req) => {
    const q = parse(paginationSchema.extend({ side: z.enum(['competitor', 'source']).default('competitor'), siteId: uuid.optional() }), req.query);
    return req.tx(async (tx) => {
      const maps = await loadSiteMaps(tx, req.orgId!);
      const a = await loadAssortment(tx, req.orgId!, maps, await loadCoverage(tx, req.orgId!, app.svc.clock(), DEFAULTS.staleAfterHours));
      const list = (q.side === 'competitor' ? a.competitorOnly : a.sourceOnly).filter((x) => !q.siteId || x.siteId === q.siteId);
      return { total: list.length, entries: list.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), counts: { competitorOnly: a.competitorOnly.length, sourceOnly: a.sourceOnly.length }, basis: a.basis, note: a.note };
    });
  });

  app.get('/insights', async (req) => {
    const [latest] = await req.tx((tx) => tx.select().from(reports).where(and(eq(reports.orgId, req.orgId!), inArray(reports.status, ['ready', 'partial']))).orderBy(desc(reports.createdAt)).limit(1));
    const data = latest?.data as ReportData | undefined;
    return { reportId: latest?.id ?? null, periodDate: latest?.periodDate ?? null, isPartial: latest?.isPartial ?? false, insights: data?.insights ?? [], methodology: 'score = 100 × type weight × (0.4 + 0.6 × magnitude) × confidence × freshness' };
  });

  app.get('/site-names', async (req) => ({ sites: await req.tx((tx) => tx.select({ id: sites.id, name: sites.name, role: sites.role }).from(sites).where(eq(sites.orgId, req.orgId!))) }));
}

interface CompareFilter {
  q?: string;
  category?: string;
  siteId?: string;
  matchClass?: string;
  freshness: 'fresh' | 'stale' | 'any';
  position?: string;
  sort: 'title' | 'gap' | 'freshness' | 'category';
  dir: 'asc' | 'desc';
}

export function filterComparison(rows: ComparisonRow[], f: CompareFilter): ComparisonRow[] {
  const needle = f.q?.trim().toLowerCase();
  let out = rows
    .filter((r) => (!needle || `${r.title} ${r.brand ?? ''}`.toLowerCase().includes(needle)) && (!f.category || r.category === f.category) && (!f.position || r.position === f.position))
    .map((r) => ({
      ...r,
      cells: r.cells.filter(
        (c) =>
          (!f.siteId || c.siteId === f.siteId) &&
          (!f.matchClass || c.matchClass === f.matchClass) &&
          (f.freshness === 'any' || (f.freshness === 'stale' ? c.price.stale : !c.price.stale)),
      ),
    }))
    .filter((r) => r.cells.length > 0);
  const gap = (r: ComparisonRow) => Math.max(...r.cells.map((c) => Math.abs(c.directlyComparable ? (c.diffPct ?? 0) : (c.unitDiffPct ?? 0))));
  const oldest = (r: ComparisonRow) => Math.min(...[r.sourcePrice.observedAt, ...r.cells.map((c) => c.price.observedAt)].map((x) => (x ? new Date(x).getTime() : 0)));
  const key: Record<CompareFilter['sort'], (r: ComparisonRow) => number | string> = { title: (r) => r.title.toLowerCase(), gap, freshness: oldest, category: (r) => r.category ?? '' };
  const k = key[f.sort];
  out = out.sort((a, b) => {
    const x = k(a);
    const y = k(b);
    const c = typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number);
    return f.dir === 'asc' ? c : -c;
  });
  return out;
}
