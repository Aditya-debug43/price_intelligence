import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatDateTime, formatMoney } from '@ci/shared';
import { api, orgPath, qs } from '../api';
import { useOrg, useOrgMutation, useOrgQuery } from '../app-shell';
import { Age, ArrowIcon, Card, DataState, EmptyState, PageHead, Pager, ProvenancePill, useToast } from '../ui';
import { UncollectedList, useCollectedCompetitors, useUncollected } from '../uncollected';

interface ProductRow { variantId: string; productId: string; siteId: string; siteName: string; role: string; title: string; variantTitle: string | null; brand: string | null; category: string | null; price: number | null; compareAt: number | null; currency: string | null; availability: string; observedAt: string | null; url: string; sku: string | null; gtin: string | null; sizeLabel: string | null; method: string; firstSeenAt: string; stale: boolean; }


export function ProductsPage() {
  const { orgId } = useOrg();
  const [sp, setSp] = useSearchParams();
  const get = (k: string, d = '') => sp.get(k) ?? d;
  const set = (patch: Record<string, string>) => {
    const n = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v === '') n.delete(k);
      else n.set(k, v);
    }
    if (!('page' in patch)) n.delete('page');
    setSp(n, { replace: true });
  };
  const page = Number(get('page', '1'));
  const params = { siteId: get('siteId'), q: get('q'), matched: get('matched'), stale: get('stale'), delisted: get('delisted'), page, pageSize: 40 };
  const sites = useOrgQuery<{ sites: { id: string; name: string; role: string }[] }>('site-names', '/site-names');
  const q = useOrgQuery<{ rows: ProductRow[]; total: number }>(['products', params], `/products${qs(params)}`, { placeholderData: (p) => p });
  const unreadSite = useUncollected(params.siteId || undefined);
  const onlyThisSite = !!params.siteId && !params.q && !params.matched && !params.stale && !params.delisted;
  return (
    <>
      <PageHead eyebrow="Market" title="Products" subtitle="Everything collected from your website and your competitors, with the last time each price was seen." />
      <div className="filters">
        <div className="field wide"><label htmlFor="p-q">Search</label><input id="p-q" type="search" defaultValue={params.q} onKeyDown={(e) => e.key === 'Enter' && set({ q: (e.target as HTMLInputElement).value })} onBlur={(e) => e.target.value !== params.q && set({ q: e.target.value })} placeholder="Product name" /></div>
        <div className="field"><label htmlFor="p-s">Website</label><select id="p-s" value={params.siteId} onChange={(e) => set({ siteId: e.target.value })}><option value="">All websites</option>{sites.data?.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div className="field"><label htmlFor="p-m">Matching</label><select id="p-m" value={params.matched} onChange={(e) => set({ matched: e.target.value })}><option value="">All</option><option value="yes">Has a match</option><option value="no">No match found</option></select></div>
        <div className="field"><label htmlFor="p-f">Freshness</label><select id="p-f" value={params.stale} onChange={(e) => set({ stale: e.target.value })}><option value="">Any</option><option value="true">Stale only</option></select></div>
        <div className="field"><label htmlFor="p-d">Listing</label><select id="p-d" value={params.delisted} onChange={(e) => set({ delisted: e.target.value })}><option value="">Currently listed</option><option value="true">Apparently delisted</option></select></div>
      </div>
      <DataState q={q} isEmpty={(d) => d.total === 0} empty={<Card>{onlyThisSite && unreadSite.length ? <EmptyState title={`${unreadSite[0]!.name} has not been collected`}>{unreadSite[0]!.status!.detail}<UncollectedList sites={unreadSite} orgId={orgId} /></EmptyState> : <EmptyState title="No products found">Collect a website from the Websites page, or relax the filters.</EmptyState>}</Card>}>
        {(d) => (
          <Card pad={false}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Product</th><th>Website</th><th className="r">Price</th><th>Stock</th><th>Identifiers</th><th>Last seen</th><th>Read with</th></tr></thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.variantId}>
                      <td><Link className="title" to={`/o/${orgId}/products/${r.productId}`}>{r.title}</Link>{r.variantTitle && <span className="muted"> — {r.variantTitle}</span>}<div className="sub">{[r.brand, r.sizeLabel, r.category].filter(Boolean).join(' · ')}</div></td>
                      <td>{r.siteName}<div className="sub">{r.role === 'source' ? 'your shop' : 'competitor'}</div></td>
                      <td className="r num" style={{ fontSize: 18 }}>{r.price === null ? <span className="muted" title="No price was found — never treated as zero">—</span> : <>{r.compareAt && <s className="muted" style={{ fontSize: 13 }}>{r.compareAt.toFixed(2)} </s>}{r.price.toFixed(2)}<small className="muted"> {r.currency ?? '?'}</small></>}</td>
                      <td><span className={`pill ${r.availability === 'in_stock' ? 'good' : r.availability === 'out_of_stock' ? 'bad' : r.availability === 'unknown' ? '' : 'warn'}`}>{r.availability.replace(/_/g, ' ')}</span></td>
                      <td className="small">{r.gtin ?? ''}{r.gtin && r.sku ? ' · ' : ''}{r.sku ?? (r.gtin ? '' : '—')}</td>
                      <td className="small">{r.stale && <span className="pill warn">stale </span>} <Age iso={r.observedAt} /></td>
                      <td className="small"><a href={r.url} target="_blank" rel="noreferrer noopener">{r.method} <ArrowIcon /></a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageSize={params.pageSize} total={d.total} onPage={(p) => set({ page: String(p) })} />
          </Card>
        )}
      </DataState>
    </>
  );
}

interface Detail {
  product: { id: string; title: string; brand: string | null; category: string | null; description: string | null; canonicalUrl: string; siteName: string; role: string; extractionMethod: string; extractionVersion: string; firstSeenAt: string; lastSeenAt: string; delistedAt: string | null; attrs: { quality?: { score: number; missingFields: string[]; notes: string[] } } };
  variants: { id: string; title: string | null; sku: string | null; gtin: string | null; price: number | null; compareAtPrice: number | null; currency: string | null; availability: string; observedAt: string | null; url: string; stale: boolean; qtyLabel: string | null; lowStockThreshold: number | null; quantity: number | null; quantitySource: string | null; stock: { state: string; quantity: number | null } | null }[];
  priceHistory: { id: string; variantId: string; observedAt: string; price: number | null; compareAtPrice: number | null; currency: string | null; availability: string; sourceUrl: string; method: string; evidenceId: string | null; }[];
  matches: { id: string; matchClass: string; confidence: number; status: string; method: string; reasons: string[]; thisSideIsSource: boolean; other: { id: string; title: string; variantTitle: string | null; siteName: string; price: number | null; currency: string | null; availability: string; observedAt: string | null; url: string; productId: string } | null }[];
  offers: { id: string; title: string; kind: string; originalPrice: number | null; salePrice: number | null; currency: string | null; claimedDiscountPct: number | null; verification: string; status: string; firstSeenAt: string; lastSeenAt: string }[];
  evidence: { id: string; url: string; fetchedAt: string; httpStatus: number | null; contentHash: string; snippet: string | null; method: string | null; version: string | null; provenance?: string; snapshotAvailable: boolean; snapshotPurgedAt: string | null; }[];
}

export function ProductDetailPage() {
  const { productId = '' } = useParams();
  const { orgId, isAdmin } = useOrg();
  const q = useOrgQuery<Detail>(['product', productId], `/products/${productId}`);
  const toast = useToast();
  const [thr, setThr] = useState<Record<string, string>>({});
  const setThreshold = useOrgMutation((id, v: { variantId: string; threshold: number | null }) => api.put(orgPath(id, `/variants/${v.variantId}/threshold`), { threshold: v.threshold }), [['product', productId], 'stock'], () => toast.push('Threshold saved.'));
  return (
    <DataState q={q}>
      {(d) => <Body d={d} orgId={orgId} isAdmin={isAdmin} thr={thr} setThr={setThr} onSave={(variantId, threshold) => setThreshold.mutate({ variantId, threshold })} />}
    </DataState>
  );
}

function NoMatches({ orgId }: { orgId: string }) {
  const unread = useUncollected();
  const read = useCollectedCompetitors();
  return (
    <EmptyState title="No matches">
      {read.length ? `No equivalent product was found in the competitor websites that were collected (${read.map((c) => c.name).join(', ')}).` : 'No competitor website has been collected yet, so no equivalent could be looked for.'}
      {unread.length > 0 && <> These websites were <b>not</b> looked at, so this says nothing about them:</>}
      <UncollectedList sites={unread} orgId={orgId} />
    </EmptyState>
  );
}

function Body({ d, orgId, isAdmin, thr, setThr, onSave }: { d: Detail; orgId: string; isAdmin: boolean; thr: Record<string, string>; setThr: (t: Record<string, string>) => void; onSave: (variantId: string, threshold: number | null) => void }) {
  const p = d.product;
  const series = useMemo(() => {
    const byDay = new Map<string, Record<string, number | string>>();
    for (const h of [...d.priceHistory].reverse()) {
      if (h.price === null) continue;
      const day = h.observedAt.slice(0, 16).replace('T', ' ');
      const row = byDay.get(day) ?? { t: day };
      const v = d.variants.find((x) => x.id === h.variantId);
      row[v?.title ?? 'Price'] = h.price;
      byDay.set(day, row);
    }
    return [...byDay.values()];
  }, [d]);
  const lines = [...new Set(d.variants.map((v) => v.title ?? 'Price'))];
  return (
    <>
      <PageHead
        eyebrow={`${p.role === 'source' ? 'Your product' : 'Competitor product'} · ${p.siteName}`}
        docTitle={p.title}
        title={<>{p.title}</>}
        subtitle={<><a href={p.canonicalUrl} target="_blank" rel="noreferrer noopener">Open the product page <ArrowIcon /></a>{p.brand ? ` · ${p.brand}` : ''}{p.category ? ` · ${p.category}` : ''}{p.delistedAt && <span className="pill bad" style={{ marginLeft: 8 }}>apparently delisted {formatDateTime(p.delistedAt)}</span>}</>}
      />
      <div className="stack">
        <Card title="Variants and current prices" pad={false}>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Variant</th><th className="r">Price</th><th>Availability</th><th>Identifiers</th><th>Stock alert</th><th>Last seen</th></tr></thead>
            <tbody>{d.variants.map((v) => (
              <tr key={v.id}>
                <td>{v.title ?? 'Default'}<div className="sub">{v.qtyLabel ?? ''}</div></td>
                <td className="r num" style={{ fontSize: 20 }}>{v.price === null ? <span className="muted">—</span> : <>{v.compareAtPrice && <s className="muted" style={{ fontSize: 14 }}>{v.compareAtPrice.toFixed(2)} </s>}{v.price.toFixed(2)} <small className="muted">{v.currency ?? '?'}</small></>}</td>
                <td><span className={`pill ${v.availability === 'in_stock' ? 'good' : v.availability === 'out_of_stock' ? 'bad' : ''}`}>{v.availability.replace(/_/g, ' ')}</span>{v.stock && p.role === 'source' && <div className="sub">state: {v.stock.state.replace(/_/g, ' ')}{v.stock.quantity !== null ? ` · ${v.stock.quantity} units` : ''}</div>}{v.stock && p.role === 'source' && v.stock.quantity !== null && ((v.stock.quantity > 0 && v.availability === 'out_of_stock') || (v.stock.quantity <= 0 && v.availability === 'in_stock')) && <div className="pill warn" style={{ whiteSpace: 'normal', marginTop: 4 }}>The public page and your inventory disagree</div>}</td>
                <td className="small">{v.gtin ?? '—'}<br />{v.sku ?? ''}</td>
                <td>{p.role === 'source' && isAdmin ? (
                  <div className="row" style={{ gap: 4 }}>
                    <input type="number" min={0} aria-label="Per-product low-stock threshold" placeholder="default" style={{ width: 80 }} value={thr[v.id] ?? (v.lowStockThreshold ?? '')} onChange={(e) => setThr({ ...thr, [v.id]: e.target.value })} />
                    <button className="btn btn-sm" onClick={() => onSave(v.id, thr[v.id] === '' || thr[v.id] === undefined ? null : Number(thr[v.id]))}>Save</button>
                  </div>
                ) : <span className="muted small">{p.role === 'source' ? 'default' : 'not applicable'}</span>}</td>
                <td className="small">{v.stale && <span className="pill warn">stale </span>} <Age iso={v.observedAt} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        </Card>

        <Card title="Price history">
          {series.length < 2 ? <EmptyState title="Not enough history yet">History builds with every collection. Each observation keeps its time, source page and extraction method.</EmptyState> : (
            <div style={{ height: 260 }}>
              <ResponsiveContainer>
                <LineChart data={series} margin={{ top: 8, right: 16, bottom: 0, left: -6 }}>
                  <CartesianGrid stroke="#e9efed" vertical={false} />
                  <XAxis dataKey="t" tick={{ fontSize: 11 }} />
                  <YAxis domain={['auto', 'auto']} tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Legend />
                  {lines.map((l, i) => <Line key={l} type="stepAfter" dataKey={l} stroke={['#0e6e73', '#d9482b', '#8a5a05', '#5b2f9a'][i % 4]} strokeWidth={2.4} dot={{ r: 3 }} connectNulls />)}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <div className="grid2">
          <Card title="Matches" pad={false}>
            {d.matches.length === 0 ? <div className="card-b"><NoMatches orgId={orgId} /></div> : (
              <table className="table"><thead className="sr-only"><tr><th>Equivalent product</th><th>Match</th></tr></thead><tbody>{d.matches.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.other ? <Link className="title" to={`/o/${orgId}/products/${m.other.productId}`}>{m.other.title}</Link> : '—'}
                    <div className="sub">{m.other?.siteName} · {m.other?.price !== null && m.other?.price !== undefined ? formatMoney(m.other.price, m.other.currency) : 'no price'}</div>
                    <div className="small muted">{m.reasons.join(' · ')}</div>
                  </td>
                  <td><span className="pill info">{m.matchClass.replace('_', ' ')}</span><div className="sub">{Math.round(m.confidence * 100)}% · {m.status.replace('_', ' ')}</div></td>
                </tr>
              ))}</tbody></table>
            )}
          </Card>
          <Card title="Offers on this product" pad={false}>
            {d.offers.length === 0 ? <div className="card-b"><EmptyState title="No offers">No sale price has been seen on this product.</EmptyState></div> : (
              <table className="table"><tbody>{d.offers.map((o) => <tr key={o.id}><td>{o.title}<div className="sub">first <Age iso={o.firstSeenAt} /> · last <Age iso={o.lastSeenAt} /></div></td><td className="num">{o.originalPrice !== null && <s className="muted">{o.originalPrice.toFixed(2)}</s>} <b>{o.salePrice?.toFixed(2)}</b></td><td><span className={`pill ${o.verification === 'verified' ? 'good' : o.verification === 'contradicted' ? 'bad' : ''}`}>{o.verification.replace('_', ' ')}</span><div className="sub">{o.status}</div></td></tr>)}</tbody></table>
            )}
          </Card>
        </div>

        <Card title="Evidence — where these numbers came from" pad={false}>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Fetched</th><th>Page</th><th>Method</th><th>Source type</th><th>Content hash</th><th>What supported the value</th><th /></tr></thead>
            <tbody>
              {d.evidence.length === 0 && <tr><td colSpan={6} className="muted">No evidence records.</td></tr>}
              {d.evidence.map((e) => (
                <tr key={e.id}>
                  <td className="small">{formatDateTime(e.fetchedAt)}<div className="sub">HTTP {e.httpStatus ?? '—'}</div></td>
                  <td className="small" style={{ maxWidth: 240, wordBreak: 'break-all' }}><a href={e.url} target="_blank" rel="noreferrer noopener">{e.url}</a></td>
                  <td className="small">{e.method ?? '—'} {e.version}</td>
                  <td><ProvenancePill value={e.provenance} /></td>
                  <td className="small mono">{e.contentHash.slice(0, 12)}…</td>
                  <td className="small" style={{ maxWidth: 360 }}><code style={{ wordBreak: 'break-all' }}>{e.snippet?.slice(0, 200)}</code></td>
                  <td className="small">{e.snapshotAvailable ? <a href={`/api/v1/orgs/${orgId}/evidence/${e.id}/snapshot`} download>raw snapshot ↓</a> : <span className="muted">{e.snapshotPurgedAt ? 'snapshot expired (retention)' : 'no snapshot'}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>

        {p.attrs.quality && (
          <Card title="Extraction quality">
            <div className="small">Method <b>{p.extractionMethod}</b> v{p.extractionVersion} · completeness score <b>{Math.round(p.attrs.quality.score * 100)}%</b>{p.attrs.quality.missingFields.length > 0 && <> · missing: {p.attrs.quality.missingFields.join(', ')}</>}{p.attrs.quality.notes.length > 0 && <div className="muted">{p.attrs.quality.notes.join(' · ')}</div>}</div>
          </Card>
        )}
      </div>
    </>
  );
}
