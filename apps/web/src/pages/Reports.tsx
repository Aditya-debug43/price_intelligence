import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { formatDateTime, formatMoney, formatPct, type ReportData } from '@ci/shared';
import { api, orgPath } from '../api';
import { useOrg, useOrgMutation, useOrgQuery } from '../app-shell';
import { MarketingSummaryCard } from '../social';
import { Age, ArrowIcon, CapabilityPill, Card, DataState, EmptyState, Icon, PageHead, Pct, PriceTag, SourceLink, StandingBar, Tabs, useDocumentTitle, useToast } from '../ui';
import type { ReportListItem, ReportRecord } from '../types';

const STATUS: Record<string, { label: string; cls: string }> = {
  ready: { label: 'Ready', cls: 'good' },
  partial: { label: 'Partial', cls: 'warn' },
  generating: { label: 'Generating…', cls: 'info' },
  failed: { label: 'Failed', cls: 'bad' },
};

// ───────────────────────────────────────────────────────────── list
export function ReportsPage() {
  const { orgId, isAdmin } = useOrg();
  const nav = useNavigate();
  const toast = useToast();
  const q = useOrgQuery<{ reports: ReportListItem[] }>('reports', '/reports', {
    refetchInterval: (query) => (query.state.data?.reports.some((r) => r.status === 'generating') ? 3000 : 30_000),
  });
  const gen = useOrgMutation((id, _: void) => api.post<{ report: { id: string } }>(orgPath(id, '/reports')), ['reports'], (r) => {
    toast.push('Report started. It opens when it is ready.');
    nav(`/o/${orgId}/reports/${r.report.id}`);
  });
  const [cmpA, setCmpA] = useState('');
  const [cmpB, setCmpB] = useState('');
  const finished = q.data?.reports.filter((r) => r.status === 'ready' || r.status === 'partial') ?? [];
  return (
    <>
      <PageHead
        eyebrow="Reports"
        title="Historical reports"
        subtitle="Every report is a saved snapshot. Opening or exporting it later shows exactly what it showed on the day — later collections never rewrite it."
        actions={isAdmin ? <button className="btn btn-primary" onClick={() => gen.mutate(undefined)} disabled={gen.isPending}><Icon name="report" /> Generate a report now</button> : undefined}
      />
      {gen.error && <div className="callout bad" role="alert" style={{ marginBottom: 12 }}>{gen.error.message}</div>}
      <DataState q={q} isEmpty={(d) => d.reports.length === 0} empty={<Card><EmptyState title="No reports yet">The daily report is prepared automatically so it is ready at the time you set in Settings. You can also generate one now once at least one website has been collected.</EmptyState></Card>}>
        {(d) => (
          <div className="stack">
            <Card pad={false}>
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Report</th><th>Status</th><th>Prepared</th><th>Deadline</th><th>Summary</th><th /></tr></thead>
                <tbody>{d.reports.map((r) => {
                  const st = STATUS[r.status] ?? { label: r.status, cls: '' };
                  return (
                    <tr key={r.id}>
                      <td><Link className="title" to={`/o/${orgId}/reports/${r.id}`}>{r.periodDate}</Link><div className="sub">{r.kind === 'scheduled' ? 'Daily (scheduled)' : 'Generated on request'}</div></td>
                      <td><span className={`pill ${st.cls}`}>{st.label}</span>{r.isPartial && r.status !== 'partial' && <span className="pill warn">partial</span>}</td>
                      <td className="small">{r.generatedAt ? formatDateTime(r.generatedAt) : '—'}</td>
                      <td className="small">{r.deadlineAt ? (r.readyBeforeDeadline === null ? formatDateTime(r.deadlineAt) : r.readyBeforeDeadline ? <span className="pill good">on time</span> : <span className="pill warn">after the deadline</span>) : '—'}</td>
                      <td className="small" style={{ maxWidth: 440 }}>{r.summaryText ?? ''}</td>
                      <td className="r">{(r.status === 'ready' || r.status === 'partial') && <ExportMenu orgId={orgId} reportId={r.id} compact />}</td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            </Card>

            {finished.length >= 2 && (
              <Card title="Compare two reports">
                <div className="row" style={{ alignItems: 'flex-end' }}>
                  <div className="field"><label htmlFor="cmp-a">Earlier</label><select id="cmp-a" value={cmpA} onChange={(e) => setCmpA(e.target.value)}><option value="">Choose…</option>{finished.map((r) => <option key={r.id} value={r.id}>{r.periodDate}{r.isPartial ? ' (partial)' : ''}</option>)}</select></div>
                  <div className="field"><label htmlFor="cmp-b">Later</label><select id="cmp-b" value={cmpB} onChange={(e) => setCmpB(e.target.value)}><option value="">Choose…</option>{finished.map((r) => <option key={r.id} value={r.id}>{r.periodDate}{r.isPartial ? ' (partial)' : ''}</option>)}</select></div>
                  <Link className={`btn btn-primary${!cmpA || !cmpB || cmpA === cmpB ? ' disabled' : ''}`} aria-disabled={!cmpA || !cmpB || cmpA === cmpB} to={`/o/${orgId}/reports/compare?a=${cmpA}&b=${cmpB}`} onClick={(e) => (!cmpA || !cmpB || cmpA === cmpB) && e.preventDefault()}>Compare</Link>
                </div>
              </Card>
            )}
          </div>
        )}
      </DataState>
    </>
  );
}

function ExportMenu({ orgId, reportId, compact }: { orgId: string; reportId: string; compact?: boolean }) {
  const base = `/api/v1/orgs/${orgId}/reports/${reportId}/export`;
  const [ds, setDs] = useState('comparison');
  return (
    <span className="row" style={{ gap: 6, justifyContent: compact ? 'flex-end' : undefined }}>
      <a className="btn btn-sm" href={`${base}?format=pdf`} download><Icon name="download" /> PDF</a>
      <a className="btn btn-sm" href={`${base}?format=xlsx`} download><Icon name="download" /> Excel</a>
      {!compact && (
        <>
          <label className="sr-only" htmlFor={`ds-${reportId}`}>CSV dataset</label>
          <select id={`ds-${reportId}`} value={ds} onChange={(e) => setDs(e.target.value)} style={{ width: 'auto' }}>
            {['comparison', 'offers', 'stock', 'marketing', 'marketing_summary', 'insights', 'coverage', 'assortment'].map((d) => <option key={d} value={d}>{d[0]!.toUpperCase() + d.slice(1).replace('_', ' ')}</option>)}
          </select>
        </>
      )}
      <a className="btn btn-sm" href={`${base}?format=csv&dataset=${compact ? 'comparison' : ds}`} download><Icon name="download" /> CSV</a>
    </span>
  );
}

// ───────────────────────────────────────────────────────────── single report
type Tab = 'insights' | 'prices' | 'offers' | 'stock' | 'marketing' | 'assortment' | 'basket' | 'coverage';

export function ReportViewPage() {
  const { reportId = '' } = useParams();
  const { orgId } = useOrg();
  const q = useOrgQuery<{ report: ReportRecord }>(['report', reportId], `/reports/${reportId}`, {
    refetchInterval: (query) => (query.state.data?.report.status === 'generating' ? 2500 : false),
  });
  return (
    <DataState q={q}>
      {({ report }) => {
        if (report.status === 'generating') return <><PageHead eyebrow="Reports" title="Preparing the report…" subtitle="Collecting the latest data into a snapshot. This page updates by itself." /><Card><div className="row"><span className="spinner" aria-label="Generating" /> This usually takes under a minute.</div></Card></>;
        if (report.status === 'failed' || !report.data) return <><PageHead eyebrow="Reports" title="This report could not be created" /><div className="callout bad" role="alert"><b>What went wrong:</b> {report.error ?? 'No data was saved for this report.'} <Link to={`/o/${orgId}/reports`}>Back to reports</Link></div></>;
        return <ReportBody report={report} data={report.data} orgId={orgId} />;
      }}
    </DataState>
  );
}

function ReportBody({ report, data, orgId }: { report: ReportRecord; data: ReportData; orgId: string }) {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab | null) ?? 'insights';
  const setTab = (t: Tab) => { const n = new URLSearchParams(sp); n.set('tab', t); setSp(n, { replace: true }); };
  const m = data.meta;
  const k = data.kpis;
  const reporting = m.reportingCurrency;
  const identical = data.comparisons.filter((r) => r.position !== 'no_data');
  const standing = useMemo(() => ({ cheap: k.productsCheaperAtSource, par: k.productsAtParity, dear: k.productsPricierAtSource }), [k]);
  return (
    <>
      <PageHead
        eyebrow={`Report · ${m.orgName}`}
        docTitle={`Report ${m.periodDate}${m.isPartial ? ' (partial)' : ''}`}
        title={<>{m.periodDate} {m.isPartial && <span className="pill warn" style={{ fontSize: 14 }}>Partial</span>}</>}
        subtitle={<>Prepared {formatDateTime(m.generatedAt)} ({m.timezone}).{m.deadlineAt && m.readyBeforeDeadline !== null && <> {m.readyBeforeDeadline ? 'Ready before' : 'Finished after'} the {formatDateTime(m.deadlineAt)} target.</>} Saved snapshot — it will not change.</>}
        actions={<ExportMenu orgId={orgId} reportId={report.id} />}
      />
      <div className="stack">
        {data.warnings.length > 0 && (
          <div className="callout warn" role="note"><b>Read this first.</b><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{data.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
        )}
        <Card>
          <h2 style={{ margin: '0 0 10px', fontFamily: 'var(--display)', fontSize: 22 }}>{data.headline}</h2>
          {data.aiSummary && (
            <div className="callout info" style={{ marginBottom: 10 }}>
              <b>AI-written summary</b> <span className="muted small">({data.aiSummary.provider}; every number was checked against the records{data.aiSummary.validated ? '' : ' — not validated'})</span>
              <p style={{ margin: '6px 0 0' }}>{data.aiSummary.text}</p>
            </div>
          )}
          <div className="kpis">
            <Kpi label="Your products matched" value={k.matchedProducts} sub={`${k.identicalMatches} identical-product comparisons`} />
            <Kpi label="Cheaper at your shop" value={k.productsCheaperAtSource} sub="comparisons, identical products" />
            <Kpi label="Pricier at your shop" value={k.productsPricierAtSource} sub="comparisons, identical products" />
            <Kpi label="Average price gap" value={k.averageDiffPct === null ? '—' : formatPct(k.averageDiffPct)} sub="competitor vs you, identical only" />
            <Kpi label="Active offers" value={k.activeOffers} sub="at all websites" />
            <Kpi label="Low / out of stock" value={`${k.lowStockCount} / ${k.outOfStockCount}`} sub="your shop only" />
            <Kpi label="New competitor products" value={k.newCompetitorProducts} sub="not in your shop" />
            <Kpi label="Marketing items" value={k.marketingItems} sub="observed, not proven paid" />
          </div>
          <div style={{ marginTop: 14 }}><StandingBar cheap={standing.cheap} par={standing.par} dear={standing.dear} /></div>
        </Card>

        <Tabs value={tab} onChange={setTab} tabs={[
          { id: 'insights', label: `Insights (${data.insights.length})` },
          { id: 'prices', label: `Prices (${data.comparisons.length})` },
          { id: 'offers', label: `Offers (${data.offers.length})` },
          { id: 'stock', label: `My stock (${data.stock.length})` },
          { id: 'marketing', label: `Marketing (${data.marketing.length})` },
          { id: 'assortment', label: 'Assortment' },
          { id: 'basket', label: 'Basket' },
          { id: 'coverage', label: 'Coverage' },
        ]} />

        {tab === 'insights' && (
          data.insights.length === 0 ? <Card><EmptyState title="No insights in this report">Insights appear when there are enough confirmed matches, offers or stock changes to say something supported by the data.</EmptyState></Card> : (
            <Card pad={false}>
              {data.insights.map((i) => (
                <div className="insight" key={i.id}>
                  <span className={`pill ${i.severity === 'critical' ? 'bad' : i.severity === 'warning' ? 'warn' : 'info'}`}>{i.type.replace(/_/g, ' ')}</span>
                  <div>
                    <h4>{i.title}</h4>
                    <p>{i.summary}</p>
                    <details className="ev">
                      <summary>Evidence and how the score was built</summary>
                      <ul>{i.evidence.map((e, n) => <li key={n}>{e.label}{e.observedAt && <> — <Age iso={e.observedAt} /></>}{e.url && <> <a href={e.url} target="_blank" rel="noreferrer noopener">source <ArrowIcon /></a></>}</li>)}</ul>
                      <div className="small muted">Score {i.score.toFixed(0)}/100 = {Object.entries(i.scoreBreakdown).map(([a, b]) => `${a} ${typeof b === 'number' ? b.toFixed(2) : b}`).join(' · ')}</div>
                    </details>
                  </div>
                  <span className={`score ${i.severity}`} title="Priority score out of 100">{i.score.toFixed(0)}</span>
                </div>
              ))}
            </Card>
          )
        )}

        {tab === 'prices' && (
          identical.length === 0 && data.comparisons.length === 0 ? <Card><EmptyState title="No price comparisons in this report">No products were matched between your shop and a competitor when this report was prepared.</EmptyState></Card> : (
            <Card pad={false}>
              <div className="table-wrap"><table className="table" style={{ minWidth: 700 }}>
                <thead><tr><th>Your product</th><th style={{ minWidth: 165 }}>You</th><th>Competitors</th></tr></thead>
                <tbody>{data.comparisons.slice(0, 150).map((row) => (
                  <tr key={row.sourceVariantId}>
                    <td><div className="title">{row.title}</div><div className="sub">{[row.brand, row.sizeLabel].filter(Boolean).join(' · ')}</div></td>
                    <td><PriceTag you site="Your shop" price={row.sourcePrice} unit={row.sourceUnitPrice} reporting={reporting} availability={row.sourceAvailability} href={row.url ?? null} product={row.title} /></td>
                    <td><div className="row" style={{ alignItems: 'flex-start' }}>{row.cells.map((c) => <div key={c.variantId} style={{ width: 170 }}><PriceTag site={c.siteName} price={c.price} unit={c.unitPrice} diffPct={c.diffPct} unitDiffPct={c.unitDiffPct} directlyComparable={c.directlyComparable} reporting={reporting} matchLabel={`${c.matchClass === 'identical' ? 'same' : c.matchClass === 'different_pack' ? 'pack' : 'similar'} ${Math.round(c.confidence * 100)}%`} availability={c.availability} offer={c.offerSummary} href={c.url ?? null} product={c.title} /></div>)}</div></td>
                  </tr>
                ))}</tbody>
              </table></div>
              {data.comparisons.length > 150 && <div className="pager"><span>Showing the first 150 of {data.comparisons.length}. Export to see all rows.</span></div>}
            </Card>
          )
        )}

        {tab === 'offers' && (
          data.offers.length === 0 ? <Card><EmptyState title="No offers in this report" /></Card> : (
            <Card pad={false}><div className="table-wrap"><table className="table">
              <thead><tr><th>Website</th><th>Offer</th><th className="r">Was → now</th><th>Discount</th><th>Valid</th><th>Status</th></tr></thead>
              <tbody>{data.offers.slice(0, 200).map((o) => (
                <tr key={o.id}>
                  <td>{o.siteName}<div className="sub">{o.siteRole === 'source' ? 'your shop' : 'competitor'}</div></td>
                  <td style={{ maxWidth: 360 }}><div className="title">{o.title}</div><div className="sub">{o.kind.replace(/_/g, ' ')}{o.conditional ? ' · conditional' : ''}</div></td>
                  <td className="r num">{o.originalPrice !== null && <s className="muted">{o.originalPrice.toFixed(2)}</s>} {o.salePrice !== null ? <b>{o.salePrice.toFixed(2)}</b> : ''} <small className="muted">{o.currency}</small></td>
                  <td className="small">{o.claimedDiscountPct !== null ? <>claimed {o.claimedDiscountPct}%</> : '—'}<div><span className={`pill ${o.verification === 'verified' ? 'good' : o.verification === 'contradicted' ? 'bad' : ''}`}>{o.verification.replace(/_/g, ' ')}</span></div></td>
                  <td className="small">{o.validTo ? `until ${formatDateTime(o.validTo)}` : 'no end date shown'}</td>
                  <td><span className="pill">{o.status}</span></td>
                </tr>
              ))}</tbody>
            </table></div></Card>
          )
        )}

        {tab === 'stock' && (
          data.stock.length === 0 ? <Card><EmptyState title="Nothing to report on stock">No low-stock or out-of-stock products at your shop when this report was prepared.</EmptyState></Card> : (
            <Card pad={false}><div className="table-wrap"><table className="table">
              <thead><tr><th>Product</th><th>State</th><th className="r">Quantity</th><th>Last seen</th></tr></thead>
              <tbody>{data.stock.map((s) => (
                <tr key={s.variantId}>
                  <td><div className="title">{s.title}</div><div className="sub">{[s.variantTitle, s.sku].filter(Boolean).join(' · ')}</div><SourceLink href={s.url ?? null} product={s.title} /></td>
                  <td><span className={`pill ${s.state === 'low_stock' ? 'warn' : s.state === 'out_of_stock' ? 'bad' : s.state === 'in_stock' ? 'good' : ''}`}>{s.state.replace(/_/g, ' ')}</span><div className="sub" style={s.conflict ? { color: 'var(--amber)' } : undefined}>{s.note}</div></td>
                  <td className="r num">{s.quantity === null ? <span className="muted" title="Public websites don't reveal exact quantities">not available</span> : <>{s.quantity} <small className="muted">of threshold {s.threshold}</small></>}</td>
                  <td className="small">{s.stale && <span className="pill warn">stale </span>} <Age iso={s.observedAt} /></td>
                </tr>
              ))}</tbody>
            </table></div></Card>
          )
        )}

        {tab === 'marketing' && data.marketingSummary && <MarketingSummaryCard summary={data.marketingSummary} />}
        {tab === 'marketing' && (
          data.marketing.length === 0 ? <Card><EmptyState title="No marketing activity observed" /></Card> : (
            <Card pad={false}><table className="table"><tbody>{data.marketing.map((x) => (
              <tr key={x.id}><td>{x.siteName}<div className="sub">{x.platform}</div></td><td style={{ maxWidth: 480 }}><div className="title">{x.title ?? x.kind}</div><div className="sub">{x.excerpt?.slice(0, 200)}</div></td><td className="small"><span className="pill info">{x.classification.replace(/_/g, ' ')}</span><div className="sub">paid status not determined</div></td><td className="small"><Age iso={x.firstSeenAt} /></td><td>{x.url && <a href={x.url} target="_blank" rel="noreferrer noopener">open <ArrowIcon /></a>}</td></tr>
            ))}</tbody></table></Card>
          )
        )}

        {tab === 'assortment' && (
          <div className="stack">
            <div className={`callout ${data.assortment.basis && (!data.assortment.basis.competitorsComplete || !data.assortment.basis.sourceComplete) ? 'warn' : 'info'}`}>{data.assortment.note}</div>
            <div className="grid2">
              <Card title={`At competitors, no equivalent found at your shop (${data.assortment.competitorOnly.length})`} pad={false}>
                <table className="table"><tbody>{data.assortment.competitorOnly.slice(0, 60).map((a) => <tr key={a.variantId}><td><div className="title">{a.title}</div><div className="sub">{a.siteName}{a.category ? ` · ${a.category}` : ''}</div><SourceLink href={a.url ?? null} product={a.title} /></td><td className="r num">{a.price !== null ? formatMoney(a.price, a.currency) : '—'}</td></tr>)}</tbody></table>
              </Card>
              <Card title={`At your shop, no equivalent found at competitors (${data.assortment.sourceOnly.length})`} pad={false}>
                <table className="table"><tbody>{data.assortment.sourceOnly.slice(0, 60).map((a) => <tr key={a.variantId}><td><div className="title">{a.title}</div><div className="sub">{a.category}</div><SourceLink href={a.url ?? null} product={a.title} /></td><td className="r num">{a.price !== null ? formatMoney(a.price, a.currency) : '—'}</td></tr>)}</tbody></table>
              </Card>
            </div>
          </div>
        )}

        {tab === 'basket' && (
          data.basket.length === 0 ? <Card><EmptyState title="No basket comparison">A basket needs several confirmed identical products with current prices at both websites.</EmptyState></Card> : (
            <Card pad={false}><table className="table">
              <thead><tr><th>Competitor</th><th className="r">Products compared</th><th className="r">Your total</th><th className="r">Their total</th><th className="r">Difference</th><th>Coverage</th></tr></thead>
              <tbody>{data.basket.map((b) => (
                <tr key={b.siteId}>
                  <td>{b.siteName}<div className="sub">{b.note}</div></td>
                  <td className="r num">{b.itemsAvailableInBoth}<small className="muted"> of {b.itemsCompared}</small></td>
                  <td className="r num">{b.sourceTotal !== null ? formatMoney(b.sourceTotal, b.currency) : '—'}</td>
                  <td className="r num">{b.competitorTotal !== null ? formatMoney(b.competitorTotal, b.currency) : '—'}</td>
                  <td className="r"><Pct value={b.diffPct} /></td>
                  <td className="small">{b.coveragePct}%</td>
                </tr>
              ))}</tbody>
            </table></Card>
          )
        )}

        {tab === 'coverage' && (
          <div className="stack">
            <Card title="Websites in this report" pad={false}>
              <table className="table">
                <thead><tr><th>Website</th><th>Capability</th><th className="r">Products</th><th className="r">Stale</th><th>Newest data</th><th>Complete?</th></tr></thead>
                <tbody>{data.sites.map((s) => (
                  <tr key={s.siteId}>
                    <td>{s.name}<div className="sub">{s.role === 'source' ? 'your shop' : 'competitor'} · {s.connector ?? 'no method'}</div></td>
                    <td><CapabilityPill status={s.capability} /></td>
                    <td className="r num">{s.productsKnown}</td>
                    <td className="r num">{s.productsStale || ''}</td>
                    <td className="small"><Age iso={s.newestObservation} /></td>
                    <td>{s.complete ? <span className="pill good">complete</span> : s.failureReason ? <span className="pill bad">unavailable</span> : <span className="pill warn">partial</span>}<div className="sub" style={{ maxWidth: 360 }}>{s.failureReason ?? s.warnings[0] ?? ''}</div></td>
                  </tr>
                ))}</tbody>
              </table>
            </Card>
            {data.fx.length > 0 && <Card title="Exchange rates used"><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{data.fx.map((f, i) => <li key={i}>1 {f.from} = {f.rate.toFixed(4)} {f.to} — {f.source}{f.isFixed ? ' (fixed peg)' : ''}, {formatDateTime(f.fetchedAt)}</li>)}</ul>{data.fx.some((f) => f.source.includes('open.er-api.com')) && <p className="small muted" style={{ margin: '8px 0 0' }}><a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer noopener">Rates By Exchange Rate API</a></p>}</Card>}
            {data.integrations.length > 0 && <Card title="Integrations at the time of this report" pad={false}><table className="table"><tbody>{data.integrations.map((i) => <tr key={i.provider}><td style={{ textTransform: 'capitalize' }}>{i.provider}</td><td><span className="pill">{i.status.replace(/_/g, ' ')}</span></td><td className="small">{i.message}</td></tr>)}</tbody></table></Card>}
          </div>
        )}
      </div>
    </>
  );
}

function Kpi({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="kpi">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      {sub && <div className="d">{sub}</div>}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── compare two
interface Cmp {
  comparison: {
    a: { periodDate: string; generatedAt: string; isPartial: boolean };
    b: { periodDate: string; generatedAt: string; isPartial: boolean };
    kpiDelta: { key: string; a: number | null; b: number | null; delta: number | null }[];
    priceChanges: { title: string; site: string; role: string; a: number | null; b: number | null; currency: string; changePct: number | null }[];
    offers: { new: string[]; ended: string[] };
    insights: { new: { title: string; score: number }[]; resolved: { title: string; score: number }[] };
    notes: string[];
  };
}

const KPI_LABEL: Record<string, string> = { matchedProducts: 'Products matched', identicalMatches: 'Identical matches', productsCheaperAtSource: 'Cheaper at your shop', productsPricierAtSource: 'Pricier at your shop', productsAtParity: 'About equal', averageDiffPct: 'Average price gap (%)', activeOffers: 'Active offers', lowStockCount: 'Low stock', outOfStockCount: 'Out of stock', newCompetitorProducts: 'New competitor products', marketingItems: 'Marketing items', sourceProducts: 'Your products', competitorProducts: 'Competitor products' };

export function ComparePage() {
  const { orgId } = useOrg();
  const [sp] = useSearchParams();
  const a = sp.get('a') ?? '';
  const b = sp.get('b') ?? '';
  const q = useOrgQuery<Cmp>(['report-compare', a, b], `/reports/compare?a=${a}&b=${b}`, { enabled: !!a && !!b });
  useDocumentTitle('Compare reports');
  if (!a || !b) return <><PageHead eyebrow="Reports" title="Compare two reports" /><EmptyState title="Choose two reports">Pick an earlier and a later report on the <Link to={`/o/${orgId}/reports`}>reports page</Link>.</EmptyState></>;
  return (
    <>
      <PageHead eyebrow="Reports" title="Compare two reports" subtitle="Both snapshots are read exactly as they were saved, so this comparison gives the same answer every time." actions={<Link className="btn" to={`/o/${orgId}/reports`}>Back to reports</Link>} />
      <DataState q={q}>
        {({ comparison: c }) => (
          <div className="stack">
            {c.notes.map((n, i) => <div key={i} className="callout warn">{n}</div>)}
            <Card title={`${c.a.periodDate}  →  ${c.b.periodDate}`} pad={false}>
              <table className="table">
                <thead><tr><th>Measure</th><th className="r">{c.a.periodDate}</th><th className="r">{c.b.periodDate}</th><th className="r">Change</th></tr></thead>
                <tbody>{c.kpiDelta.map((k) => <tr key={k.key}><td>{KPI_LABEL[k.key] ?? k.key}</td><td className="r num">{k.a ?? '—'}</td><td className="r num">{k.b ?? '—'}</td><td className="r num" style={{ color: k.delta ? (k.delta > 0 ? 'var(--palm)' : 'var(--coral)') : undefined }}>{k.delta === null ? '—' : k.delta > 0 ? `+${k.delta}` : k.delta}</td></tr>)}</tbody>
              </table>
            </Card>
            <Card title={`Price changes (${c.priceChanges.length})`} pad={false}>
              {c.priceChanges.length === 0 ? <div className="card-b muted">No product changed price between the two snapshots.</div> : (
                <div className="table-wrap"><table className="table">
                  <thead><tr><th>Product</th><th>Website</th><th className="r">Before</th><th className="r">After</th><th className="r">Change</th></tr></thead>
                  <tbody>{c.priceChanges.slice(0, 100).map((p, i) => <tr key={i}><td>{p.title}</td><td>{p.site}{p.role === 'source' && <span className="pill"> you</span>}</td><td className="r num">{p.a?.toFixed(2)}</td><td className="r num">{p.b?.toFixed(2)} <small className="muted">{p.currency}</small></td><td className="r"><Pct value={p.changePct} invert /></td></tr>)}</tbody>
                </table></div>
              )}
            </Card>
            <div className="grid2">
              <Card title={`New offers (${c.offers.new.length})`}><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{c.offers.new.length ? c.offers.new.map((o, i) => <li key={i}>{o}</li>) : <li className="muted">None</li>}</ul></Card>
              <Card title={`Offers that ended (${c.offers.ended.length})`}><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{c.offers.ended.length ? c.offers.ended.map((o, i) => <li key={i}>{o}</li>) : <li className="muted">None</li>}</ul></Card>
              <Card title={`New insights (${c.insights.new.length})`}><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{c.insights.new.length ? c.insights.new.map((o, i) => <li key={i}>{o.title}</li>) : <li className="muted">None</li>}</ul></Card>
              <Card title={`No longer present (${c.insights.resolved.length})`}><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{c.insights.resolved.length ? c.insights.resolved.map((o, i) => <li key={i}>{o.title}</li>) : <li className="muted">None</li>}</ul></Card>
            </div>
          </div>
        )}
      </DataState>
    </>
  );
}
