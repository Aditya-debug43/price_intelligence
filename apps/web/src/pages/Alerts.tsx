import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDateTime } from '@ci/shared';
import { api, errorMessage, orgPath, qs } from '../api';
import { useOrg, useOrgMutation, useOrgQuery } from '../app-shell';
import { Age, ArrowIcon, Card, DataState, EmptyState, Modal, PageHead, Pager, ProvenancePill, Tabs, useToast } from '../ui';
import type { AlertDetail, AlertEvidence } from '../types';

type Tab = 'open' | 'acknowledged' | 'resolved' | 'all';

const BASIS: Record<string, string> = {
  authorised_quantity: 'a quantity from your authorised inventory connection',
  simulated_quantity: 'a simulated quantity (development only)',
  public_quantity_claim: 'a quantity your website states publicly',
  public_limited_flag: 'your website flagging the item as limited',
  public_availability: 'the availability your website shows',
};

export function AlertsPage() {
  const { orgId } = useOrg();
  const toast = useToast();
  const [status, setStatus] = useState<Tab>('open');
  const [page, setPage] = useState(1);
  const [resolving, setResolving] = useState<AlertDetail | null>(null);
  const q = useOrgQuery<{ rows: AlertDetail[]; total: number }>(['alerts', status, page], `/alerts${qs({ status, page, pageSize: 25 })}`, { placeholderData: (p) => p, refetchInterval: 20_000 });
  const ack = useOrgMutation((id, alertId: string) => api.post(orgPath(id, `/alerts/${alertId}/ack`)), ['alerts', 'dashboard']);
  const ackAll = useOrgMutation((id, _: void) => api.post(orgPath(id, '/alerts/ack-all')), ['alerts', 'dashboard'], () => toast.push('Everything that needed attention is acknowledged. Resolved alerts were left as they are.'));
  return (
    <>
      <PageHead eyebrow="Overview" title="Alerts" subtitle="Low stock, out of stock, collection problems and finished reports. Each change alerts once — an unchanged state never repeats. An alert closes by itself when the condition clears, or you can close it with a note."
        actions={<button className="btn" onClick={() => ackAll.mutate(undefined)} disabled={ackAll.isPending}>Acknowledge all</button>} />
      {(ack.error || ackAll.error) && <div className="callout bad" role="alert" style={{ marginBottom: 12 }}>{errorMessage(ack.error ?? ackAll.error)}</div>}
      <Tabs value={status} onChange={(s) => { setStatus(s); setPage(1); }} tabs={[{ id: 'open', label: 'Needs attention' }, { id: 'acknowledged', label: 'Acknowledged' }, { id: 'resolved', label: 'Resolved' }, { id: 'all', label: 'All' }]} />
      <DataState q={q} isEmpty={(d) => d.total === 0} empty={<Card><EmptyState title={status === 'open' ? 'You’re all caught up' : 'No alerts here'}>New alerts appear here and in your email. You can choose which ones to receive in Settings → Notifications.</EmptyState></Card>}>
        {(d) => (
          <Card pad={false}>
            {d.rows.map((a) => (
              <div className="insight" key={a.id} style={{ gridTemplateColumns: 'auto 1fr auto', opacity: a.status === 'open' ? 1 : 0.8 }}>
                <span className={`pill ${a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : 'info'}`}>{a.type.replace(/_/g, ' ')}</span>
                <div>
                  <h4>{a.title}</h4>
                  {a.body && <p>{a.body}</p>}
                  <div className="small muted">
                    <Age iso={a.createdAt} />
                    {a.siteName && <> · {a.siteName}</>}
                    {a.productId && <> · <Link to={`/o/${orgId}/products/${a.productId}`}>{a.productTitle ?? 'product'}</Link></>}
                    {a.reportId && <> · <Link to={`/o/${orgId}/reports/${a.reportId}`}>open report</Link></>}
                    {' · '}<StatusText a={a} />
                  </div>
                  <AlertHistory a={a} />
                </div>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  {a.status === 'open' && <button className="btn btn-sm" onClick={() => ack.mutate(a.id)} disabled={ack.isPending}>Acknowledge</button>}
                  {a.status !== 'resolved' && a.resolvable && <button className="btn btn-sm" onClick={() => setResolving(a)}>Mark resolved…</button>}
                </div>
              </div>
            ))}
            <Pager page={page} pageSize={25} total={d.total} onPage={setPage} />
          </Card>
        )}
      </DataState>
      {resolving && <ResolveDialog alert={resolving} onClose={() => setResolving(null)} />}
    </>
  );
}

function StatusText({ a }: { a: AlertDetail }) {
  if (a.status === 'resolved' && a.resolution) {
    return <b>{a.resolution.kind === 'automatic' ? 'Resolved automatically' : `Resolved by ${a.resolution.by ?? 'a team member'}`} · <Age iso={a.resolution.at} /></b>;
  }
  if (a.status === 'acknowledged') return <b>Acknowledged{a.acknowledgedBy ? ` by ${a.acknowledgedBy}` : ''}{a.acknowledgedAt ? <> · <Age iso={a.acknowledgedAt} /></> : null}</b>;
  return <b>{a.resolvable ? 'Open — the condition is still current' : 'New'}</b>;
}

/** What the alert is based on: the page we looked at (or the authorised connection), the numbers, and how it ended. */
function AlertHistory({ a }: { a: AlertDetail }) {
  const d = a.data as { quantity?: number | null; threshold?: number; basis?: string; from?: string | null; to?: string; quantitySource?: string | null; observedAt?: string; connectionId?: string | null };
  const basis = d.basis ? BASIS[d.basis] : null;
  const fromConnection = !a.evidence && (d.quantitySource === 'authorised_inventory' || d.quantitySource === 'simulated' || !!d.connectionId);
  const hasAnything = a.evidence || basis || a.resolution || fromConnection;
  if (!hasAnything) return null;
  return (
    <details className="ev">
      <summary>Evidence and history</summary>
      <dl className="kv">
        {(a.type === 'low_stock' || a.type === 'out_of_stock' || a.type === 'restocked') && (
          <>
            <dt>Quantity</dt>
            <dd>{d.quantity === null || d.quantity === undefined ? 'unknown — your website does not publish a unit count' : `${d.quantity} (alert threshold ${d.threshold ?? '—'})`}</dd>
            {d.from && d.to && (<><dt>Change</dt><dd>{d.from.replace(/_/g, ' ')} → {d.to.replace(/_/g, ' ')}</dd></>)}
            {basis && (<><dt>Based on</dt><dd>{basis}</dd></>)}
          </>
        )}
        <dt>What we looked at</dt>
        <dd>
          {a.evidence ? <EvidenceLine e={a.evidence} /> : fromConnection ? 'Your authorised inventory connection (no web page involved).' : 'Collection monitoring — no single page.'}
        </dd>
        {a.resolution && (
          <>
            <dt>{a.resolution.kind === 'automatic' ? 'Resolved automatically' : 'Resolved by'}</dt>
            <dd>
              {formatDateTime(a.resolution.at)}{a.resolution.kind === 'manual' && a.resolution.by ? ` — ${a.resolution.by}` : ''}
              {a.resolution.note && <div className="muted">{a.resolution.note}</div>}
              {a.resolution.evidence && <div><EvidenceLine e={a.resolution.evidence} /></div>}
            </dd>
          </>
        )}
      </dl>
    </details>
  );
}

function EvidenceLine({ e }: { e: AlertEvidence }) {
  return (
    <>
      <a href={e.url} target="_blank" rel="noreferrer noopener">{e.url} <ArrowIcon /></a> · observed {formatDateTime(e.observedAt)} <ProvenancePill value={e.provenance} />
      {e.snapshotPurged && <span className="muted"> · the stored copy of the page has been removed under your retention settings</span>}
      {e.snippet && <blockquote className="snippet">{e.snippet}</blockquote>}
    </>
  );
}

function ResolveDialog({ alert, onClose }: { alert: AlertDetail; onClose: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const m = useOrgMutation((id, _: void) => api.post(orgPath(id, `/alerts/${alert.id}/resolve`), { note: note.trim() || undefined }), ['alerts', 'dashboard'], () => {
    toast.push('Alert resolved.');
    onClose();
  });
  return (
    <Modal title="Mark this alert as resolved" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => m.mutate(undefined)} disabled={m.isPending}>Mark resolved</button></>}>
      <p><b>{alert.title}</b></p>
      <p className="muted">If the condition clears on its own, the alert closes automatically. Close it yourself when it has been dealt with — for example, stock was ordered. If the same condition starts again later, it raises a new alert.</p>
      {m.error && <div className="callout bad" role="alert">{errorMessage(m.error)}</div>}
      <div className="field"><label htmlFor="res-note">What was done? (optional)</label><textarea id="res-note" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: reordered 40 units, arriving Friday" /></div>
    </Modal>
  );
}
