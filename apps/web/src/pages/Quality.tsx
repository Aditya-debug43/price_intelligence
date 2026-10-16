import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useOrg, useOrgQuery } from '../app-shell';
import { Age, CapabilityPill, Card, DataState, FixturePill, PageHead } from '../ui';
import type { SiteCoverage } from '../types';

interface Q {
  coverage: SiteCoverage[];
  extraction: { siteId: string; method: string; products: number; avgQuality: number | null; missingPrice: number; missingCurrency: number }[];
  identifiers: { siteId: string; withGtin: number; total: number }[];
  recentProblems: { id: string; siteId: string; status: string; kind: string; errorCode: string | null; error: string | null; notes: string[]; createdAt: string; finishedAt: string | null; productsSaved: number }[];
  matchesNeedingReview: number;
}

export function QualityPage() {
  const { orgId } = useOrg();
  const q = useOrgQuery<Q>('quality', '/quality', { refetchInterval: 20_000 });
  return (
    <>
      <PageHead eyebrow="Reports" title="Data quality and coverage" subtitle="How complete, fresh and reliable the data behind every screen is — per website, per extraction method, and what went wrong recently." />
      <DataState q={q}>
        {(d) => {
          const name = (id: string) => d.coverage.find((c) => c.siteId === id)?.name ?? id;
          return (
            <div className="stack">
              <Card title="Coverage and freshness by website" pad={false}>
                <div className="table-wrap"><table className="table">
                  <thead><tr><th>Website</th><th>Capability</th><th className="r">Collected</th><th className="r">Estimated size</th><th className="r">Fresh</th><th className="r">Stale</th><th>Oldest → newest observation</th><th>Complete?</th></tr></thead>
                  <tbody>{d.coverage.map((c) => (
                    <tr key={c.siteId}>
                      <td><Link className="title" to={`/o/${orgId}/websites/${c.siteId}`}>{c.name}</Link> {c.isFixture && <FixturePill />}<div className="sub">{c.connector ?? 'no method yet'}</div></td>
                      <td><CapabilityPill status={c.capability} /></td>
                      <td className="r num">{c.productsKnown}</td>
                      <td className="r num">{c.estimatedCatalogue ?? '—'}{c.coveragePct !== null && <div className="sub">{c.coveragePct}%</div>}</td>
                      <td className="r num">{c.productsObservedFresh}</td>
                      <td className="r num">{c.productsStale ? <b style={{ color: 'var(--amber)' }}>{c.productsStale}</b> : 0}</td>
                      <td className="small"><Age iso={c.oldestObservation} /> → <Age iso={c.newestObservation} /></td>
                      <td>{c.complete ? <span className="pill good">complete</span> : c.failureReason ? <span className="pill bad">unavailable</span> : <span className="pill warn">partial</span>}<div className="sub" style={{ maxWidth: 320 }}>{c.failureReason ?? c.warnings[0] ?? ''}</div></td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </Card>

              <div className="grid2">
                <Card title="How products were read" pad={false}>
                  <table className="table">
                    <thead><tr><th>Website</th><th>Method</th><th className="r">Products</th><th className="r">Quality</th><th className="r">No price</th><th className="r">No currency</th></tr></thead>
                    <tbody>
                      {d.extraction.length === 0 && <tr><td colSpan={6} className="muted">Nothing collected yet.</td></tr>}
                      {d.extraction.map((e, i) => <tr key={i}><td>{name(e.siteId)}</td><td>{e.method.replace(/_/g, ' ')}</td><td className="r num">{e.products}</td><td className="r num">{e.avgQuality !== null ? `${Math.round(e.avgQuality * 100)}%` : '—'}</td><td className="r num">{e.missingPrice || ''}</td><td className="r num">{e.missingCurrency || ''}</td></tr>)}
                    </tbody>
                  </table>
                </Card>
                <Card title="Barcodes available (helps matching)">
                  {d.identifiers.length === 0 ? <p className="muted">No data yet.</p> : (
                    <div style={{ height: 220 }}>
                      <ResponsiveContainer>
                        <BarChart data={d.identifiers.map((i) => ({ name: name(i.siteId).slice(0, 18), withGtin: i.withGtin, without: i.total - i.withGtin }))} margin={{ left: -10, right: 8 }}>
                          <CartesianGrid vertical={false} stroke="#e9efed" />
                          <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                          <YAxis tick={{ fontSize: 12 }} />
                          <Tooltip />
                          <Bar dataKey="withGtin" name="With barcode" stackId="a" fill="#0e6e73" />
                          <Bar dataKey="without" name="Without" stackId="a" fill="#d8e1df" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                  <p className="small muted" style={{ margin: 0 }}>Without barcodes, matches rely on brand, name and size, so more of them wait for your review ({d.matchesNeedingReview} now).</p>
                </Card>
              </div>

              <Card title="Recent problems and partial runs" pad={false}>
                {d.recentProblems.length === 0 ? <div className="card-b"><p className="muted" style={{ margin: 0 }}>No failed, blocked or partial collections. </p></div> : (
                  <table className="table">
                    <thead><tr><th>When</th><th>Website</th><th>Outcome</th><th>What happened</th></tr></thead>
                    <tbody>{d.recentProblems.map((p) => (
                      <tr key={p.id}>
                        <td className="small"><Age iso={p.finishedAt ?? p.createdAt} /></td>
                        <td>{name(p.siteId)}</td>
                        <td><span className={`pill ${p.status === 'partial' ? 'warn' : 'bad'}`}>{p.status}</span><div className="sub">{p.kind}{p.productsSaved ? ` · ${p.productsSaved} saved` : ''}</div></td>
                        <td className="small" style={{ maxWidth: 560 }}>{p.error ?? p.notes[0] ?? p.errorCode ?? ''}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                )}
              </Card>
            </div>
          );
        }}
      </DataState>
    </>
  );
}
