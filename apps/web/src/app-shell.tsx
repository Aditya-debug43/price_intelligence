import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { ApiError, api, orgPath } from './api';
import type { DashboardData, Me, Meta } from './types';
import { Age, CapabilityPill, Icon, Spinner } from './ui';

// ───────────────────────────────────────────────────────────── session + metadata
export function useMe() {
  return useQuery<Me | null>({
    queryKey: ['me'],
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      try {
        return await api.get<Me>('/api/v1/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });
}

export function useMeta() {
  return useQuery<Meta>({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/api/v1/meta'), staleTime: 300_000 });
}

const OrgCtx = createContext<{ orgId: string; name: string; role: 'owner' | 'admin' | 'staff'; isAdmin: boolean } | null>(null);
export function useOrg() {
  const v = useContext(OrgCtx);
  if (!v) throw new Error('useOrg outside an organisation route');
  return v;
}

/** Org-scoped GET. The key includes the org so switching workspaces never shows another workspace's cache. */
export function useOrgQuery<T>(key: string | unknown[], path: string, opts: Partial<Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>> = {}) {
  const { orgId } = useOrg();
  return useQuery<T>({ queryKey: ['org', orgId, ...(Array.isArray(key) ? key : [key])], queryFn: () => api.get<T>(orgPath(orgId, path)), ...opts });
}

export function useOrgMutation<TVars, TRes>(fn: (orgId: string, vars: TVars) => Promise<TRes>, invalidate: (string | unknown[])[] = [], onDone?: (res: TRes, vars: TVars) => void) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  return useMutation<TRes, Error, TVars>({
    mutationFn: (vars) => fn(orgId, vars),
    onSuccess: (res, vars) => {
      for (const k of invalidate) void qc.invalidateQueries({ queryKey: ['org', orgId, ...(Array.isArray(k) ? k : [k])] });
      onDone?.(res, vars);
    },
  });
}

// ───────────────────────────────────────────────────────────── layout
const NAV: { label: string; items: { to: string; label: string; icon: string; end?: boolean }[] }[] = [
  {
    label: 'Overview',
    items: [
      { to: '', label: 'Dashboard', icon: 'dashboard', end: true },
      { to: 'alerts', label: 'Alerts', icon: 'bell' },
    ],
  },
  {
    label: 'Market',
    items: [
      { to: 'prices', label: 'Price comparison', icon: 'prices' },
      { to: 'offers', label: 'Offers & flyers', icon: 'offers' },
      { to: 'marketing', label: 'Marketing activity', icon: 'megaphone' },
      { to: 'products', label: 'Products', icon: 'stock' },
      { to: 'matches', label: 'Match review', icon: 'scale' },
    ],
  },
  {
    label: 'Your shop',
    items: [{ to: 'stock', label: 'My stock', icon: 'stock' }],
  },
  {
    label: 'Reports',
    items: [
      { to: 'reports', label: 'Reports', icon: 'report' },
      { to: 'quality', label: 'Data quality', icon: 'quality' },
    ],
  },
  {
    label: 'Set up',
    items: [
      { to: 'websites', label: 'Websites', icon: 'globe' },
      { to: 'settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

export function OrgLayout() {
  const { orgId } = useParams();
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const m = me.data?.memberships.find((x) => x.orgId === orgId);
  const logout = useMutation({
    mutationFn: () => api.post('/api/v1/auth/logout'),
    onSuccess: async () => {
      qc.clear();
      nav('/login');
    },
  });
  if (me.isLoading) return <div style={{ padding: 40 }}><Spinner label="Loading your workspace" /></div>;
  if (!me.data) return <NavigateToLogin />;
  if (!m || !orgId) return <WorkspaceNotFound />;
  return (
    <OrgCtx.Provider value={{ orgId, name: m.name, role: m.role, isAdmin: m.role !== 'staff' }}>
      <div className="shell">
        <Sidebar name={m.name} role={m.role} user={me.data.user.displayName} onLogout={() => logout.mutate()} workspaces={me.data.memberships} />
        <div className="main">
          <HonestyBar />
          <main className="page" id="main">
            <Outlet />
          </main>
        </div>
      </div>
    </OrgCtx.Provider>
  );
}

function NavigateToLogin() {
  const nav = useNavigate();
  queueMicrotask(() => nav('/login', { replace: true }));
  return null;
}

function WorkspaceNotFound() {
  return (
    <div className="page">
      <div className="callout bad" role="alert">
        <b>Workspace not found.</b> It may have been removed, or your account doesn’t have access. <Link to="/">Go to your workspaces</Link>
      </div>
    </div>
  );
}

function Sidebar({ name, role, user, onLogout, workspaces }: { name: string; role: string; user: string; onLogout: () => void; workspaces: Me['memberships'] }) {
  const { orgId } = useParams();
  const nav = useNavigate();
  const dash = useQuery<DashboardData>({ queryKey: ['org', orgId, 'dashboard'], queryFn: () => api.get<DashboardData>(orgPath(orgId!, '/dashboard')), refetchInterval: 20_000 });
  const unack = dash.data?.alerts.unacknowledged ?? 0;
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]); // on small screens the menu closes after choosing a page
  return (
    <aside className="sidebar" aria-label="Main navigation" data-open={open}>
      <div className="sidebar-head">
      <Link to={`/o/${orgId}`} className="brand">
        <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="6" fill="#ffd43b" />
          <rect x="5" y="8" width="22" height="16" rx="2" fill="#10252b" />
          <rect x="8" y="11" width="9" height="3.5" fill="#ffd43b" />
          <rect x="8" y="17" width="16" height="3.5" fill="#0e6e73" />
        </svg>
        <span className="brand-name">Shelfwatch</span>
      </Link>
      <button type="button" className="menu-toggle" aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Menu'}{!open && unack > 0 && <span className="nav-badge">{unack}</span>}</button>
      </div>
      <div className="sidebar-body" id="site-nav">
      {workspaces.length > 1 && (
        <select aria-label="Switch workspace" value={orgId} onChange={(e) => nav(`/o/${e.target.value}`)} style={{ background: '#1b3a42', color: '#fff', borderColor: '#35545c' }}>
          {workspaces.map((w) => (
            <option key={w.orgId} value={w.orgId}>
              {w.name}
            </option>
          ))}
        </select>
      )}
      {NAV.map((g) => (
        <div className="nav-group" key={g.label}>
          <div className="nav-label">{g.label}</div>
          {g.items.map((i) => (
            <NavLink key={i.to} to={`/o/${orgId}/${i.to}`.replace(/\/$/, '')} end={i.end} className="nav-link">
              <Icon name={i.icon} />
              {i.label}
              {i.to === 'alerts' && unack > 0 && <span className="nav-badge">{unack}</span>}
              {i.to === 'matches' && (dash.data?.matchesNeedingReview ?? 0) > 0 && <span className="nav-badge" style={{ background: '#e0a116', color: '#10252b' }}>{dash.data!.matchesNeedingReview}</span>}
            </NavLink>
          ))}
        </div>
      ))}
      <div className="side-foot">
        <b>{name}</b>
        {user} · {role}
        <br />
        <button onClick={onLogout}>Sign out</button>
      </div>
      </div>
    </aside>
  );
}

/** Always-visible statement of how complete and how fresh the data behind the current screen is. */
function HonestyBar() {
  const { orgId } = useOrg();
  const q = useQuery<DashboardData>({ queryKey: ['org', orgId, 'dashboard'], queryFn: () => api.get<DashboardData>(orgPath(orgId, '/dashboard')), refetchInterval: 20_000 });
  const d = q.data;
  if (!d) return <div className="honesty"><Spinner label="Checking data freshness" /></div>;
  const collecting = d.coverage.filter((c) => c.lastScanStatus !== null);
  const complete = d.coverage.filter((c) => c.complete).length;
  const problems = d.coverage.filter((c) => c.status ? c.status.severity === 'bad' : !!c.failureReason || c.capability === 'blocked' || c.capability === 'failed').length;
  const level = d.coverage.length === 0 ? 'idle' : problems ? 'bad' : complete === d.coverage.length ? '' : 'warn';
  return (
    <div className="honesty" role="region" aria-label="Data coverage and freshness">
      <span className="item">
        <span className={`dot ${level}`} aria-hidden="true" />
        {d.coverage.length === 0 ? (
          <span>No websites yet — <Link to={`/o/${orgId}/setup`}>set up your business</Link></span>
        ) : (
          <span>
            <b>{complete}</b> of {d.coverage.length} websites complete{problems ? <>, <b style={{ color: 'var(--coral)' }}>{problems} need{problems === 1 ? 's' : ''} attention</b></> : null}
          </span>
        )}
      </span>
      {collecting.length > 0 && (
        <span className="item" title="The oldest observation across all collected products">
          Data from <Age iso={d.freshness.oldest} /> to <Age iso={d.freshness.newest} />
          {d.freshness.staleProducts > 0 && <span className="pill warn">{d.freshness.staleProducts} stale</span>}
        </span>
      )}
      {d.activeScans.length > 0 && (
        <span className="item"><Spinner /> Collecting from {d.activeScans.length} website{d.activeScans.length === 1 ? '' : 's'}…</span>
      )}
      {d.latestReport?.isPartial && <span className="pill warn" title={d.latestReport.warnings[0]}>Latest report is partial</span>}
      <span className="spacer" />
      <Link to={`/o/${orgId}/quality`}>Data quality</Link>
    </div>
  );
}

export function Gate({ children, need }: { children: ReactNode; need?: 'admin' }) {
  const org = useOrg();
  if (need === 'admin' && !org.isAdmin) return <div className="callout warn">Only owners and admins can do this.</div>;
  return <>{children}</>;
}

export { CapabilityPill };
