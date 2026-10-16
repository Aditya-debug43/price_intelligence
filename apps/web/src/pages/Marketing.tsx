import { useSearchParams } from 'react-router-dom';
import { type MarketingRow } from '@ci/shared';
import { qs } from '../api';
import { useOrg, useOrgQuery } from '../app-shell';
import { Link } from 'react-router-dom';
import { Age, ArrowIcon, Card, DataState, EmptyState, PageHead, ProvenancePill } from '../ui';
import { MarketingSummaryCard, ProviderCard, type MarketingSummaryView, type SocialProviderView } from '../social';
import { formatDateTime } from '@ci/shared';

const PLATFORM: Record<string, string> = { site: 'Website', facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube' };
const KIND: Record<string, string> = { social_post: 'Post', video: 'Video', promo_banner: 'Promo banner', announcement_bar: 'Announcement bar', sale_page: 'Sale page', campaign_landing: 'Campaign page', launch_announcement: 'Launch', flyer: 'Flyer' };
const CLASS: Record<string, string> = { promotion: 'Promotion', product_launch: 'New product', seasonal: 'Seasonal', brand_content: 'Brand content', unclassified: 'Unclassified' };

export function MarketingPage() {
  const { orgId } = useOrg();
  const [sp, setSp] = useSearchParams();
  const platform = sp.get('platform') ?? '';
  const q = useOrgQuery<{ activity: MarketingRow[]; summary: MarketingSummaryView; note: string }>(['marketing', platform], `/marketing${qs({ platform, days: 30 })}`);
  const integ = useOrgQuery<{ social: { providers: SocialProviderView[] } }>('integrations', '/integrations');
  return (
    <>
      <PageHead eyebrow="Market" title="Competitor marketing activity" subtitle="Promotional banners, sale pages and flyers from the websites themselves, plus posts and videos read through the official Facebook, Instagram and YouTube APIs when those are connected." />
      <div className="callout info" style={{ marginBottom: 14 }}>
        <b>What this is — and isn’t.</b> We record publicly <i>observed</i> content with its link and the time we saw it. That is <b>not</b> proof that a paid advertising campaign is running, and we never describe it that way.
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
      <DataState q={q} isEmpty={(d) => d.activity.length === 0} empty={<Card><EmptyState title="No marketing activity observed yet">Banners and flyers are picked up when a website is checked. Social posts need a confirmed account and a configured integration — see the panels above for exactly what is missing.</EmptyState></Card>}>
        {(d) => (
          <Card pad={false}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Website</th><th>Where</th><th>Content</th><th>Type</th><th>Reading</th><th>Engagement</th><th>Published</th><th>Source type</th><th>First seen</th><th /></tr></thead>
                <tbody>
                  {d.activity.map((m) => (
                    <tr key={m.id}>
                      <td>{m.siteName}</td>
                      <td>{PLATFORM[m.platform]}</td>
                      <td style={{ maxWidth: 420 }}><div className="title">{m.title ?? KIND[m.kind]}</div>{m.excerpt && m.excerpt !== m.title && <div className="sub">{m.excerpt.slice(0, 220)}</div>}</td>
                      <td>{KIND[m.kind]}</td>
                      <td><span className="pill info" title="Rule-based reading of the text — modest confidence">{CLASS[m.classification]}</span><div className="sub">{Math.round(m.confidence * 100)}% sure · paid status not determined</div></td>
                      <td className="small">{m.platform === 'site' ? <span className="muted">—</span> : m.engagement ? <>{[m.engagement.likes !== null && `${m.engagement.likes.toLocaleString()} likes`, m.engagement.comments !== null && `${m.engagement.comments.toLocaleString()} comments`, m.engagement.views !== null && `${m.engagement.views.toLocaleString()} views`, m.engagement.shares !== null && `${m.engagement.shares.toLocaleString()} shares`].filter(Boolean).join(' · ')}<div className="sub">as of <Age iso={m.engagement.observedAt} /></div></> : <span className="muted" title="The platform did not provide public counts for this item">not provided</span>}</td>
                      <td className="small">{m.publishedAt ? formatDateTime(m.publishedAt) : '—'}</td>
                      <td><ProvenancePill value={m.provenance} /></td>
                      <td className="small"><Age iso={m.firstSeenAt} /></td>
                      <td className="r">{m.url && <a href={m.url} target="_blank" rel="noreferrer noopener">open <ArrowIcon /></a>}</td>
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
