import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useOrg, useOrgQuery } from '../app-shell';
import { Age, ArrowIcon, Card, DataState, EmptyState, PageHead } from '../ui';
import type { StockResponse } from '../types';

const STATE: Record<string, { label: string; cls: string }> = { out_of_stock: { label: 'Out of stock', cls: 'bad' }, low_stock: { label: 'Low stock', cls: 'warn' }, unknown: { label: 'Unknown', cls: '' }, in_stock: { label: 'In stock', cls: 'good' } };

export function StockPage() {
  const { orgId, isAdmin } = useOrg();
  const [all, setAll] = useState(false);
  const q = useOrgQuery<StockResponse>(['stock', all], `/stock?includeInStock=${all}`);
  return (
    <>
      <PageHead eyebrow="Your shop" title="My stock" subtitle="Low-stock, out-of-stock and unknown items on your own website. Exact unit counts appear only when they come from your authorised inventory connection or an explicit “only N left” statement on the site." />
      <DataState q={q}>
        {(d) => (
          <div className="stack">
            <div className={`callout ${d.mode === 'public' ? 'info' : d.connection?.syncHealth !== 'ok' ? 'warn' : 'good'}`}>
              <b>{d.mode === 'public' ? 'Public availability mode' : 'Connected inventory mode'}.</b> {d.explanation}{' '}
              {d.mode === 'public' && isAdmin && <Link to={`/o/${orgId}/settings?tab=integrations`}>Connect your store inventory</Link>}
              {d.connection?.lastSyncAt && <> Last sync <Age iso={d.connection.lastSyncAt} />.</>}
              {d.mode === 'authorised' && d.connection?.syncHealth === 'failed' && <> <b>The last sync failed{d.connection.lastError ? `: ${d.connection.lastError}` : ''}.</b> Quantities below may be out of date.</>}
              {d.mode === 'authorised' && d.connection?.syncHealth === 'stale' && <> <b>This sync is older than expected.</b> Quantities below may be out of date.</>}
              {d.mode === 'authorised' && d.connection?.syncHealth === 'never' && <> <b>No sync has completed yet.</b> No quantities are available until the first one does.</>}
            </div>
            <div className="kpis">
              <div className="kpi"><div className="k">Out of stock</div><div className="v" style={{ color: d.counts.out ? 'var(--coral)' : undefined }}>{d.counts.out}</div></div>
              <div className="kpi"><div className="k">Low stock (≤ {d.threshold})</div><div className="v" style={{ color: d.counts.low ? 'var(--amber)' : undefined }}>{d.counts.low}</div></div>
              <div className="kpi"><div className="k">Availability unknown</div><div className="v">{d.counts.unknown}</div></div>
              <div className="kpi"><div className="k">In stock</div><div className="v">{d.counts.in.toLocaleString('en-US')}</div><div className="d" title="A product can come in several variants (sizes, amounts…). Each variant is one item you can sell, and each has its own stock state.">of {d.total.toLocaleString('en-US')} items{d.products !== undefined && <> · {d.products.toLocaleString('en-US')} products</>}</div></div>
            </div>
            <div className="row"><label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /><span>Also list items that are in stock</span></label></div>
            {d.rows.length === 0 ? (
              <Card><EmptyState title={d.total === 0 ? 'No products collected yet' : 'Nothing needs attention'}>{d.total === 0 ? 'Collect your own website first, then stock states appear here.' : 'No low-stock, out-of-stock or unknown items right now.'}</EmptyState></Card>
            ) : (
              <Card pad={false}>
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Product</th><th>State</th><th className="r">Units</th><th>Basis</th><th className="r">Alert at</th><th>Observed</th><th>Since</th></tr></thead>
                    <tbody>
                      {d.rows.map((s) => (
                        <tr key={s.variantId}>
                          <td><Link className="title" to={`/o/${orgId}/products/${s.productId}`}>{s.title}</Link><div className="sub">{s.sku ?? 'no SKU'}</div></td>
                          <td><span className={`pill ${STATE[s.state]?.cls}`}>{STATE[s.state]?.label}</span></td>
                          <td className="r num" style={{ fontSize: 20 }}>{s.quantity ?? <span className="muted" title="Not published — never estimated">?</span>}</td>
                          <td className="small">{s.conflict && <div style={{ marginBottom: 6 }}><span className="pill warn" style={{ whiteSpace: 'normal' }}>page and inventory disagree</span><div className="sub">{s.note} <a href={s.url} target="_blank" rel="noreferrer noopener">Open the page <ArrowIcon /></a></div></div>}{s.quantitySource === 'authorised_inventory' ? 'Authorised inventory' : s.quantitySource === 'public_claim' ? 'Site says “only N left”' : (s.note ?? 'Public availability')}</td>
                          <td className="r num">{s.threshold}</td>
                          <td className="small">{s.stale && <span className="pill warn">stale </span>} <Age iso={s.observedAt} /></td>
                          <td className="small">{s.lastChangeAt ? <Age iso={s.lastChangeAt} /> : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>
        )}
      </DataState>
    </>
  );
}
