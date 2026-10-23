import { Link } from 'react-router-dom';
import { useOrgQuery } from './app-shell';
import type { DashboardData } from './types';

/** Competitor websites of the workspace that were NOT collected, with the reason — so an empty result is never mistaken for "nothing there". */
export function useUncollected(only?: string) {
  const dash = useOrgQuery<DashboardData>('dashboard', '/dashboard');
  return (dash.data?.coverage ?? []).filter((c) => c.role === 'competitor' && (only ? c.siteId === only : true) && c.status && c.status.state !== 'collected' && c.status.state !== 'partial' && c.status.state !== 'stale');
}

/** Competitor websites whose catalogue was read (completely, partly, or long ago). */
export function useCollectedCompetitors() {
  const dash = useOrgQuery<DashboardData>('dashboard', '/dashboard');
  return (dash.data?.coverage ?? []).filter((c) => c.role === 'competitor' && c.status && (c.status.state === 'collected' || c.status.state === 'partial' || c.status.state === 'stale'));
}

export function UncollectedList({ sites, orgId }: { sites: ReturnType<typeof useUncollected>; orgId: string }) {
  if (!sites.length) return null;
  return (
    <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
      {sites.map((c) => (
        <li key={c.siteId}>
          <Link to={`/o/${orgId}/websites/${c.siteId}`}>{c.name}</Link> — <b>{c.status!.label}</b>. {c.status!.nextAction ? `Next: ${c.status!.nextAction}.` : c.status!.detail}
        </li>
      ))}
    </ul>
  );
}
