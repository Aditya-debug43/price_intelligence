import { Link, useNavigate } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatDateTime } from '@ci/shared';
import { api, errorMessage, orgPath } from '../api';
import { useOrg, useOrgMutation, useOrgQuery } from '../app-shell';
import { Age, ArrowIcon, Card, CapabilityPill, DataState, EmptyState, FixturePill, PageHead, SiteStatusPill, StandingBar, useToast } from '../ui';
import { JourneyCard } from '../journey';
import type { DashboardData } from '../types';

export function DashboardPage() {
  const { orgId, name, isAdmin } = useOrg();
  const nav = useNavigate();
  const toast = useToast();
  const q = useOrgQuery<DashboardData>('dashboard', '/dashboard', { refetchInterval: 15_000 });
  const hasSites = (q.data?.coverage.length ?? 0) > 0;
  const hasData = !!q.data?.coverage.some((c) => c.productsKnown > 0);
  const refresh = useOrgMutation((id) => api.post<{ started: unknown[]; skipped: { name: string; reason: string }[] }>(orgPath(id, '/refresh'), { limit: 25 }), ['dashboard', 'scans'], (r) =>
    toast.push(r.started.length ? `Collecting a small live sample from ${r.started.length} website(s).` : `Nothing to refresh: ${r.skipped[0]?.reason ?? 'no websites with recorded consent'}.`, !r.started.length),
  );
  const report = useOrgMutation((id) => api.post<{ report: { id: string } }>(orgPath(id, '/reports'), {}), ['reports', 'dashboard'], (r) => {
    toast.push('Building your report…');
    nav(`/o/${orgId}/reports/${r.report.id}`);
  });
  return (
    <>
      <PageHead
        eyebrow={name}
        title="Where you stand today"
        subtitle="Prices, stock risks, offers and competitor activity — each figure shows when it was observed and where it came from."
        actions={
          isAdmin && (
            <>
              <button className="btn" onClick={() => refresh.mutate(undefined)} disabled={refresh.isPending || !hasSites} title={hasSites ? 'Collects only a handful of products per website so you can see fresh data in seconds. Needs permission recorded for each website.' : 'Add your websites first.'}>
                {refresh.isPending ? 'Starting…' : 'Small live refresh'}
              </button>
              <button className="btn btn-primary" onClick={() => report.mutate(undefined)} disabled={report.isPending || !hasData} title={hasData ? undefined : 'Nothing has been collected yet, so there is nothing to report on.'}>Generate report now</button>
            </>
          )
        }
      />
      {(refresh.error || report.error) && <div className="callout bad" role="alert" style={{ marginBottom: 14 }}>{errorMessage(refresh.error ?? report.error)}</div>}
      <DataState q={q}>{(d) => <DashboardBody d={d} />}</DataState>
    </>
  );
}

function DashboardBody({ d }: { d: DashboardData }) {
  const { orgId, isAdmin } = useOrg();
  const r = d.latestReport;
  // An empty workspace shows the guided path, not made-up numbers.
  if (d.coverage.length === 0) return <JourneyCard />;
  const k = r?.kpis;
  const identical = k ? k.productsCheaperAtSource + k.productsPricierAtSource + k.productsAtParity : 0;
  return (
    <div className="stack">
      <JourneyCard compact />
      {r?.containsFixture && <div className="callout warn"><b>Demonstration data.</b> This workspace contains fixture sites — fictional data from local test websites, not live market prices.</div>}
      <div className="grid2" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
        <Card title={r ? `Price position — report of ${r.periodDate}` : 'Price position'} actions={r && <Link className="small" to={`/o/${orgId}/reports/${r.id}`}>Open report</Link>}>
          {r && k ? (
            <div className="stack">
              <StandingBar cheap={k.productsCheaperAtSource} par={k.productsAtParity} dear={k.productsPricierAtSource} />
              <div className="row small" style={{ gap: 18 }}>
                <span><i className="swatch" aria-hidden="true" style={{ background: 'var(--palm)' }} />Cheaper at your shop</span>
                <span><i className="swatch" aria-hidden="true" style={{ background: '#b9cac8' }} />About equal (±0.5%)</span>
                <span><i className="swatch" aria-hidden="true" style={{ background: 'var(--coral)' }} />Pricier at your shop</span>
              </div>
              <p style={{ margin: 0, fontSize: 15.5 }}>
                {identical > 0 ? (
                  <>Across <b>{identical}</b> confirmed identical product comparisons, competitors average <b>{k.averageDiffPct === null ? '—' : `${k.averageDiffPct > 0 ? '+' : ''}${k.averageDiffPct}%`}</b> versus your prices. {k.matchedProducts} of your {k.sourceProducts} products have at least one match.</>
                ) : (
                  <>No confirmed identical matches with comparable prices yet. Review pending matches or collect more data.</>
                )}
              </p>
              <div className="small muted">Generated {formatDateTime(r.generatedAt)} {r.isPartial && <span className="pill warn">partial</span>} {r.readyBeforeDeadline === false && <span className="pill bad">after the deadline</span>}</div>
            </div>
          ) : (
            <EmptyState title="No report yet" action={isAdmin ? <Link className="btn btn-primary" to={`/o/${orgId}/websites`}>Check websites and collect data</Link> : undefined}>
              Once at least one competitor has been collected and matched, your first report appears here. The daily report is built automatically before your deadline.
            </EmptyState>
          )}
        </Card>
        <Card title="Next report">
          {d.nextReport ? (
            <div className="stack-s">
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 20 }}>{formatDateTime(d.nextReport.deadlineAt, d.nextReport.timezone)}</div>
              <div className="small muted">{d.nextReport.timezone} · {d.nextReport.enabled ? 'scheduled' : <b>schedule switched off</b>}</div>
              <div className="small">Collection starts about <b>{formatDateTime(d.nextReport.plannedStartAt, d.nextReport.timezone)}</b>.</div>
              <div className="small muted">Start time = slowest site’s measured duration × safety margin + analysis time. {d.nextReport.basis}.</div>
            </div>
          ) : (
            <p className="muted">No schedule yet.</p>
          )}
        </Card>
      </div>

      {k && (
        <div className="kpis">
          <Kpi label="Active offers seen" value={k.activeOffers} to="offers" note="across all websites" />
          <Kpi label="Low-stock items" value={k.lowStockCount} to="stock" note="your shop" tone={k.lowStockCount ? 'warn' : undefined} />
          <Kpi label="Out of stock" value={k.outOfStockCount} to="stock" note="your shop" tone={k.outOfStockCount ? 'bad' : undefined} />
          <Kpi label="New competitor products" value={k.newCompetitorProducts} to="products" note="last 7 days" />
          <Kpi label="Marketing items seen" value={k.marketingItems} to="marketing" note="last 30 days" />
          <Kpi label="Matches to review" value={d.matchesNeedingReview} to="matches" note="not used for conclusions" tone={d.matchesNeedingReview ? 'warn' : undefined} />
        </div>
      )}

      <div className="grid2" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' }}>
        <Card title="Most important findings" pad={false} actions={r && <Link className="small" to={`/o/${orgId}/reports/${r.id}`}>All findings</Link>}>
          {r && r.topInsights.length ? (
            r.topInsights.map((i) => (
              <div className="insight" key={i.id}>
                <div className={`score ${i.severity}`} title={`Impact score ${i.score}`}>{Math.round(i.score)}</div>
                <div>
                  <h4>{i.title}</h4>
                  <p>{i.summary}</p>
                  <details className="ev">
                    <summary>{i.evidence.length} supporting record{i.evidence.length === 1 ? '' : 's'}</summary>
                    <ul>
                      {i.evidence.map((e, n) => (
                        <li key={n}>{e.label}{e.observedAt ? <> — <Age iso={e.observedAt} /></> : null}{e.url ? <> · <a href={e.url} target="_blank" rel="noreferrer noopener">source <ArrowIcon /></a></> : null}</li>
                      ))}
                    </ul>
                  </details>
                </div>
              </div>
            ))
          ) : (
            <div className="card-b"><EmptyState title="No findings yet">Findings appear once there is matched price data to analyse.</EmptyState></div>
          )}
        </Card>
        <div className="stack">
          <Card title="Recent alerts" pad={false} actions={<Link className="small" to={`/o/${orgId}/alerts`}>{d.alerts.unacknowledged} open</Link>}>
            {d.alerts.recent.length === 0 ? (
              <div className="card-b"><EmptyState title="No alerts">Low-stock, restock and collection problems show up here.</EmptyState></div>
            ) : (
              d.alerts.recent.slice(0, 6).map((a) => (
                <div className="insight" key={a.id} style={{ gridTemplateColumns: 'auto 1fr' }}>
                  <span className={`pill ${a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : 'info'}`}>{a.type.replace(/_/g, ' ')}</span>
                  <div>
                    <h4 style={{ fontWeight: a.acknowledgedAt ? 400 : 600 }}>{a.title}</h4>
                    <div className="small muted"><Age iso={a.createdAt} /></div>
                  </div>
                </div>
              ))
            )}
          </Card>
        </div>
      </div>

      <Card title="Websites — what we can see and how fresh it is" pad={false} actions={<Link className="small" to={`/o/${orgId}/websites`}>Manage websites</Link>}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Website</th><th>Status</th><th>Capability</th><th className="r">Products</th><th className="r">Stale</th><th>Coverage</th><th>What to do</th></tr></thead>
            <tbody>
              {d.coverage.map((c) => (
                <tr key={c.siteId}>
                  <td><Link to={`/o/${orgId}/websites/${c.siteId}`} className="title">{c.name}</Link> {c.isFixture && <FixturePill />}<div className="sub">{c.role === 'source' ? 'Your website' : 'Competitor'}</div></td>
                  <td><SiteStatusPill status={c.status} />{c.lastScanAt && <div className="sub">last collection <Age iso={c.lastScanAt} /></div>}</td>
                  <td><CapabilityPill status={c.capability} /></td>
                  <td className="r num">{c.productsKnown}</td>
                  <td className="r num">{c.productsStale ? <b style={{ color: 'var(--amber)' }}>{c.productsStale}</b> : 0}</td>
                  <td style={{ minWidth: 120 }}>{c.coveragePct === null ? <span className="muted small">unknown size</span> : <div title={`${c.productsKnown} of about ${c.estimatedCatalogue}`}><div className="progress"><div style={{ width: `${c.coveragePct}%` }} /></div><span className="small muted">{c.coveragePct}%</span></div>}</td>
                  <td className="small" style={{ maxWidth: 320 }}>{c.status?.nextAction ? <b>{c.status.nextAction}.</b> : null} {c.status?.detail ?? c.failureReason ?? c.warnings[0] ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {d.trend.filter((t) => t.averageDiffPct !== null).length >= 2 && (
        <Card title="Average competitor price versus yours, by report">
          <div className="chart-box" style={{ height: 220 }}>
            <ResponsiveContainer>
              <LineChart data={d.trend.filter((t) => t.averageDiffPct !== null)} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
                <CartesianGrid stroke="#e9efed" vertical={false} />
                <XAxis dataKey="periodDate" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} unit="%" />
                <ReferenceLine y={0} stroke="#10252b" />
                <Tooltip formatter={(v) => [`${v}%`, 'Competitors vs you']} />
                <Line type="monotone" dataKey="averageDiffPct" stroke="#0e6e73" strokeWidth={2.5} dot={{ r: 4, fill: '#ffd43b', stroke: '#10252b' }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="small muted" style={{ margin: 0 }}>Above zero: competitors charge more than you on average. Partial reports are included but cover fewer websites.</p>
        </Card>
      )}
    </div>
  );
}

function Kpi({ label, value, note, to, tone }: { label: string; value: number; note: string; to: string; tone?: 'warn' | 'bad' }) {
  const { orgId } = useOrg();
  return (
    <Link to={`/o/${orgId}/${to}`} className="kpi" style={{ textDecoration: 'none', color: 'inherit', borderTop: tone === 'bad' ? '3px solid var(--coral)' : tone === 'warn' ? '3px solid var(--tag)' : undefined }}>
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      <div className="d">{note}</div>
    </Link>
  );
}
