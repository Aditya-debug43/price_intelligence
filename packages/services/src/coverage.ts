import { desc, eq, sql } from 'drizzle-orm';
import type { SiteCoverage } from '@ci/shared';
import { deriveSiteStatus } from '@ci/core';
import { scanRuns, siteProfiles, sites, type DbLike } from '@ci/database';

/**
 * Per-site completeness and freshness. A failed or blocked collection is reported as such — never as a catalogue
 * with zero products — and partial coverage is always disclosed.
 */
export async function loadCoverage(db: DbLike, orgId: string, now: Date, staleAfterHours: number): Promise<SiteCoverage[]> {
  const siteRows = await db.select().from(sites).where(eq(sites.orgId, orgId));
  if (!siteRows.length) return [];
  const staleCutoff = new Date(now.getTime() - staleAfterHours * 3_600_000).toISOString();
  const stats = await db.execute<{ site_id: string; known: string; fresh: string; stale: string; newest: string | null; oldest: string | null }>(sql`
    select p.site_id,
      count(*)::text as known,
      count(*) filter (where lv.last_obs >= ${staleCutoff}::timestamptz)::text as fresh,
      count(*) filter (where lv.last_obs is null or lv.last_obs < ${staleCutoff}::timestamptz)::text as stale,
      max(lv.last_obs)::text as newest, min(lv.last_obs)::text as oldest
    from products p
    left join lateral (select max(v.observed_at) as last_obs from variants v where v.product_id = p.id) lv on true
    where p.org_id = ${orgId} and p.delisted_at is null
    group by p.site_id`);
  const statBy = new Map(stats.rows.map((r) => [r.site_id, r]));
  const runs = await db.select().from(scanRuns).where(eq(scanRuns.orgId, orgId)).orderBy(desc(scanRuns.createdAt)).limit(300);
  const profiles = await db.select().from(siteProfiles).where(eq(siteProfiles.orgId, orgId)).orderBy(desc(siteProfiles.createdAt)).limit(100);

  return siteRows.map((s) => {
    const st = statBy.get(s.id);
    const siteRuns = runs.filter((r) => r.siteId === s.id);
    const last = siteRuns.find((r) => r.status !== 'queued' && r.status !== 'cancelled') ?? siteRuns[0] ?? null;
    const lastGood = siteRuns.find((r) => r.status === 'succeeded' || (r.status === 'partial' && r.productsSaved > 0)) ?? null;
    const prof = profiles.find((p) => p.siteId === s.id);
    const known = Number(st?.known ?? 0);
    const stale = Number(st?.stale ?? 0);
    const fresh = Number(st?.fresh ?? 0);
    const estimated = siteRuns.find((r) => r.estimatedTotal !== null)?.estimatedTotal ?? prof?.data.catalogue.estimatedProducts ?? null;
    const failing = last && (last.status === 'failed' || last.status === 'blocked') && (!lastGood || (lastGood.finishedAt ?? lastGood.createdAt) < (last.finishedAt ?? last.createdAt));
    const warnings: string[] = [];
    const termsForbid = s.role === 'competitor' && !s.writtenPermission && prof?.data.terms?.level === 'prohibits_automation';
    if (termsForbid) warnings.push('Nothing was collected: the website’s terms of use forbid automated collection and no written permission from its owner is recorded.');
    else if (s.consentStatus !== 'confirmed') warnings.push('Collection has not started: the collection rules for this website are not confirmed yet.');
    if (!last && s.consentStatus === 'confirmed') warnings.push('No collection has run yet.');
    if (last?.status === 'partial') warnings.push(`The last collection was partial${last.errorCode === 'request_budget' ? ' (request budget)' : last.errorCode === 'deadline' ? ' (time limit)' : ''}; some products have older observations.`);
    if (last?.kind === 'sample') warnings.push('The last run was a small live sample, not a full refresh.');
    const newest = siteRuns[0];
    // siteRuns is ordered newest-first, so "newer than the last real collection" is simply an earlier index.
    if (newest?.status === 'cancelled' && newest.error && (!last || siteRuns.indexOf(newest) < siteRuns.indexOf(last))) {
      warnings.push(`The latest collection was cancelled (${newest.error.replace(/^Cancelled: /, '').toLowerCase()}); data shown is from the previous collection.`);
    }
    if (known > 0 && stale > 0) warnings.push(`${stale} of ${known} products have not been observed within ${staleAfterHours} h and are shown with their original observation time.`);
    if (estimated && known && known < estimated * 0.9) warnings.push(`Only ${known} of about ${estimated} products have been collected.`);
    if (s.capabilityStatus === 'limited') warnings.push('Capability is limited: only part of the analysis is possible for this site.');
    // A refresh that re-checked every known product counts as a complete cycle even though it did not re-enumerate the site.
    const complete = !!last && last.status === 'succeeded' && (last.isComplete || last.kind === 'refresh') && stale === 0 && !failing;
    const running = siteRuns.find((r) => r.status === 'queued' || r.status === 'running');
    const finished = siteRuns.find((r) => r.status !== 'queued' && r.status !== 'running');
    const noProducts = prof?.data.limitations.some((l) => l.code === 'catalogue_elsewhere' || l.code === 'not_a_shop')
      ? { storefrontUrl: prof.data.limitations.some((l) => l.code === 'catalogue_elsewhere') ? (prof.data.storefront?.url ?? null) : null }
      : null;
    const status = deriveSiteStatus({
      active: s.active,
      consentStatus: s.consentStatus,
      capability: s.capabilityStatus,
      hasUsableMethod: prof ? prof.data.strategy.primary !== null : null,
      productCount: known,
      lastRun: finished ? { status: finished.status, isComplete: finished.isComplete, kind: finished.kind, errorCode: finished.errorCode, error: finished.error } : null,
      collecting: !!running,
      termsForbid,
      noProducts,
      collectingProgress: running ? { saved: running.productsSaved, estimated: running.estimatedTotal } : null,
      newestObservationAt: st?.newest ? new Date(st.newest) : null,
      now,
      staleAfterHours,
    });
    return {
      status,
      consent: s.consentStatus,
      siteId: s.id,
      name: s.name,
      hostname: s.hostname,
      role: s.role,
      capability: s.capabilityStatus,
      connector: last?.connector ?? null,
      lastScanStatus: last?.status ?? null,
      lastScanAt: (last?.finishedAt ?? last?.createdAt)?.toISOString() ?? null,
      productsKnown: known,
      productsObservedFresh: fresh,
      productsStale: stale,
      estimatedCatalogue: estimated,
      coveragePct: estimated && estimated > 0 ? Math.min(100, Math.round((known / estimated) * 100)) : null,
      newestObservation: st?.newest ? new Date(st.newest).toISOString() : null,
      oldestObservation: st?.oldest ? new Date(st.oldest).toISOString() : null,
      complete,
      warnings,
      failureReason: failing ? (last!.error ?? 'The latest collection did not complete.') : null,
    } satisfies SiteCoverage;
  });
}
