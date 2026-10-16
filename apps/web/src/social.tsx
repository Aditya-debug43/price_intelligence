import { formatDateTime, type MarketingSummary } from '@ci/shared';
import { Age, ArrowIcon, PLATFORM_LABEL } from './ui';

export interface CredentialView {
  level: 'ok' | 'warning' | 'bad' | 'unknown';
  message: string;
  daysLeft: number | null;
  neverExpires: boolean;
  expiresAt: string | null;
  missingScopes: string[];
  checkedAt: string;
}

export interface SocialProviderView {
  provider: string;
  state: string;
  message: string;
  requirements?: string[];
  limits?: string[];
  docsUrl?: string;
  credential?: CredentialView;
}

export interface SocialAccountView {
  id: string;
  siteId: string;
  siteName: string;
  platform: string;
  handle: string;
  url: string | null;
  discoveredFrom: string | null;
  confirmed: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncMessage: string | null;
  failureKind?: string | null;
  nextAttemptAt?: string | null;
  consecutiveFailures?: number;
}

/** The summary is part of the saved report as well as the live page, so both use the one shared definition. */
export type MarketingSummaryView = MarketingSummary;

const STATE_PILL: Record<string, { cls: string; label: string }> = {
  ready: { cls: 'good', label: 'ready' },
  requires_approval: { cls: 'warn', label: 'needs platform approval' },
  error: { cls: 'bad', label: 'problem' },
  not_configured: { cls: '', label: 'not set up' },
};

const CRED_PILL: Record<CredentialView['level'], { cls: string; label: string }> = {
  ok: { cls: 'good', label: 'token valid' },
  warning: { cls: 'warn', label: 'token needs attention' },
  bad: { cls: 'bad', label: 'token not valid' },
  unknown: { cls: '', label: 'token not checked' },
};

/** One provider: whether it can be used, why not, how healthy the credential is, and what it can and cannot show. */
export function ProviderCard({ p, detail = false }: { p: SocialProviderView; detail?: boolean }) {
  const s = STATE_PILL[p.state] ?? STATE_PILL['not_configured']!;
  return (
    <div className="callout" style={{ borderLeftColor: p.state === 'ready' ? 'var(--palm)' : p.state === 'requires_approval' ? '#e0a116' : p.state === 'error' ? 'var(--coral)' : 'var(--faint)' }}>
      <b>{PLATFORM_LABEL[p.provider] ?? p.provider}</b> — <span className={`pill ${s.cls}`}>{s.label}</span>
      <div className="small muted" style={{ marginTop: 4 }}>{p.message}</div>
      {p.credential && (
        <div className="small" style={{ marginTop: 6 }}>
          <span className={`pill ${CRED_PILL[p.credential.level].cls}`}>{CRED_PILL[p.credential.level].label}</span>{' '}
          {p.credential.message}
          <div className="muted">
            {p.credential.neverExpires ? 'Does not expire. ' : p.credential.expiresAt ? `Expires ${formatDateTime(p.credential.expiresAt)}. ` : ''}Checked <Age iso={p.credential.checkedAt} />.
          </div>
        </div>
      )}
      {detail && p.limits && p.limits.length > 0 && (
        <details className="ev"><summary>What this can and cannot show</summary><ul>{p.limits.map((l) => <li key={l}>{l}</li>)}</ul></details>
      )}
      {detail && p.state !== 'ready' && p.requirements && p.requirements.length > 0 && (
        <details className="ev" open={p.state === 'not_configured'}>
          <summary>What is needed{p.docsUrl ? '' : ''}</summary>
          <ul>{p.requirements.map((r) => <li key={r}>{r}</li>)}</ul>
          {p.docsUrl && <a href={p.docsUrl} target="_blank" rel="noreferrer noopener">Platform documentation <ArrowIcon /></a>}
        </details>
      )}
    </div>
  );
}

const SYNC_LABEL: Record<string, string> = {
  ready: 'Read successfully',
  needs_reconnect: 'Needs a new credential',
  requires_approval: 'Waiting for platform approval',
  error: 'Problem',
  not_configured: 'Not set up',
  backing_off: 'Waiting before trying again',
};

/** The outcome of the last read, and — when the platform said to wait — exactly until when. */
export function AccountSync({ a, now = new Date() }: { a: SocialAccountView; now?: Date }) {
  if (!a.lastSyncAt) return <>never</>;
  const waiting = a.nextAttemptAt && new Date(a.nextAttemptAt) > now;
  return (
    <>
      <Age iso={a.lastSyncAt} />
      <div className="sub">
        <b>{SYNC_LABEL[a.lastSyncStatus ?? ''] ?? a.lastSyncStatus}</b>
        {a.lastSyncMessage ? ` — ${a.lastSyncMessage}` : ''}
      </div>
      {a.failureKind === 'auth' && <div className="sub">Not retried until the credential is replaced.</div>}
      {waiting && <div className="sub">Will ask again after {formatDateTime(a.nextAttemptAt!)}.</div>}
      {a.failureKind && (a.consecutiveFailures ?? 0) > 1 && <div className="sub">{a.consecutiveFailures} attempts in a row have failed.</div>}
    </>
  );
}

const CLASS_LABEL: Record<string, string> = { promotion: 'promotional', product_launch: 'new product', seasonal: 'seasonal', brand_content: 'brand content', unclassified: 'unclassified' };

/** What the observed activity shows — only patterns the evidence supports, each with the number of items behind it. */
export function MarketingSummaryCard({ summary }: { summary: MarketingSummaryView }) {
  return (
    <div className="stack-s" style={{ marginBottom: 14 }}>
      <div className="callout"><b>What the evidence shows (last {summary.windowDays} days).</b> {summary.headline}</div>
      {summary.competitors.map((c) => (
        <details key={c.siteId} className="card" open={c.total > 0} style={{ padding: '12px 16px' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{c.siteName} <span className="muted" style={{ fontWeight: 400 }}>— {c.total} item{c.total === 1 ? '' : 's'} observed</span></summary>
          <div className="stack-s" style={{ marginTop: 10 }}>
            {c.total > 0 && (
              <p className="small" style={{ margin: 0 }}>
                {Object.entries(c.byPlatform).map(([k, n]) => `${PLATFORM_LABEL[k] ?? k} ${n}`).join(' · ')}
                {' — '}
                {Object.entries(c.byClassification).map(([k, n]) => `${n} ${CLASS_LABEL[k] ?? k}`).join(', ')}
              </p>
            )}
            {c.themes.length > 0 && (
              <div className="small"><b>Recurring themes</b> (words that appear in several different items):{' '}
                {c.themes.map((t, i) => <span key={t.term}>{i > 0 && ', '}<b>{t.term}</b> ({t.items} items{t.examples[0]?.url ? <>, e.g. <a href={t.examples[0].url} target="_blank" rel="noreferrer noopener">{t.examples[0].title || 'example'}</a></> : ''})</span>)}
              </div>
            )}
            {c.brandMentions.length > 0 && <div className="small"><b>Brands mentioned in promotions:</b> {c.brandMentions.map((b) => `${b.brand} (${b.items})`).join(', ')}. <span className="muted">A mention is not proof the brand is discounted.</span></div>}
            {c.timing ? <div className="small"><b>Timing:</b> {c.timing.sentence}</div> : c.timingNote ? <div className="small muted"><b>Timing:</b> {c.timingNote}</div> : null}
            {c.mostLiked.length > 0 && <div className="small"><b>Most liked:</b> {c.mostLiked.map((e, i) => <span key={e.url ?? e.title}>{i > 0 && ' · '}{e.url ? <a href={e.url} target="_blank" rel="noreferrer noopener">{e.title}</a> : e.title} ({e.value.toLocaleString()} on {PLATFORM_LABEL[e.platform] ?? e.platform})</span>)}</div>}
            {c.mostViewed.length > 0 && <div className="small"><b>Most viewed:</b> {c.mostViewed.map((e, i) => <span key={e.url ?? e.title}>{i > 0 && ' · '}{e.url ? <a href={e.url} target="_blank" rel="noreferrer noopener">{e.title}</a> : e.title} ({e.value.toLocaleString()} views)</span>)}</div>}
            <details className="ev"><summary>What we cannot see</summary><ul>{c.limitations.map((l) => <li key={l}>{l}</li>)}</ul></details>
          </div>
        </details>
      ))}
      <p className="small muted" style={{ margin: 0 }}>{summary.note}</p>
    </div>
  );
}
