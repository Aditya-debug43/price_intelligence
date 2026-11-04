import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage, orgPath, qs } from '../api';
import { useOrg, useOrgMutation, useOrgQuery } from '../app-shell';
import { ProductSearchModal } from '../product-search';
import { Card, DataState, EmptyState, Pager, SourceLink, useToast } from '../ui';

interface Row { variantId: string; productId: string; title: string; variantTitle: string | null; brand: string | null; sku: string | null; price: number | null; currency: string | null; url: string | null }

/**
 * Your variants with no live pair at all. "No counterpart found" is what the matcher found, never a finding that no competitor sells one: a person can search the whole competitor catalogue
 * from here and record the right product, which is then an ordinary decision of theirs.
 */
export function NoCounterpartList() {
  const { orgId, isAdmin } = useOrg();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [text, setText] = useState('');
  const [needle, setNeedle] = useState('');
  const [finding, setFinding] = useState<Row | null>(null);
  const q = useOrgQuery<{ rows: Row[]; total: number }>(['matches', 'none', page, needle], `/matches/no-counterpart${qs({ page, pageSize: 15, q: needle })}`, { placeholderData: (p) => p });
  const choose = useOrgMutation((id, v: { sourceVariantId: string; competitorVariantId: string; relationship: string }) => api.post(orgPath(id, '/matches/manual'), v), ['matches', 'comparison', 'dashboard', 'journey'], () => {
    toast.push('Saved as your decision. It is kept every time matching runs again.');
    setFinding(null);
  });
  return (
    <div className="stack-s">
      <div className="callout info" role="note">These are your variants for which the matcher has <b>found no counterpart</b> at any competitor. That is not a finding that none exists: search the competitors’ catalogues and record the right product if you know it.</div>
      {choose.error && <div className="callout bad" role="alert">{errorMessage(choose.error)}</div>}
      <div className="field wide"><label htmlFor="nc-q">Search your products</label><input id="nc-q" type="search" value={text} placeholder="Name, brand or SKU" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { setNeedle(text.trim()); setPage(1); } }} onBlur={() => { setNeedle(text.trim()); setPage(1); }} /></div>
      <DataState q={q} isEmpty={(d) => d.total === 0} empty={<Card><EmptyState title="Every one of your variants has a counterpart or a suggestion">Nothing is listed here when the matcher found a pair (confirmed or suggested) for the variant.</EmptyState></Card>}>
        {(d) => (
          <Card pad={false}>
            {d.rows.map((r) => (
              <div key={r.variantId} className="row" style={{ padding: '12px 18px', borderBottom: '1px solid var(--line-2)', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <Link className="title" to={`/o/${orgId}/products/${r.productId}`}>{r.title}</Link>
                  <div className="sub">{[r.brand, r.variantTitle && r.variantTitle.toLowerCase() !== 'default title' ? r.variantTitle : null, r.sku ? `SKU ${r.sku}` : null].filter(Boolean).join(' · ')}{r.price !== null ? ` · ${r.price.toFixed(2)} ${r.currency ?? ''}` : ''} · <SourceLink href={r.url} product={r.title} text="View source" /></div>
                </div>
                {isAdmin && <button className="btn btn-sm" onClick={() => setFinding(r)}>Find a product…</button>}
              </div>
            ))}
            <Pager page={page} pageSize={15} total={d.total} onPage={setPage} />
          </Card>
        )}
      </DataState>
      {finding && <ProductSearchModal title={`Which competitor product matches “${finding.title}”?`} sourceVariantId={finding.variantId} onClose={() => setFinding(null)} onChosen={(c, relationship) => choose.mutate({ sourceVariantId: finding.variantId, competitorVariantId: c.variantId, relationship })} />}
    </div>
  );
}
