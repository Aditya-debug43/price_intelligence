import { describe, expect, it } from 'vitest';
import { allSocialStatuses, fetchYouTube, isoDurationSeconds, parseYouTubeRef, verifyYouTubeChannel, youtubeStatus, type HttpJson } from './social.ts';

/** The YouTube Data API v3 integration against LOCAL IMITATIONS of its documented responses. No real request is made. */
const KEY = 'test-youtube-key-EEEE';
const CFG = { youtubeApiKey: KEY };
const NOW = new Date('2026-10-15T12:00:00Z');
const UC = 'UCabcdefghijklmnopqrstuv';
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const channel = (over: Record<string, unknown> = {}) => ({ items: [{ id: UC, snippet: { title: 'Brand Channel', customUrl: '@brandchannel' }, contentDetails: { relatedPlaylists: { uploads: 'UUbrand' } }, ...over }] });

describe('what an address or handle names', () => {
  it('reads a channel id, @handles and channel addresses', () => {
    expect(parseYouTubeRef(UC)).toEqual({ kind: 'id', channelId: UC });
    expect(parseYouTubeRef('@brandchannel')).toEqual({ kind: 'handle', handle: '@brandchannel' });
    expect(parseYouTubeRef('brandchannel')).toEqual({ kind: 'handle', handle: '@brandchannel' });
    expect(parseYouTubeRef('x', 'https://www.youtube.com/@BrandChannel/videos?sub=1')).toEqual({ kind: 'handle', handle: '@BrandChannel' });
    expect(parseYouTubeRef('x', `https://youtube.com/channel/${UC}/`)).toEqual({ kind: 'id', channelId: UC });
    expect(parseYouTubeRef('x', 'https://www.youtube.com/user/OldName')).toEqual({ kind: 'username', username: 'OldName' });
  });

  it('recognises an older /c/ custom address but does not pretend it names a channel', () => {
    expect(parseYouTubeRef('x', 'https://www.youtube.com/c/Brand%20Name')).toEqual({ kind: 'custom_url', name: 'Brand Name' });
  });

  it('refuses anything that is not a channel address — a video, a playlist, text, a shortened name', () => {
    expect(parseYouTubeRef('https://www.youtube.com/watch?v=abc')).toBeNull();
    expect(parseYouTubeRef('https://www.youtube.com/playlist?list=PLx')).toBeNull();
    expect(parseYouTubeRef('https://evil.example/@brand')).toBeNull();
    expect(parseYouTubeRef('not a handle!!')).toBeNull();
    expect(parseYouTubeRef('@x')).toBeNull(); // YouTube handles have at least three characters
    expect(parseYouTubeRef('   ')).toBeNull();
  });

  it('reads video lengths', () => {
    expect(isoDurationSeconds('PT4M5S')).toBe(245);
    expect(isoDurationSeconds('PT1H2M3S')).toBe(3723);
    expect(isoDurationSeconds('P1DT1H')).toBe(90_000);
    expect(isoDurationSeconds('PT0S')).toBe(0);
    expect(isoDurationSeconds('P0D')).toBeNull(); // YouTube gives this for a live broadcast that has no length yet
    expect(isoDurationSeconds(undefined)).toBeNull();
  });
});

describe('the YouTube card says what is true — a key alone is not "connected"', () => {
  it('not configured without a key, whatever channels exist', () => {
    expect(youtubeStatus({}, { connected: 2, unconnected: 0, collecting: false }).state).toBe('not_configured');
  });
  it('needs channel setup with a key and no connected channel, and says how many are waiting', () => {
    const s = youtubeStatus(CFG, { connected: 0, unconnected: 2, collecting: false });
    expect(s.state).toBe('needs_channel_setup');
    expect(s.message).toMatch(/2 channels were found on competitors’ websites and are waiting to be checked and connected/);
    expect(youtubeStatus(CFG, { connected: 0, unconnected: 0, collecting: false }).message).toMatch(/Add each competitor’s own YouTube channel/);
  });
  it('collecting while a read runs; ready when channels are connected; an error carries the reason', () => {
    expect(youtubeStatus(CFG, { connected: 2, unconnected: 0, collecting: true }).state).toBe('collecting');
    expect(youtubeStatus(CFG, { connected: 2, unconnected: 0, collecting: false }).state).toBe('ready');
    const e = youtubeStatus(CFG, { connected: 2, unconnected: 0, collecting: true, problem: 'Shop: quota is used up', problems: 2 });
    expect(e).toMatchObject({ state: 'error' });
    expect(e.message).toMatch(/quota is used up.*2 channels are affected/);
  });
  it('Instagram and Facebook are untouched by the YouTube key', () => {
    const all = allSocialStatuses(CFG, null, { connected: 1, unconnected: 0, collecting: false });
    expect(all.map((s) => [s.provider, s.state])).toEqual([['youtube', 'ready'], ['instagram', 'not_configured'], ['facebook', 'not_configured']]);
  });
});

describe('verifying a channel with YouTube before it is used', () => {
  const answer = (json: unknown, status = 200): HttpJson => async () => ({ status, json });

  it('looks a handle up by YouTube’s exact handle lookup and sends the key in a header, never in the address', async () => {
    const seen: { url: string; headers?: Record<string, string> }[] = [];
    const http: HttpJson = async (url, init) => { seen.push({ url, headers: init?.headers }); return { status: 200, json: channel() }; };
    const v = await verifyYouTubeChannel(CFG, { handle: '@BrandChannel' }, http);
    expect(v).toMatchObject({ ok: true, units: 1, channel: { channelId: UC, title: 'Brand Channel', customUrl: '@brandchannel', uploadsPlaylistId: 'UUbrand' } });
    expect(seen[0]!.url).toContain('forHandle=%40BrandChannel');
    expect(seen[0]!.url).not.toContain(KEY);
    expect(seen[0]!.headers).toEqual({ 'x-goog-api-key': KEY });
  });

  it('looks a channel id up by id; the id is exact by itself', async () => {
    const seen: string[] = [];
    const v = await verifyYouTubeChannel(CFG, { handle: 'whatever', externalId: UC }, async (url) => { seen.push(url); return { status: 200, json: channel() }; });
    expect(v.ok).toBe(true);
    expect(seen[0]).toContain(`id=${UC}`);
  });

  it('refuses a channel whose own address is not the handle asked for — never matched by a similar name', async () => {
    const v = await verifyYouTubeChannel(CFG, { handle: '@brandchannel2' }, answer(channel()));
    expect(v).toMatchObject({ ok: false, failure: { kind: 'not_found' } });
    expect((v as { message: string }).message).toMatch(/may be a different channel/);
  });

  it('refuses a channel that does not exist, a /c/ address, junk, and a channel without uploads', async () => {
    expect(await verifyYouTubeChannel(CFG, { handle: '@nobodyhere' }, answer({ pageInfo: { totalResults: 0 } }))).toMatchObject({ ok: false, message: expect.stringMatching(/no channel/) });
    const custom = await verifyYouTubeChannel(CFG, { handle: 'x', url: 'https://www.youtube.com/c/OldBrand' }, async () => { throw new Error('must not be asked'); });
    expect(custom).toMatchObject({ ok: false, units: 0, message: expect.stringMatching(/cannot turn it into a channel/) });
    expect(await verifyYouTubeChannel(CFG, { handle: '???' }, answer({}))).toMatchObject({ ok: false, message: expect.stringMatching(/not a YouTube channel address/) });
    expect(await verifyYouTubeChannel(CFG, { handle: '@brandchannel' }, answer(channel({ contentDetails: { relatedPlaylists: {} } })))).toMatchObject({ ok: false, message: expect.stringMatching(/no public uploads list/) });
  });

  it('reports a missing, rejected, restricted or not-enabled key, and quota, distinctly', async () => {
    expect(await verifyYouTubeChannel({}, { handle: '@brandchannel' }, answer({}))).toMatchObject({ ok: false, notConfigured: true });
    const msg = async (json: unknown, status: number) => (await verifyYouTubeChannel(CFG, { handle: '@brandchannel' }, answer(json, status)) as { message: string; failure: { kind: string } });
    expect(await msg({ error: { errors: [{ reason: 'keyInvalid' }] } }, 400)).toMatchObject({ failure: { kind: 'auth' }, message: expect.stringMatching(/YOUTUBE_API_KEY/) });
    expect(await msg({ error: { errors: [{ reason: 'accessNotConfigured' }], message: 'YouTube Data API v3 has not been used in project 1 before or it is disabled.' } }, 403)).toMatchObject({ failure: { kind: 'auth' }, message: expect.stringMatching(/not enabled/) });
    expect(await msg({ error: { errors: [{ reason: 'ipRefererBlocked' }] } }, 403)).toMatchObject({ failure: { kind: 'auth' }, message: expect.stringMatching(/restricted/) });
    expect(await msg({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403)).toMatchObject({ failure: { kind: 'quota' } });
  });

  it('a network error never quotes the key', async () => {
    const v = await verifyYouTubeChannel(CFG, { handle: '@brandchannel' }, async (url) => { throw new Error(`socket hang up ${url} key=${KEY}`); });
    expect(v).toMatchObject({ ok: false, failure: { kind: 'transient' } });
    expect((v as { message: string }).message).not.toContain(KEY);
    expect((v as { message: string }).message).toContain('[key]');
  });
});

describe('reading a channel’s uploads', () => {
  /** A channel whose uploads playlist holds `ids` (newest first), each published `ageDays[id]` days ago. Pages hold `page` items. */
  function imitation(ids: string[], ageDays: Record<string, number>, opts: { page?: number; unavailable?: Set<string>; failVideosAfter?: number } = {}) {
    const page = opts.page ?? 50;
    const calls: string[] = [];
    let videoCalls = 0;
    const http: HttpJson = async (url) => {
      calls.push(url);
      const u = new URL(url);
      if (u.pathname.endsWith('/channels')) return { status: 200, json: channel() };
      if (u.pathname.endsWith('/playlistItems')) {
        const at = Number(u.searchParams.get('pageToken') ?? 0);
        return { status: 200, json: { items: ids.slice(at, at + page).map((id) => ({ contentDetails: { videoId: id, videoPublishedAt: day(ageDays[id]!) } })), ...(at + page < ids.length ? { nextPageToken: String(at + page) } : {}) } };
      }
      videoCalls++;
      if (opts.failVideosAfter !== undefined && videoCalls > opts.failVideosAfter) return { status: 403, json: { error: { errors: [{ reason: 'quotaExceeded' }] } } };
      const wanted = (u.searchParams.get('id') ?? '').split(',');
      return { status: 200, json: { items: wanted.filter((id) => !opts.unavailable?.has(id)).map((id) => ({ id, snippet: { title: `T ${id}`, publishedAt: day(ageDays[id]!), channelId: UC, channelTitle: 'Brand Channel' }, contentDetails: { duration: 'PT1M' }, statistics: { viewCount: '10' } })) } };
    };
    return { http, calls };
  }
  const run = (http: HttpJson) => fetchYouTube(CFG, { handle: '@brandchannel' }, http, { now: NOW });

  it('follows the uploads playlist page by page, and asks for the videos 50 at a time', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `v${i}`);
    const ages = Object.fromEntries(ids.map((id, i) => [id, 1 + (i % 25)])); // all within the window
    const { http, calls } = imitation(ids, ages, { page: 50 });
    const r = await run(http);
    expect(r.ok).toBe(true);
    expect(r.posts).toHaveLength(120);
    expect(calls.filter((c) => c.includes('/playlistItems'))).toHaveLength(3); // 50 + 50 + 20
    const videoCalls = calls.filter((c) => c.includes('/videos?'));
    expect(videoCalls).toHaveLength(3); // 50 + 50 + 20 ids
    expect(videoCalls.every((c) => (new URL(c).searchParams.get('id') ?? '').split(',').length <= 50)).toBe(true);
    expect(r.units).toBe(1 + 3 + 3); // quota: the channel, the playlist pages and the video batches
    expect(calls.some((c) => c.includes('/search'))).toBe(false); // never the 100-unit search
    expect(calls.every((c) => !c.includes(KEY))).toBe(true);
  });

  it('a window of 30 days by publication date: stops paging at older videos and never records them', async () => {
    const ids = ['new1', 'new2', 'old1', 'old2', 'old3'];
    const { http, calls } = imitation(ids, { new1: 1, new2: 29, old1: 31, old2: 40, old3: 200 }, { page: 2 });
    const r = await run(http);
    expect(r.posts.map((p) => p.externalId)).toEqual(['new1', 'new2']);
    expect(calls.filter((c) => c.includes('/playlistItems'))).toHaveLength(2); // [new1 new2] [old1 old2] — never the third page
  });

  it('records what YouTube gave: title, description, thumbnail, length, dates and counts, and keeps the date apart', async () => {
    const http: HttpJson = async (url) => {
      if (url.includes('/channels')) return { status: 200, json: channel() };
      if (url.includes('/playlistItems')) return { status: 200, json: { items: [{ contentDetails: { videoId: 'a1', videoPublishedAt: day(3) } }] } };
      return { status: 200, json: { items: [{ id: 'a1', snippet: { title: 'New tyres', description: 'x'.repeat(3000), publishedAt: day(3), channelId: UC, channelTitle: 'Brand Channel', liveBroadcastContent: 'none', thumbnails: { default: { url: 'https://i.ytimg.com/d.jpg' }, high: { url: 'https://i.ytimg.com/h.jpg' } } }, contentDetails: { duration: 'PT1H2M3S' }, statistics: { viewCount: '1000', likeCount: '5', commentCount: '0' } }] } };
    };
    const r = await run(http);
    const p = r.posts[0]!;
    expect(p).toMatchObject({ externalId: 'a1', title: 'New tyres', url: 'https://www.youtube.com/watch?v=a1', kind: 'video', engagement: { views: 1000, likes: 5, comments: 0, shares: null } });
    expect(p.publishedAt.toISOString()).toBe(day(3));
    expect(p.text).toHaveLength(500);
    expect(p.details).toMatchObject({ videoId: 'a1', channelId: UC, channelTitle: 'Brand Channel', thumbnailUrl: 'https://i.ytimg.com/h.jpg', durationSeconds: 3723, liveBroadcast: 'none' });
    expect(p.details!.description).toHaveLength(2000);
  });

  it('a private or deleted video (listed, but not returned) is not recorded, and the message says so', async () => {
    const { http } = imitation(['p1', 'p2', 'p3'], { p1: 1, p2: 2, p3: 3 }, { unavailable: new Set(['p2']) });
    const r = await run(http);
    expect(r.posts.map((p) => p.externalId)).toEqual(['p1', 'p3']);
    expect(r.message).toMatch(/1 video\(s\) in the playlist were private or removed/);
  });

  it('a scheduled (upcoming) broadcast is not an upload', async () => {
    const http: HttpJson = async (url) => {
      if (url.includes('/channels')) return { status: 200, json: channel() };
      if (url.includes('/playlistItems')) return { status: 200, json: { items: [{ contentDetails: { videoId: 'u1', videoPublishedAt: day(1) } }] } };
      return { status: 200, json: { items: [{ id: 'u1', snippet: { title: 'Live soon', publishedAt: day(1), liveBroadcastContent: 'upcoming' } }] } };
    };
    expect((await run(http)).posts).toEqual([]);
  });

  it('a quota failure part-way keeps what was already read and reports the failure with the units spent', async () => {
    const ids = Array.from({ length: 70 }, (_, i) => `q${i}`);
    const { http } = imitation(ids, Object.fromEntries(ids.map((id) => [id, 2])), { failVideosAfter: 1 });
    const r = await run(http);
    expect(r).toMatchObject({ ok: false, state: 'error', failure: { kind: 'quota' }, externalId: UC });
    expect(r.posts).toHaveLength(50); // the first batch
    expect(r.message).toMatch(/50 upload\(s\) were read before it/);
    expect(r.units).toBe(1 + 2 + 2);
  });

  it('a channel with no recent uploads is a successful read of nothing — not an error', async () => {
    const { http } = imitation(['z1'], { z1: 90 });
    const r = await run(http);
    expect(r).toMatchObject({ ok: true, posts: [] });
    expect(r.message).toMatch(/Read 0 upload\(s\)/);
  });

  it('the channel the playlist belongs to is verified on every read, so a channel that vanished is reported', async () => {
    const http: HttpJson = async () => ({ status: 200, json: { items: [] } });
    const r = await fetchYouTube(CFG, { handle: '@brandchannel', externalId: UC }, http, { now: NOW });
    expect(r).toMatchObject({ ok: false, state: 'error', failure: { kind: 'not_found' } });
    expect(r.message).toMatch(/no channel for the id/);
  });

  it('does nothing without a key', async () => {
    const r = await fetchYouTube({}, { handle: '@brandchannel' }, async () => { throw new Error('no call expected'); });
    expect(r).toMatchObject({ ok: false, state: 'not_configured' });
  });
});
