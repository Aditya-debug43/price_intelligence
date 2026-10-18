import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, api, errorMessage, orgPath } from '../api';
import { useMeta, useOrg, useOrgQuery } from '../app-shell';
import { COMMON_CURRENCIES, COMMON_ZONES, Card, DataState, Field, PageHead, Spinner, useToast } from '../ui';
import type { Settings, SitesResponse } from '../types';

interface Row {
  id?: string;
  url: string;
  name: string;
  original?: string;
  error?: string;
}

/** Whether two addresses are different websites (a different host), as opposed to the same website written another way. */
function differentWebsite(a: string, b: string): boolean {
  try {
    const host = (u: string) => new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`).hostname.toLowerCase();
    return host(a) !== host(b);
  } catch {
    return false; // not an address yet: let the server say what is wrong with it
  }
}

export function SetupPage() {
  const { orgId, isAdmin } = useOrg();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const meta = useMeta();
  const sites = useOrgQuery<SitesResponse>('sites', '/sites');
  const settings = useOrgQuery<{ settings: Settings }>('settings', '/settings');
  const [source, setSource] = useState<Row>({ url: '', name: '' });
  const [competitors, setCompetitors] = useState<Row[]>([{ url: '', name: '' }, { url: '', name: '' }, { url: '', name: '' }]);
  const [form, setForm] = useState<Settings | null>(null);
  const [recipients, setRecipients] = useState('');
  const [saving, setSaving] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (loaded || !sites.data || !settings.data) return;
    const src = sites.data.sites.find((s) => s.role === 'source');
    if (src) setSource({ id: src.id, url: src.url, name: src.name, original: src.url });
    const comps = sites.data.sites.filter((s) => s.role === 'competitor').map((s) => ({ id: s.id, url: s.url, name: s.name, original: s.url }));
    while (comps.length < 3) comps.push({ id: undefined, url: '', name: '', original: undefined } as never);
    setCompetitors(comps);
    setForm(settings.data.settings);
    setRecipients(settings.data.settings.alertPrefs.recipients.join(', '));
    setLoaded(true);
  }, [sites.data, settings.data, loaded]);

  if (!isAdmin) return <div className="callout warn">Only owners and admins can change the business setup.</div>;
  const max = sites.data?.limits.maxCompetitors ?? 5;
  const min = sites.data?.limits.minCompetitors ?? 3;

  async function save() {
    if (!form) return;
    setSaving(true);
    setTopError(null);
    let ok = true;
    const touched: string[] = [];
    try {
      await api.put(orgPath(orgId, '/settings'), {
        reportingCurrency: form.reportingCurrency,
        timezone: form.timezone,
        reportReadyTime: form.reportReadyTime,
        lowStockThreshold: Number(form.lowStockThreshold),
        scheduleEnabled: form.scheduleEnabled,
        alertPrefs: { ...form.alertPrefs, recipients: recipients.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean) },
      });
    } catch (e) {
      setTopError(errorMessage(e));
      setSaving(false);
      return;
    }
    const apply = async (row: Row, role: 'source' | 'competitor', set: (r: Row) => void) => {
      const url = row.url.trim();
      try {
        if (!url && row.id) {
          await api.del(orgPath(orgId, `/sites/${row.id}`));
          set({ url: '', name: '' });
        } else if (url && !row.id) {
          const r = await api.post<{ site: { id: string } }>(orgPath(orgId, '/sites'), { url, role, name: row.name.trim() || undefined });
          touched.push(r.site.id);
          set({ ...row, id: r.site.id, original: url, error: undefined });
        } else if (url && row.id && row.original && url !== row.original && differentWebsite(url, row.original)) {
          // A different website is a new entry: the old one's collected products and history belong to it and are not carried over.
          if (!window.confirm(`Replace ${row.original} with ${url}?\n\nEverything collected from ${row.original} (products, prices, history) will be removed, and ${url} starts empty.`)) {
            set({ ...row, url: row.original, error: undefined });
            return;
          }
          await api.del(orgPath(orgId, `/sites/${row.id}`));
          const r = await api.post<{ site: { id: string } }>(orgPath(orgId, '/sites'), { url, role, name: row.name.trim() || undefined });
          touched.push(r.site.id);
          set({ ...row, id: r.site.id, original: url, error: undefined });
        } else if (url && row.id && (url !== row.original || row.name)) {
          const r = await api.patch<{ site: { id: string } }>(orgPath(orgId, `/sites/${row.id}`), { ...(url !== row.original ? { url } : {}), ...(row.name.trim() ? { name: row.name.trim() } : {}) });
          if (url !== row.original) touched.push(r.site.id);
          set({ ...row, original: url, error: undefined });
        }
      } catch (e) {
        ok = false;
        set({ ...row, error: errorMessage(e) });
      }
    };
    await apply(source, 'source', setSource);
    const next = [...competitors];
    for (let i = 0; i < next.length; i++) await apply(next[i]!, 'competitor', (r) => (next[i] = r));
    setCompetitors(next);
    await qc.invalidateQueries({ queryKey: ['org', orgId] });
    if (ok) {
      for (const id of touched) await api.post(orgPath(orgId, `/sites/${id}/profile`)).catch(() => {});
      toast.push('Saved. Checking what can be collected from each website…');
      nav(`/o/${orgId}/websites`);
    } else setTopError('Some websites could not be saved — see the messages below.');
    setSaving(false);
  }

  const filled = competitors.filter((c) => c.url.trim()).length;
  return (
    <>
      <PageHead eyebrow="Business setup" title="Set up your business" subtitle="Tell us about your shop and who you compete with. Nothing is collected yet — first we check what each website allows." />
      <DataState q={{ isLoading: sites.isLoading || settings.isLoading || !form, error: sites.error ?? settings.error, data: form ?? undefined, refetch: () => { void sites.refetch(); void settings.refetch(); } }}>
        {(f) => (
          <div className="steps">
            <div className="step">
              <Card title="Your business">
                <div className="grid2">
                  <Field label="Reporting currency" hint="Prices from every website are converted to this for comparison. Original prices are always kept.">
                    {(id) => (
                      <select id={id} value={f.reportingCurrency} onChange={(e) => setForm({ ...f, reportingCurrency: e.target.value })}>
                        {[...new Set([f.reportingCurrency, ...COMMON_CURRENCIES])].map((c) => <option key={c}>{c}</option>)}
                      </select>
                    )}
                  </Field>
                  <Field label="Time zone" hint="Reports are ready by the time below in this zone.">
                    {(id) => (
                      <select id={id} value={f.timezone} onChange={(e) => setForm({ ...f, timezone: e.target.value })}>
                        {[...new Set([f.timezone, ...COMMON_ZONES])].map((z) => <option key={z}>{z}</option>)}
                      </select>
                    )}
                  </Field>
                  <Field label="Daily report ready by" hint="Collection starts early enough to finish before this time.">
                    {(id) => <input id={id} type="time" value={f.reportReadyTime} onChange={(e) => setForm({ ...f, reportReadyTime: e.target.value })} />}
                  </Field>
                  <Field label="Low-stock alert at or below" hint="Units. Applies to your own shop only, and only when exact counts are available.">
                    {(id) => <input id={id} type="number" min={0} value={f.lowStockThreshold} onChange={(e) => setForm({ ...f, lowStockThreshold: Number(e.target.value) })} />}
                  </Field>
                </div>
              </Card>
            </div>

            <div className="step">
              <Card title="Your website">
                <div className="grid2">
                  <Field label="Website address" hint="The shop whose prices and stock you want to protect." error={source.error}>
                    {(id) => <input id={id} type="text" inputMode="url" placeholder="https://yourshop.com" value={source.url} onChange={(e) => setSource({ ...source, url: e.target.value, error: undefined })} />}
                  </Field>
                  <Field label="Display name (optional)">{(id) => <input id={id} type="text" value={source.name} onChange={(e) => setSource({ ...source, name: e.target.value })} />}</Field>
                </div>
              </Card>
            </div>

            <div className="step">
              <Card title={`Competitors (${min}–${max})`} actions={<button className="btn btn-sm" disabled={competitors.length >= max} onClick={() => setCompetitors([...competitors, { url: '', name: '' }])}>Add competitor</button>}>
                <div className="stack">
                  {competitors.map((c, i) => (
                    <div className="grid2" key={i} style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) auto', alignItems: 'start' }}>
                      <Field label={`Competitor ${i + 1} website`} error={c.error}>
                        {(id) => <input id={id} type="text" inputMode="url" placeholder="https://competitor.com" value={c.url} onChange={(e) => setCompetitors(competitors.map((x, n) => (n === i ? { ...x, url: e.target.value, error: undefined } : x)))} />}
                      </Field>
                      <Field label="Name (optional)">{(id) => <input id={id} type="text" value={c.name} onChange={(e) => setCompetitors(competitors.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)))} />}</Field>
                      <button className="btn btn-sm btn-ghost" style={{ marginTop: 22 }} aria-label={`Clear competitor ${i + 1}`} onClick={() => setCompetitors(competitors.map((x, n) => (n === i ? { ...x, url: '', name: '' } : x)))}>Remove</button>
                    </div>
                  ))}
                  {filled < min && <div className="hint">Add at least {min} competitors for meaningful comparisons. You can save now and add the rest later.</div>}
                </div>
              </Card>
            </div>

            <div className="step">
              <Card title="Notifications">
                <div className="stack">
                  <label className="check"><input type="checkbox" checked={f.alertPrefs.inApp} onChange={(e) => setForm({ ...f, alertPrefs: { ...f.alertPrefs, inApp: e.target.checked } })} /><span>Show alerts in the app</span></label>
                  <label className="check"><input type="checkbox" checked={f.alertPrefs.email} onChange={(e) => setForm({ ...f, alertPrefs: { ...f.alertPrefs, email: e.target.checked } })} /><span>Email me stock and collection alerts</span></label>
                  <label className="check"><input type="checkbox" checked={f.alertPrefs.dailySummaryEmail} onChange={(e) => setForm({ ...f, alertPrefs: { ...f.alertPrefs, dailySummaryEmail: e.target.checked } })} /><span>Email a short summary when the daily report is ready</span></label>
                  <Field label="Send emails to" hint="Separate addresses with commas. Leave empty to use the workspace owners.">
                    {(id) => <input id={id} type="text" value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="owner@yourshop.com, manager@yourshop.com" />}
                  </Field>
                  {!meta.data?.emailConfigured && <div className="callout info small">Email delivery isn’t configured on this server, so emails are saved to a local outbox instead of being sent.</div>}
                </div>
              </Card>
            </div>

            {topError && <div className="callout bad" role="alert">{topError}</div>}
            <div className="row">
              <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !source.url.trim()}>{saving ? <Spinner label="Saving" /> : 'Save and check websites'}</button>
              <span className="small muted">Next: you’ll review what can be collected from each website and record permission before collection starts.</span>
            </div>
          </div>
        )}
      </DataState>
    </>
  );
}

void ApiError;
