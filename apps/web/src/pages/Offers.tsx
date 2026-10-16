import { Fragment, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { REVIEWABLE_OFFER_KINDS, formatMoney, formatDateTime, type OfferRow } from '@ci/shared';
import { api, errorMessage, orgPath, qs } from '../api';
import { useOrg, useOrgMutation, useOrgQuery } from '../app-shell';
import { Age, ArrowIcon, Card, DataState, EmptyState, Modal, PageHead, ProvenancePill, useToast } from '../ui';

const KIND_LABEL: Record<string, string> = { sale_price: 'Sale price', banner: 'Banner', coupon: 'Coupon code', minimum_order: 'Minimum order', bundle: 'Bundle', buy_x_get_y: 'Buy X get Y', payment_offer: 'Payment offer', cashback: 'Cashback', free_shipping: 'Free shipping', time_limited: 'Time-limited', flyer: 'Flyer item' };
const VERIFY: Record<string, { label: string; cls: string; help: string }> = {
  verified: { label: 'Checked against history', cls: 'good', help: 'The “was” price matches what this product actually sold for before.' },
  contradicted: { label: 'Looks overstated', cls: 'bad', help: 'The “was” price is higher than what the product was selling for before the offer.' },
  insufficient_history: { label: 'Not enough history', cls: 'warn', help: 'Some earlier prices exist but not enough to check the claim yet.' },
  unverified: { label: 'Unverified', cls: '', help: 'No earlier price history, or the offer states no prices.' },
};

const REVIEW_LABEL: Record<string, string> = { unreviewed: 'Not reviewed', confirmed: 'Confirmed by a person', corrected: 'Corrected by a person', dismissed: 'Dismissed: not an offer' };

export function OffersPage() {
  const { isAdmin } = useOrg();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const kind = sp.get('kind') ?? '';
  const status = sp.get('status') ?? 'active';
  const siteId = sp.get('siteId') ?? '';
  const review = sp.get('review') ?? '';
  const [open, setOpen] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<OfferRow | null>(null);
  const q = useOrgQuery<{ offers: OfferRow[]; note: string }>(['offers', kind, status, siteId, review], `/offers${qs({ kind, status: status === 'all' ? '' : status, siteId, review, days: 60 })}`);
  const decide = useOrgMutation((id, v: { offerId: string; action: 'confirm' | 'dismiss' }) => api.post(orgPath(id, `/offers/${v.offerId}/review`), { action: v.action }), ['offers', 'dashboard'], (_d, v) => toast.push(v.action === 'confirm' ? 'Confirmed. This stays as you decided it, even when the flyer is collected again.' : 'Dismissed. It is no longer counted as an offer.'));
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };
  return (
    <>
      <PageHead eyebrow="Market" title="Offers, discounts and flyers" subtitle="Sale prices, banners, codes and weekly flyers as the websites show them. We state the conditions explicitly, and a “was” price is checked against the product’s own price history before we call a discount real." />
      <div className="filters">
        <div className="field"><label htmlFor="o-k">Type</label><select id="o-k" value={kind} onChange={(e) => set('kind', e.target.value)}><option value="">All types</option>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="field"><label htmlFor="o-s">Status</label><select id="o-s" value={status} onChange={(e) => set('status', e.target.value)}><option value="active">Active now</option><option value="all">All (last 60 days)</option><option value="presumed_ended">Probably ended</option><option value="expired">Expired</option><option value="ended">Ended</option></select></div>
        <div className="field"><label htmlFor="o-r">Review</label><select id="o-r" value={review} onChange={(e) => set('review', e.target.value)}><option value="">Everything shown</option><option value="needs_review">Needs review</option><option value="reviewed">Reviewed by a person</option><option value="dismissed">Dismissed</option></select></div>
      </div>
      {decide.error && <div className="callout bad" role="alert" style={{ marginBottom: 12 }}>{errorMessage(decide.error)}</div>}
      <DataState q={q} isEmpty={(d) => d.offers.length === 0} empty={<Card><EmptyState title="No offers found">Offers appear after websites have been collected. Banner offers are found during the capability check; sale prices and flyers during collection.</EmptyState></Card>}>
        {(d) => (
          <>
            <Card pad={false}>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Website</th><th>Offer</th><th>Prices</th><th className="r">Claimed</th><th>Check against history</th><th>Valid</th><th>Source type</th><th>Seen</th><th /></tr></thead>
                  <tbody>
                    {d.offers.map((o) => (
                      <Fragment key={o.id}>
                        <tr>
                          <td>{o.siteName}<div className="sub">{o.siteRole === 'source' ? 'your shop' : 'competitor'}</div></td>
                          <td style={{ maxWidth: 380 }}>
                            <div className="title">{o.title}</div>
                            <div className="sub"><span className="pill">{KIND_LABEL[o.kind] ?? o.kind}</span>{o.conditional ? <span className="pill warn" style={{ marginLeft: 4 }}>conditional</span> : <span className="pill good" style={{ marginLeft: 4 }}>unconditional</span>}{o.needsReview && <span className="pill warn" style={{ marginLeft: 4 }}>needs review</span>}{o.status !== 'active' && <span className="pill" style={{ marginLeft: 4 }}>{o.status.replace('_', ' ')}</span>}</div>
                            {o.conditions.length > 0 && <div className="small" style={{ marginTop: 3 }}>Conditions: {o.conditions.join(' · ')}</div>}
                            {o.code && <div className="small">Code: <code>{o.code}</code></div>}
                          </td>
                          <td className="num">{o.originalPrice !== null || o.salePrice !== null ? <>{o.originalPrice !== null && <s className="muted">{formatMoney(o.originalPrice, o.currency)}</s>} <b>{formatMoney(o.salePrice, o.currency)}</b></> : <span className="muted">—</span>}</td>
                          <td className="r num">{o.claimedDiscountPct !== null ? `${o.claimedDiscountPct}%` : '—'}{o.historicalDiscountPct !== null && <div className="sub">vs history {o.historicalDiscountPct}%</div>}</td>
                          <td><span className={`pill ${VERIFY[o.verification]?.cls}`} title={VERIFY[o.verification]?.help}>{VERIFY[o.verification]?.label}</span></td>
                          <td className="small">{o.validTo ? <>until {formatDateTime(o.validTo)}</> : <span className="muted">no end date stated</span>}</td>
                          <td><ProvenancePill value={o.provenance} /></td>
                          <td className="small">first <Age iso={o.firstSeenAt} /><br />last <Age iso={o.lastSeenAt} /></td>
                          <td className="r">{o.sourceUrl && <a href={o.sourceUrl} target="_blank" rel="noreferrer noopener">source <ArrowIcon /></a>}<br /><button className="btn btn-sm btn-ghost" onClick={() => setOpen(open === o.id ? null : o.id)}>{open === o.id ? 'Hide' : 'Details'}</button></td>
                        </tr>
                        {open === o.id && (
                          <tr key={`${o.id}-d`}><td colSpan={8} style={{ background: '#fafcfc' }}>
                            <div className="small"><b>Verification:</b> {VERIFY[o.verification]?.help}<br /><b>Confidence in the reading:</b> {o.confidence !== null ? `${Math.round(o.confidence * 100)}%` : '—'} · <b>Description:</b> {o.description ?? '—'}</div>
                            {o.review && (
                              <div className="small" style={{ marginTop: 6 }}>
                                <b>Review:</b> {REVIEW_LABEL[o.review.status]}{o.review.by ? ` by ${o.review.by}` : ''}{o.review.at ? <> · <Age iso={o.review.at} /></> : null}{o.review.note ? ` — “${o.review.note}”` : ''}
                                {o.review.originalReading && <div className="muted">The machine read: {String(o.review.originalReading['title'] ?? '—')} · sale {formatMoney(o.review.originalReading['salePrice'] as number | null, o.currency)} · was {formatMoney(o.review.originalReading['originalPrice'] as number | null, o.currency)}</div>}
                              </div>
                            )}
                            {isAdmin && (REVIEWABLE_OFFER_KINDS as readonly string[]).includes(o.kind) && (
                              <div className="row" style={{ marginTop: 8 }}>
                                {o.review?.status !== 'confirmed' && <button className="btn btn-sm btn-primary" disabled={decide.isPending} onClick={() => decide.mutate({ offerId: o.id, action: 'confirm' })}>Yes, this is read correctly</button>}
                                {o.kind === 'flyer' && <button className="btn btn-sm" onClick={() => setCorrecting(o)}>Correct what was read…</button>}
                                {o.review?.status !== 'dismissed' && <button className="btn btn-sm btn-danger" disabled={decide.isPending} onClick={() => decide.mutate({ offerId: o.id, action: 'dismiss' })}>This is not an offer</button>}
                              </div>
                            )}
                          </td></tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            {correcting && <CorrectOffer offer={correcting} onClose={() => setCorrecting(null)} />}
            <p className="small muted" style={{ marginTop: 10 }}>{d.note} An offer that stops appearing is only marked “probably ended” after enough time <i>and</i> several complete collections without it; a failed or partial collection never ends an offer.</p>
          </>
        )}
      </DataState>
    </>
  );
}

const dayOf = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

/** Fix what the flyer reader got wrong. The original reading is kept for the record, and the correction is never overwritten by a later collection. */
function CorrectOffer({ offer, onClose }: { offer: OfferRow; onClose: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(offer.title);
  const [sale, setSale] = useState(offer.salePrice?.toString() ?? '');
  const [was, setWas] = useState(offer.originalPrice?.toString() ?? '');
  const [from, setFrom] = useState(dayOf(offer.validFrom));
  const [to, setTo] = useState(dayOf(offer.validTo));
  const [note, setNote] = useState('');
  const m = useOrgMutation(
    (id, _: void) =>
      api.post(orgPath(id, `/offers/${offer.id}/review`), {
        action: 'correct',
        title: title.trim() || undefined,
        salePrice: sale.trim() ? Number(sale) : undefined,
        originalPrice: was.trim() ? Number(was) : undefined,
        validFrom: from ? `${from}T00:00:00.000Z` : null,
        validTo: to ? `${to}T23:59:59.000Z` : null,
        note: note.trim() || undefined,
      }),
    ['offers', 'dashboard'],
    () => {
      toast.push('Corrected. The original reading is kept, and your correction stays when the flyer is collected again.');
      onClose();
    },
  );
  return (
    <Modal title="Correct what was read from the flyer" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => m.mutate(undefined)} disabled={m.isPending}>Save correction</button></>}>
      <div className="stack-s">
        <p className="muted" style={{ margin: 0 }}>Check the numbers against the flyer itself{offer.sourceUrl && <> (<a href={offer.sourceUrl} target="_blank" rel="noreferrer noopener">open it <ArrowIcon /></a>)</>}. Leave “was” empty if the flyer states no earlier price.</p>
        {m.error && <div className="callout bad" role="alert">{errorMessage(m.error)}</div>}
        <div className="field"><label htmlFor="c-title">Product or offer</label><input id="c-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="grid2">
          <div className="field"><label htmlFor="c-sale">Sale price ({offer.currency ?? '?'})</label><input id="c-sale" inputMode="decimal" value={sale} onChange={(e) => setSale(e.target.value)} /></div>
          <div className="field"><label htmlFor="c-was">Price before ({offer.currency ?? '?'})</label><input id="c-was" inputMode="decimal" value={was} onChange={(e) => setWas(e.target.value)} /></div>
          <div className="field"><label htmlFor="c-from">Valid from</label><input id="c-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field"><label htmlFor="c-to">Valid until (whole day)</label><input id="c-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
        <div className="field"><label htmlFor="c-note">What was wrong? (optional)</label><input id="c-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="For example: the price was split across two lines" /></div>
      </div>
    </Modal>
  );
}
