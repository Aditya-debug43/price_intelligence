import { describe, expect, it } from 'vitest';
import { MIN_TIMING_ITEMS, summariseMarketing, type SummaryItem } from './marketing-summary.ts';

const now = new Date('2026-10-15T12:00:00Z');
const tz = 'America/Aruba';
const comp = [{ id: 'A', name: 'Rival A' }, { id: 'B', name: 'Rival B' }];

let n = 0;
const item = (o: Partial<SummaryItem> & { title: string }): SummaryItem => ({
  siteId: 'A', siteName: 'Rival A', platform: 'instagram', kind: 'social_post', excerpt: null, url: `https://example.test/p/${++n}`, classification: 'promotion',
  publishedAt: '2026-10-10T15:00:00Z', firstSeenAt: '2026-10-12T00:00:00Z', engagement: null, ...o,
});
const run = (items: SummaryItem[], over: Partial<Parameters<typeof summariseMarketing>[1]> = {}) =>
  summariseMarketing(items, { now, windowDays: 30, timeZone: tz, brands: [], accounts: [], competitors: comp, ...over });
const a = (s: ReturnType<typeof run>) => s.competitors.find((c) => c.siteId === 'A')!;

describe('summariseMarketing', () => {
  it('says nothing was observed — and why that is ambiguous — when there is no data', () => {
    const s = run([]);
    expect(s.headline).toMatch(/No marketing activity was observed/);
    expect(s.headline).toMatch(/nothing could be read/);
    expect(a(s)).toMatchObject({ total: 0, themes: [], timing: null });
  });

  it('counts by platform and classification and only inside the window', () => {
    const s = run([
      item({ title: 'Weekend sale on drinks' }),
      item({ title: 'New snack range', classification: 'product_launch', platform: 'facebook' }),
      item({ title: 'Old post', publishedAt: '2026-07-01T00:00:00Z', firstSeenAt: '2026-07-02T00:00:00Z' }),
    ]);
    expect(a(s)).toMatchObject({ total: 2, promotionCount: 1, byPlatform: { instagram: 1, facebook: 1 }, byClassification: { promotion: 1, product_launch: 1 } });
  });

  it('reports a recurring theme only when several DIFFERENT items share it', () => {
    const s = run([
      item({ title: 'Chocolate festival this weekend' }),
      item({ title: 'More chocolate deals' }),
      item({ title: 'Sunscreen reminder, sunscreen sunscreen sunscreen' }), // repeats within one item: not a theme
    ]);
    const terms = a(s).themes.map((t) => [t.term, t.items]);
    expect(terms).toContainEqual(['chocolate', 2]);
    expect(terms.some(([t]) => t === 'sunscreen')).toBe(false);
    expect(a(s).themes[0]!.examples).toHaveLength(2);
  });

  it('ignores filler words', () => {
    const s = run([item({ title: 'This is your best deal ever' }), item({ title: 'Your best price, this week' })]);
    expect(a(s).themes.map((t) => t.term)).toEqual(['best']);
  });

  it('counts brand mentions in promotional items only, on word boundaries', () => {
    const s = run(
      [item({ title: 'Coca-Cola 12-packs 2 for 1' }), item({ title: 'Cola Premium special', classification: 'promotion' }), item({ title: 'Coca-Cola history', classification: 'brand_content' })],
      { brands: ['Coca-Cola', 'Cola', 'Fanta'] },
    );
    expect(a(s).brandMentions).toEqual([{ brand: 'Cola', items: 2 }, { brand: 'Coca-Cola', items: 1 }]);
  });

  describe('promotional timing', () => {
    const dated = (iso: string) => item({ title: `Sale ${iso}`, publishedAt: iso });

    it('refuses to describe a pattern with too few dated promotions, and says how many it has', () => {
      const s = run([dated('2026-10-09T15:00:00Z'), dated('2026-10-02T15:00:00Z')]);
      expect(a(s).timing).toBeNull();
      expect(a(s).timingNote).toMatch(new RegExp(`2 of the ${MIN_TIMING_ITEMS} needed`));
    });

    it('names the busiest weekday in the customer’s time zone when the evidence supports it', () => {
      // Fridays 2026-10-09, 10-02, 09-25, 09-18 (UTC 15:00 = 11:00 in Aruba) plus one Tuesday
      const s = run([dated('2026-10-09T15:00:00Z'), dated('2026-10-02T15:00:00Z'), dated('2026-09-25T15:00:00Z'), dated('2026-09-18T15:00:00Z'), dated('2026-10-06T15:00:00Z')]);
      expect(a(s).timing).toMatchObject({ items: 5, busiest: { day: 'Friday', items: 4 } });
      expect(a(s).timing!.sentence).toMatch(/4 of 5 dated promotional posts were published on a Friday/);
    });

    it('uses local time: 01:00 UTC on a Saturday is still Friday evening in Aruba', () => {
      const saturdays = ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26', '2026-10-03'];
      expect(saturdays.every((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 6)).toBe(true);
      const s = run(saturdays.map((d) => dated(`${d}T01:00:00Z`)), { windowDays: 60 }); // Saturdays 01:00 UTC = Friday 21:00 in Aruba
      expect(a(s).timing!.busiest.day).toBe('Friday');
    });

    it('does not crown a day when several tie', () => {
      const s = run([dated('2026-10-09T15:00:00Z'), dated('2026-10-10T15:00:00Z'), dated('2026-10-11T15:00:00Z'), dated('2026-10-12T15:00:00Z'), dated('2026-10-13T15:00:00Z')]);
      expect(a(s).timing!.sentence).toMatch(/no single day stands out/);
    });

    it('items without a publish time never count towards timing', () => {
      const s = run([1, 2, 3, 4, 5, 6].map((i) => item({ title: `Sale ${i}`, publishedAt: null })));
      expect(a(s).timing).toBeNull();
      expect(a(s).timingNote).toMatch(/0 of the 5 needed/);
    });
  });

  it('ranks most liked and most viewed separately, and never turns a missing count into zero', () => {
    const e = (likes: number | null, views: number | null = null) => ({ views, likes, comments: null, shares: null, observedAt: '2026-10-14T00:00:00Z' });
    const s = run([item({ title: 'Quiet', engagement: e(3) }), item({ title: 'Popular', engagement: e(250) }), item({ title: 'Video', platform: 'youtube', kind: 'video', engagement: e(null, 9000) }), item({ title: 'Unknown', engagement: null })]);
    expect(a(s).mostLiked.map((x) => [x.title, x.value])).toEqual([['Popular', 250], ['Quiet', 3]]); // the video has no like count: it is absent, not 0
    expect(a(s).mostViewed.map((x) => [x.title, x.value])).toEqual([['Video', 9000]]);
  });

  it('spells out what cannot be seen', () => {
    const s = run([item({ title: 'Sale' })], { accounts: [{ siteId: 'A', platform: 'facebook', handle: 'rivala', confirmed: true, lastSyncStatus: 'requires_approval', lastSyncMessage: 'Meta approval is outstanding.' }] });
    const lim = a(s).limitations.join(' | ');
    expect(lim).toMatch(/facebook \(rivala\): Meta approval is outstanding/);
    expect(lim).toMatch(/cannot see private campaigns/);
    expect(lim).toMatch(/no engagement counts/);
    expect(s.competitors.find((c) => c.siteId === 'B')!.limitations.join(' ')).toMatch(/No social account is confirmed/);
  });

  it('never calls observed content a paid campaign', () => {
    const s = run([item({ title: 'Big sale' })]);
    expect(JSON.stringify(s)).not.toMatch(/\bpaid campaign (is|was) running|\bad spend of\b/i);
    expect(s.note).toMatch(/not evidence of paid advertising/);
  });
});
