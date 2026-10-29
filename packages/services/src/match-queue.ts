import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { productMatches, matchRuns, orgSettings, type DbLike } from '@ci/database';
import type { MatchingEngine } from '@ci/shared';

/**
 * The pairs that wait for a person: current (not set aside), not yet decided, and something a person can confirm as the same product, the same
 * product in another pack or a substitute. ("Related" and "not enough information" pairs are listed separately; they never count as work to do.)
 * `auto` is what the earlier engine called a pair it accepted itself; since nothing is accepted without a person, those wait too.
 */
export const awaitingReview = (orgId: string) =>
  and(eq(productMatches.orgId, orgId), inArray(productMatches.status, ['needs_review', 'auto']), isNull(productMatches.supersededAt), ne(productMatches.matchClass, 'not_comparable'));

export async function countAwaitingReview(db: DbLike, orgId: string): Promise<number> {
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(productMatches).where(awaitingReview(orgId));
  return n;
}

export interface MatchSummary {
  engine: MatchingEngine;
  lastRun: { id: string; engine: MatchingEngine; engineVersion: string | null; startedAt: string; finishedAt: string | null; error: string | null; stats: Record<string, unknown> } | null;
  counts: {
    /** Suggestions waiting for a person (same product, other pack, or substitute). */
    awaiting: number;
    /** The same waiting suggestions counted as product pairs (your product against one competitor product): a product with many variants is one item to look at. */
    awaitingProductPairs: number;
    /** Related products and pairs without enough information: kept for reference, never work to do. */
    unclear: number;
    confirmedSame: number;
    confirmedSubstitutes: number;
    confirmedRelated: number;
    rejected: number;
    /** Decided pairs whose products changed since. */
    needLookAgain: number;
    /** Suggestions the matcher set aside because it no longer proposes them. */
    setAside: number;
  };
  /** Your products, and the competitor products collected: the two sides a match joins. */
  catalogue: { yourProducts: number; competitorProducts: number; competitorWebsites: number };
  /**
   * What the empty states should say. `never_run`: matching has not run. `shadow`: the new matcher is being tested and has not been switched on. `no_candidates`: it ran and proposed nothing. `none_confirmed`: suggestions exist
   * and none has been confirmed. `ok`: something is confirmed.
   */
  state: 'no_competitors' | 'never_run' | 'shadow' | 'no_candidates' | 'none_confirmed' | 'ok';
  /** After a run: how many of your products have no suggestion at all (no reliable counterpart was found among the collected products). */
  withoutCounterpart: number | null;
}

export async function matchSummary(db: DbLike, orgId: string): Promise<MatchSummary> {
  const [settings] = await db.select({ e: orgSettings.matchingEngine }).from(orgSettings).where(eq(orgSettings.orgId, orgId));
  const engine = settings?.e ?? 'v1';
  const [run] = await db.select().from(matchRuns).where(eq(matchRuns.orgId, orgId)).orderBy(sql`${matchRuns.startedAt} desc`).limit(1);
  const c = await db.execute<Record<string, string>>(sql`
    select
      count(*) filter (where status in ('needs_review','auto') and superseded_at is null and match_class <> 'not_comparable')::text as awaiting,
      count(*) filter (where status in ('needs_review','auto') and superseded_at is null and match_class = 'not_comparable')::text as unclear,
      count(*) filter (where status = 'accepted' and match_class in ('identical','different_pack'))::text as confirmed_same,
      count(*) filter (where status = 'accepted' and match_class = 'comparable')::text as confirmed_substitutes,
      count(*) filter (where status = 'accepted' and match_class = 'not_comparable')::text as confirmed_related,
      count(*) filter (where status = 'rejected')::text as rejected,
      count(*) filter (where needs_reevaluation)::text as look_again,
      count(*) filter (where superseded_at is not null and status in ('needs_review','auto'))::text as set_aside
    from product_matches where org_id = ${orgId}`);
  const row = c.rows[0] ?? {};
  const n = (k: string) => Number(row[k] ?? 0);
  const pp = await db.execute<{ n: string }>(sql`
    select count(distinct (vs.product_id, vc.product_id))::text as n from product_matches m
    join variants vs on vs.id = m.source_variant_id join variants vc on vc.id = m.competitor_variant_id
    where m.org_id = ${orgId} and m.status in ('needs_review','auto') and m.superseded_at is null and m.match_class <> 'not_comparable'`);
  const cat = await db.execute<Record<string, string>>(sql`
    select count(*) filter (where s.role = 'source')::text as mine, count(*) filter (where s.role = 'competitor')::text as theirs, count(distinct s.id) filter (where s.role = 'competitor')::text as sites
    from variants v join products p on p.id = v.product_id join sites s on s.id = p.site_id
    where v.org_id = ${orgId} and s.active and p.delisted_at is null`);
  const k = cat.rows[0] ?? {};
  const counts = {
    awaiting: n('awaiting'), awaitingProductPairs: Number(pp.rows[0]?.n ?? 0), unclear: n('unclear'), confirmedSame: n('confirmed_same'), confirmedSubstitutes: n('confirmed_substitutes'), confirmedRelated: n('confirmed_related'),
    rejected: n('rejected'), needLookAgain: n('look_again'), setAside: n('set_aside'),
  };
  const catalogue = { yourProducts: Number(k['mine'] ?? 0), competitorProducts: Number(k['theirs'] ?? 0), competitorWebsites: Number(k['sites'] ?? 0) };
  const everyone = counts.awaiting + counts.unclear + counts.confirmedSame + counts.confirmedSubstitutes + counts.confirmedRelated + counts.rejected;
  const stats = (run?.stats ?? {}) as Record<string, unknown>;
  const state: MatchSummary['state'] =
    catalogue.competitorProducts === 0 ? 'no_competitors' : !run && everyone === 0 ? 'never_run' : everyone === 0 && engine === 'v2_shadow' ? 'shadow' : everyone === 0 ? 'no_candidates' : counts.confirmedSame + counts.confirmedSubstitutes === 0 ? 'none_confirmed' : 'ok';
  const withoutCounterpart = typeof stats['sources'] === 'number' && typeof stats['sourcesWithSuggestion'] === 'number' ? (stats['sources'] as number) - (stats['sourcesWithSuggestion'] as number) : null;
  return {
    engine,
    lastRun: run ? { id: run.id, engine: run.engine, engineVersion: run.engineVersion, startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null, error: run.error, stats } : null,
    counts, catalogue, state, withoutCounterpart,
  };
}

