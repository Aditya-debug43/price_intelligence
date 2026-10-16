import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDateTime } from '@ci/shared';
import { api, errorMessage, orgPath, qs } from '../api';
import { useOrg, useOrgMutation, useOrgQuery } from '../app-shell';
import { Age, ArrowIcon, Card, DataState, EmptyState, Modal, PageHead, Pager, Tabs, useToast } from '../ui';

interface MatchRow {
  id: string; matchClass: string; confidence: number; status: string; method: string; reasons: string[]; decidedByPerson: boolean;
  sourceVariantId: string; competitorVariantId: string; competitorSiteId: string;
  sourceTitle: string; sourceVariantTitle: string | null; sourcePrice: number | null; sourceCurrency: string | null; sourceSize: string | null; sourceBrand: string | null; sourceProductId: string; sourceUrl: string;
  sourceAvailability: string; sourceObservedAt: string | null; sourceGtin: string | null; sourceSku: string | null; sourceCategory: string | null;
  competitorTitle: string; competitorVariantTitle: string | null; competitorPrice: number | null; competitorCurrency: string | null; competitorSize: string | null; competitorBrand: string | null; competitorProductId: string; competitorSite: string; competitorUrl: string;
  competitorAvailability: string; competitorObservedAt: string | null; competitorGtin: string | null; competitorSku: string | null; competitorCategory: string | null;
}

interface Candidate {
  variantId: string; productId: string; siteId: string; siteName: string; title: string; variantTitle: string | null; brand: string | null; sizeLabel: string | null; gtin: string | null; sku: string | null;
  price: number | null; currency: string | null; availability: string; observedAt: string | null; url: string;
  suggestion: { matchClass: string; confidence: number; reasons: string[] } | null;
}

const CLASSES = [['identical', 'Identical product'], ['different_pack', 'Same product, different pack'], ['comparable', 'Comparable product']] as const;
const CLASS_LABEL: Record<string, string> = { identical: 'identical', different_pack: 'different pack', comparable: 'comparable', not_comparable: 'not comparable' };
const money = (p: number | null, c: string | null) => (p === null ? '—' : `${p.toFixed(2)} ${c ?? '?'}`);

export function MatchesPage() {
  const { orgId, isAdmin } = useOrg();
  const [tab, setTab] = useState<'needs_review' | 'auto' | 'accepted' | 'rejected'>('needs_review');
  const [page, setPage] = useState(1);
  const [choosing, setChoosing] = useState<MatchRow | null>(null);
  const toast = useToast();
  const q = useOrgQuery<{ rows: MatchRow[]; total: number }>(['matches', tab, page], `/matches${qs({ status: tab, page, pageSize: 15 })}`, { placeholderData: (p) => p });
  const decide = useOrgMutation((id, v: { id: string; decision: 'accept' | 'reject' | 'reclassify'; matchClass?: string }) => api.post(orgPath(id, `/matches/${v.id}/decision`), { decision: v.decision, matchClass: v.matchClass }), ['matches', 'comparison', 'dashboard', 'journey'], () => toast.push('Decision saved. It will be kept the next time matching runs.'));
  const rerun = useOrgMutation((id, _: void) => api.post(orgPath(id, '/matches/run')), ['matches'], () => toast.push('Matching started.'));
  return (
    <>
      <PageHead eyebrow="Market" title="Match review" subtitle="Similar names don’t prove identical products. Pairs we aren’t sure about wait here, and they are not used for price conclusions until you confirm them. Your decisions are never overwritten."
        actions={isAdmin && <button className="btn" onClick={() => rerun.mutate(undefined)} disabled={rerun.isPending}>Run matching again</button>} />
      {(decide.error || rerun.error) && <div className="callout bad" role="alert" style={{ marginBottom: 12 }}>{errorMessage(decide.error ?? rerun.error)}</div>}
      <Tabs value={tab} onChange={(t) => { setTab(t); setPage(1); }} tabs={[{ id: 'needs_review', label: 'Needs review' }, { id: 'auto', label: 'Auto-accepted' }, { id: 'accepted', label: 'Confirmed by you' }, { id: 'rejected', label: 'Rejected' }]} />
      <DataState q={q} isEmpty={(d) => d.total === 0} empty={<Card><EmptyState title={tab === 'needs_review' ? 'Nothing to review' : 'Nothing here'}>{tab === 'needs_review' ? 'Every match is either confirmed or was accepted with strong evidence.' : 'No matches in this list.'}</EmptyState></Card>}>
        {(d) => (
          <Card pad={false}>
            {d.rows.map((m) => (
              <div key={m.id} style={{ padding: '14px 18px', borderBottom: '1px solid var(--line-2)' }}>
                <div className="grid2" style={{ gridTemplateColumns: '1fr auto 1fr auto', alignItems: 'center' }}>
                  <div>
                    <div className="small muted">Your product</div>
                    <Link className="title" to={`/o/${orgId}/products/${m.sourceProductId}`}>{m.sourceTitle}</Link>
                    <div className="sub">{[m.sourceBrand, m.sourceSize].filter(Boolean).join(' · ')} · <b className="num">{money(m.sourcePrice, m.sourceCurrency)}</b></div>
                  </div>
                  <span aria-hidden="true" style={{ fontSize: 22, color: 'var(--mute)' }}>≟</span>
                  <div>
                    <div className="small muted">{m.competitorSite}</div>
                    <Link className="title" to={`/o/${orgId}/products/${m.competitorProductId}`}>{m.competitorTitle}</Link>
                    <div className="sub">{[m.competitorBrand, m.competitorSize].filter(Boolean).join(' · ')} · <b className="num">{money(m.competitorPrice, m.competitorCurrency)}</b></div>
                  </div>
                  <div style={{ textAlign: 'right' }}><span className="pill info">{CLASS_LABEL[m.matchClass] ?? m.matchClass}</span><div className="num" style={{ fontSize: 24 }}>{Math.round(m.confidence * 100)}%</div>{m.decidedByPerson && <div className="small muted">decided by a person</div>}</div>
                </div>
                <div className="small muted" style={{ margin: '6px 0' }}>Why: {m.reasons.join(' · ')} <span className="pill">{m.method.replace('_', ' ')}</span></div>
                <SideBySide m={m} />
                {isAdmin && (
                  <div className="row" style={{ marginTop: 8 }}>
                    {m.status !== 'accepted' && <button className="btn btn-sm btn-primary" onClick={() => decide.mutate({ id: m.id, decision: 'accept' })}>Yes, keep as {CLASS_LABEL[m.matchClass] ?? m.matchClass}</button>}
                    {CLASSES.filter(([c]) => c !== m.matchClass).map(([c, l]) => <button key={c} className="btn btn-sm" onClick={() => decide.mutate({ id: m.id, decision: 'reclassify', matchClass: c })}>Actually: {l.toLowerCase()}</button>)}
                    <button className="btn btn-sm" onClick={() => setChoosing(m)}>Choose a different product…</button>
                    {m.status !== 'rejected' && <button className="btn btn-sm btn-danger" onClick={() => decide.mutate({ id: m.id, decision: 'reject' })}>Not a match</button>}
                  </div>
                )}
              </div>
            ))}
            <Pager page={page} pageSize={15} total={d.total} onPage={setPage} />
          </Card>
        )}
      </DataState>
      {choosing && <ChooseProduct row={choosing} onClose={() => setChoosing(null)} />}
    </>
  );
}

/** The two products' facts next to each other, each with its source link and the time it was observed. */
function SideBySide({ m }: { m: MatchRow }) {
  const rows: [string, string | null, string | null][] = [
    ['Product', m.sourceTitle, m.competitorTitle],
    ['Variant', m.sourceVariantTitle, m.competitorVariantTitle],
    ['Brand', m.sourceBrand, m.competitorBrand],
    ['Size / pack', m.sourceSize, m.competitorSize],
    ['Barcode (GTIN)', m.sourceGtin, m.competitorGtin],
    ['SKU', m.sourceSku, m.competitorSku],
    ['Category', m.sourceCategory, m.competitorCategory],
    ['Price', money(m.sourcePrice, m.sourceCurrency), money(m.competitorPrice, m.competitorCurrency)],
    ['Availability', m.sourceAvailability.replace(/_/g, ' '), m.competitorAvailability.replace(/_/g, ' ')],
    ['Last observed', m.sourceObservedAt ? formatDateTime(m.sourceObservedAt) : 'never', m.competitorObservedAt ? formatDateTime(m.competitorObservedAt) : 'never'],
  ];
  return (
    <details className="ev">
      <summary>Compare the two products side by side</summary>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th /><th>Your product</th><th>{m.competitorSite}</th></tr></thead>
          <tbody>
            {rows.map(([k, a, b]) => {
              const differs = !!a && !!b && a.toLowerCase() !== b.toLowerCase() && !['Price', 'Last observed', 'Availability'].includes(k);
              return <tr key={k}><td className="muted small">{k}</td><td style={differs ? { background: 'var(--amber-wash, #fff4c2)' } : undefined}>{a || <span className="muted">not published</span>}</td><td style={differs ? { background: 'var(--amber-wash, #fff4c2)' } : undefined}>{b || <span className="muted">not published</span>}</td></tr>;
            })}
            <tr><td className="muted small">Source page</td><td><a href={m.sourceUrl} target="_blank" rel="noreferrer noopener">open <ArrowIcon /></a></td><td><a href={m.competitorUrl} target="_blank" rel="noreferrer noopener">open <ArrowIcon /></a></td></tr>
          </tbody>
        </table>
      </div>
      <div className="small muted">Highlighted rows differ between the two products. A missing barcode or size means the website does not publish it, not that it is zero.</div>
    </details>
  );
}

/** Search the competitor's catalogue for the right product and record the choice. The person's decision is the evidence. */
function ChooseProduct({ row, onClose }: { row: MatchRow; onClose: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [needle, setNeedle] = useState('');
  const [cls, setCls] = useState<'identical' | 'different_pack' | 'comparable'>('identical');
  useEffect(() => {
    const t = setTimeout(() => setNeedle(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  const q = useOrgQuery<{ candidates: Candidate[] }>(['match-candidates', row.sourceVariantId, row.competitorSiteId, needle], `/matches/candidates${qs({ sourceVariantId: row.sourceVariantId, siteId: row.competitorSiteId, q: needle, limit: 20 })}`);
  const choose = useOrgMutation((id, c: Candidate) => api.post(orgPath(id, '/matches/manual'), { sourceVariantId: row.sourceVariantId, competitorVariantId: c.variantId, matchClass: cls, replaceMatchId: row.id }), ['matches', 'comparison', 'dashboard', 'journey'], () => {
    toast.push('Saved. Your choice is kept and replaces the earlier suggestion.');
    onClose();
  });
  return (
    <Modal title={`Which ${row.competitorSite} product matches “${row.sourceTitle}”?`} onClose={onClose}>
      <div className="stack-s">
        <div className="field"><label htmlFor="cand-q">Search this website’s products</label><input id="cand-q" type="search" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, brand, SKU or barcode" /></div>
        <div className="field"><label htmlFor="cand-c">These products are</label><select id="cand-c" value={cls} onChange={(e) => setCls(e.target.value as typeof cls)}>{CLASSES.map(([c, l]) => <option key={c} value={c}>{l}</option>)}</select></div>
        {choose.error && <div className="callout bad" role="alert">{errorMessage(choose.error)}</div>}
        <DataState q={q} isEmpty={(d) => d.candidates.length === 0} empty={<p className="muted">No product on this website matches that search.</p>}>
          {(d) => (
            <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
              <table className="table">
                <tbody>
                  {d.candidates.map((c) => (
                    <tr key={c.variantId}>
                      <td>
                        <div className="title">{c.title}{c.variantTitle ? ` — ${c.variantTitle}` : ''}</div>
                        <div className="sub">{[c.brand, c.sizeLabel, c.sku].filter(Boolean).join(' · ')} · <b className="num">{money(c.price, c.currency)}</b> · {c.availability.replace(/_/g, ' ')} · <Age iso={c.observedAt} /> · <a href={c.url} target="_blank" rel="noreferrer noopener">page <ArrowIcon /></a></div>
                        {c.suggestion && <div className="small muted">Suggested as {CLASS_LABEL[c.suggestion.matchClass] ?? c.suggestion.matchClass} ({Math.round(c.suggestion.confidence * 100)}%): {c.suggestion.reasons.slice(0, 2).join(' · ')}</div>}
                      </td>
                      <td className="r"><button className="btn btn-sm btn-primary" disabled={choose.isPending || c.variantId === row.competitorVariantId} onClick={() => choose.mutate(c)}>{c.variantId === row.competitorVariantId ? 'Current suggestion' : 'Use this product'}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DataState>
        <p className="small muted" style={{ margin: 0 }}>Suggestions are ranked by how well they fit, with the reasons shown — but only your choice counts. It replaces the earlier suggestion for this website and is kept every time matching runs again.</p>
      </div>
    </Modal>
  );
}
