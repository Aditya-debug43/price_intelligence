import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { ENGINE_VERSION, runEngine, type DossierInput, type EngineResult, type Suggestion } from '@ci/core';
import { classOfRelationship, relationshipOfClass, type MatchingEngine, type MatchRelationship } from '@ci/shared';
import { matchRuns, productMatches, type DbLike } from '@ci/database';

/**
 * Persistence for matching engine v2. The rules this file enforces, in order of importance:
 *  1. A person's decision (accepted / rejected) is never changed by a run. If a product in a decided pair changed since, the pair is FLAGGED
 *     for a second look; the decision itself stands.
 *  2. A suggestion that is no longer proposed is SUPERSEDED, not deleted: the row and its history stay, and it can come back.
 *  3. A run accepts nothing on its own EXCEPT under a workspace's auto-confirmation setting, and then only the pairs the engine's auto-confirmation policy allows
 *     (identifiers; the same maker with identical names and consistent sizes). Such a pair is stored as 'accepted' with auto_confirmed_at set and no person on it. Everything
 *     else waits for a person (status 'needs_review'). A person's later decision clears the marker and is final; the engine only ever withdraws a confirmation it made itself
 *     (the policy no longer allows it, a product changed, the pair is no longer proposed, or the setting was turned off).
 *  4. Every change to a suggestion and every decision is appended to match_events with the evidence and a snapshot of both products.
 */

export interface PersistResult {
  created: number;
  changed: number;
  unchanged: number;
  reinstated: number;
  superseded: number;
  flagged: number;
  baselined: number;
  protectedDecisions: number;
  /** Pairs the engine confirmed under the auto-confirmation policy in this run, and confirmations it withdrew. */
  autoConfirmed: number;
  autoWithdrawn: number;
}

type EventKind = 'suggested' | 'changed' | 'superseded' | 'reinstated' | 'decided' | 'flagged' | 'auto_confirmed' | 'auto_withdrawn';

const chunks = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));
const uuidList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);

/**
 * Appends one history row per match, reading the CURRENT state of the match and a snapshot of both products. Called after the change it
 * records, so the row says what the pair is now.
 */
export async function recordMatchEvents(db: DbLike, orgId: string, matchIds: string[], kind: EventKind, o: { actorId?: string | null; decision?: string | null; note?: string | null } = {}): Promise<void> {
  for (const part of chunks(matchIds, 400)) {
    await db.execute(sql`
      insert into match_events (org_id, source_variant_id, competitor_variant_id, match_id, kind, relationship, tier, status, decision, evidence, engine_version, pair_hash, snapshot, actor_id, note)
      select m.org_id, m.source_variant_id, m.competitor_variant_id, m.id, ${kind}, coalesce(m.relationship, case m.match_class when 'identical' then 'exact' when 'different_pack' then 'variant' when 'comparable' then 'substitute' else 'non_match' end),
             m.tier, m.status, ${o.decision ?? null}, m.evidence, m.engine_version, m.pair_hash,
             jsonb_build_object(
               'source', jsonb_build_object('title', ps.title, 'variantTitle', vs.title, 'brand', ps.brand, 'category', ps.category, 'gtin', vs.gtin, 'sku', vs.sku, 'mpn', ps.mpn, 'size', vs.qty_label, 'options', vs.options, 'website', ss.hostname),
               'competitor', jsonb_build_object('title', pc.title, 'variantTitle', vc.title, 'brand', pc.brand, 'category', pc.category, 'gtin', vc.gtin, 'sku', vc.sku, 'mpn', pc.mpn, 'size', vc.qty_label, 'options', vc.options, 'website', sc.hostname)),
             ${o.actorId ?? null}::uuid, ${o.note ?? null}
      from product_matches m
      join variants vs on vs.id = m.source_variant_id join products ps on ps.id = vs.product_id join sites ss on ss.id = ps.site_id
      join variants vc on vc.id = m.competitor_variant_id join products pc on pc.id = vc.product_id join sites sc on sc.id = pc.site_id
      where m.org_id = ${orgId} and m.id in (${uuidList(part)})`);
  }
}

export async function persistSuggestions(db: DbLike, orgId: string, suggestions: Suggestion[], now: Date, opts: { autoConfirm?: boolean } = {}): Promise<PersistResult> {
  const r: PersistResult = { created: 0, changed: 0, unchanged: 0, reinstated: 0, superseded: 0, flagged: 0, baselined: 0, protectedDecisions: 0, autoConfirmed: 0, autoWithdrawn: 0 };
  const autoOn = opts.autoConfirm === true;
  const existing = await db.select().from(productMatches).where(eq(productMatches.orgId, orgId));
  const byPair = new Map(existing.map((m) => [`${m.sourceVariantId}|${m.competitorVariantId}`, m]));
  const seen = new Set<string>();
  const ids: Record<'suggested' | 'changed' | 'reinstated' | 'flagged' | 'auto_confirmed' | 'auto_withdrawn', string[]> = { suggested: [], changed: [], reinstated: [], flagged: [], auto_confirmed: [], auto_withdrawn: [] };
  const inserts: (typeof productMatches.$inferInsert)[] = [];
  const insertAuto: boolean[] = [];

  for (const s of suggestions) {
    const key = `${s.sourceVariantId}|${s.competitorVariantId}`;
    seen.add(key);
    const ex = byPair.get(key);
    // a confirmation the ENGINE made is the engine's to keep up to date; one a person made is not
    const engineOwned = !!ex && ex.status === 'accepted' && ex.autoConfirmedAt !== null;
    const eligible = autoOn && s.autoEligible;
    const values = {
      matchClass: classOfRelationship(s.relationship), confidence: s.rank, status: (eligible ? 'accepted' : 'needs_review') as 'accepted' | 'needs_review', method: s.method, reasons: [s.evidence.summary],
      autoConfirmedAt: eligible ? (engineOwned ? ex!.autoConfirmedAt : now) : null,
      decidedAt: eligible ? (engineOwned ? ex!.decidedAt : now) : null,
      decisionNote: eligible ? 'Confirmed automatically: the same identifier, or the same maker with identical names and consistent sizes.' : null,
      components: { engine: ENGINE_VERSION, signals: s.evidence.signals } as Record<string, unknown>, relationship: s.relationship, tier: s.tier, evidence: s.evidence, engineVersion: s.engineVersion,
      pairHash: s.pairHash, supersededAt: null, needsReevaluation: false, updatedAt: now,
    };
    if (ex && (ex.status === 'accepted' || ex.status === 'rejected') && !engineOwned) {
      // a person decided this pair: the run may only notice that a product changed since
      r.protectedDecisions++;
      if (ex.pairHash === null) {
        await db.update(productMatches).set({ pairHash: s.pairHash }).where(eq(productMatches.id, ex.id));
        r.baselined++;
      } else if (ex.pairHash !== s.pairHash) {
        await db.update(productMatches).set({ pairHash: s.pairHash, needsReevaluation: true }).where(eq(productMatches.id, ex.id));
        ids.flagged.push(ex.id);
        r.flagged++;
      }
      continue;
    }
    if (!ex) {
      inserts.push({ orgId, sourceVariantId: s.sourceVariantId, competitorVariantId: s.competitorVariantId, competitorSiteId: s.competitorSiteId, ...values });
      insertAuto.push(eligible);
      continue;
    }
    const same = ex.relationship === s.relationship && ex.tier === s.tier && ex.pairHash === s.pairHash && ex.engineVersion === s.engineVersion && ex.evidence?.summary === s.evidence.summary && ex.supersededAt === null && ex.status === values.status && (ex.autoConfirmedAt !== null) === eligible;
    if (same) {
      r.unchanged++;
      continue;
    }
    const { updatedAt: _u, ...rest } = values;
    void _u;
    await db.update(productMatches).set({ ...rest, updatedAt: now }).where(eq(productMatches.id, ex.id));
    if (eligible && !engineOwned) {
      ids.auto_confirmed.push(ex.id);
      r.autoConfirmed++;
    } else if (engineOwned && !eligible) {
      ids.auto_withdrawn.push(ex.id);
      r.autoWithdrawn++;
    } else if (ex.supersededAt) {
      ids.reinstated.push(ex.id);
      r.reinstated++;
    } else {
      ids.changed.push(ex.id);
      r.changed++;
    }
  }
  for (const part of chunks(inserts, 400)) {
    const rows = await db.insert(productMatches).values(part).returning({ id: productMatches.id });
    // (the rows come back in the order they went in)
    const offset = inserts.indexOf(part[0]!);
    rows.forEach((x, i) => { if (insertAuto[offset + i]) { ids.auto_confirmed.push(x.id); r.autoConfirmed++; } else ids.suggested.push(x.id); });
    r.created += rows.length;
  }

  // suggestions the engine no longer proposes: kept, marked, and out of the review queue — never deleted
  const notSeen = existing.filter((m) => !seen.has(`${m.sourceVariantId}|${m.competitorVariantId}`) && m.supersededAt === null);
  const stale = notSeen.filter((m) => m.status === 'auto' || m.status === 'needs_review').map((m) => m.id);
  for (const part of chunks(stale, 500)) {
    await db.update(productMatches).set({ supersededAt: now, updatedAt: now }).where(and(inArray(productMatches.id, part), eq(productMatches.orgId, orgId), isNull(productMatches.supersededAt)));
  }
  r.superseded = stale.length;
  // a confirmation the engine made for a pair it no longer proposes is withdrawn with the suggestion (a person's confirmation is never touched)
  const withdrawn = notSeen.filter((m) => m.status === 'accepted' && m.autoConfirmedAt !== null).map((m) => m.id);
  for (const part of chunks(withdrawn, 500)) {
    await db.update(productMatches).set({ status: 'needs_review', autoConfirmedAt: null, decidedAt: null, decisionNote: null, supersededAt: now, updatedAt: now }).where(and(inArray(productMatches.id, part), eq(productMatches.orgId, orgId), isNotNull(productMatches.autoConfirmedAt), eq(productMatches.status, 'accepted')));
  }
  ids.auto_withdrawn.push(...withdrawn);
  r.autoWithdrawn += withdrawn.length;

  await recordMatchEvents(db, orgId, ids.suggested, 'suggested');
  await recordMatchEvents(db, orgId, ids.changed, 'changed');
  await recordMatchEvents(db, orgId, ids.reinstated, 'reinstated');
  await recordMatchEvents(db, orgId, ids.flagged, 'flagged', { note: 'A product in this decided pair changed since you decided. Your decision is unchanged.' });
  await recordMatchEvents(db, orgId, ids.auto_confirmed, 'auto_confirmed', { decision: 'accept', note: 'Confirmed automatically under the workspace\u2019s auto-confirmation setting.' });
  await recordMatchEvents(db, orgId, ids.auto_withdrawn, 'auto_withdrawn', { note: 'Automatic confirmation withdrawn: the pair no longer meets the policy, a product changed, or automatic confirmation was turned off.' });
  await recordMatchEvents(db, orgId, stale, 'superseded', { note: 'The matcher no longer proposes this pair.' });
  return r;
}

/** Takes back every confirmation the ENGINE made in a workspace (they return to the review queue as suggestions). A person's confirmations are never touched. */
export async function withdrawAutoConfirmations(db: DbLike, orgId: string, now: Date): Promise<number> {
  const rows = await db.update(productMatches).set({ status: 'needs_review', autoConfirmedAt: null, decidedAt: null, decisionNote: null, updatedAt: now })
    .where(and(eq(productMatches.orgId, orgId), eq(productMatches.status, 'accepted'), isNotNull(productMatches.autoConfirmedAt))).returning({ id: productMatches.id });
  await recordMatchEvents(db, orgId, rows.map((r) => r.id), 'auto_withdrawn', { note: 'Automatic confirmation was turned off for this workspace.' });
  return rows.length;
}

export interface EngineRunSummary {
  runId: string;
  engine: MatchingEngine;
  engineVersion: string;
  ms: number;
  rssMb: number;
  heapMb: number;
  sources: number;
  competitors: number;
  suggestions: number;
  sourcesWithSuggestion: number;
  byRelationship: Record<MatchRelationship, number>;
  byTier: Record<string, number>;
  candidatesLooked: number;
  droppedAsNonMatch: number;
  droppedReasons: Record<string, number>;
  corpus: Record<string, number>;
  persisted: PersistResult | null;
}

/** Records the run (always) and, unless this is a shadow run, applies the suggestions. A shadow run changes nothing a person can see. */
export async function runEngineOnInputs(db: DbLike, orgId: string, engine: MatchingEngine, sources: DossierInput[], competitors: DossierInput[], now: Date, opts: { autoConfirm?: boolean } = {}): Promise<{ summary: EngineRunSummary; result: EngineResult }> {
  const [run] = await db.insert(matchRuns).values({ orgId, engine, engineVersion: ENGINE_VERSION, startedAt: now }).returning({ id: matchRuns.id });
  const t0 = Date.now();
  try {
    const result = runEngine(sources, competitors);
    const persisted = engine === 'v2' ? await persistSuggestions(db, orgId, result.suggestions, now, { autoConfirm: opts.autoConfirm }) : null;
    const mem = process.memoryUsage();
    const summary: EngineRunSummary = {
      runId: run!.id, engine, engineVersion: ENGINE_VERSION, ms: Date.now() - t0, rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576),
      sources: result.stats.sources, competitors: result.stats.competitors, suggestions: result.stats.suggestions, sourcesWithSuggestion: result.stats.sourcesWithSuggestion,
      byRelationship: result.stats.byRelationship, byTier: result.stats.byTier, candidatesLooked: result.stats.candidatesLooked, droppedAsNonMatch: result.stats.droppedAsNonMatch,
      droppedReasons: Object.fromEntries(Object.entries(result.stats.droppedReasons).sort((a, b) => b[1] - a[1]).slice(0, 12)), corpus: { ...result.corpus.stats }, persisted,
    };
    await db.update(matchRuns).set({ finishedAt: new Date(), stats: summary as unknown as Record<string, unknown> }).where(eq(matchRuns.id, run!.id));
    return { summary, result };
  } catch (e) {
    await db.update(matchRuns).set({ finishedAt: new Date(), error: e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500) }).where(eq(matchRuns.id, run!.id));
    throw e;
  }
}

export { classOfRelationship, relationshipOfClass };
