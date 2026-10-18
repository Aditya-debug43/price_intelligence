import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CAPABILITY_EXPLANATIONS, adviceForLimitation, formatDateTime, type FieldKey } from '@ci/shared';
import { api, errorMessage, orgPath } from '../api';
import { useOrg, useOrgMutation, useOrgQuery } from '../app-shell';
import { Age, ArrowIcon, CapabilityPill, Card, DataState, EmptyState, Modal, PageHead, SiteStatusPill, Spinner, useToast } from '../ui';
import { JourneyCard } from '../journey';
import type { ProfileResponse, ScanDetailData, ScanRun, SiteItem, SitesResponse } from '../types';

const FIELD_LABELS: Record<FieldKey, string> = {
  title: 'Product name', price: 'Price', compare_at_price: 'Was-price (compare-at)', currency: 'Currency', availability: 'In stock / out of stock', brand: 'Brand', sku: 'SKU', gtin: 'Barcode (GTIN)',
  description: 'Description', category: 'Category', image: 'Image', variants: 'Variants', size_or_weight: 'Size / weight', shipping_cost: 'Shipping cost', stock_quantity: 'Exact stock count',
};

export function WebsitesPage() {
  const { orgId, isAdmin } = useOrg();
  const q = useOrgQuery<SitesResponse>('sites', '/sites', { refetchInterval: 8000 });
  const nav = useNavigate();
  const toast = useToast();
  const profileAll = useOrgMutation(async (id, sites: SiteItem[]) => Promise.all(sites.map((s) => api.post(orgPath(id, `/sites/${s.id}/profile`)))), ['sites'], () => toast.push('Re-checking every website…'));
  return (
    <>
      <PageHead
        eyebrow="Set up"
        title="Websites"
        subtitle="What we can collect from each website, under the access rules it publishes. A failed or blocked website is always shown as such — never as an empty catalogue."
        actions={isAdmin && (
          <>
            <button className="btn" onClick={() => q.data && profileAll.mutate(q.data.sites)} disabled={!q.data?.sites.length}>Re-check all</button>
            <Link className="btn btn-primary" to={`/o/${orgId}/setup`}>Edit websites</Link>
          </>
        )}
      />
      <div style={{ marginBottom: 14 }}><JourneyCard compact /></div>
      <DataState q={q} isEmpty={(d) => d.sites.length === 0} empty={<Card><EmptyState title="No websites yet" action={<Link className="btn btn-primary" to={`/o/${orgId}/setup`}>Add your website and competitors</Link>}>Add your own website and three to five competitors to begin.</EmptyState></Card>}>
        {(d) => (
          <Card pad={false}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Website</th><th>Status</th><th>Capability</th><th>Permission</th><th>Platform</th><th>Currency</th><th className="r">Products</th><th /></tr></thead>
                <tbody>
                  {d.sites.map((s) => (
                    <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/o/${orgId}/websites/${s.id}`)}>
                      <td><Link to={`/o/${orgId}/websites/${s.id}`} className="title" onClick={(e) => e.stopPropagation()}>{s.name}</Link><div className="sub">{s.role === 'source' ? 'Your website' : 'Competitor'} · {s.hostname}</div></td>
                      <td style={{ maxWidth: 260 }}><SiteStatusPill status={s.status} />{s.status && <div className="sub" style={{ whiteSpace: 'normal' }}>{s.status.nextAction ? <b>Next: {s.status.nextAction}.</b> : s.status.detail}{s.lastScan?.finishedAt && <> · last collection <Age iso={s.lastScan.finishedAt} /></>}</div>}</td>
                      <td><CapabilityPill status={s.capabilityStatus} /><div className="sub">{s.lastProfiledAt ? <>checked <Age iso={s.lastProfiledAt} /></> : 'not checked yet'}</div></td>
                      <td>{s.consentStatus === 'confirmed' ? <span className="pill good">Recorded</span> : s.consentStatus === 'revoked' ? <span className="pill bad">Withdrawn</span> : <span className="pill warn">Needed</span>}</td>
                      <td>{s.platform ?? '—'}</td>
                      <td>{s.currency ?? <span className="muted">unknown</span>}</td>
                      <td className="r num">{s.productCount}</td>
                      <td className="r"><Link className="btn btn-sm" to={`/o/${orgId}/websites/${s.id}`} onClick={(e) => e.stopPropagation()}>Open</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </DataState>
    </>
  );
}

// ───────────────────────────────────────────────────────────── detail
export function SiteDetailPage() {
  const [openScan, setOpenScan] = useState<string | null>(null);
  const { siteId = '' } = useParams();
  const { orgId, isAdmin } = useOrg();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const sites = useOrgQuery<SitesResponse>('sites', '/sites', { refetchInterval: 6000 });
  const site = sites.data?.sites.find((s) => s.id === siteId);
  const [waitingSince, setWaitingSince] = useState<string | null>(null);
  const profile = useOrgQuery<ProfileResponse>(['profile', siteId], `/sites/${siteId}/profile`, { refetchInterval: waitingSince ? 1500 : false });
  const scans = useOrgQuery<{ scans: ScanRun[] }>(['scans', siteId], `/scans?siteId=${siteId}&pageSize=15`, { refetchInterval: (query) => ((query.state.data as { scans: ScanRun[] } | undefined)?.scans.some((s) => ['queued', 'running'].includes(s.status)) ? 2000 : 15_000) });
  const history = useOrgQuery<{ profiles: { id: string; status: string; summary: string; createdAt: string }[] }>(['profiles', siteId], `/sites/${siteId}/profiles`);

  useEffect(() => {
    if (waitingSince && profile.data?.profile && profile.data.profile.createdAt > waitingSince) {
      setWaitingSince(null);
      void qc.invalidateQueries({ queryKey: ['org', orgId] });
      toast.push('Capability check finished.');
    }
  }, [profile.data, waitingSince, qc, orgId, toast]);

  const runProfile = useOrgMutation((id, _: void) => api.post<{ requestedAt: string }>(orgPath(id, `/sites/${siteId}/profile`)), [], (r) => setWaitingSince(r.requestedAt));
  const collect = useOrgMutation((id, v: { kind: 'discovery' | 'sample'; limit?: number }) => api.post(orgPath(id, `/sites/${siteId}/scans`), v), [['scans', siteId], 'sites', 'dashboard'], () => toast.push('Collection queued.'));
  const cancel = useOrgMutation((id, scanId: string) => api.post(orgPath(id, `/scans/${scanId}/cancel`)), [['scans', siteId], 'dashboard']);
  const remove = useOrgMutation((id, _: void) => api.del(orgPath(id, `/sites/${siteId}`)), ['sites', 'dashboard'], () => nav(`/o/${orgId}/websites`));
  const [consentOpen, setConsentOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  if (sites.isLoading) return <Spinner label="Loading website" />;
  if (!site) return <div className="callout bad">This website isn’t in your workspace. <Link to={`/o/${orgId}/websites`}>Back to websites</Link></div>;
  const p = profile.data?.profile?.data;
  const running = scans.data?.scans.find((s) => ['queued', 'running'].includes(s.status));
  return (
    <>
      <PageHead
        eyebrow={site.role === 'source' ? 'Your website' : 'Competitor website'}
        docTitle={site.name}
        title={<>{site.name}</>}
        subtitle={<><a href={site.url} target="_blank" rel="noreferrer noopener">{site.url} <ArrowIcon /></a></>}
        actions={isAdmin && (
          <>
            <button className="btn" onClick={() => runProfile.mutate(undefined)} disabled={runProfile.isPending || !!waitingSince}>{waitingSince ? <Spinner label="Checking…" /> : 'Re-check capabilities'}</button>
            <button className="btn btn-danger" onClick={() => setRemoveOpen(true)}>Remove</button>
          </>
        )}
      />
      <div className="stack">
        <Card title="What we can collect">
          {profile.isLoading ? <Spinner label="Loading capability report" /> : !p ? (
            <EmptyState title="Not checked yet" action={isAdmin ? <button className="btn btn-primary" onClick={() => runProfile.mutate(undefined)} disabled={!!waitingSince}>Check this website now</button> : undefined}>
              A capability check reads robots.txt, the homepage, sitemaps and a few sample product pages (typically 10–20 requests). It doesn’t collect the catalogue.
            </EmptyState>
          ) : (
            <div className="stack">
              <div className="row"><CapabilityPill status={p.status} big /><span style={{ fontSize: 15.5 }}>{p.summary}</span></div>
              <div className="small muted">{CAPABILITY_EXPLANATIONS[p.status]} Checked {formatDateTime(profile.data!.profile!.createdAt)} using {p.requestsMade} request{p.requestsMade === 1 ? '' : 's'} in {(p.durationMs / 1000).toFixed(1)} s.</div>
              {p.limitations.length > 0 && (
                <div className="stack-s">
                  {p.limitations.map((l, i) => {
                    const advice = adviceForLimitation(l.code);
                    return <div key={i} className={`callout ${l.severity === 'blocking' ? 'bad' : l.severity === 'warning' ? 'warn' : 'info'}`}>{l.message}{advice && <div className="small" style={{ marginTop: 4 }}><b>What you can do:</b> {advice}</div>}</div>;
                  })}
                </div>
              )}
            </div>
          )}
        </Card>

        <div className="grid2">
          <Card title="Permission to collect">
            <ConsentBlock site={site} text={sites.data!.consentText} onOpen={() => setConsentOpen(true)} />
          </Card>
          <Card title="Collection" actions={isAdmin && running && <button className="btn btn-sm btn-danger" onClick={() => cancel.mutate(running.id)}>Cancel</button>}>
            <div className="stack">
              {site.consentStatus !== 'confirmed' && <div className="callout warn">Collection is switched off until permission is recorded for this website.</div>}
              <div className="row">
                <button className="btn btn-primary" disabled={!isAdmin || site.consentStatus !== 'confirmed' || !!running || collect.isPending} onClick={() => collect.mutate({ kind: 'discovery' })}>Collect catalogue</button>
                <button className="btn" disabled={!isAdmin || site.consentStatus !== 'confirmed' || !!running || collect.isPending} onClick={() => collect.mutate({ kind: 'sample', limit: 25 })} title="Fetch only 25 products — a fast way to confirm everything works.">Small live refresh (25)</button>
              </div>
              {collect.error && <div className="callout bad" role="alert">{errorMessage(collect.error)}</div>}
              <p className="small muted" style={{ margin: 0 }}>Large catalogues are refreshed on a rolling basis inside a request budget of {site.maxRequestsPerRun} requests with at least {site.crawlDelayMs / 1000} s between requests. Collection stops if the website denies access.</p>
            </div>
          </Card>
        </div>

        <Card title="Collection history" pad={false}>
          <DataState q={scans} isEmpty={(d) => d.scans.length === 0} empty={<div className="card-b"><EmptyState title="Nothing collected yet" /></div>}>
            {(d) => (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Started</th><th>Kind</th><th>Status</th><th>Method</th><th className="r">Products</th><th>Progress</th><th>Notes</th><th /></tr></thead>
                  <tbody>
                    {d.scans.map((s) => {
                      const pctDone = s.estimatedTotal ? Math.min(100, Math.round((s.productsSaved / s.estimatedTotal) * 100)) : null;
                      return (
                        <Fragment key={s.id}>
                        <tr>
                          <td><Age iso={s.startedAt ?? s.createdAt} /></td>
                          <td>{s.kind}{s.trigger === 'scheduled' && <span className="sub"> scheduled</span>}</td>
                          <td><span className={`pill ${s.status === 'succeeded' ? 'good' : s.status === 'partial' ? 'warn' : ['failed', 'blocked'].includes(s.status) ? 'bad' : s.status === 'running' ? 'info' : ''}`}>{s.status}</span></td>
                          <td className="small">{s.connector ?? '—'}</td>
                          <td className="r num">{s.productsSaved}{s.estimatedTotal ? <span className="muted"> / ~{s.estimatedTotal}</span> : null}</td>
                          <td style={{ minWidth: 110 }}>{['queued', 'running'].includes(s.status) ? <div className="progress"><div style={{ width: `${pctDone ?? 15}%` }} /></div> : s.isComplete ? <span className="small">complete catalogue</span> : <span className="small muted">not a full catalogue</span>}</td>
                          <td className="small" style={{ maxWidth: 360 }}>{s.error ?? s.notes[0] ?? ''}</td>
                          <td className="r"><button className="btn btn-sm btn-ghost" aria-expanded={openScan === s.id} onClick={() => setOpenScan(openScan === s.id ? null : s.id)}>{openScan === s.id ? 'Hide details' : 'Details'}</button></td>
                        </tr>
                        {openScan === s.id && <tr><td colSpan={8} style={{ background: 'var(--salt, #f4f7f6)' }}><ScanDetailPanel scanId={s.id} /></td></tr>}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </DataState>
        </Card>

        {p && <ProfileBody siteId={siteId} p={p} site={site} />}

        {history.data && history.data.profiles.length > 1 && (
          <Card title="Earlier capability checks" pad={false}>
            <table className="table"><thead className="sr-only"><tr><th>When</th><th>Result</th><th>Summary</th></tr></thead><tbody>{history.data.profiles.map((h) => <tr key={h.id}><td className="nowrap">{formatDateTime(h.createdAt)}</td><td><CapabilityPill status={h.status} /></td><td className="small">{h.summary}</td></tr>)}</tbody></table>
          </Card>
        )}
      </div>
      {consentOpen && <ConsentModal site={site} text={sites.data!.consentText} onClose={() => setConsentOpen(false)} />}
      {removeOpen && (
        <Modal title={`Remove ${site.name}?`} onClose={() => setRemoveOpen(false)} footer={<><button className="btn" onClick={() => setRemoveOpen(false)}>Keep it</button><button className="btn btn-danger" onClick={() => remove.mutate(undefined)} disabled={remove.isPending}>Remove website and its data</button></>}>
          <p>This deletes the website’s collected products, price history, offers and matches from your workspace. Saved reports are kept as they were generated.</p>
        </Modal>
      )}
    </>
  );
}

function ConsentBlock({ site, text, onOpen }: { site: SiteItem; text: SitesResponse['consentText']; onOpen: () => void }) {
  const { isAdmin } = useOrg();
  return (
    <div className="stack">
      <div className="row">
        {site.consentStatus === 'confirmed' ? <span className="pill good">Recorded {formatDateTime(site.consentAt)}</span> : site.consentStatus === 'revoked' ? <span className="pill bad">Withdrawn</span> : <span className="pill warn">Not recorded</span>}
      </div>
      <p className="small" style={{ margin: 0 }}>{site.role === 'source' ? text.source : text.competitor}</p>
      <p className="small muted" style={{ margin: 0 }}>We never log in to websites, solve CAPTCHAs, rotate identities or bypass rate limits. Each website’s robots.txt and rate limits are always followed.</p>
      {isAdmin && <div className="row">{site.consentStatus !== 'confirmed' ? <button className="btn btn-tag" onClick={onOpen}>Record permission…</button> : <button className="btn btn-sm btn-danger" onClick={onOpen}>Withdraw permission…</button>}</div>}
    </div>
  );
}

function ConsentModal({ site, text, onClose }: { site: SiteItem; text: SitesResponse['consentText']; onClose: () => void }) {
  const [attest, setAttest] = useState(false);
  const [note, setNote] = useState('');
  const withdraw = site.consentStatus === 'confirmed';
  const toast = useToast();
  const m = useOrgMutation((id, _: void) => api.post(orgPath(id, `/sites/${site.id}/consent`), { status: withdraw ? 'revoked' : 'confirmed', attest, note: note || undefined }), ['sites', 'dashboard'], () => {
    toast.push(withdraw ? 'Permission withdrawn. Queued collections were cancelled.' : 'Permission recorded.');
    onClose();
  });
  return (
    <Modal title={withdraw ? 'Withdraw permission' : 'Record permission'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className={`btn ${withdraw ? 'btn-danger' : 'btn-primary'}`} disabled={(!withdraw && !attest) || m.isPending} onClick={() => m.mutate(undefined)}>{withdraw ? 'Withdraw permission' : 'Record permission'}</button></>}>
      <div className="stack">
        <p>{withdraw ? `Collection from ${site.name} will stop and queued runs will be cancelled. Existing data stays until you remove the website.` : (site.role === 'source' ? text.source : text.competitor)}</p>
        {!withdraw && <label className="check"><input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} /><span>I confirm the statement above on behalf of my business.</span></label>}
        <div className="field"><label htmlFor="cn">Note for your records (optional)</label><input id="cn" type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. approved by the owner on 14 Oct" /></div>
        {m.error && <div className="callout bad" role="alert">{errorMessage(m.error)}</div>}
      </div>
    </Modal>
  );
}

function ProfileBody({ siteId, p, site }: { siteId: string; p: NonNullable<ProfileResponse['profile']>['data']; site: SiteItem }) {
  const { orgId, isAdmin } = useOrg();
  const [cur, setCur] = useState(site.currency ?? '');
  const toast = useToast();
  const setCurrency = useOrgMutation((id, currency: string | null) => api.patch(orgPath(id, `/sites/${siteId}`), { currency }), ['sites', 'dashboard'], () => toast.push('Currency saved.'));
  const initial = useRef(site.currency);
  useEffect(() => { initial.current = site.currency; setCur(site.currency ?? ''); }, [site.currency]);
  const fields = Object.entries(p.fields) as [FieldKey, (typeof p.fields)[FieldKey]][];
  return (
    <>
      <div className="grid2">
        <Card title="Fields available">
          <div className="fields">
            {fields.map(([k, f]) => (
              <div key={k} className={`fieldcap ${f.availability}`} title={f.note ?? undefined}>
                <div className="n">{FIELD_LABELS[k]}</div>
                <div className="small muted">{f.availability === 'available' ? 'Available' : f.availability === 'partial' ? 'Partly available' : f.availability === 'missing' ? 'Not available' : 'Not measured'}{f.coverage !== null ? ` · ${Math.round(f.coverage * 100)}% of samples` : ''}</div>
                {f.source && <div className="small muted">{f.source}</div>}
              </div>
            ))}
          </div>
        </Card>
        <div className="stack">
          <Card title="How we collect it">
            <dl className="kv">
              <dt>Platform</dt><dd>{p.platform.id}{p.platform.confidence ? ` (${Math.round(p.platform.confidence * 100)}% sure)` : ''}<div className="small muted">{p.platform.evidence.join('; ')}</div></dd>
              <dt>Method</dt><dd>{p.strategy.primary ?? <b>none available</b>}<div className="small muted">{p.strategy.reason}</div></dd>
              <dt>Fallbacks</dt><dd>{p.strategy.recommended.slice(1).join(', ') || '—'}</dd>
              <dt>Catalogue size</dt><dd>{p.catalogue.estimatedProducts ? `about ${p.catalogue.estimatedProducts.toLocaleString()} products` : 'unknown'}<div className="small muted">{p.catalogue.estimateBasis}</div></dd>
              <dt>Effort</dt><dd>{p.effort.requestsEstimate ? `~${p.effort.requestsEstimate.toLocaleString()} requests` : '—'}{p.effort.minutesEstimate ? `, about ${p.effort.minutesEstimate} min` : ''}<div className="small muted">{p.effort.notes} Waits at least {p.effort.crawlDelayMs / 1000} s between requests; budget {p.effort.maxRequestsPerRun.toLocaleString()} requests per run.</div></dd>
              <dt>JavaScript needed</dt><dd>{p.rendering.requiresJavaScript ? <b>Yes</b> : 'No'}<div className="small muted">{p.rendering.evidence}</div></dd>
            </dl>
          </Card>
          <Card title="Currency">
            <div className="stack-s">
              <div>Detected: <b>{p.currency.detected ?? 'unknown'}</b>{p.currency.conflicting && <span className="pill warn" style={{ marginLeft: 8 }}>conflicting evidence</span>}</div>
              <div className="small muted">{p.currency.evidence.join('; ') || 'No currency evidence found.'}</div>
              {isAdmin && (
                <div className="row">
                  <input type="text" aria-label="Currency code" maxLength={3} value={cur} onChange={(e) => setCur(e.target.value.toUpperCase())} style={{ width: 90 }} placeholder="USD" />
                  <button className="btn btn-sm" disabled={cur.length !== 3 || cur === site.currency} onClick={() => setCurrency.mutate(cur)}>Confirm this currency</button>
                  {site.currencySource === 'user' && <span className="small muted">confirmed by you</span>}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      <div className="grid2">
        <Card title="Access" >
          <dl className="kv">
            <dt>robots.txt</dt><dd>{p.access.robots.fetched ? 'Read' : 'Not available'} (HTTP {p.access.robots.httpStatus ?? '—'}){p.access.robots.note && <div className="small muted">{p.access.robots.note}</div>}</dd>
            <dt>Automated access</dt><dd>{p.access.robots.disallowsAll ? <b style={{ color: 'var(--coral)' }}>Not permitted</b> : 'Permitted for public pages'}{p.access.robots.crawlDelaySeconds ? ` · asks for ${p.access.robots.crawlDelaySeconds}s between requests` : ''}</dd>
            <dt>Login required</dt><dd>{p.access.loginRequired ? <b>Yes</b> : 'No'}</dd>
            <dt>Bot protection</dt><dd>{p.access.challengeDetected ? <b style={{ color: 'var(--coral)' }}>{p.access.challengeKind}</b> : 'None seen'}</dd>
            {p.access.barriers.length > 0 && (<><dt>Barriers</dt><dd>{p.access.barriers.join('; ')}</dd></>)}
          </dl>
        </Card>
        <Card title="Promotions and social accounts found on the homepage">
          <dl className="kv">
            <dt>Banners</dt><dd>{p.promotions.bannerTexts.length ? p.promotions.bannerTexts.map((t, i) => <div key={i}>“{t}”</div>) : '—'}</dd>
            <dt>Sale pages</dt><dd>{p.promotions.saleLinks.length ? p.promotions.saleLinks.map((u) => <div key={u}><a href={u} target="_blank" rel="noreferrer noopener">{u}</a></div>) : '—'}</dd>
            <dt>Flyers (PDF)</dt><dd>{p.promotions.flyerLinks.length ? p.promotions.flyerLinks.map((u) => <div key={u}><a href={u} target="_blank" rel="noreferrer noopener">{u}</a></div>) : '—'}</dd>
            <dt>Coupon codes</dt><dd>{p.promotions.couponMentions.join(', ') || '—'}</dd>
            <dt>Social</dt><dd>{[p.social.facebook, p.social.instagram, p.social.youtube].filter(Boolean).map((u) => <div key={u!}><a href={u!} target="_blank" rel="noreferrer noopener">{u}</a></div>)}{!p.social.facebook && !p.social.instagram && !p.social.youtube && '—'}<div className="small muted">Confirm accounts in <Link to={`/o/${orgId}/settings`}>Settings → Integrations</Link> before activity is read.</div></dd>
          </dl>
        </Card>
      </div>

      <Card title="Catalogue sources" pad={false}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Source</th><th>Kind</th><th className="r">Entries</th><th>Result</th></tr></thead>
            <tbody>
              {p.catalogue.publicApis.map((a) => <tr key={a.url}><td className="small">{a.url}</td><td>public API</td><td className="r num">{a.total ?? '—'}</td><td>{a.usable ? <span className="pill good">usable</span> : <span className="pill bad">unavailable</span>}<div className="sub">{a.notes}</div></td></tr>)}
              {p.catalogue.sitemaps.map((s) => <tr key={s.url}><td className="small">{s.url}</td><td>sitemap ({s.kind})</td><td className="r num">{s.urlCount ?? '—'}</td><td>{s.failed ? <span className="pill bad">could not be read</span> : <span className="pill good">read</span>}</td></tr>)}
              {!p.catalogue.publicApis.length && !p.catalogue.sitemaps.length && <tr><td colSpan={4} className="muted">No public feed or sitemap was found.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      {p.sampledProducts.length > 0 && (
        <Card title="Sample product pages we looked at" pad={false}>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Page</th><th>Title</th><th className="r">Price</th><th>Availability</th><th>Barcode</th><th>Read with</th></tr></thead>
              <tbody>{p.sampledProducts.map((s) => <tr key={s.url}><td className="small"><a href={s.url} target="_blank" rel="noreferrer noopener">{s.url.replace(/^https?:\/\//, '')}</a></td><td>{s.title ?? <span className="muted">not a product page, or unreadable</span>}</td><td className="r num">{s.price !== null ? `${s.currency ?? ''} ${s.price}` : '—'}</td><td>{s.availability ?? '—'}</td><td className="small">{s.gtin ?? '—'}</td><td className="small">{s.method ?? '—'}</td></tr>)}</tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}


/** What happened in one collection run, in plain language: what was collected, why it may be incomplete, which pages failed and why. */
function ScanDetailPanel({ scanId }: { scanId: string }) {
  const q = useOrgQuery<ScanDetailData>(['scan', scanId], `/scans/${scanId}`, { refetchInterval: (query) => (['queued', 'running'].includes(query.state.data?.run.status ?? '') ? 4000 : false) });
  return (
    <div style={{ padding: '10px 4px' }}>
      <DataState q={q} skeletonRows={2}>
        {(d) => {
          const r = d.run;
          const pillCls = d.explanation.completeness === 'complete' ? 'good' : d.explanation.completeness === 'partial' ? 'warn' : r.status === 'queued' || r.status === 'running' ? 'info' : 'bad';
          const seconds = r.startedAt && r.finishedAt ? Math.max(0, Math.round((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000)) : null;
          return (
            <div className="stack-s">
              <div className="row"><span className={`pill ${pillCls}`}>{d.explanation.completeness === 'complete' ? 'Complete catalogue' : d.explanation.completeness === 'partial' ? 'Partial' : r.status === 'queued' || r.status === 'running' ? 'In progress' : 'Nothing collected'}</span><b>{d.explanation.summary}</b></div>
              {d.explanation.reason && <div><b>Why:</b> {d.explanation.reason}</div>}
              {d.explanation.nextStep && <div><b>Next:</b> {d.explanation.nextStep}</div>}
              <dl className="kv" style={{ margin: 0 }}>
                <dt>Pages found</dt><dd className="num">{r.urlsDiscovered}</dd>
                <dt>Pages read</dt><dd className="num">{r.urlsFetched}</dd>
                <dt>Products saved</dt><dd className="num">{r.productsSaved}{r.estimatedTotal ? <span className="muted"> of about {r.estimatedTotal}</span> : null}</dd>
                <dt>Failed pages</dt><dd className="num">{d.queue.failed ?? 0}</dd>
                <dt>Skipped pages</dt><dd className="num">{d.queue.skipped ?? 0}</dd>
                <dt>Still to read</dt><dd className="num">{d.queue.pending ?? 0}</dd>
                <dt>Requests</dt><dd className="num">{r.requestsMade}{r.requestBudget ? <span className="muted"> of {r.requestBudget} allowed</span> : null}</dd>
                <dt>Duration</dt><dd className="num">{seconds === null ? '—' : seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`}</dd>
                <dt>Method</dt><dd>{r.connector ?? '—'}</dd>
              </dl>
              {d.failureReasons.length > 0 && (
                <div>
                  <b>Why pages failed</b>
                  <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>{d.failureReasons.map((f, i) => <li key={i}><b>{f.count}×</b> {f.reason}</li>)}</ul>
                </div>
              )}
              {d.failedUrls.length > 0 && (
                <details className="ev">
                  <summary>First {d.failedUrls.length} failed pages</summary>
                  <ul>{d.failedUrls.map((f, i) => <li key={i}><a href={f.url} target="_blank" rel="noreferrer noopener">{f.url}</a>{f.error && <span className="muted"> — {f.error}</span>}</li>)}</ul>
                </details>
              )}
              {d.skippedUrls.length > 0 && (
                <details className="ev">
                  <summary>First {d.skippedUrls.length} skipped pages (not product pages)</summary>
                  <ul>{d.skippedUrls.map((f, i) => <li key={i}><a href={f.url} target="_blank" rel="noreferrer noopener">{f.url}</a></li>)}</ul>
                </details>
              )}
              {r.notes.length > 0 && <details className="ev"><summary>Notes from this run</summary><ul>{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></details>}
            </div>
          );
        }}
      </DataState>
    </div>
  );
}
