import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDateTime, type EvidenceItem, type MatchEvidence } from '@ci/shared';
import { api, errorMessage, orgPath, qs } from '../api';
import { useOrg, useOrgMutation, useOrgQuery } from '../app-shell';
import { Age, Card, DataState, EmptyState, Modal, PageHead, Pager, SourceLink, Tabs, useToast } from '../ui';
import { matchStateMessage, type MatchSummaryView } from '../match-text';

interface MatchRow {
  id: string; matchClass: string; relationship: string; tier: string | null; evidence: MatchEvidence | null; engineVersion: string | null; needsReevaluation: boolean; supersededAt: string | null;
  confidence: number; status: string; method: string; reasons: string[]; decidedByPerson: boolean;
  sourceVariantId: string; competitorVariantId: string; competitorSiteId: string;
  sourceTitle: string; sourceVariantTitle: string | null; sourcePrice: number | null; sourceCurrency: string | null; sourceSize: string | null; sourceBrand: string | null; sourceProductId: string; sourceUrl: string;
  sourceAvailability: string; sourceObservedAt: string | null; sourceGtin: string | null; sourceSku: string | null; sourceCategory: string | null;
  competitorTitle: string; competitorVariantTitle: string | null; competitorPrice: number | null; competitorCurrency: string | null; competitorSize: string | null; competitorBrand: string | null; competitorProductId: string; competitorSite: string; competitorUrl: string;
  competitorAvailability: string; competitorObservedAt: string | null; competitorGtin: string | null; competitorSku: string | null; competitorCategory: string | null;
  /** In the grouped "To review" list: how many variant pairs of this product pair are waiting (this row is the strongest of them). */
  groupSize?: number;
}

interface Candidate {
  variantId: string; productId: string; siteId: string; siteName: string; title: string; variantTitle: string | null; brand: string | null; sizeLabel: string | null; gtin: string | null; sku: string | null;
  price: number | null; currency: string | null; availability: string; observedAt: string | null; url: string;
  suggestion: { relationship: string; tier: string; summary: string; reasons: string[] } | null;
}

type Bucket = 'review' | 'unclear' | 'confirmed' | 'rejected' | 'look_again' | 'set_aside';

/** What a person can say two products are. The wording is the contract: a stand-in is never called the same product. */
const RELATIONSHIPS = [
  ['exact', 'The same product'],
  ['variant', 'The same product, different pack, size or colour'],
  ['substitute', 'A substitute (not the same product)'],
  ['related', 'Related only (goes with it, not interchangeable)'],
] as const;
const REL_LABEL: Record<string, string> = {
  exact: 'Same product', variant: 'Same product, other pack or colour', substitute: 'Substitute', related: 'Related product', non_match: 'Not a match', insufficient: 'Not enough information',
};
const REL_HELP: Record<string, string> = {
  exact: 'The same product from the same maker.', variant: 'The same product, but a different pack size, quantity or colour: compared per unit.', substitute: 'A different product that can stand in for yours. It is never shown as the same product.',
  related: 'It goes with your product but cannot replace it.', non_match: 'Different products.', insufficient: 'The listings do not say enough to tell.',
};
const TIER_LABEL: Record<string, string> = { strong: 'Strong evidence', medium: 'Some evidence', insufficient: 'Not enough evidence' };
const money = (p: number | null, c: string | null) => (p === null ? '—' : `${p.toFixed(2)} ${c ?? '?'}`);

const EFFECT: Record<EvidenceItem['effect'], { icon: string; label: string; cls: string }> = {
  supports: { icon: '✓', label: 'Supports', cls: 'good' },
  differs: { icon: '△', label: 'Differs', cls: 'warn' },
  conflicts: { icon: '✕', label: 'Conflicts', cls: 'bad' },
  missing: { icon: '?', label: 'Not stated', cls: '' },
};

export function MatchesPage() {
  const { orgId, isAdmin } = useOrg();
  const [tab, setTab] = useState<Bucket>('review');
  const [page, setPage] = useState(1);
  const [choosing, setChoosing] = useState<MatchRow | null>(null);
  const toast = useToast();
  const summary = useOrgQuery<MatchSummaryView>(['matches', 'summary'], '/matches/summary');
  // "To review" lists one item per product pair (your product against one competitor product), not one per variant pair
  const q = useOrgQuery<{ rows: MatchRow[]; total: number }>(['matches', tab, page], `/matches${qs({ bucket: tab, page, pageSize: 15, group: tab === 'review' ? 'product' : undefined })}`, { placeholderData: (p) => p });
  const refresh = ['matches', 'comparison', 'dashboard', 'journey'];
  const decide = useOrgMutation(
    (id, v: { id: string; decision: 'accept' | 'reject' | 'reclassify'; relationship?: string }) => api.post(orgPath(id, `/matches/${v.id}/decision`), { decision: v.decision, relationship: v.relationship }),
    refresh,
    () => toast.push('Decision saved. It is kept every time matching runs again.'),
  );
  const rerun = useOrgMutation((id, _: void) => api.post(orgPath(id, '/matches/run')), refresh, () => toast.push('Matching started. Suggestions appear here when it finishes.'));
  const rejectGroup = useOrgMutation(
    (id, v: { sourceProductId: string; competitorProductId: string }) => api.post<{ rejected: number }>(orgPath(id, '/matches/product-pair/reject'), v),
    refresh,
    (r) => toast.push(`${r.rejected} suggestion${r.rejected === 1 ? '' : 's'} for these two products marked as not a match. Your decision is kept every time matching runs again.`),
  );
  const s = summary.data;
  const count = (b: Bucket) => (s ? ({ review: s.counts.awaitingProductPairs ?? s.counts.awaiting, unclear: s.counts.unclear, confirmed: s.counts.confirmedSame + s.counts.confirmedSubstitutes + s.counts.confirmedRelated, rejected: s.counts.rejected, look_again: s.counts.needLookAgain, set_aside: s.counts.setAside }[b]) : null);
  const label = (text: string, b: Bucket) => (count(b) === null ? text : `${text} (${count(b)})`);
  const tabs: { id: Bucket; label: string }[] = [
    { id: 'review', label: label('To review', 'review') },
    { id: 'unclear', label: label('Related & unclear', 'unclear') },
    { id: 'confirmed', label: label('Confirmed by you', 'confirmed') },
    { id: 'rejected', label: label('Not a match', 'rejected') },
    ...((count('look_again') ?? 0) > 0 ? [{ id: 'look_again' as Bucket, label: label('Look again', 'look_again') }] : []),
    ...((count('set_aside') ?? 0) > 0 ? [{ id: 'set_aside' as Bucket, label: label('Set aside', 'set_aside') }] : []),
  ];
  return (
    <>
      <PageHead
        eyebrow="Market"
        title="Match review"
        subtitle="The matcher suggests; you decide. Nothing is used for a price comparison until you confirm it, a similar name never proves the same product, and your decisions are never overwritten."
        actions={isAdmin && <button className="btn" onClick={() => rerun.mutate(undefined)} disabled={rerun.isPending}>Run matching again</button>}
      />
      {s && s.engine === 'v2_shadow' && <div className="callout info" role="status" style={{ marginBottom: 12 }}>The new matcher is being tested alongside the old one. It records what it would suggest but changes nothing you see here.</div>}
      {isAdmin && tab === 'review' && (q.data?.total ?? 0) > 0 && <BulkAccept />}
      {(decide.error || rerun.error || rejectGroup.error) && <div className="callout bad" role="alert" style={{ marginBottom: 12 }}>{errorMessage(decide.error ?? rerun.error ?? rejectGroup.error)}</div>}
      {tab === 'review' && s && s.counts.awaitingProductPairs !== undefined && s.counts.awaitingProductPairs < s.counts.awaiting && (
        <div className="small muted" style={{ marginBottom: 8 }}>{s.counts.awaitingProductPairs} product pairs to look at, covering {s.counts.awaiting} variant pairs: a product with several variants is one item here; open it to see its variants.</div>
      )}
      <Tabs value={tab} onChange={(t) => { setTab(t); setPage(1); }} tabs={tabs} />
      <DataState
        q={q}
        isEmpty={(d) => d.total === 0}
        empty={
          <Card>
            <EmptyState title={emptyTitle(tab, s)}>
              {emptyText(tab, s)}
            </EmptyState>
          </Card>
        }
      >
        {(d) => (
          <Card pad={false}>
            {d.rows.map((m) => (
              <MatchCard key={m.id} m={m} orgId={orgId} isAdmin={isAdmin} onDecide={(v) => decide.mutate({ id: m.id, ...v })} onChoose={() => setChoosing(m)}
                group={(m.groupSize ?? 1) > 1 ? { onDecideMember: (id, v) => decide.mutate({ id, ...v }), onChooseMember: setChoosing, onRejectAll: () => rejectGroup.mutate({ sourceProductId: m.sourceProductId, competitorProductId: m.competitorProductId }), busy: rejectGroup.isPending } : undefined} />
            ))}
            <Pager page={page} pageSize={15} total={d.total} onPage={setPage} />
          </Card>
        )}
      </DataState>
      {choosing && <ChooseProduct row={choosing} onClose={() => setChoosing(null)} />}
    </>
  );
}

function emptyTitle(tab: Bucket, s: MatchSummaryView | undefined): string {
  if (tab === 'review') {
    if (!s) return 'Nothing to show';
    return s.state === 'ok' || s.state === 'none_confirmed' ? (s.counts.awaiting === 0 && (s.counts.confirmedSame + s.counts.confirmedSubstitutes + s.counts.rejected) > 0 ? 'Every suggestion has been decided' : 'Nothing is waiting for review') : matchStateMessage(s).title;
  }
  return 'Nothing here';
}

function emptyText(tab: Bucket, s: MatchSummaryView | undefined) {
  if (tab === 'review') return s ? matchStateMessage(s).body : 'Loading…';
  if (tab === 'unclear') return 'Related products and pairs without enough information are kept here for reference. They never count as work to do and never appear in a price comparison.';
  if (tab === 'confirmed') return 'Nothing confirmed yet. Confirm a suggestion and it is kept here, and used in the price comparison once it is the same product, or in the substitutes view once it is a substitute.';
  if (tab === 'rejected') return 'You have not rejected any suggestions. A rejected pair is never suggested again.';
  if (tab === 'look_again') return 'No decided pair has a changed product.';
  return 'The matcher has not set any earlier suggestion aside.';
}

function EvidenceList({ evidence }: { evidence: MatchEvidence }) {
  const order: EvidenceItem['effect'][] = ['conflicts', 'differs', 'supports', 'missing'];
  const items = [...evidence.items].sort((a, b) => order.indexOf(a.effect) - order.indexOf(b.effect));
  return (
    <ul className="ev-list" style={{ listStyle: 'none', margin: '6px 0', padding: 0 }}>
      {items.map((i, n) => {
        const e = EFFECT[i.effect];
        return (
          <li key={n} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0' }}>
            <span className={`pill ${e.cls}`} title={e.label} aria-label={e.label} style={{ minWidth: 22, textAlign: 'center' }}>{e.icon}</span>
            <span>
              {i.text}
              {(i.a || i.b) && i.a !== i.b && <span className="small muted"> — yours: {i.a ?? 'not stated'} · theirs: {i.b ?? 'not stated'}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

type DecideArgs = { decision: 'accept' | 'reject' | 'reclassify'; relationship?: string };
interface GroupHandlers { onDecideMember: (id: string, v: DecideArgs) => void; onChooseMember: (m: MatchRow) => void; onRejectAll: () => void; busy: boolean }

/** The other variant pairs of the same two products, opened on request, and the one decision that applies to all of them (not the same product). */
function GroupBar({ m, orgId, isAdmin, g }: { m: MatchRow; orgId: string; isAdmin: boolean; g: GroupHandlers }) {
  const [open, setOpen] = useState(false);
  const n = m.groupSize ?? 1;
  const members = useOrgQuery<{ rows: MatchRow[] }>(['matches', 'group', m.sourceProductId, m.competitorProductId], `/matches${qs({ bucket: 'review', sourceProductId: m.sourceProductId, competitorProductId: m.competitorProductId, pageSize: 50 })}`, { enabled: open });
  return (
    <>
      <div className="callout info" role="status" style={{ margin: '8px 0' }}>
        These two products have <b>{n} variant pairs</b> waiting; the strongest is shown. Each variant pair is confirmed on its own, because sizes and options differ between them.
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn btn-sm" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide the other variant pairs' : `Show the other ${n - 1} variant pair${n - 1 === 1 ? '' : 's'}`}</button>
          {isAdmin && <button className="btn btn-sm btn-danger" disabled={g.busy} onClick={() => { if (window.confirm(`Mark all ${n} variant pairs of these two products as “not a match”?`)) g.onRejectAll(); }}>These are different products: reject all {n}</button>}
        </div>
      </div>
      {open && members.isPending && <div className="small muted" style={{ padding: '4px 0' }}>Loading the variant pairs…</div>}
      {open && (members.data?.rows ?? []).filter((r) => r.id !== m.id).map((r) => (
        <div key={r.id} style={{ borderLeft: '3px solid var(--line-2)', marginLeft: 6 }}>
          <MatchCard m={r} orgId={orgId} isAdmin={isAdmin} onDecide={(v) => g.onDecideMember(r.id, v)} onChoose={() => g.onChooseMember(r)} />
        </div>
      ))}
    </>
  );
}

function MatchCard({ m, orgId, isAdmin, onDecide, onChoose, group }: { m: MatchRow; orgId: string; isAdmin: boolean; onDecide: (v: { decision: 'accept' | 'reject' | 'reclassify'; relationship?: string }) => void; onChoose: () => void; group?: GroupHandlers }) {
  const decided = m.status === 'accepted' || m.status === 'rejected';
  const earlier = m.engineVersion == null;
  const rel = m.relationship ?? ({ identical: 'exact', different_pack: 'variant', comparable: 'substitute' } as Record<string, string>)[m.matchClass] ?? 'non_match';
  return (
    <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line-2)' }}>
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
        <div style={{ textAlign: 'right' }}>
          <span className="pill info" title={REL_HELP[rel]}>{REL_LABEL[rel] ?? rel}</span>
          <div className="small" style={{ marginTop: 4 }}>{earlier ? <span className="muted">Suggested by the earlier matcher</span> : <b>{TIER_LABEL[m.tier ?? 'medium']}</b>}</div>
          {m.decidedByPerson && <div className="small muted">decided by a person</div>}
        </div>
      </div>
      {m.needsReevaluation && (
        <div className="callout info" role="status" style={{ margin: '8px 0' }}>
          A product in this pair changed after you decided. <b>Your decision still stands</b> — look at the two products again and, if it still holds, keep it.
          {isAdmin && <> <button className="btn btn-sm" onClick={() => onDecide({ decision: m.status === 'rejected' ? 'reject' : 'accept' })}>Keep my decision</button></>}
        </div>
      )}
      {m.evidence ? (
        <>
          <div className="small" style={{ margin: '6px 0' }}>{m.evidence.summary}</div>
          <EvidenceList evidence={m.evidence} />
        </>
      ) : (
        <div className="small muted" style={{ margin: '6px 0' }}>Why: {m.reasons.join(' · ')}</div>
      )}
      <SideBySide m={m} />
      <History id={m.id} />
      {group && <GroupBar m={m} orgId={orgId} isAdmin={isAdmin} g={group} />}
      {isAdmin && (
        <div className="row" style={{ marginTop: 8 }}>
          {!decided && (rel === 'exact' || rel === 'variant' || rel === 'substitute' || rel === 'related') && (
            <button className="btn btn-sm btn-primary" onClick={() => onDecide({ decision: 'accept' })}>Yes — {REL_LABEL[rel]!.toLowerCase()}</button>
          )}
          {RELATIONSHIPS.filter(([c]) => c !== rel || decided).map(([c, l]) => (
            <button key={c} className="btn btn-sm" onClick={() => onDecide({ decision: 'reclassify', relationship: c })}>{decided && c === rel ? `${l} ✓` : `Actually: ${l.toLowerCase()}`}</button>
          ))}
          <button className="btn btn-sm" onClick={onChoose}>Choose a different product…</button>
          {m.status !== 'rejected' && <button className="btn btn-sm btn-danger" onClick={() => onDecide({ decision: 'reject' })}>Not a match</button>}
        </div>
      )}
    </div>
  );
}

function History({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const q = useOrgQuery<{ events: { id: string; kind: string; relationship: string | null; tier: string | null; decision: string | null; note: string | null; createdAt: string }[] }>(['matches', 'history', id], `/matches/${id}/history`, { enabled: open });
  const WORDS: Record<string, string> = { suggested: 'Suggested', changed: 'Suggestion changed', superseded: 'Set aside (no longer suggested)', reinstated: 'Suggested again', decided: 'Decided', flagged: 'A product changed' };
  return (
    <details className="ev" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>History of this pair</summary>
      {open && (
        <DataState q={q} isEmpty={(d) => d.events.length === 0} empty={<p className="muted small">Nothing recorded yet.</p>}>
          {(d) => (
            <ul>
              {d.events.map((e) => (
                <li key={e.id}>
                  <b>{WORDS[e.kind] ?? e.kind}</b>{e.relationship ? ` — ${REL_LABEL[e.relationship] ?? e.relationship}` : ''}{e.decision ? ` (${e.decision})` : ''}{e.note ? `: ${e.note}` : ''} <span className="muted small">{formatDateTime(e.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </DataState>
      )}
    </details>
  );
}

interface BulkResult {
  count: number;
  accepted: boolean;
  examples: { competitorSite: string; sourceTitle: string; sourcePrice: number | null; sourceCurrency: string | null; competitorTitle: string; competitorPrice: number | null; competitorCurrency: string | null; confidence: number; reasons: string[] }[];
}

/**
 * When shops publish no barcodes or brands, hundreds of pairs agree on name and size and all wait for review. A person can confirm a group together —
 * but only after seeing how many there are and a sample, only groups of "the same product" (a substitute needs its own look), and nothing a person
 * already decided is touched.
 */
function BulkAccept() {
  const toast = useToast();
  const [cls, setCls] = useState<'identical' | 'different_pack'>('identical');
  const [min, setMin] = useState(0.7);
  const [preview, setPreview] = useState<BulkResult | null>(null);
  const name = cls === 'identical' ? 'the same product' : 'the same product in another pack';
  const body = (dryRun: boolean) => ({ matchClass: cls, minConfidence: min, dryRun });
  const check = useOrgMutation((id, _: void) => api.post<BulkResult>(orgPath(id, '/matches/bulk'), body(true)), [], (r) => setPreview(r));
  const accept = useOrgMutation((id, _: void) => api.post<BulkResult>(orgPath(id, '/matches/bulk'), body(false)), ['matches', 'comparison', 'dashboard', 'journey'], (r) => {
    toast.push(`Confirmed ${r.count} pairs as ${name}. They are now used in the price comparison.`);
    setPreview(null);
  });
  return (
    <Card title="Confirm many at once">
      <div className="stack-s">
        <p className="small muted" style={{ margin: 0 }}>
          Where the evidence is strongest (and, for suggestions from the earlier matcher, its score is high) you can confirm a group together. You see how many there are and a sample first. Substitutes are never confirmed in bulk, and pairs you already decided are never touched.
        </p>
        <div className="row" style={{ alignItems: 'end' }}>
          <div className="field"><label htmlFor="bulk-class">Confirm pairs that are</label><select id="bulk-class" value={cls} onChange={(e) => setCls(e.target.value as typeof cls)}><option value="identical">The same product</option><option value="different_pack">The same product, different pack</option></select></div>
          <div className="field"><label htmlFor="bulk-min">earlier-matcher score of at least</label><select id="bulk-min" value={min} onChange={(e) => setMin(Number(e.target.value))}>{[0.6, 0.7, 0.8, 0.9].map((v) => <option key={v} value={v}>{Math.round(v * 100)}%</option>)}</select></div>
          <button className="btn" onClick={() => check.mutate(undefined)} disabled={check.isPending}>Show me which ones</button>
        </div>
        {check.error && <div className="callout bad" role="alert">{errorMessage(check.error)}</div>}
      </div>
      {preview && (
        <Modal
          title={preview.count === 0 ? 'No pairs fit' : `Confirm ${preview.count} pairs as ${name}?`}
          onClose={() => setPreview(null)}
          footer={preview.count > 0 ? <><button className="btn" onClick={() => setPreview(null)}>Cancel</button><button className="btn btn-primary" onClick={() => accept.mutate(undefined)} disabled={accept.isPending}>Confirm all {preview.count}</button></> : <button className="btn" onClick={() => setPreview(null)}>Close</button>}
        >
          <div className="stack-s">
            {preview.count === 0 ? <p className="muted">Nothing waiting for review fits.</p> : (
              <>
                <p style={{ margin: 0 }}>Confirming says <b>you</b> judge each of these pairs to be {name}; they are then used in the price comparison. A sample, spread across the list:</p>
                <div className="table-wrap"><table className="table"><tbody>
                  {preview.examples.map((e, i) => (
                    <tr key={i}><td><div className="title">{e.sourceTitle}</div><div className="sub">{e.sourcePrice === null ? '—' : `${e.sourcePrice.toFixed(2)} ${e.sourceCurrency ?? '?'}`}</div></td><td aria-hidden="true">≟</td><td><div className="title">{e.competitorTitle}</div><div className="sub">{e.competitorSite} · {e.competitorPrice === null ? '—' : `${e.competitorPrice.toFixed(2)} ${e.competitorCurrency ?? '?'}`}</div></td></tr>
                  ))}
                </tbody></table></div>
                <p className="small muted" style={{ margin: 0 }}>If something in the sample is wrong, cancel and review those pairs one at a time. A wrong pair you confirm can still be rejected afterwards.</p>
                {accept.error && <div className="callout bad" role="alert">{errorMessage(accept.error)}</div>}
              </>
            )}
          </div>
        </Modal>
      )}
    </Card>
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
            <tr><td className="muted small">Source page</td><td><SourceLink href={m.sourceUrl} product={m.sourceTitle} /></td><td><SourceLink href={m.competitorUrl} product={m.competitorTitle} /></td></tr>
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
  const [rel, setRel] = useState<'exact' | 'variant' | 'substitute' | 'related'>('exact');
  useEffect(() => {
    const t = setTimeout(() => setNeedle(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  const q = useOrgQuery<{ candidates: Candidate[] }>(['match-candidates', row.sourceVariantId, row.competitorSiteId, needle], `/matches/candidates${qs({ sourceVariantId: row.sourceVariantId, siteId: row.competitorSiteId, q: needle, limit: 20 })}`);
  const choose = useOrgMutation((id, c: Candidate) => api.post(orgPath(id, '/matches/manual'), { sourceVariantId: row.sourceVariantId, competitorVariantId: c.variantId, relationship: rel, replaceMatchId: row.id }), ['matches', 'comparison', 'dashboard', 'journey'], () => {
    toast.push('Saved. Your choice is kept and replaces the earlier suggestion.');
    onClose();
  });
  return (
    <Modal title={`Which ${row.competitorSite} product matches “${row.sourceTitle}”?`} onClose={onClose}>
      <div className="stack-s">
        <div className="field"><label htmlFor="cand-q">Search this website’s products</label><input id="cand-q" type="search" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, brand, SKU or barcode" /></div>
        <div className="field"><label htmlFor="cand-c">These products are</label><select id="cand-c" value={rel} onChange={(e) => setRel(e.target.value as typeof rel)}>{RELATIONSHIPS.map(([c, l]) => <option key={c} value={c}>{l}</option>)}</select></div>
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
                        <div className="sub">{[c.brand, c.sizeLabel, c.sku].filter(Boolean).join(' · ')} · <b className="num">{money(c.price, c.currency)}</b> · {c.availability.replace(/_/g, ' ')} · <Age iso={c.observedAt} /> · <SourceLink href={c.url} product={c.title} text="Open page" /></div>
                        {c.suggestion && <div className="small muted">{REL_LABEL[c.suggestion.relationship] ?? c.suggestion.relationship} · {TIER_LABEL[c.suggestion.tier] ?? c.suggestion.tier}: {c.suggestion.reasons.slice(0, 3).join(' · ')}</div>}
                      </td>
                      <td className="r"><button className="btn btn-sm btn-primary" disabled={choose.isPending || c.variantId === row.competitorVariantId} onClick={() => choose.mutate(c)}>{c.variantId === row.competitorVariantId ? 'Current suggestion' : 'Use this product'}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DataState>
        <p className="small muted" style={{ margin: 0 }}>Products are ranked by how well the evidence fits, with the reasons shown — but only your choice counts. It replaces the earlier suggestion for this website and is kept every time matching runs again.</p>
      </div>
    </Modal>
  );
}
