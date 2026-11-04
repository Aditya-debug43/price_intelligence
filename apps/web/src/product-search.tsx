import { useEffect, useState } from 'react';
import { qs } from './api';
import { useOrgQuery } from './app-shell';
import { DataState, Modal, SourceLink } from './ui';

export interface SearchCandidate {
  variantId: string; productId: string; siteId: string; siteName: string; title: string; variantTitle: string | null; brand: string | null; sizeLabel: string | null; sku: string | null;
  price: number | null; currency: string | null; availability: string; observedAt: string | null; url: string;
  suggestion: { relationship: string; tier: string; summary: string; reasons: string[] } | null;
}

export const RELATIONSHIP_CHOICES = [
  ['exact', 'The same product'],
  ['variant', 'The same product, different pack, size or colour'],
  ['equivalent', 'A compatible equivalent (another maker, verified to do the same job)'],
  ['substitute', 'A substitute (not the same product)'],
  ['related', 'Related only (goes with it, not interchangeable)'],
] as const;

const money = (p: number | null, c: string | null) => (p === null ? '—' : `${p.toFixed(2)} ${c ?? '?'}`);

/**
 * Search the WHOLE competitor catalogue for the right product (names, brand, SKU, barcode, manufacturer part number, bulb codes under any of their names, vehicle words) and choose one.
 * Used wherever a person looks for another product: from an AI suggestion, from "no counterpart found", and while labelling an evaluation case.
 */
export function ProductSearchModal({ title, sourceVariantId, siteId, currentVariantId, withRelationship = true, onClose, onChosen }: { title: string; sourceVariantId: string; siteId?: string; currentVariantId?: string; withRelationship?: boolean; onClose: () => void; onChosen: (c: SearchCandidate, relationship: string) => void }) {
  const [text, setText] = useState('');
  const [needle, setNeedle] = useState('');
  const [rel, setRel] = useState<string>('exact');
  useEffect(() => {
    const t = setTimeout(() => setNeedle(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  const q = useOrgQuery<{ candidates: SearchCandidate[] }>(['match-candidates', sourceVariantId, siteId ?? '', needle, 'search'], `/matches/candidates${qs({ sourceVariantId, siteId, q: needle, limit: 20 })}`);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack-s">
        <div className="field"><label htmlFor="ps-q">Search the competitors’ products</label><input id="ps-q" type="search" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, brand, SKU, barcode, part number, bulb code or vehicle" /></div>
        {withRelationship && <div className="field"><label htmlFor="ps-c">These products are</label><select id="ps-c" value={rel} onChange={(e) => setRel(e.target.value)}>{RELATIONSHIP_CHOICES.map(([c, l]) => <option key={c} value={c}>{l}</option>)}</select></div>}
        <DataState q={q} isEmpty={(d) => d.candidates.length === 0} empty={<p className="muted">No product matches that search.</p>}>
          {(d) => (
            <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
              <table className="table">
                <tbody>
                  {d.candidates.map((c) => (
                    <tr key={c.variantId}>
                      <td>
                        <div className="title">{c.title}{c.variantTitle && c.variantTitle.toLowerCase() !== 'default title' ? ` — ${c.variantTitle}` : ''}</div>
                        <div className="sub">{[c.siteName, c.brand, c.sizeLabel, c.sku].filter(Boolean).join(' · ')} · <b className="num">{money(c.price, c.currency)}</b> · <SourceLink href={c.url} product={c.title} text="View source" /></div>
                        {withRelationship && c.suggestion && <div className="small muted">{c.suggestion.summary}</div>}
                      </td>
                      <td className="r"><button className="btn btn-sm btn-primary" disabled={c.variantId === currentVariantId} onClick={() => onChosen(c, rel)}>{c.variantId === currentVariantId ? 'Already shown' : 'Use this product'}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DataState>
        <p className="small muted" style={{ margin: 0 }}>The search covers every competitor product, not only what the matcher or the AI looked at.</p>
      </div>
    </Modal>
  );
}
