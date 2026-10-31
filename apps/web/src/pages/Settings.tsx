import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DEFAULTS, connectionSyncHealth, formatDateTime } from '@ci/shared';
import { api, errorMessage, fieldErrors, orgPath } from '../api';
import { useMe, useMeta, useOrg, useOrgMutation, useOrgQuery } from '../app-shell';
import { AccountSync, ProviderCard, type SocialAccountView, type SocialProviderView } from '../social';
import { Age, Card, COMMON_CURRENCIES, COMMON_ZONES, DataState, EmptyState, Field, PageHead, PLATFORM_LABEL, Tabs, useToast } from '../ui';
import type { DashboardData, Settings } from '../types';

type TabId = 'general' | 'notifications' | 'members' | 'integrations' | 'developer';

export function SettingsPage() {
  const { isAdmin } = useOrg();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as TabId | null) ?? 'general';
  const setTab = (t: TabId) => setSp({ tab: t }, { replace: true });
  const connected = sp.get('connected');
  const error = sp.get('error');
  return (
    <>
      <PageHead eyebrow="Set up" title="Settings" subtitle={isAdmin ? 'Everything here applies to this workspace only.' : 'You can read these settings. Only owners and admins can change them.'} />
      {connected === 'shopify' && <div className="callout good" role="status" style={{ marginBottom: 12 }}><b>Shopify connected.</b> Inventory is being read now; low-stock alerts start with the first sync.</div>}
      {error && <div className="callout bad" role="alert" style={{ marginBottom: 12 }}><b>The connection was not completed.</b> {error}</div>}
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'general', label: 'Reports & schedule' },
        { id: 'notifications', label: 'Notifications' },
        { id: 'members', label: 'People' },
        { id: 'integrations', label: 'Integrations' },
      ]} />
      {tab === 'general' && <GeneralTab />}
      {tab === 'notifications' && <NotificationsTab />}
      {tab === 'members' && <MembersTab />}
      {tab === 'integrations' && <IntegrationsTab />}
    </>
  );
}

function useSettingsSave(label = 'Settings saved.') {
  const toast = useToast();
  return useOrgMutation((id, body: Record<string, unknown>) => api.put(orgPath(id, '/settings'), body), ['settings', 'dashboard', 'stock', 'comparison'], () => toast.push(label));
}

// ───────────────────────────────────────────────────────────── reports & schedule
function GeneralTab() {
  const { isAdmin } = useOrg();
  const q = useOrgQuery<{ settings: Settings | null }>('settings', '/settings');
  const dash = useOrgQuery<DashboardData>('dashboard', '/dashboard');
  return (
    <DataState q={q} isEmpty={(d) => !d.settings} empty={<EmptyState title="No settings found" />}>
      {({ settings }) => <GeneralForm s={settings!} isAdmin={isAdmin} next={dash.data?.nextReport ?? null} />}
    </DataState>
  );
}

function GeneralForm({ s, isAdmin, next }: { s: Settings; isAdmin: boolean; next: DashboardData['nextReport'] }) {
  const save = useSettingsSave();
  const [f, setF] = useState({ reportingCurrency: s.reportingCurrency, timezone: s.timezone, reportReadyTime: s.reportReadyTime, scheduleEnabled: s.scheduleEnabled, snapshotRetentionDays: s.snapshotRetentionDays, historyRetentionDays: s.historyRetentionDays });
  const errs = fieldErrors(save.error);
  const dirty = JSON.stringify(f) !== JSON.stringify({ reportingCurrency: s.reportingCurrency, timezone: s.timezone, reportReadyTime: s.reportReadyTime, scheduleEnabled: s.scheduleEnabled, snapshotRetentionDays: s.snapshotRetentionDays, historyRetentionDays: s.historyRetentionDays });
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); save.mutate({ ...f, snapshotRetentionDays: Number(f.snapshotRetentionDays), historyRetentionDays: Number(f.historyRetentionDays) }); }}>
      <Card title="Daily report">
        <div className="grid2">
          <Field label="Report ready by" hint="The report is built so it is finished by this local time every day.">
            {(id) => <input id={id} type="time" value={f.reportReadyTime} disabled={!isAdmin} onChange={(e) => setF({ ...f, reportReadyTime: e.target.value })} />}
          </Field>
          <Field label="Time zone" error={errs['timezone']} hint="An IANA zone, so daylight-saving changes are handled for you. Aruba has none; the default is America/Aruba.">
            {(id) => (
              <>
                <input id={id} list="zones" value={f.timezone} disabled={!isAdmin} onChange={(e) => setF({ ...f, timezone: e.target.value })} />
                <datalist id="zones">{COMMON_ZONES.map((z) => <option key={z} value={z} />)}</datalist>
              </>
            )}
          </Field>
          <Field label="Reporting currency" error={errs['reportingCurrency']} hint="Prices are converted to this currency to compare. The original price is always kept next to it.">
            {(id) => (
              <>
                <input id={id} list="ccy" value={f.reportingCurrency} maxLength={3} disabled={!isAdmin} onChange={(e) => setF({ ...f, reportingCurrency: e.target.value.toUpperCase() })} />
                <datalist id="ccy">{COMMON_CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
              </>
            )}
          </Field>
          <div className="field">
            <span className="label-like" style={{ fontWeight: 600, fontSize: 13 }}>Automatic daily report</span>
            <label className="row" style={{ gap: 8, marginTop: 6 }}><input type="checkbox" checked={f.scheduleEnabled} disabled={!isAdmin} onChange={(e) => setF({ ...f, scheduleEnabled: e.target.checked })} /> Prepare the report every day</label>
          </div>
        </div>
        {next && (
          <div className="callout info" style={{ marginTop: 12 }}>
            <b>Next report:</b> {next.date}, ready by {formatDateTime(next.deadlineAt)}. {next.enabled ? <>Collection is planned to start at <b>{formatDateTime(next.plannedStartAt)}</b> — {next.basis}</> : 'Automatic reports are switched off.'}
          </div>
        )}
        <p className="small muted" style={{ margin: '10px 0 0' }}>If a website is slow or refuses requests, the report still goes out on time: it contains what was collected, says which websites are missing, and old data is labelled as old rather than presented as fresh. The Aruban florin is converted at its fixed rate of 1.79 per US dollar.</p>
      </Card>
      <Card title="Keeping data">
        <div className="grid2">
          <Field label="Keep raw page snapshots for (days)" error={errs['snapshotRetentionDays']} hint="After this the saved copy of the page is deleted. The price record and its source link stay.">
            {(id) => <input id={id} type="number" min={1} max={3650} value={f.snapshotRetentionDays} disabled={!isAdmin} onChange={(e) => setF({ ...f, snapshotRetentionDays: Number(e.target.value) })} />}
          </Field>
          <Field label="Keep price history for (days)" error={errs['historyRetentionDays']} hint="Longer history gives better ‘was’ price checks. Saved reports are kept either way.">
            {(id) => <input id={id} type="number" min={30} max={3650} value={f.historyRetentionDays} disabled={!isAdmin} onChange={(e) => setF({ ...f, historyRetentionDays: Number(e.target.value) })} />}
          </Field>
        </div>
      </Card>
      {isAdmin && <div className="row"><button className="btn btn-primary" type="submit" disabled={!dirty || save.isPending}>Save changes</button>{save.error && !Object.keys(errs).length && <span className="err" role="alert">{errorMessage(save.error)}</span>}</div>}
    </form>
  );
}

// ───────────────────────────────────────────────────────────── notifications
interface Rule { id: string; type: string; enabled: boolean; channelInApp: boolean; channelEmail: boolean }
const RULE_LABEL: Record<string, string> = { low_stock: 'Low stock at your shop', out_of_stock: 'A product at your shop sold out', restocked: 'A product at your shop is back in stock', collection_failure: 'A website could not be collected' };

interface EmailStatus {
  configured: boolean;
  host: string | null;
  from: string | null;
  recent: { id: string; to: string[]; subject: string; kind: string; status: 'queued' | 'sent' | 'retrying' | 'failed' | 'not_configured'; attempts: number; error: string | null; createdAt: string; sentAt: string | null }[];
}
interface EmailTestResult { ok: boolean; to: string; messageId?: string | null; response?: string | null; problem?: { code: string; message: string } }

const EMAIL_STATUS: Record<EmailStatus['recent'][number]['status'], { label: string; cls: string; hint: string }> = {
  sent: { label: 'Sent', cls: 'good', hint: 'The mail server accepted it.' },
  queued: { label: 'Waiting', cls: 'warn', hint: 'Not sent yet.' },
  retrying: { label: 'Retrying', cls: 'warn', hint: 'A temporary problem; it will be tried again.' },
  failed: { label: 'Not delivered', cls: 'bad', hint: 'The mail server did not take it.' },
  not_configured: { label: 'Not sent', cls: '', hint: 'This server has no email delivery set up.' },
};

/** What email delivery is doing: configured or not, a real test message with the mail server's own answer, and what happened to the latest messages. */
function EmailDeliveryCard() {
  const { isAdmin } = useOrg();
  const q = useOrgQuery<EmailStatus>('email', '/email', { refetchInterval: 15_000 });
  const [result, setResult] = useState<EmailTestResult | null>(null);
  const test = useOrgMutation((id, _: void) => api.post<EmailTestResult>(orgPath(id, '/email/test')), ['email'], (r) => setResult(r));
  if (!isAdmin) return null;
  return (
    <Card title="Email delivery" pad={false}>
      <DataState q={q}>
        {(d) => (
          <div>
            <div className="card-b stack">
              {d.configured ? (
                <div className="callout good"><b>Email delivery is set up</b> ({d.host}). Messages are sent as <b>{d.from}</b>. A message counts as sent only when the mail server has accepted it.</div>
              ) : (
                <div className="callout warn">
                  <b>Email delivery is not set up on this server.</b> No email is sent: nobody can register or reset a password, and alerts and the daily summary stay in the app. An administrator must set <code>SMTP_HOST</code>, <code>SMTP_USER</code> and <code>SMTP_PASSWORD</code> in the server’s <code>.env</code> (see docs/integrations.md), then restart.
                </div>
              )}
              {d.configured && (
                <div className="row" style={{ alignItems: 'center' }}>
                  <button className="btn" onClick={() => { setResult(null); test.mutate(undefined); }} disabled={test.isPending}>{test.isPending ? 'Sending…' : 'Send me a test email'}</button>
                  <span className="small muted">Sends one real message to your own address right now.</span>
                </div>
              )}
              {test.error && <div className="callout bad" role="alert">{errorMessage(test.error)}</div>}
              {result && (result.ok ? (
                <div className="callout good" role="status"><b>Accepted by the mail server.</b> Check the inbox of {result.to} (and the spam folder).{result.response ? <> The server said: <code>{result.response}</code></> : null}</div>
              ) : (
                <div className="callout bad" role="alert"><b>The mail server did not accept the message.</b> {result.problem?.message}</div>
              ))}
            </div>
            {d.recent.length > 0 && (
              <table className="table">
                <caption className="sr-only">Latest messages for this workspace</caption>
                <thead><tr><th>Message</th><th>Status</th><th>When</th></tr></thead>
                <tbody>{d.recent.map((m) => (
                  <tr key={m.id}>
                    <td>{m.subject}<div className="sub">to {m.to.join(', ')} · {m.kind.replace(/-/g, ' ')}</div>{m.error && <div className="sub" style={{ color: 'var(--coral)' }}>{m.error}</div>}</td>
                    <td><span className={`pill ${EMAIL_STATUS[m.status].cls}`} title={EMAIL_STATUS[m.status].hint}>{EMAIL_STATUS[m.status].label}</span>{m.attempts > 1 && <div className="sub">{m.attempts} attempts</div>}</td>
                    <td className="small"><Age iso={m.sentAt ?? m.createdAt} /></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        )}
      </DataState>
    </Card>
  );
}

function NotificationsTab() {
  const { isAdmin } = useOrg();
  const q = useOrgQuery<{ settings: Settings | null }>('settings', '/settings');
  const rules = useOrgQuery<{ rules: Rule[] }>('alert-rules', '/alert-rules');
  const toast = useToast();
  const setRule = useOrgMutation((id, r: Rule) => api.put(orgPath(id, '/alert-rules'), { type: r.type, enabled: r.enabled, channelInApp: r.channelInApp, channelEmail: r.channelEmail }), ['alert-rules'], () => toast.push('Alert rule saved.'));
  return (
    <div className="stack">
      <EmailDeliveryCard />
      <DataState q={q} isEmpty={(d) => !d.settings}>
        {({ settings }) => <NotifForm s={settings!} isAdmin={isAdmin} />}
      </DataState>
      <Card title="Which alerts to raise" pad={false}>
        <DataState q={rules}>
          {({ rules: rs }) => (
            <table className="table">
              <thead><tr><th>Alert</th><th>On</th><th>In the app</th><th>By email</th></tr></thead>
              <tbody>{rs.map((r) => (
                <tr key={r.type}>
                  <td>{RULE_LABEL[r.type] ?? r.type.replace(/_/g, ' ')}{r.type.includes('stock') || r.type === 'restocked' ? <div className="sub">your own shop only — competitor stock never alerts</div> : null}</td>
                  {(['enabled', 'channelInApp', 'channelEmail'] as const).map((k) => (
                    <td key={k}><input type="checkbox" aria-label={`${RULE_LABEL[r.type] ?? r.type}: ${k}`} checked={r[k]} disabled={!isAdmin || setRule.isPending} onChange={(e) => setRule.mutate({ ...r, [k]: e.target.checked })} /></td>
                  ))}
                </tr>
              ))}</tbody>
            </table>
          )}
        </DataState>
      </Card>
    </div>
  );
}

function NotifForm({ s, isAdmin }: { s: Settings; isAdmin: boolean }) {
  const save = useSettingsSave('Notification settings saved.');
  const meta = useMeta();
  const [threshold, setThreshold] = useState(s.lowStockThreshold);
  const [prefs, setPrefs] = useState({ ...s.alertPrefs, recipientsText: s.alertPrefs.recipients.join(', ') });
  const [ai, setAi] = useState(s.aiAdjudication);
  const savedEngine = s.matchingEngine ?? 'v1';
  const [engine, setEngine] = useState<'v1' | 'v2_shadow' | 'v2'>(savedEngine);
  const [autoConfirm, setAutoConfirm] = useState(s.matchingAutoConfirm === true);
  const errs = fieldErrors(save.error);
  const recipients = prefs.recipientsText.split(/[\s,;]+/).filter(Boolean);
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); save.mutate({ lowStockThreshold: Number(threshold), alertPrefs: { inApp: prefs.inApp, email: prefs.email, dailySummaryEmail: prefs.dailySummaryEmail, recipients }, enabledAiAdjudication: ai, ...(engine !== savedEngine ? { matchingEngine: engine } : {}), ...(autoConfirm !== (s.matchingAutoConfirm === true) || (engine !== 'v2' && s.matchingAutoConfirm === true) ? { matchingAutoConfirm: engine === 'v2' && autoConfirm } : {}) }); }}>
      <Card title="Low-stock threshold">
        <Field label="Default threshold (units)" error={errs['lowStockThreshold']} hint="A product at your shop counts as low when its quantity is at or below this number. You can set a different number for one product on its page.">
          {(id) => <input id={id} type="number" min={0} style={{ maxWidth: 140 }} value={threshold} disabled={!isAdmin} onChange={(e) => setThreshold(Number(e.target.value))} />}
        </Field>
        <p className="small muted" style={{ margin: '8px 0 0' }}>Exact quantities come only from an inventory connection you authorise (Integrations). On the public website we can see in stock / sold out — never an invented number — so no low-stock alert is raised without a real quantity.</p>
      </Card>
      <Card title="How you hear about things">
        <div className="stack-s">
          <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={prefs.inApp} disabled={!isAdmin} onChange={(e) => setPrefs({ ...prefs, inApp: e.target.checked })} /> Show alerts in the app</label>
          <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={prefs.email} disabled={!isAdmin} onChange={(e) => setPrefs({ ...prefs, email: e.target.checked })} /> Email alerts</label>
          <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={prefs.dailySummaryEmail} disabled={!isAdmin} onChange={(e) => setPrefs({ ...prefs, dailySummaryEmail: e.target.checked })} /> Email a short summary when each daily report is ready</label>
          <Field label="Send emails to" error={errs['alertPrefs.recipients'] ?? errs['alertPrefs']} hint="Separate addresses with commas. Leave empty to email the workspace owners.">
            {(id) => <input id={id} value={prefs.recipientsText} placeholder="owner@example.com, manager@example.com" disabled={!isAdmin} onChange={(e) => setPrefs({ ...prefs, recipientsText: e.target.value })} />}
          </Field>
        </div>
      </Card>
      <Card title="Optional AI assistance">
        <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={ai} disabled={!isAdmin || meta.data?.aiProvider === 'none'} onChange={(e) => setAi(e.target.checked)} /> Ask an AI for a second opinion on uncertain product matches</label>
        <p className="small muted" style={{ margin: '8px 0 0' }}>{meta.data?.aiProvider === 'none' ? 'No AI provider is configured on this server, so this is unavailable. Everything else works without it.' : `Provider: ${meta.data?.aiProvider}. The AI only suggests; it never confirms a match by itself, and every number in an AI-written summary is checked against the stored records.`}</p>
      </Card>
      <Card title="Product matching">
        <Field label="Which matcher suggests matches" hint="Whatever you choose, nothing is confirmed without you, and your earlier decisions are never changed.">
          {(id) => (
            <select id={id} value={engine} disabled={!isAdmin} onChange={(e) => setEngine(e.target.value as typeof engine)}>
              <option value="v1">The earlier matcher (current)</option>
              <option value="v2_shadow">Test the new matcher — changes nothing you see</option>
              <option value="v2">The new, evidence-based matcher</option>
            </select>
          )}
        </Field>
        <label className="row" style={{ gap: 8, marginTop: 10 }}><input type="checkbox" checked={autoConfirm} disabled={!isAdmin || engine !== 'v2'} onChange={(e) => setAutoConfirm(e.target.checked)} /> Confirm clear-cut matches automatically</label>
        <p className="small muted" style={{ margin: '4px 0 0' }}>Only for the new matcher, and only when it is certain the two listings are the same product: the same barcode, or the same maker with identical names and sizes that agree. These are marked “confirmed automatically”, appear in the same-product comparison, and you can overrule any of them. Turning this off returns them all to the review list.</p>
        <p className="small muted" style={{ margin: '8px 0 0' }}>The new matcher explains every suggestion (what agrees, what differs, what is missing) and tells the same product, a different pack, a substitute and a related product apart. It is being measured before it is recommended: the test option runs it on your data and records the result without adding or removing a single suggestion.</p>
      </Card>
      {isAdmin && <div className="row"><button className="btn btn-primary" type="submit" disabled={save.isPending}>Save changes</button>{save.error && !Object.keys(errs).length && <span className="err" role="alert">{errorMessage(save.error)}</span>}</div>}
    </form>
  );
}

// ───────────────────────────────────────────────────────────── people
interface Invitation { id: string; email: string; role: 'owner' | 'admin' | 'staff'; status: 'pending' | 'accepted' | 'revoked' | 'expired'; invitedBy: string | null; createdAt: string; lastSentAt: string; expiresAt: string }
interface Member { userId: string; email: string; displayName: string; role: 'owner' | 'admin' | 'staff'; joinedAt: string; emailVerified: boolean }

function MembersTab() {
  const { isAdmin, role } = useOrg();
  const me = useMe();
  const toast = useToast();
  const q = useOrgQuery<{ members: Member[] }>('members', '/members');
  const meta = useMeta();
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<'staff' | 'admin' | 'owner'>('staff');
  /** The link is only ever shown when this server cannot email it — the inviter has to hand it over. Never stored. */
  const [manual, setManual] = useState<{ email: string; link: string } | null>(null);
  const invites = useOrgQuery<{ invitations: Invitation[] }>('invitations', '/invitations', { enabled: isAdmin });
  const invite = useOrgMutation(
    (id, v: { email: string; role: string }) => api.post<{ invitation: Invitation; link: string | null; resent: boolean }>(orgPath(id, '/invitations'), v),
    ['invitations'],
    (r) => {
      setEmail('');
      setManual(r.link ? { email: r.invitation.email, link: r.link } : null);
      toast.push(r.link ? 'Invitation created. Send them the link below.' : r.resent ? 'Invitation sent again. The earlier link no longer works.' : 'Invitation sent.');
    },
  );
  const resend = useOrgMutation(
    (id, invitationId: string) => api.post<{ invitation: Invitation; link: string | null }>(orgPath(id, `/invitations/${invitationId}/resend`)),
    ['invitations'],
    (r) => { setManual(r.link ? { email: r.invitation.email, link: r.link } : null); toast.push(r.link ? 'New link created. Send it to them.' : 'Invitation sent again.'); },
  );
  const revoke = useOrgMutation((id, invitationId: string) => api.del(orgPath(id, `/invitations/${invitationId}`)), ['invitations'], () => toast.push('Invitation withdrawn. Its link no longer works.'));
  const change = useOrgMutation((id, v: { userId: string; role: string }) => api.patch(orgPath(id, `/members/${v.userId}`), { role: v.role }), ['members'], () => toast.push('Role changed.'));
  const remove = useOrgMutation((id, userId: string) => api.del(orgPath(id, `/members/${userId}`)), ['members'], () => toast.push('Member removed.'));
  return (
    <div className="stack">
      <Card title="People in this workspace" pad={false}>
        <DataState q={q}>
          {({ members }) => (
            <table className="table">
              <thead><tr><th>Person</th><th>Role</th><th>Joined</th><th /></tr></thead>
              <tbody>{members.map((m) => (
                <tr key={m.userId}>
                  <td><span className="title">{m.displayName}</span>{m.userId === me.data?.user.id && <span className="pill"> you</span>}<div className="sub">{m.email}{!m.emailVerified && <span className="pill warn" style={{ marginLeft: 6 }} title="This address has not been confirmed by following an emailed link.">not verified</span>}</div></td>
                  <td>{isAdmin && m.userId !== me.data?.user.id ? (
                    <select aria-label={`Role for ${m.displayName}`} value={m.role} onChange={(e) => change.mutate({ userId: m.userId, role: e.target.value })} disabled={m.role === 'owner' && role !== 'owner'} style={{ width: 'auto' }}>
                      <option value="staff">Staff — view only</option><option value="admin">Admin — manage data</option>{role === 'owner' && <option value="owner">Owner</option>}
                    </select>
                  ) : <span className="pill">{m.role}</span>}</td>
                  <td className="small"><Age iso={m.joinedAt} /></td>
                  <td className="r">{isAdmin && m.userId !== me.data?.user.id && (role === 'owner' || m.role !== 'owner') && <button className="btn btn-sm btn-danger" onClick={() => window.confirm(`Remove ${m.displayName} from this workspace?`) && remove.mutate(m.userId)}>Remove</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </DataState>
      </Card>
      {(change.error || remove.error) && <div className="callout bad" role="alert">{errorMessage(change.error ?? remove.error)}</div>}
      {isAdmin && (
        <Card title="Invite someone">
          <p className="small muted" style={{ marginTop: 0 }}>They get a link that works once and expires in 7 days. They sign in or create an account with <b>this email address</b> and choose to join — nobody is added without accepting.</p>
          <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); invite.mutate({ email, role: newRole }); }}>
            <Field label="Their email">{(id) => <input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
            <Field label="Role">{(id) => <select id={id} value={newRole} onChange={(e) => setNewRole(e.target.value as typeof newRole)}><option value="staff">Staff — view only</option><option value="admin">Admin — manage data</option>{role === 'owner' && <option value="owner">Owner</option>}</select>}</Field>
            <button className="btn btn-primary" type="submit" disabled={invite.isPending}>{meta.data?.emailConfigured ? 'Send invitation' : 'Create invitation link'}</button>
          </form>
          {!meta.data?.emailConfigured && <p className="small muted" style={{ marginBottom: 0 }}>This server can’t send email yet, so you will be given the link to pass on yourself.</p>}
          {(invite.error || resend.error || revoke.error) && <div className="callout bad" role="alert" style={{ marginTop: 10 }}>{errorMessage(invite.error ?? resend.error ?? revoke.error)}</div>}
          {manual && (
            <div className="callout warn" style={{ marginTop: 10 }}>
              <b>Send this link to {manual.email} yourself.</b> It works once and expires in 7 days. Anyone who has it can try to use it, but only a person signed in as {manual.email} can accept.
              <div className="row" style={{ marginTop: 8 }}>
                <input readOnly aria-label={`Invitation link for ${manual.email}`} value={manual.link} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, minWidth: 220 }} />
                <button className="btn btn-sm" onClick={() => { void navigator.clipboard?.writeText(manual.link); toast.push('Link copied.'); }}>Copy link</button>
                <button className="btn btn-sm btn-ghost" onClick={() => setManual(null)}>Hide</button>
              </div>
            </div>
          )}
        </Card>
      )}
      {isAdmin && (invites.data?.invitations.length ?? 0) > 0 && (
        <Card title="Invitations" pad={false}>
          <table className="table">
            <thead><tr><th>Invited</th><th>Role</th><th>Status</th><th>Sent</th><th /></tr></thead>
            <tbody>{invites.data!.invitations.map((i) => (
              <tr key={i.id}>
                <td>{i.email}{i.invitedBy && <div className="sub">by {i.invitedBy}</div>}</td>
                <td><span className="pill">{i.role}</span></td>
                <td><span className={`pill ${i.status === 'pending' ? 'info' : i.status === 'accepted' ? 'good' : ''}`}>{{ pending: 'waiting', accepted: 'joined', revoked: 'withdrawn', expired: 'expired' }[i.status]}</span>{i.status === 'pending' && <div className="sub">link valid until {formatDateTime(i.expiresAt)}</div>}</td>
                <td className="small"><Age iso={i.lastSentAt} /></td>
                <td className="r">
                  {(i.status === 'pending' || i.status === 'expired') && <button className="btn btn-sm" onClick={() => resend.mutate(i.id)} disabled={resend.isPending}>{i.status === 'expired' ? 'Invite again' : 'Send again'}</button>}
                  {i.status === 'pending' && <button className="btn btn-sm btn-danger" style={{ marginLeft: 6 }} onClick={() => window.confirm(`Withdraw the invitation to ${i.email}?`) && revoke.mutate(i.id)}>Withdraw</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── integrations
function ConnectionPill({ c }: { c: Conn }) {
  // “connected” only says the authorisation exists; green is reserved for a connection whose last sync worked and is recent.
  const health = c.status === 'connected' ? connectionSyncHealth(c, new Date(), DEFAULTS.staleAfterHours) : null;
  if (c.status === 'error') return <span className="pill bad">error</span>;
  if (health === 'ok') return <span className="pill good">connected</span>;
  if (health === 'failed') return <span className="pill bad">connected — last sync failed</span>;
  if (health === 'stale') return <span className="pill warn">connected — sync is old</span>;
  if (health === 'never') return <span className="pill warn">connected — not synced yet</span>;
  return <span className="pill">{c.status}</span>;
}

interface Conn { id: string; provider: string; siteId: string | null; status: string; shopDomain: string | null; scopes: string | null; connectedAt: string | null; revokedAt: string | null; lastSyncAt: string | null; lastError: string | null; accessTokenExpiresAt: string | null }
interface Integrations {
  shopify: { configured: boolean; missing: string[]; scopes: string; apiVersion: string; readOnly: boolean; note: string };
  connections: Conn[];
  social: { providers: SocialProviderView[]; accounts: SocialAccountView[] };
}

function IntegrationsTab() {
  const { isAdmin } = useOrg();
  const q = useOrgQuery<Integrations>('integrations', '/integrations');
  const names = useOrgQuery<{ sites: { id: string; name: string; role: string }[] }>('site-names', '/site-names');
  const toast = useToast();
  const [shop, setShop] = useState('');
  const [siteId, setSiteId] = useState('');
  const start = useOrgMutation((id, v: { shop: string; siteId?: string }) => api.post<{ url: string }>(orgPath(id, '/integrations/shopify/start'), v), [], (r) => window.location.assign(r.url));
  const sync = useOrgMutation((id, connectionId: string) => api.post(orgPath(id, `/integrations/${connectionId}/sync`)), ['integrations'], () => toast.push('Inventory sync started.'));
  const disconnect = useOrgMutation((id, connectionId: string) => api.del(orgPath(id, `/integrations/${connectionId}`)), ['integrations', 'stock'], () => toast.push('Disconnected. The access token was revoked and deleted.'));
  const syncSocial = useOrgMutation((id, _: void) => api.post(orgPath(id, '/social/sync')), ['integrations', 'marketing'], () => toast.push('Social sync started.'));
  const [acct, setAcct] = useState({ siteId: '', platform: 'facebook', handle: '' });
  const addAcct = useOrgMutation((id, v: typeof acct) => api.post(orgPath(id, '/social-accounts'), v), ['integrations'], () => { toast.push('Account added. Confirm it before it is used.'); setAcct({ ...acct, handle: '' }); });
  const confirm = useOrgMutation((id, v: { accountId: string; confirmed: boolean }) => api.patch(orgPath(id, `/social-accounts/${v.accountId}`), { confirmed: v.confirmed }), ['integrations']);
  return (
    <DataState q={q}>
      {(d) => {
        const real = d.connections;
        return (
          <div className="stack">
            <Card title="Your shop’s inventory (Shopify, read-only)">
              <p style={{ marginTop: 0 }}>{d.shopify.note}</p>
              {!d.shopify.configured ? (
                <div className="callout warn">
                  <b>Shopify is not set up on this server.</b> To enable it, an administrator needs to register a Shopify app and set: {d.shopify.missing.map((m) => <code key={m} style={{ marginRight: 6 }}>{m}</code>)}. Until then, the app shows only whether products are in stock or sold out — it will not invent a quantity. See docs/integrations.md.
                </div>
              ) : isAdmin ? (
                <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); start.mutate({ shop, siteId: siteId || undefined }); }}>
                  <Field label="Store address" hint="For example my-store.myshopify.com. You will be sent to Shopify to approve read-only access.">{(id) => <input id={id} required value={shop} onChange={(e) => setShop(e.target.value)} placeholder="my-store.myshopify.com" />}</Field>
                  <Field label="Linked website">{(id) => <select id={id} value={siteId} onChange={(e) => setSiteId(e.target.value)}><option value="">Your shop (automatic)</option>{names.data?.sites.filter((s) => s.role === 'source').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</Field>
                  <button className="btn btn-primary" type="submit" disabled={start.isPending}>Connect with Shopify</button>
                </form>
              ) : <p className="muted">Ask an owner or admin to connect Shopify.</p>}
              {start.error && <div className="callout bad" role="alert" style={{ marginTop: 10 }}>{errorMessage(start.error)}</div>}
              {real.length > 0 && (
                <table className="table" style={{ marginTop: 12 }}>
                  <thead><tr><th>Store</th><th>Status</th><th>Last sync</th><th /></tr></thead>
                  <tbody>{real.map((c) => (
                    <tr key={c.id}>
                      <td>{c.shopDomain}<div className="sub">scopes: {c.scopes}</div></td>
                      <td><ConnectionPill c={c} />{c.lastError && <div className="sub" style={{ color: 'var(--coral)' }}>{c.lastError}</div>}</td>
                      <td className="small"><Age iso={c.lastSyncAt} /></td>
                      <td className="r">{isAdmin && c.status !== 'revoked' && <span className="row" style={{ justifyContent: 'flex-end' }}><button className="btn btn-sm" onClick={() => sync.mutate(c.id)}>Sync now</button><button className="btn btn-sm btn-danger" onClick={() => window.confirm('Disconnect this store? Quantities will stop updating.') && disconnect.mutate(c.id)}>Disconnect</button></span>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </Card>

            <Card title="Competitor marketing (official APIs)" actions={isAdmin ? <button className="btn btn-sm" onClick={() => syncSocial.mutate(undefined)} disabled={syncSocial.isPending}>Sync now</button> : undefined}>
              <div className="grid3">
                {d.social.providers.map((p) => <ProviderCard key={p.provider} p={p} detail />)}
              </div>
              <p className="small muted">Accounts are read only through the official Facebook, Instagram and YouTube APIs — never by scraping or logging in. An account found on a competitor’s website is only used after you confirm it is the right one.</p>
              {d.social.accounts.length > 0 && (
                <table className="table">
                  <thead><tr><th>Website</th><th>Account</th><th>Confirmed</th><th>Last sync</th></tr></thead>
                  <tbody>{d.social.accounts.map((a) => (
                    <tr key={a.id}>
                      <td>{a.siteName}</td>
                      <td><span>{PLATFORM_LABEL[a.platform] ?? a.platform}</span>: {a.url ? <a href={a.url} target="_blank" rel="noreferrer noopener">{a.handle}</a> : a.handle}{a.discoveredFrom && <div className="sub">found on {a.discoveredFrom}</div>}</td>
                      <td><input type="checkbox" aria-label={`Confirm ${a.platform} account ${a.handle}`} checked={a.confirmed} disabled={!isAdmin || confirm.isPending} onChange={(e) => confirm.mutate({ accountId: a.id, confirmed: e.target.checked })} /></td>
                      <td className="small"><AccountSync a={a} /></td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {isAdmin && (
                <form className="row" style={{ alignItems: 'flex-end', marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); addAcct.mutate(acct); }}>
                  <Field label="Website">{(id) => <select id={id} required value={acct.siteId} onChange={(e) => setAcct({ ...acct, siteId: e.target.value })}><option value="">Choose…</option>{names.data?.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</Field>
                  <Field label="Platform">{(id) => <select id={id} value={acct.platform} onChange={(e) => setAcct({ ...acct, platform: e.target.value })}><option value="facebook">Facebook</option><option value="instagram">Instagram</option><option value="youtube">YouTube</option></select>}</Field>
                  <Field label="Handle or page id">{(id) => <input id={id} required value={acct.handle} onChange={(e) => setAcct({ ...acct, handle: e.target.value })} />}</Field>
                  <button className="btn" type="submit" disabled={addAcct.isPending}>Add account</button>
                </form>
              )}
              {addAcct.error && <div className="callout bad" role="alert" style={{ marginTop: 10 }}>{errorMessage(addAcct.error)}</div>}
            </Card>
          </div>
        );
      }}
    </DataState>
  );
}
