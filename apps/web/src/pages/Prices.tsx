import { Link, useSearchParams } from 'react-router-dom';
import { formatDateTime } from '@ci/shared';
import { qs } from '../api';
import { useOrg, useOrgQuery } from '../app-shell';
import { Card, DataState, EmptyState, PageHead, Pager, PriceTag, SiteStatusPill } from '../ui';
import type { ComparisonResponse } from '../types';
import { UncollectedList, useCollectedCompetitors, useUncollected } from '../uncollected';

const PAGE_SIZE = 25;

export function PricesPage() {
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
  const params = { q: get('q'), category: get('category'), siteId: get('siteId'), matchClass: get('matchClass'), review: get('review', 'confirmed'), minConfidence: get('minConfidence'), freshness: get('freshness', 'any'), sort: get('sort', 'title'), dir: get('dir', 'asc'), page, pageSize: PAGE_SIZE };
  const q = useOrgQuery<ComparisonResponse>(['comparison', params], `/comparison${qs(params)}`, { placeholderData: (prev) => prev });
  const d = q.data;
  // pairs that only look alike wait for a person; by default this page shows confirmed matches only, and says how many are not shown
  const waiting = useOrgQuery<{ total: number }>(['matches', 'waiting-count'], '/matches?status=needs_review&pageSize=1');
  const unread = useUncollected();
  const readCompetitors = useCollectedCompetitors();
  const competitors = d?.facets.competitors ?? [];
  const shownSites = params.siteId ? competitors.filter((c) => c.id === params.siteId) : competitors;
  const reporting = d?.reportingCurrency ?? 'USD';

  return (
    <>
      <PageHead
        eyebrow="Market"
        title="Price comparison"
        subtitle={<>One row per product you sell. Each tag shows the price as the website displays it, how it compares after conversion to <b>{reporting}</b>, and when it was last seen.</>}
        actions={<Link className="btn" to={`/o/${orgId}/matches`}>Review matches</Link>}
      />
      <div className="filters" role="search">
        <div className="field wide"><label htmlFor="f-q">Search products</label><input id="f-q" type="search" placeholder="e.g. ketchup, Heinz" defaultValue={params.q} onKeyDown={(e) => e.key === 'Enter' && set({ q: (e.target as HTMLInputElement).value })} onBlur={(e) => e.target.value !== params.q && set({ q: e.target.value })} /></div>
        <div className="field"><label htmlFor="f-c">Category</label><select id="f-c" value={params.category} onChange={(e) => set({ category: e.target.value })}><option value="">All categories</option>{d?.facets.categories.map((c) => <option key={c}>{c}</option>)}</select></div>
        <div className="field"><label htmlFor="f-s">Competitor</label><select id="f-s" value={params.siteId} onChange={(e) => set({ siteId: e.target.value })}><option value="">All competitors</option>{competitors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div className="field"><label htmlFor="f-m">Match type</label><select id="f-m" value={params.matchClass} onChange={(e) => set({ matchClass: e.target.value })}><option value="">All</option><option value="identical">Identical product</option><option value="different_pack">Different pack size</option><option value="comparable">Comparable product</option></select></div>
        <div className="field"><label htmlFor="f-r">Match review</label><select id="f-r" value={params.review} onChange={(e) => set({ review: e.target.value })}><option value="any">Any</option><option value="confirmed">Confirmed</option><option value="needs_review">Needs review</option></select></div>
        <div className="field"><label htmlFor="f-f">Freshness</label><select id="f-f" value={params.freshness} onChange={(e) => set({ freshness: e.target.value })}><option value="any">Any</option><option value="fresh">Fresh only</option><option value="stale">Stale only</option></select></div>
        <div className="field"><label htmlFor="f-o">Sort by</label><select id="f-o" value={`${params.sort}:${params.dir}`} onChange={(e) => { const [s, dir] = e.target.value.split(':'); set({ sort: s!, dir: dir! }); }}>
          <option value="title:asc">Product A–Z</option><option value="gap:desc">Largest price gap</option><option value="gap:asc">Smallest price gap</option><option value="confidence:asc">Match confidence ↑</option><option value="confidence:desc">Match confidence ↓</option><option value="freshness:asc">Oldest data first</option><option value="category:asc">Category</option>
        </select></div>
        <div className="field"><label htmlFor="f-k">Min. confidence</label><select id="f-k" value={params.minConfidence} onChange={(e) => set({ minConfidence: e.target.value })}><option value="">Any</option><option value="0.6">60%+</option><option value="0.8">80%+</option><option value="0.9">90%+</option></select></div>
      </div>

      {params.review === 'confirmed' && (waiting.data?.total ?? 0) > 0 && (
        <div className="callout info" role="status" style={{ marginBottom: 12 }}>
          Showing <b>confirmed</b> matches only. <b>{waiting.data!.total}</b> proposed pair{waiting.data!.total === 1 ? '' : 's'} wait for your review and {waiting.data!.total === 1 ? 'is' : 'are'} not shown here — similar names do not prove the same product.{' '}
          <Link to={`/o/${orgId}/matches`}>Review them</Link>{' · '}<button className="btn btn-sm" onClick={() => set({ review: 'any' })}>Show them here too, marked unconfirmed</button>
        </div>
      )}
      <DataState q={q} isEmpty={(r) => r.total === 0} empty={<Card><EmptyState title={params.q || params.category || params.siteId || params.matchClass ? 'No products match these filters' : 'No comparisons yet'}>{params.q || params.category || params.siteId || params.matchClass ? 'Clear a filter to see more.' : (readCompetitors.length ? 'No confirmed comparison yet. Comparisons appear when your products have been matched with products at the collected competitors and a person has confirmed the match.' : 'No competitor website has been collected, so there is nothing to compare yet. This is not a result about your prices.')}{!params.q && !params.category && !params.siteId && !params.matchClass && unread.length > 0 && <> <b>Not collected:</b><UncollectedList sites={unread} orgId={orgId} /></>}</EmptyState></Card>}>
        {(r) => (
          <Card pad={false}>
            <div className="table-wrap">
              <table className="table" style={{ minWidth: 260 + (shownSites.length + 1) * 170 }}>
                <thead>
                  <tr>
                    <th style={{ minWidth: 220 }}>Your product</th>
                    <th style={{ minWidth: 165 }}>You</th>
                    {shownSites.map((c) => <th key={c.id} style={{ minWidth: 165 }}>{c.name}{c.status && c.status.state !== 'collected' && <div><SiteStatusPill status={c.status} /></div>}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {r.rows.map((row) => (
                    <tr key={row.sourceVariantId}>
                      <td>
                        <Link className="title" to={`/o/${orgId}/products/${row.sourceProductId}`}>{row.title}</Link>
                        <div className="sub">{[row.brand, row.sizeLabel, row.category].filter(Boolean).join(' · ')}</div>
                        {row.position !== 'no_data' && <span className={`pill ${row.position === 'cheapest' ? 'good' : row.position === 'highest' ? 'bad' : ''}`} style={{ marginTop: 4 }}>{row.position === 'cheapest' ? 'Cheapest' : row.position === 'highest' ? 'Most expensive' : row.position === 'tied' ? 'Tied' : 'In the middle'}</span>}
                      </td>
                      <td><PriceTag you site="Your shop" price={row.sourcePrice} unit={row.sourceUnitPrice} reporting={reporting} availability={row.sourceAvailability} href={row.url ?? null} product={row.title} /></td>
                      {shownSites.map((s) => {
                        const c = row.cells.find((x) => x.siteId === s.id);
                        if (!c) {
                          // "No match found" is only true when the competitor was actually collected. Otherwise say what is really going on.
                          const st = s.status;
                          const collected = !st || st.state === 'collected' || st.state === 'stale';
                          const text = collected ? 'no match found' : st.state === 'partial' ? 'no match found yet (catalogue only partly collected)' : `not available — ${st.label.toLowerCase()}`;
                          return <td key={s.id}><div className="ptag empty small" title={collected ? undefined : st?.detail}>{text}</div></td>;
                        }
                        return (
                          <td key={s.id}>
                            <PriceTag site={c.siteName} price={c.price} unit={c.unitPrice} diffPct={c.diffPct} unitDiffPct={c.unitDiffPct} directlyComparable={c.directlyComparable} reporting={reporting}
                              matchLabel={`${c.matchClass === 'identical' ? 'same' : c.matchClass === 'different_pack' ? 'pack' : 'similar'} ${Math.round(c.confidence * 100)}%`} href={c.url ?? null} availability={c.availability} offer={c.offerSummary} product={c.title} />
                            {(c.caveats.length > 0 || c.reasons.length > 0) && (
                              <details className="ev">
                                <summary>{c.matchStatus === 'needs_review' ? 'Unconfirmed match — why?' : 'Why this match?'}</summary>
                                <div><b>{c.title}</b>{c.variantTitle ? ` — ${c.variantTitle}` : ''}</div>
                                <ul>{c.reasons.map((x, i) => <li key={i}>{x}</li>)}{c.caveats.map((x, i) => <li key={`c${i}`} style={{ color: 'var(--amber)' }}>{x}</li>)}</ul>
                              </details>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageSize={PAGE_SIZE} total={r.total} onPage={(p) => set({ page: String(p) })} />
          </Card>
        )}
      </DataState>

      {d && (
        <div className="stack-s" style={{ marginTop: 14 }}>
          <div className="small muted">
            <b>Reading a tag:</b> the big number is the price exactly as the website displays it, in its own currency; the strip shows the difference to your price after conversion to {reporting} — only for confirmed identical products. Different pack sizes and similar products are compared per unit (per 100 g / per litre / per item). A dashed border means the price is older than {36} hours.
          </div>
          {d.fx.length > 0 && <div className="small muted"><b>Exchange rates used:</b> {d.fx.map((f) => `1 ${f.from} = ${f.rate.toFixed(4)} ${f.to} (${f.source}${f.isFixed ? ', fixed' : ''}, ${formatDateTime(f.fetchedAt)})`).join(' · ')}{d.fx.some((f) => f.source.includes('open.er-api.com')) && <> · <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer noopener">Rates By Exchange Rate API</a></>}</div>}
        </div>
      )}
    </>
  );
}
