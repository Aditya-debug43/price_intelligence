import { and, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  UNTRUSTED_PREAMBLE,
  applyAdjudication,
  buildMatches,
  collectKnownBrands,
  isPlaceholderBrand,
  placeholderBrandKeys,
  prepareVariant,
  sizeHintOf,
  wrapUntrusted,
  type Adjudication,
  analyseCatalogue,
  evaluatePair,
  type Corpus,
  type DossierInput,
  type LlmProvider,
  type MatchAdjudicator,
  type MatchCandidate,
  type PreparedVariant,
  AUTO_ACCEPT_THRESHOLD,
} from '@ci/core';
import { MATCH_CLASSES, classOfRelationship, relationshipOfClass, type DecidableRelationship, type MatchClass, type MatchRelationship } from '@ci/shared';
import { orgSettings, productMatches, products, sites, variants, auditEvents, type DbLike } from '@ci/database';
import type { Services } from './context.ts';
import { recordMatchEvents, runEngineOnInputs } from './matching-v2.ts';

const verdictSchema = z.object({ verdict: z.enum(MATCH_CLASSES), confidence: z.number().min(0).max(1), rationale: z.string().max(400) });

/** Optional AI second opinion for ambiguous pairs. Output is parsed strictly and then constrained by `applyAdjudication`. */
export class LlmAdjudicator implements MatchAdjudicator {
  readonly id = 'llm';
  constructor(private readonly llm: LlmProvider) {}
  async adjudicate(input: Parameters<MatchAdjudicator['adjudicate']>[0]): Promise<Adjudication | null> {
    if (!this.llm.available) return null;
    try {
      const raw = await this.llm.complete({
        system: `${UNTRUSTED_PREAMBLE}\nYou compare two retail products. Answer JSON only: {"verdict":"identical"|"different_pack"|"comparable"|"not_comparable","confidence":0..1,"rationale":"short reason"}. "identical" means the same product, same brand and the same size. Different pack size of the same product is "different_pack". A similar product from another brand is "comparable".`,
        user: wrapUntrusted(JSON.stringify({ a: input.a, b: input.b, currentGuess: input.current.matchClass })),
        maxTokens: 250,
      });
      const parsed = verdictSchema.safeParse(JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}

export interface MatchRunResult {
  sources: number;
  competitors: number;
  candidates: number;
  created: number;
  updated: number;
  removed: number;
  preservedManual: number;
  adjudicated: number;
  byClass: Record<MatchClass, number>;
  needsReview: number;
}

async function loadMatchable(db: DbLike, orgId: string) {
  const rows = await db
    .select({
      variantId: variants.id, productId: products.id, siteId: products.siteId, role: sites.role, title: products.title, variantTitle: variants.title, brand: products.brand, category: products.category,
      gtin: variants.gtin, sku: variants.sku, mpn: products.mpn, model: products.model, qtyLabel: variants.qtyLabel, attrs: products.attrs, price: variants.price, currency: variants.currency, options: variants.options,
    })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .innerJoin(sites, eq(sites.id, products.siteId))
    .where(and(eq(variants.orgId, orgId), eq(sites.active, true), isNull(products.delistedAt)));
  return rows;
}

/** The product pages' own descriptions (the first part: a bulb-size chart is near the top), one string per product. Only the v2 engine reads them, and only for a chart. */
async function loadDescriptions(db: DbLike, orgId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const res = await db.execute<{ id: string; d: string }>(sql`select p.id, left(p.description, 6000) as d from products p join sites s on s.id = p.site_id where p.org_id = ${orgId} and s.active and p.delisted_at is null and p.description is not null and position('location bulb size' in lower(p.description)) > 0`);
  for (const r of res.rows) out.set(r.id, r.d);
  return out;
}

/** The shop's own tags ("Beer", "Soft Drinks") as plain words: used only to tell fluid ounces from weight ounces. */
export const tagContext = (attrs: Record<string, unknown> | null | undefined): string | null => (Array.isArray(attrs?.['tags']) ? (attrs!['tags'] as unknown[]).filter((t): t is string => typeof t === 'string').join(' ') : null);

const tagList = (attrs: Record<string, unknown> | null | undefined): string[] => (Array.isArray(attrs?.['tags']) ? (attrs!['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : []);

export async function runMatching(svc: Services, db: DbLike, orgId: string): Promise<MatchRunResult> {
  const rows = await loadMatchable(db, orgId);
  const [settings] = await db.select().from(orgSettings).where(eq(orgSettings.orgId, orgId));
  // A vendor field that holds the shop's own name, the country or a platform default is not a brand (see core/brands.ts): matching uses none.
  const placeholders = placeholderBrandKeys(rows.map((r) => ({ siteId: r.siteId, brand: r.brand, title: r.title })));
  const matchables: (DossierInput & { role: 'source' | 'competitor' })[] = rows.map((r) => ({
    variantId: r.variantId, productId: r.productId, siteId: r.siteId, role: r.role, title: r.title, variantTitle: r.variantTitle, brand: isPlaceholderBrand(placeholders, r.siteId, r.brand) ? null : r.brand, category: r.category, gtin: r.gtin, sku: r.sku,
    mpn: r.mpn, model: r.model, sizeHints: [r.qtyLabel, sizeHintOf(r.attrs)], context: tagContext(r.attrs), options: r.options, tags: tagList(r.attrs),
  }));

  // Engine v2 (and its shadow mode) is chosen per workspace. Shadow computes and records the run and changes nothing a person can see.
  const engine = settings?.matchingEngine ?? 'v1';
  if (engine === 'v2' || engine === 'v2_shadow') {
    const now = svc.clock();
    const descriptions = await loadDescriptions(db, orgId);
    for (const m of matchables) m.description = descriptions.get(m.productId) ?? null;
    const { summary, result } = await runEngineOnInputs(db, orgId, engine, matchables.filter((m) => m.role === 'source'), matchables.filter((m) => m.role === 'competitor'), now, { autoConfirm: settings?.matchingAutoConfirm === true });
    const p = summary.persisted;
    const rel = summary.byRelationship;
    return {
      sources: summary.sources, competitors: summary.competitors, candidates: summary.suggestions, created: p?.created ?? 0, updated: (p?.changed ?? 0) + (p?.reinstated ?? 0), removed: p?.superseded ?? 0, preservedManual: p?.protectedDecisions ?? 0,
      adjudicated: 0, byClass: { identical: rel.exact, different_pack: rel.variant, comparable: rel.substitute, not_comparable: rel.related + rel.insufficient },
      needsReview: result.suggestions.filter((s) => s.relationship === 'exact' || s.relationship === 'variant' || s.relationship === 'substitute').length,
    };
  }

  const brands = collectKnownBrands(matchables);
  const prepared = matchables.map((m) => ({ role: m.role, p: prepareVariant(m, brands) }));
  const sources = prepared.filter((x) => x.role === 'source').map((x) => x.p);
  const competitors = prepared.filter((x) => x.role === 'competitor').map((x) => x.p);

  let candidates: MatchCandidate[] = buildMatches(sources, competitors);

  // Optional AI second opinion on ambiguous pairs (bounded; never auto-accepted).
  let adjudicated = 0;
  if (settings?.aiAdjudication && svc.llm.available) {
    const adj = new LlmAdjudicator(svc.llm);
    const byId = new Map<string, PreparedVariant>([...sources, ...competitors].map((p) => [p.variantId, p]));
    const price = new Map(rows.map((r) => [r.variantId, r.price !== null ? `${r.currency ?? '?'} ${r.price}` : null]));
    const ambiguous = candidates.filter((c) => c.status === 'needs_review' && c.confidence >= 0.4 && c.confidence < AUTO_ACCEPT_THRESHOLD).slice(0, 40);
    for (const c of ambiguous) {
      const a = byId.get(c.sourceVariantId);
      const b = byId.get(c.competitorVariantId);
      if (!a || !b) continue;
      const view = (p: PreparedVariant) => ({ title: p.fullTitle, brand: p.brand, size: p.qty.label, category: p.category, price: price.get(p.variantId) });
      const verdict = await adj.adjudicate({ a: view(a), b: view(b), current: c });
      if (!verdict) continue;
      const idx = candidates.indexOf(c);
      candidates[idx] = applyAdjudication(c, verdict);
      adjudicated++;
    }
  }
  candidates = candidates.filter((c) => c.matchClass !== 'not_comparable');

  // Merge with stored matches; human decisions always win.
  const existing = await db.select().from(productMatches).where(eq(productMatches.orgId, orgId));
  const byPair = new Map(existing.map((m) => [`${m.sourceVariantId}|${m.competitorVariantId}`, m]));
  const seen = new Set<string>();
  const now = svc.clock();
  const result: MatchRunResult = {
    sources: sources.length, competitors: competitors.length, candidates: candidates.length, created: 0, updated: 0, removed: 0, preservedManual: 0, adjudicated,
    byClass: { identical: 0, different_pack: 0, comparable: 0, not_comparable: 0 }, needsReview: 0,
  };
  for (const c of candidates) {
    const key = `${c.sourceVariantId}|${c.competitorVariantId}`;
    seen.add(key);
    const ex = byPair.get(key);
    if (ex && (ex.status === 'accepted' || ex.status === 'rejected')) {
      result.preservedManual++;
      continue;
    }
    result.byClass[c.matchClass]++;
    // Nothing a run proposes is accepted by the run: a person confirms every pair (what the earlier engine called "auto" waits for review too).
    result.needsReview++;
    const values = { matchClass: c.matchClass, confidence: c.confidence, status: 'needs_review' as const, method: c.method, reasons: c.reasons, components: c.components as unknown as Record<string, unknown>, supersededAt: null, updatedAt: now };
    if (ex) {
      await db.update(productMatches).set(values).where(eq(productMatches.id, ex.id));
      result.updated++;
    } else {
      await db.insert(productMatches).values({ orgId, sourceVariantId: c.sourceVariantId, competitorVariantId: c.competitorVariantId, competitorSiteId: c.competitorSiteId, ...values });
      result.created++;
    }
  }
  // Suggestions that are no longer proposed are set aside (kept, with their history), not deleted.
  const stale = existing.filter((m) => !seen.has(`${m.sourceVariantId}|${m.competitorVariantId}`) && (m.status === 'auto' || m.status === 'needs_review') && m.supersededAt === null);
  if (stale.length) {
    for (let i = 0; i < stale.length; i += 500) {
      await db.update(productMatches).set({ supersededAt: now, updatedAt: now }).where(and(inArray(productMatches.id, stale.slice(i, i + 500).map((m) => m.id)), eq(productMatches.orgId, orgId)));
    }
    await recordMatchEvents(db, orgId, stale.map((m) => m.id), 'superseded', { note: 'The matcher no longer proposes this pair.' });
    result.removed = stale.length;
  }
  return result;
}

export interface BulkAcceptInput {
  /** Only "the same product" groups can be accepted together. A stand-in always needs its own look: the differences are the point. */
  matchClass: 'identical' | 'different_pack';
  minConfidence: number;
  siteId?: string;
  dryRun?: boolean;
  note?: string;
}
export interface BulkAcceptResult {
  /** How many waiting proposals fit (and were accepted, unless this was a dry run). */
  count: number;
  accepted: boolean;
  /** A sample of the pairs (spread across the list), so the person can see what they are accepting. */
  examples: { competitorSite: string; sourceTitle: string; sourcePrice: number | null; sourceCurrency: string | null; competitorTitle: string; competitorPrice: number | null; competitorCurrency: string | null; confidence: number; reasons: string[] }[];
}

const BULK_LIMIT = 5000;

/**
 * A person accepts every waiting proposal of one class at or above a confidence in one decision. Only proposals that are still waiting
 * for review are touched (never one a person already decided), each is stored as the person's decision, and one audit entry records
 * the whole action with its filter and count.
 */
export async function bulkAcceptMatches(db: DbLike, orgId: string, userId: string, p: BulkAcceptInput, now: Date): Promise<BulkAcceptResult> {
  // waiting pairs of one class: an earlier-engine pair by its score; an engine-v2 pair only when its evidence is in the strong tier
  const where = and(
    eq(productMatches.orgId, orgId),
    inArray(productMatches.status, ['needs_review', 'auto']),
    isNull(productMatches.supersededAt),
    eq(productMatches.matchClass, p.matchClass),
    or(and(isNull(productMatches.relationship), gte(productMatches.confidence, p.minConfidence)), eq(productMatches.tier, 'strong')),
    ...(p.siteId ? [eq(productMatches.competitorSiteId, p.siteId)] : []),
  );
  const ids = (await db.select({ id: productMatches.id }).from(productMatches).where(where).orderBy(productMatches.id).limit(BULK_LIMIT)).map((r) => r.id);
  const pick = ids.length <= 6 ? ids : Array.from({ length: 6 }, (_, i) => ids[Math.floor((i * (ids.length - 1)) / 5)]!);
  const sample = pick.length
    ? await db.execute<{ competitorSite: string; sourceTitle: string; sourcePrice: number | null; sourceCurrency: string | null; competitorTitle: string; competitorPrice: number | null; competitorCurrency: string | null; confidence: number; reasons: string[] }>(sql`
        select sc.name as "competitorSite", ps.title as "sourceTitle", vs.price as "sourcePrice", vs.currency as "sourceCurrency", pc.title as "competitorTitle", vc.price as "competitorPrice", vc.currency as "competitorCurrency", m.confidence, m.reasons
        from product_matches m join variants vs on vs.id = m.source_variant_id join products ps on ps.id = vs.product_id
        join variants vc on vc.id = m.competitor_variant_id join products pc on pc.id = vc.product_id join sites sc on sc.id = m.competitor_site_id
        where m.org_id = ${orgId} and m.id in (${sql.join(pick.map((id) => sql`${id}::uuid`), sql`, `)}) order by m.id`)
    : { rows: [] };
  const examples = sample.rows.map((r) => ({ ...r, sourcePrice: r.sourcePrice === null ? null : Number(r.sourcePrice), competitorPrice: r.competitorPrice === null ? null : Number(r.competitorPrice), confidence: Number(r.confidence) }));
  if (p.dryRun || !ids.length) return { count: ids.length, accepted: false, examples };
  for (let i = 0; i < ids.length; i += 500) {
    await db
      .update(productMatches)
      .set({ status: 'accepted', decidedBy: userId, decidedAt: now, decisionNote: p.note ?? 'Accepted together with other proposals of the same kind', needsReevaluation: false, updatedAt: now })
      .where(and(inArray(productMatches.id, ids.slice(i, i + 500)), eq(productMatches.orgId, orgId), inArray(productMatches.status, ['needs_review', 'auto'])));
  }
  await recordMatchEvents(db, orgId, ids, 'decided', { actorId: userId, decision: 'bulk', note: p.note ?? null });
  await db.insert(auditEvents).values({ orgId, userId, action: 'match.bulk_accept', target: orgId, meta: { matchClass: p.matchClass, minConfidence: p.minConfidence, siteId: p.siteId ?? null, count: ids.length } });
  return { count: ids.length, accepted: true, examples };
}

export class MatchError extends Error {
  constructor(message: string, readonly status = 404) {
    super(message);
  }
}

export async function decideMatch(
  db: DbLike,
  orgId: string,
  matchId: string,
  userId: string,
  d: { decision: 'accept' | 'reject' | 'reclassify'; matchClass?: MatchClass; relationship?: DecidableRelationship; note?: string },
  now: Date,
) {
  const [m] = await db.select().from(productMatches).where(and(eq(productMatches.id, matchId), eq(productMatches.orgId, orgId)));
  if (!m) throw new MatchError('Match not found');
  const current: MatchRelationship = m.relationship ?? relationshipOfClass(m.matchClass);
  // a person's decision always replaces a pending "look again" flag: they have looked
  const set: Partial<typeof productMatches.$inferInsert> = { decidedBy: userId, decidedAt: now, decisionNote: d.note ?? null, needsReevaluation: false, autoConfirmedAt: null, updatedAt: now };
  if (d.decision === 'accept') {
    // "insufficient" and "non-match" are not something to confirm: say what the products are instead
    if (current === 'insufficient' || current === 'non_match') throw new MatchError('Choose what these products are: the same product, a substitute or related.', 400);
    set.status = 'accepted';
    set.relationship = current;
  } else if (d.decision === 'reject') {
    set.status = 'rejected';
    set.matchClass = 'not_comparable';
    set.relationship = 'non_match';
  } else {
    const rel: MatchRelationship | undefined = d.relationship ?? (d.matchClass && d.matchClass !== 'not_comparable' ? relationshipOfClass(d.matchClass) : undefined);
    if (!rel || rel === 'non_match' || rel === 'insufficient') throw new MatchError('Choose what these products are', 400);
    set.status = 'accepted';
    set.relationship = rel;
    set.matchClass = classOfRelationship(rel);
  }
  const [row] = await db.update(productMatches).set(set).where(eq(productMatches.id, matchId)).returning();
  await recordMatchEvents(db, orgId, [matchId], 'decided', { actorId: userId, decision: d.decision, note: d.note ?? null });
  await db.insert(auditEvents).values({ orgId, userId, action: `match.${d.decision}`, target: matchId, meta: { from: m.matchClass, to: set.matchClass ?? m.matchClass, relationship: set.relationship ?? current } });
  return row!;
}


/**
 * "These two products are not the same": one decision for every variant pair of the product pair that is still waiting for a person. Each pair gets its own
 * ordinary "rejected" decision (history and audit entry included); pairs a person already decided, and pairs the matcher set aside, are never touched.
 * Only a rejection can be applied to a group: confirming needs each variant pair looked at, because the sizes and options differ between them.
 */
export async function rejectProductPair(db: DbLike, orgId: string, sourceProductId: string, competitorProductId: string, userId: string, note: string | undefined, now: Date): Promise<{ rejected: number }> {
  const waiting = await db.execute<{ id: string }>(sql`
    select m.id from product_matches m
    join variants vs on vs.id = m.source_variant_id join variants vc on vc.id = m.competitor_variant_id
    where m.org_id = ${orgId} and vs.product_id = ${sourceProductId}::uuid and vc.product_id = ${competitorProductId}::uuid
      and ((m.status in ('needs_review','auto') and m.superseded_at is null) or (m.status = 'accepted' and m.auto_confirmed_at is not null))`);
  for (const r of waiting.rows) await decideMatch(db, orgId, r.id, userId, { decision: 'reject', note }, now);
  return { rejected: waiting.rows.length };
}

// ───────────────────────────────────────────────────────────── human choice: search for the right product

export interface MatchCandidateRow {
  variantId: string;
  productId: string;
  siteId: string;
  siteName: string;
  title: string;
  variantTitle: string | null;
  brand: string | null;
  sizeLabel: string | null;
  gtin: string | null;
  sku: string | null;
  price: number | null;
  currency: string | null;
  availability: string;
  observedAt: Date | null;
  url: string;
  /** What the matcher thinks of this pair, with the evidence — a suggestion for a person, never applied automatically. */
  suggestion: { relationship: MatchRelationship; tier: string; summary: string; reasons: string[] } | null;
}

/**
 * Competitor products a person could pick as the equivalent of one of their own, best suggestions first. Optional free-text filter
 * (title, brand, SKU, barcode) and website filter. Nothing here changes any match.
 */
export async function searchMatchCandidates(db: DbLike, orgId: string, p: { sourceVariantId: string; q?: string; siteId?: string; limit?: number }): Promise<MatchCandidateRow[]> {
  const all = await loadMatchable(db, orgId);
  const src = all.find((r) => r.variantId === p.sourceVariantId && r.role === 'source');
  if (!src) throw new MatchError('Product not found');
  const toMatchable = (r: (typeof all)[number]): DossierInput => ({
    variantId: r.variantId, productId: r.productId, siteId: r.siteId, title: r.title, variantTitle: r.variantTitle, brand: r.brand, category: r.category, gtin: r.gtin, sku: r.sku, mpn: r.mpn, model: r.model,
    sizeHints: [r.qtyLabel, sizeHintOf(r.attrs)], context: tagContext(r.attrs), options: r.options, tags: tagList(r.attrs),
  });
  // the same evidence the matcher uses, so a person choosing by hand sees why each product is suggested or not (the catalogue analysis is reused for a few minutes)
  const corpus = cachedCorpus(orgId, all.map(toMatchable));
  const srcDossier = corpus.byVariant.get(src.variantId)!;
  const needle = p.q?.trim().toLowerCase();
  const pool = all.filter((r) => r.role === 'competitor' && (!p.siteId || r.siteId === p.siteId));
  const scored = pool
    .filter((r) => !needle || [r.title, r.variantTitle, r.brand, r.sku, r.gtin].some((v) => v?.toLowerCase().includes(needle)))
    .map((r) => {
      const e = evaluatePair(srcDossier, corpus.byVariant.get(r.variantId)!, corpus);
      const usable = e.relationship !== 'non_match';
      return { r, e, sc: usable ? e : null, rank: usable ? (e.relationship === 'exact' ? 3 : e.relationship === 'variant' ? 2.5 : e.relationship === 'substitute' ? 2 : 1) + e.rank : 0 };
    })
    .sort((a, b) => b.rank - a.rank || a.r.title.localeCompare(b.r.title))
    .slice(0, Math.min(p.limit ?? 20, 50));
  if (!scored.length) return [];
  const details = await db
    .select({ id: variants.id, availability: variants.availability, observedAt: variants.observedAt, url: variants.url, siteName: sites.name })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .innerJoin(sites, eq(sites.id, products.siteId))
    .where(and(eq(variants.orgId, orgId), inArray(variants.id, scored.map((x) => x.r.variantId))));
  const byId = new Map(details.map((d) => [d.id, d]));
  return scored.map(({ r, sc }) => ({
    variantId: r.variantId, productId: r.productId, siteId: r.siteId, siteName: byId.get(r.variantId)?.siteName ?? '', title: r.title, variantTitle: r.variantTitle, brand: r.brand, sizeLabel: r.qtyLabel,
    gtin: r.gtin, sku: r.sku, price: r.price, currency: r.currency, availability: byId.get(r.variantId)?.availability ?? 'unknown', observedAt: byId.get(r.variantId)?.observedAt ?? null, url: byId.get(r.variantId)?.url ?? '',
    suggestion: sc ? { relationship: sc.relationship, tier: sc.tier, summary: sc.evidence.summary, reasons: sc.evidence.items.filter((i) => i.effect !== 'missing').slice(0, 4).map((i) => i.text) } : null,
  }));
}

const corpusCache = new Map<string, { at: number; size: number; corpus: Corpus }>();
function cachedCorpus(orgId: string, inputs: DossierInput[]): Corpus {
  const hit = corpusCache.get(orgId);
  if (hit && Date.now() - hit.at < 5 * 60_000 && hit.size === inputs.length) return hit.corpus;
  const corpus = analyseCatalogue(inputs);
  corpusCache.set(orgId, { at: Date.now(), size: inputs.length, corpus });
  if (corpusCache.size > 3) corpusCache.delete(corpusCache.keys().next().value!);
  return corpus;
}

/**
 * Records a person's decision that a competitor product corresponds to one of their own. A human decision is the evidence: it is stored
 * as accepted with method 'manual', replaces the suggestion being corrected, and survives every later matching run.
 */
export async function setManualMatch(
  db: DbLike,
  orgId: string,
  userId: string,
  p: { sourceVariantId: string; competitorVariantId: string; matchClass?: 'identical' | 'different_pack' | 'comparable'; relationship?: DecidableRelationship; replaceMatchId?: string; note?: string },
  now: Date,
) {
  const relationship: DecidableRelationship | undefined = p.relationship ?? (p.matchClass ? (relationshipOfClass(p.matchClass) as DecidableRelationship) : undefined);
  if (!relationship) throw new MatchError('Choose what these products are', 400);
  const rows = await db
    .select({ id: variants.id, siteId: products.siteId, role: sites.role })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .innerJoin(sites, eq(sites.id, products.siteId))
    .where(and(eq(variants.orgId, orgId), inArray(variants.id, [p.sourceVariantId, p.competitorVariantId])));
  const src = rows.find((r) => r.id === p.sourceVariantId);
  const comp = rows.find((r) => r.id === p.competitorVariantId);
  if (!src || !comp) throw new MatchError('Product not found');
  if (src.role !== 'source' || comp.role !== 'competitor') throw new MatchError('A match pairs one of your products with a competitor’s product.', 400);

  const values = { matchClass: classOfRelationship(relationship), confidence: 1, status: 'accepted' as const, method: 'manual', reasons: ['Chosen by a person'], relationship, supersededAt: null, needsReevaluation: false, decidedBy: userId, decidedAt: now, decisionNote: p.note ?? null, updatedAt: now };
  const [existing] = await db.select().from(productMatches).where(and(eq(productMatches.sourceVariantId, p.sourceVariantId), eq(productMatches.competitorVariantId, p.competitorVariantId)));
  const row = existing
    ? (await db.update(productMatches).set(values).where(eq(productMatches.id, existing.id)).returning())[0]!
    : (await db.insert(productMatches).values({ orgId, sourceVariantId: p.sourceVariantId, competitorVariantId: p.competitorVariantId, competitorSiteId: comp.siteId, components: {}, ...values }).returning())[0]!;

  // Other suggestions for the same product at the same website are superseded by the person's choice (accepted ones are left alone).
  const superseded = await db
    .update(productMatches)
    .set({ status: 'rejected', matchClass: 'not_comparable', relationship: 'non_match', decidedBy: userId, decidedAt: now, decisionNote: 'Replaced by a manual choice', updatedAt: now })
    .where(
      and(
        eq(productMatches.orgId, orgId),
        eq(productMatches.sourceVariantId, p.sourceVariantId),
        eq(productMatches.competitorSiteId, comp.siteId),
        ne(productMatches.id, row.id),
        or(inArray(productMatches.status, ['auto', 'needs_review']), p.replaceMatchId ? eq(productMatches.id, p.replaceMatchId) : undefined),
      ),
    )
    .returning({ id: productMatches.id });
  await recordMatchEvents(db, orgId, [row.id], 'decided', { actorId: userId, decision: 'manual', note: p.note ?? null });
  if (superseded.length) await recordMatchEvents(db, orgId, superseded.map((s) => s.id), 'decided', { actorId: userId, decision: 'reject', note: 'Replaced by a manual choice' });
  await db.insert(auditEvents).values({ orgId, userId, action: 'match.manual', target: row.id, meta: { matchClass: values.matchClass, relationship, superseded: superseded.length, replaced: p.replaceMatchId ?? null } });
  return { match: row, superseded: superseded.length };
}
