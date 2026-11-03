import { useSearchParams } from 'react-router-dom';
import { MARKETING_WINDOW_DAYS, type MarketingRow } from '@ci/shared';
import { qs } from '../api';
import { useOrg, useOrgQuery } from '../app-shell';
import { Link } from 'react-router-dom';
import { Age, ArrowIcon, Card, DataState, EmptyState, PageHead, ProvenancePill } from '../ui';
import { MarketingSummaryCard, ProviderCard, type MarketingSummaryView, type SocialProviderView } from '../social';
import { formatDateTime } from '@ci/shared';

const PLATFORM: Record<string, string> = { site: 'Website', facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube' };
const KIND: Record<string, string> = { social_post: 'Post', video: 'Video', promo_banner: 'Promo banner', announcement_bar: 'Announcement bar', sale_page: 'Sale page', campaign_landing: 'Campaign page', launch_announcement: 'Launch', flyer: 'Flyer' };
const CLASS: Record<string, string> = { promotion: 'Promotion', product_launch: 'New product', seasonal: 'Seasonal', brand_content: 'Brand content', unclassified: 'Unclassified' };

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * What a platform told us about the reach of one item. A count the platform did not give (a channel can hide likes, or switch comments off) is said to be unavailable —
 * it is never shown as zero. Other platforms keep listing only the counts they provided.
 */
export function EngagementCell({ m }: { m: MarketingRow }) {
  if (m.platform === 'site') return <span className="muted">—</span>;
  const e = m.engagement;
  if (!e) return <span className="muted" title="The platform did not provide public counts for this item">not provided</span>;
  const n = (v: number | null, one: string, many = one) => (v === null ? null : `${v.toLocaleString()} ${v === 1 ? one : many}`);
  if (m.platform === 'youtube') {
    const parts: { label: string; text: string | null }[] = [
      { label: 'views', text: n(e.views, 'view', 'views') },
      { label: 'likes', text: n(e.likes, 'like', 'likes') },
      { label: 'comments', text: n(e.comments, 'comment', 'comments') },
    ];
    return (
      <>
        {parts.map((p, i) => <span key={p.label}>{i > 0 && ' · '}{p.text ?? <span className="muted" title={`YouTube did not provide ${p.label} for this video (the channel may hide them)`}>{p.label} unavailable</span>}</span>)}
        <div className="sub">as of <Age iso={e.observedAt} /></div>
      </>
    );
  }
  return <>{[n(e.likes, 'like', 'likes'), n(e.comments, 'comment', 'comments'), n(e.views, 'view', 'views'), n(e.shares, 'share', 'shares')].filter(Boolean).join(' · ')}<div className="sub">as of <Age iso={e.observedAt} /></div></>;
}

/** The evidence behind everything on the page: one row per observed item, with where it was seen, when it was published and first seen, its public counts, and the original link in a new tab. */
export function MarketingTable({ rows }: { rows: MarketingRow[] }) {
  return (
    <table className="table">
      <thead><tr><th>Website</th><th>Where</th><th>Content</th><th>Type</th><th>Reading</th><th>Engagement</th><th>Published</th><th>Source type</th><th>First seen</th><th /></tr></thead>
      <tbody>
        {rows.map((m) => (
          <tr key={m.id}>
            <td>{m.siteName}</td>
            <td>{PLATFORM[m.platform]}{m.details?.channelTitle && <div className="sub" title="The YouTube channel this video belongs to">{m.details.channelTitle}</div>}</td>
            <td style={{ minWidth: 300, maxWidth: 420 }}>
              <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', gap: 10 }}>
                {m.details?.thumbnailUrl?.startsWith('https://') && <img src={m.details.thumbnailUrl} alt="" width={80} height={45} loading="lazy" referrerPolicy="no-referrer" style={{ flex: 'none', borderRadius: 4, objectFit: 'cover', background: 'var(--slate-wash)' }} />}
                <div style={{ flex: '1 1 180px', minWidth: 0 }}><div className="title">{m.title ?? KIND[m.kind]}</div>{m.excerpt && m.excerpt !== m.title && <div className="sub">{m.excerpt.slice(0, 220)}</div>}{m.details?.durationSeconds ? <div className="sub">{formatDuration(m.details.durationSeconds)} long</div> : null}</div>
              </div>
            </td>
            <td>{KIND[m.kind]}</td>
            <td><span className="pill info" title="Rule-based reading of the text — modest confidence">{CLASS[m.classification]}</span><div className="sub">{Math.round(m.confidence * 100)}% sure · paid status not determined</div></td>
            <td className="small"><EngagementCell m={m} /></td>
            <td className="small">{m.publishedAt ? formatDateTime(m.publishedAt) : '—'}</td>
            <td><ProvenancePill value={m.provenance} /></td>
            <td className="small"><Age iso={m.firstSeenAt} /></td>
            <td className="r">{m.url && <a href={m.url} target="_blank" rel="noreferrer noopener" aria-label={`Open ${m.title ?? 'this item'} on ${PLATFORM[m.platform] ?? 'its source'} (new tab)`}>open <ArrowIcon /></a>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function MarketingPage() {
  const { orgId } = useOrg();
  const [sp, setSp] = useSearchParams();
  const platform = sp.get('platform') ?? '';
  const q = useOrgQuery<{ activity: MarketingRow[]; summary: MarketingSummaryView; note: string }>(['marketing', platform], `/marketing${qs({ platform, days: MARKETING_WINDOW_DAYS })}`);
  const integ = useOrgQuery<{ social: { providers: SocialProviderView[] } }>('integrations', '/integrations');
  return (
    <>
      <PageHead eyebrow="Market" title="Competitor marketing activity" subtitle={`Promotional banners, sale pages and flyers from the websites themselves, plus posts and videos read through the official Facebook, Instagram and YouTube APIs when those are connected. YouTube shows each connected competitor channel’s videos published in the last ${MARKETING_WINDOW_DAYS} days.`} />
      <div className="callout info" style={{ marginBottom: 14 }}>
        <b>What this is — and isn’t.</b> We record publicly <i>observed</i> content with its link and the time we saw it. That is <b>not</b> proof that a paid advertising campaign is running, and we never describe it that way. A video a channel uploads is content it published — not an advertisement, and not a sign of any ad spend.
      </div>
      {integ.data && (
        <div className="grid3" style={{ marginBottom: 14 }}>
          {integ.data.social.providers.map((p) => <ProviderCard key={p.provider} p={p} />)}
        </div>
      )}
      <div className="filters">
        <div className="field"><label htmlFor="m-p">Where</label><select id="m-p" value={platform} onChange={(e) => { const n = new URLSearchParams(sp); if (e.target.value) n.set('platform', e.target.value); else n.delete('platform'); setSp(n, { replace: true }); }}><option value="">Everywhere</option>{Object.entries(PLATFORM).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <Link className="btn" to={`/o/${orgId}/settings?tab=integrations`}>Manage social connections</Link>
      </div>
      {q.data && <MarketingSummaryCard summary={q.data.summary} />}
      <DataState q={q} isEmpty={(d) => d.activity.length === 0} empty={<Card><EmptyState title="No marketing activity observed yet">Banners and flyers are picked up when a website is checked. Social posts and videos need a confirmed account and a configured integration — see the panels above for exactly what is missing, and use “Manage social connections” to connect a competitor’s YouTube channel.</EmptyState></Card>}>
        {(d) => (
          <Card pad={false}>
            <div className="table-wrap">
              <MarketingTable rows={d.activity} />
            </div>
          </Card>
        )}
      </DataState>
    </>
  );
}
