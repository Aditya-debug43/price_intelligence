import { sql } from 'drizzle-orm';
import type { DbLike } from '@ci/database';
import { ActionNotPossibleError } from './workspace.ts';

export interface DataReadiness {
  activeSites: number;
  consentedSites: number;
  sourceSites: number;
  competitorSites: number;
  /** Products currently listed, by the role of the website they belong to. */
  sourceProducts: number;
  competitorProducts: number;
  confirmedSocialAccounts: number;
}

/** What actually exists in a workspace right now. Used to refuse actions that cannot do anything yet instead of pretending they worked. */
export async function loadReadiness(db: DbLike, orgId: string): Promise<DataReadiness> {
  const s = await db.execute<{ active: string; consented: string; source: string; competitor: string }>(sql`
    select count(*) filter (where active)::text as active,
           count(*) filter (where active and consent_status = 'confirmed')::text as consented,
           count(*) filter (where active and role = 'source')::text as source,
           count(*) filter (where active and role = 'competitor')::text as competitor
    from sites where org_id = ${orgId}`);
  const p = await db.execute<{ role: string; n: string }>(sql`
    select s.role, count(*)::text as n
    from products p join sites s on s.id = p.site_id
    where p.org_id = ${orgId} and p.delisted_at is null and s.active
    group by s.role`);
  const soc = await db.execute<{ n: string }>(sql`select count(*)::text as n from social_accounts where org_id = ${orgId} and confirmed`);
  const byRole = new Map(p.rows.map((r) => [r.role, Number(r.n)]));
  const row = s.rows[0];
  return {
    activeSites: Number(row?.active ?? 0),
    consentedSites: Number(row?.consented ?? 0),
    sourceSites: Number(row?.source ?? 0),
    competitorSites: Number(row?.competitor ?? 0),
    sourceProducts: byRole.get('source') ?? 0,
    competitorProducts: byRole.get('competitor') ?? 0,
    confirmedSocialAccounts: Number(soc.rows[0]?.n ?? 0),
  };
}

export function assertCanReport(r: DataReadiness): void {
  if (r.sourceProducts + r.competitorProducts === 0) {
    throw new ActionNotPossibleError(
      r.activeSites === 0
        ? 'There is nothing to report on yet. Add your website and your competitors first.'
        : 'Nothing has been collected yet, so there is nothing to report on. Record permission for your websites and run a collection first.',
      'nothing_to_report',
    );
  }
}

export function assertCanMatch(r: DataReadiness): void {
  if (r.sourceProducts === 0 || r.competitorProducts === 0) {
    throw new ActionNotPossibleError(
      r.sourceProducts === 0 ? 'Matching needs your own products first. Collect your website, then your competitors.' : 'Matching needs products from at least one competitor. Collect a competitor first.',
      'nothing_to_match',
    );
  }
}

export function assertCanSyncSocial(r: DataReadiness): void {
  if (r.confirmedSocialAccounts === 0) {
    throw new ActionNotPossibleError('No social accounts are confirmed yet. Add a competitor’s account in Settings → Integrations and confirm it is the right one.', 'no_social_accounts');
  }
}
