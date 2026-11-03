import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MarketingRow } from '@ci/shared';

// The web app is compiled by its own project (DOM + JSX settings), so this root-level test loads its screen components at run time.
type Component = FunctionComponent<Record<string, unknown>>;
const SOCIAL_MODULE: string = '../../apps/web/src/social.tsx';
const MARKETING_MODULE: string = '../../apps/web/src/pages/Marketing.tsx';
let ProviderCard: Component;
let AccountSync: Component;
let MarketingTable: Component;
let EngagementCell: Component;
let formatDuration: (n: number) => string;
beforeAll(async () => {
  ({ ProviderCard, AccountSync } = (await import(/* @vite-ignore */ SOCIAL_MODULE)) as { ProviderCard: Component; AccountSync: Component });
  ({ MarketingTable, EngagementCell, formatDuration } = (await import(/* @vite-ignore */ MARKETING_MODULE)) as { MarketingTable: Component; EngagementCell: Component; formatDuration: (n: number) => string });
});

/**
 * What the customer sees of the YouTube integration: the card's status, and the evidence rows. The markup is rendered exactly as the browser gets it.
 */
const html = (c: Component, props: Record<string, unknown>) => renderToStaticMarkup(createElement(c, props));
const provider = (state: string, over: Record<string, unknown> = {}) => ({ provider: 'youtube', state, message: `message for ${state}`, requirements: ['Set YOUTUBE_API_KEY on the server'], ...over });

describe('the YouTube card shows exactly one of five honest statuses', () => {
  it.each([
    ['not_configured', 'not set up'],
    ['needs_channel_setup', 'needs a channel'],
    ['ready', 'ready'],
    ['collecting', 'collecting…'],
    ['error', 'problem'],
  ])('%s is shown as "%s"', (state, label) => {
    const out = html(ProviderCard, { p: provider(state) });
    expect(out).toContain(`>${label}</span>`);
    expect(out).toContain(`message for ${state}`);
    expect(out).toContain('<b>YouTube</b>');
  });

  it('"needs a channel" is a warning and "problem" is an error — a key alone is never the green "ready"', () => {
    expect(html(ProviderCard, { p: provider('needs_channel_setup') })).toMatch(/pill warn">needs a channel/);
    expect(html(ProviderCard, { p: provider('error') })).toMatch(/pill bad">problem/);
    expect(html(ProviderCard, { p: provider('ready') })).toMatch(/pill good">ready/);
    expect(html(ProviderCard, { p: provider('needs_channel_setup') })).not.toMatch(/pill good/);
  });

  it('on the settings screen the missing steps are open for a channel that still has to be set up, and hidden once collecting', () => {
    expect(html(ProviderCard, { p: provider('needs_channel_setup'), detail: true })).toMatch(/<details class="ev" open="">/);
    expect(html(ProviderCard, { p: provider('collecting'), detail: true })).not.toContain('What is needed');
  });

  it('Instagram and Facebook stay "not set up" with their own words', () => {
    for (const p of ['instagram', 'facebook']) {
      const out = html(ProviderCard, { p: { provider: p, state: 'not_configured', message: `${p} is not set up`, requirements: ['x'] } });
      expect(out).toContain('>not set up</span>');
      expect(out).toContain(`${p} is not set up`);
    }
  });

  it('an account being read shows it is collecting; one that is not shows its last read', () => {
    const a = { id: '1', siteId: 's', siteName: 'S', platform: 'youtube', handle: '@x', url: null, discoveredFrom: 'manual', confirmed: true, lastSyncAt: '2026-10-14T12:00:00Z', lastSyncStatus: 'ready', lastSyncMessage: 'Read 3 uploads' };
    expect(html(AccountSync, { a: { ...a, syncing: true } })).toContain('collecting now…');
    const done = html(AccountSync, { a, now: new Date('2026-10-14T13:00:00Z') });
    expect(done).toContain('Read successfully');
    expect(done).toContain('Read 3 uploads');
  });
});

const row = (over: Partial<MarketingRow> = {}): MarketingRow => ({
  id: 'r1', siteId: 's1', siteName: 'Fixture Mart', platform: 'youtube', kind: 'video', title: 'Spring sale on car lights', excerpt: 'Great prices this week',
  url: 'https://www.youtube.com/watch?v=abc123', publishedAt: '2026-10-09T15:00:00.000Z', firstSeenAt: '2026-10-14T12:00:00.000Z', lastSeenAt: '2026-10-14T12:00:00.000Z',
  classification: 'promotion', confidence: 0.6, paidStatus: 'not_determined', note: '', provenance: 'official_api',
  engagement: { views: 1200, likes: 80, comments: 7, shares: null, observedAt: '2026-10-14T12:00:00.000Z' },
  details: { videoId: 'abc123', channelId: 'UCx', channelTitle: 'Fixture Mart Official', thumbnailUrl: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg', durationSeconds: 245 },
  ...over,
});

describe('the evidence table', () => {
  it('shows a video with its competitor, source, title, publication date, engagement, first-seen time and original link', () => {
    const out = html(MarketingTable, { rows: [row()] });
    expect(out).toContain('<td>Fixture Mart</td>'); // the competitor
    expect(out).toContain('YouTube');
    expect(out).toContain('Fixture Mart Official'); // the channel
    expect(out).toContain('Spring sale on car lights');
    expect(out).toContain('4:05 long');
    expect(out).toContain('1,200 views');
    expect(out).toContain('80 likes');
    expect(out).toContain('7 comments');
    expect(out).toMatch(/Published/);
    expect(out).toContain('official');
    for (const header of ['Website', 'Where', 'Content', 'Engagement', 'Published', 'Source type', 'First seen']) expect(out).toContain(`<th>${header}</th>`);
  });

  it('the original link opens YouTube in a new tab, safely, with a name that says what it is', () => {
    const out = html(MarketingTable, { rows: [row()] });
    const a = out.match(/<a\b[^>]*>/)![0];
    expect(a).toContain('href="https://www.youtube.com/watch?v=abc123"');
    expect(a).toContain('target="_blank"');
    expect(a).toMatch(/rel="noreferrer noopener"/);
    expect(a).toContain('aria-label="Open Spring sale on car lights on YouTube (new tab)"');
  });

  it('shows the thumbnail only when it is an https address, without sending our address to the image host', () => {
    expect(html(MarketingTable, { rows: [row()] })).toMatch(/<img src="https:\/\/i\.ytimg\.com\/vi\/abc123\/hqdefault\.jpg"[^>]*referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/i);
    expect(html(MarketingTable, { rows: [row({ details: { videoId: 'abc123', thumbnailUrl: 'javascript:alert(1)' } })] })).not.toContain('<img');
    expect(html(MarketingTable, { rows: [row({ details: null })] })).not.toContain('<img');
  });

  it('keeps the publication date and the first-seen time as two different things', () => {
    const out = html(MarketingTable, { rows: [row({ publishedAt: '2026-10-09T15:00:00.000Z', firstSeenAt: '2026-10-14T12:00:00.000Z' })] });
    expect(out).toContain('Oct');
    expect(out.match(/<td class="small">/g)!.length).toBeGreaterThanOrEqual(3); // engagement, published, first seen
  });

  it('says a count is unavailable — it is never shown as zero — and a real zero stays zero', () => {
    const hidden = html(EngagementCell, { m: row({ engagement: { views: 50, likes: null, comments: 0, shares: null, observedAt: '2026-10-14T12:00:00.000Z' } }) });
    expect(hidden).toContain('50 views');
    expect(hidden).toContain('likes unavailable');
    expect(hidden).toContain('0 comments');
    expect(hidden).not.toContain('0 likes');
    expect(html(EngagementCell, { m: row({ engagement: null }) })).toContain('not provided');
  });

  it('website observations still render as before, with no engagement and no channel', () => {
    const site = row({ id: 'r2', platform: 'site', kind: 'promo_banner', title: 'Spring sale: 20% off', url: 'https://fixturemart.test/', engagement: null, details: null, provenance: 'public_web' });
    const out = html(MarketingTable, { rows: [site] });
    expect(out).toContain('Website');
    expect(out).toContain('Spring sale: 20% off');
    expect(out).toContain('Promo banner');
    expect(out).not.toContain('<img');
    expect(out).toContain('<span class="muted">—</span>');
    expect(out).toContain('paid status not determined');
  });

  it('does not describe a video as an advertisement', () => {
    expect(html(MarketingTable, { rows: [row()] })).not.toMatch(/sponsor|ad spend|paid campaign/i);
  });

  it('keeps Instagram and Facebook rows as they were', () => {
    const ig = row({ id: 'r3', platform: 'instagram', kind: 'social_post', engagement: { views: null, likes: 42, comments: 3, shares: null, observedAt: '2026-10-14T12:00:00.000Z' }, details: null });
    const fb = row({ id: 'r4', platform: 'facebook', kind: 'social_post', engagement: { views: null, likes: 120, comments: 9, shares: 4, observedAt: '2026-10-14T12:00:00.000Z' }, details: null });
    const out = html(MarketingTable, { rows: [ig, fb] });
    expect(out).toContain('42 likes · 3 comments');
    expect(out).toContain('120 likes · 9 comments · 4 shares');
    expect(out).not.toContain('unavailable');
  });

  it('puts each video under the competitor it belongs to', () => {
    const out = html(MarketingTable, { rows: [row({ id: 'a', siteName: 'Alpha Shop' }), row({ id: 'b', siteName: 'Beta Shop', title: 'Beta video' })] });
    expect(out.indexOf('Alpha Shop')).toBeLessThan(out.indexOf('Beta Shop'));
    expect(out.match(/<tr>/g)!.length).toBe(3); // the header and one row for each video
    expect(out.indexOf('Beta video')).toBeGreaterThan(out.indexOf('<td>Beta Shop</td>')); // each title sits in its own competitor's row
    expect(out.indexOf('<td>Beta Shop</td>')).toBeGreaterThan(out.indexOf('Spring sale on car lights'));
  });
});

describe('video length', () => {
  it('reads as minutes and seconds, or hours', () => {
    expect(formatDuration(245)).toBe('4:05');
    expect(formatDuration(59)).toBe('0:59');
    expect(formatDuration(3723)).toBe('1:02:03');
  });
});
