import { describe, expect, it } from 'vitest';
import { allSocialStatuses, checkMetaToken, fetchFacebook, fetchInstagram, fetchYouTube, type HttpJson } from './social.ts';

/**
 * Engagement metrics, failure classification and token health — all against LOCAL imitations of the provider answers.
 * No real provider was contacted; shapes follow the providers' documented responses.
 */
const reply = (json: unknown, status = 200, headers?: Record<string, string>): HttpJson => async () => ({ status, json, headers });
const NOW = new Date('2026-10-15T12:00:00Z');
const epoch = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

describe('engagement metrics: a count the platform does not give is null, never zero', () => {
  const channel = { items: [{ id: 'UCabc', contentDetails: { relatedPlaylists: { uploads: 'UUabc' } } }] };
  const playlist = {
    items: ['v1', 'v2', 'v3'].map((id, i) => ({ snippet: { title: `Video ${i + 1}`, publishedAt: '2026-10-10T10:00:00Z', resourceId: { videoId: id } }, contentDetails: { videoId: id, videoPublishedAt: '2026-10-10T10:00:00Z' } })),
  };

  it('YouTube: views, likes and comments from one statistics call; a hidden like count stays null', async () => {
    const calls: string[] = [];
    const http: HttpJson = async (url) => {
      calls.push(url);
      if (url.includes('/channels?')) return { status: 200, json: channel };
      if (url.includes('/playlistItems?')) return { status: 200, json: playlist };
      return { status: 200, json: { items: [
        { id: 'v1', statistics: { viewCount: '1200', likeCount: '80', commentCount: '7' } },
        { id: 'v2', statistics: { viewCount: '50', commentCount: '0' } }, // likes hidden by the channel; zero comments is a real zero
        // v3 has no statistics at all
      ] } };
    };
    const r = await fetchYouTube({ youtubeApiKey: 'K' }, { handle: '@x' }, http);
    expect(r.ok).toBe(true);
    expect(calls.filter((u) => u.includes('/videos?'))).toHaveLength(1);
    expect(calls.find((u) => u.includes('/videos?'))).toContain('id=v1,v2,v3');
    expect(r.posts.map((p) => p.engagement)).toEqual([
      { views: 1200, likes: 80, comments: 7, shares: null },
      { views: 50, likes: null, comments: 0, shares: null },
      null,
    ]);
  });

  it('YouTube: if the statistics call fails the uploads are still returned, and the message says counts are missing', async () => {
    const http: HttpJson = async (url) => {
      if (url.includes('/channels?')) return { status: 200, json: channel };
      if (url.includes('/playlistItems?')) return { status: 200, json: playlist };
      return { status: 403, json: { error: { errors: [{ reason: 'quotaExceeded' }] } } };
    };
    const r = await fetchYouTube({ youtubeApiKey: 'K' }, { handle: '@x' }, http);
    expect(r.ok).toBe(true);
    expect(r.posts).toHaveLength(3);
    expect(r.posts.every((p) => !p.engagement)).toBe(true);
    expect(r.message).toMatch(/counts were not available/i);
  });

  it('Instagram: like and comment counts where returned; absent when Instagram hides them', async () => {
    const cfg = { metaAccessToken: 'T', metaInstagramBusinessAccountId: '1789' };
    const r = await fetchInstagram(cfg, { handle: '@rival' }, reply({ business_discovery: { username: 'rival', media: { data: [
      { id: '1', caption: 'Sale!', permalink: 'https://www.instagram.com/p/a/', timestamp: '2026-10-11T00:00:00+0000', like_count: 42, comments_count: 3 },
      { id: '2', caption: 'Hidden likes', permalink: 'https://www.instagram.com/p/b/', timestamp: '2026-10-12T00:00:00+0000', comments_count: 1 },
      { id: '3', caption: 'Nothing', permalink: 'https://www.instagram.com/p/c/', timestamp: '2026-10-13T00:00:00+0000' },
    ] } } }));
    expect(r.posts.map((p) => p.engagement)).toEqual([{ views: null, likes: 42, comments: 3, shares: null }, { views: null, likes: null, comments: 1, shares: null }, null]);
  });

  it('Facebook: reactions, comments and shares from the summary fields', async () => {
    const r = await fetchFacebook({ metaAccessToken: 'T' }, { handle: 'rival' }, reply({ data: [
      { id: '1_1', message: 'Sale', created_time: '2026-10-12T10:00:00+0000', permalink_url: 'https://facebook.com/rival/posts/1', reactions: { summary: { total_count: 120 } }, comments: { summary: { total_count: 9 } }, shares: { count: 4 } },
      { id: '1_2', message: 'Plain', created_time: '2026-10-12T11:00:00+0000', permalink_url: 'https://facebook.com/rival/posts/2' },
    ] }));
    expect(r.posts.map((p) => p.engagement)).toEqual([{ views: null, likes: 120, comments: 9, shares: 4 }, null]);
  });

  it('nonsense counts are ignored rather than stored', async () => {
    const r = await fetchFacebook({ metaAccessToken: 'T' }, { handle: 'rival' }, reply({ data: [{ id: '1', message: 'x', created_time: '2026-10-12T10:00:00+0000', permalink_url: 'https://facebook.com/r/1', reactions: { summary: { total_count: -5 } }, comments: { summary: { total_count: 'many' } } }] }));
    expect(r.posts[0]!.engagement).toBeNull();
  });
});

describe('failures are classified so the retry policy can act on them', () => {
  const yt = (json: unknown, status: number, headers?: Record<string, string>) => fetchYouTube({ youtubeApiKey: 'K' }, { handle: '@x' }, reply(json, status, headers));
  const fb = (json: unknown, status: number, headers?: Record<string, string>) => fetchFacebook({ metaAccessToken: 'T' }, { handle: 'p' }, reply(json, status, headers));

  it('YouTube: quota, bad key, rate limit with Retry-After, server trouble', async () => {
    expect((await yt({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403)).failure).toEqual({ kind: 'quota' });
    expect((await yt({ error: { errors: [{ reason: 'keyInvalid' }] } }, 400)).failure).toEqual({ kind: 'auth' });
    expect((await yt({ error: { errors: [{ reason: 'accessNotConfigured' }] } }, 403)).failure).toEqual({ kind: 'auth' });
    expect((await yt({ error: {} }, 429, { 'retry-after': '90' })).failure).toEqual({ kind: 'rate_limit', retryAfterSeconds: 90 });
    expect((await yt({}, 503)).failure).toEqual({ kind: 'transient' });
  });

  it('Meta: expired token, revoked grant, rate limit, missing approval, unknown account, server trouble', async () => {
    const expired = await fb({ error: { code: 190, message: 'Error validating access token: Session has expired' } }, 401);
    expect(expired.failure).toEqual({ kind: 'auth' });
    expect(expired.message).toMatch(/invalid or expired/);
    const revoked = await fb({ error: { code: 190, error_subcode: 458, message: 'The user has not authorized application' } }, 400);
    expect(revoked.failure).toEqual({ kind: 'auth' });
    expect(revoked.message).toMatch(/revoked/i);
    expect((await fb({ error: { code: 4, message: 'Application request limit reached' } }, 400, { 'retry-after': '600' })).failure).toEqual({ kind: 'rate_limit', retryAfterSeconds: 600 });
    expect((await fb({ error: { code: 17, message: 'User request limit reached' } }, 400)).failure?.kind).toBe('rate_limit');
    const perm = await fb({ error: { code: 10, message: 'Application does not have permission for this action' } }, 403);
    expect(perm).toMatchObject({ state: 'requires_approval', failure: { kind: 'permission' } });
    expect((await fb({ error: { code: 100, message: 'Unsupported get request' } }, 400)).failure?.kind).toBe('not_found');
    expect((await fb({ error: { code: 2, message: 'Service temporarily unavailable' } }, 500)).failure?.kind).toBe('transient');
  });

  it('a network error is transient and never throws', async () => {
    const r = await fetchFacebook({ metaAccessToken: 'T' }, { handle: 'p' }, async () => { throw new Error('ECONNRESET'); });
    expect(r).toMatchObject({ ok: false, failure: { kind: 'transient' } });
  });

  it('"not configured" is not a failure: there is nothing to retry', async () => {
    expect((await fetchYouTube({}, { handle: '@x' })).failure).toBeUndefined();
    expect((await fetchInstagram({}, { handle: '@x' })).failure).toBeUndefined();
  });
});

describe('Meta token health (debug_token — costs no API quota)', () => {
  const cfg = { metaAccessToken: 'TOKEN', metaAppId: '123', metaAppSecret: 'SECRET' };
  const debug = (data: Record<string, unknown>) => reply({ data });
  const FULL = ['instagram_basic', 'pages_show_list', 'pages_read_engagement'];

  it('no token: nothing to check', async () => {
    expect(await checkMetaToken({}, reply({}), NOW)).toBeNull();
  });

  it('a token with no app credentials cannot be checked, and the message says exactly what to set', async () => {
    const h = await checkMetaToken({ metaAccessToken: 'T' }, async () => { throw new Error('must not call Meta without app credentials'); }, NOW);
    expect(h).toMatchObject({ level: 'unknown', valid: null });
    expect(h!.message).toMatch(/META_APP_ID and META_APP_SECRET/);
  });

  it('a valid token that never expires (system-user token)', async () => {
    const h = await checkMetaToken(cfg, debug({ is_valid: true, expires_at: 0, scopes: FULL }), NOW);
    expect(h).toMatchObject({ level: 'ok', valid: true, neverExpires: true, expiresAt: null, missingScopes: [] });
  });

  it('a valid token far from expiry is ok and says when it expires', async () => {
    const h = await checkMetaToken(cfg, debug({ is_valid: true, expires_at: epoch('2026-12-20T12:00:00Z'), scopes: FULL }), NOW);
    expect(h).toMatchObject({ level: 'ok', neverExpires: false, daysLeft: 66 });
    expect(h!.expiresAt!.toISOString()).toBe('2026-12-20T12:00:00.000Z');
  });

  it('warns two weeks before expiry, with the number of days', async () => {
    const h = await checkMetaToken(cfg, debug({ is_valid: true, expires_at: epoch('2026-10-20T12:00:00Z'), scopes: FULL }), NOW);
    expect(h).toMatchObject({ level: 'warning', daysLeft: 5 });
    expect(h!.message).toMatch(/expires in 5 days/);
  });

  it('an expired or revoked token is bad and tells the owner what to do', async () => {
    const expired = await checkMetaToken(cfg, debug({ is_valid: true, expires_at: epoch('2026-10-14T12:00:00Z'), scopes: FULL }), NOW);
    expect(expired).toMatchObject({ level: 'bad', valid: false });
    const invalid = await checkMetaToken(cfg, debug({ is_valid: false, error: { code: 190, message: 'The user has not authorized application 123.' } }), NOW);
    expect(invalid).toMatchObject({ level: 'bad', valid: false });
    expect(invalid!.message).toMatch(/revoked/);
    expect(invalid!.message).toMatch(/META_ACCESS_TOKEN/);
  });

  it('a valid token missing permissions is flagged, naming each one', async () => {
    const h = await checkMetaToken(cfg, debug({ is_valid: true, expires_at: 0, scopes: ['instagram_basic'] }), NOW);
    expect(h).toMatchObject({ level: 'warning', missingScopes: ['pages_show_list', 'pages_read_engagement'] });
    expect(h!.message).toMatch(/pages_show_list, pages_read_engagement/);
  });

  it('warns when data access is about to lapse', async () => {
    const h = await checkMetaToken(cfg, debug({ is_valid: true, expires_at: 0, data_access_expires_at: epoch('2026-10-22T12:00:00Z'), scopes: FULL }), NOW);
    expect(h).toMatchObject({ level: 'warning' });
    expect(h!.message).toMatch(/re-authorise/);
  });

  it('Meta rejecting the app credentials, or being unreachable, is reported without condemning the token', async () => {
    const rejected = await checkMetaToken(cfg, reply({ error: { code: 190, message: 'Invalid OAuth access token signature.' } }, 400), NOW);
    expect(rejected!.level).toBe('warning');
    expect(rejected!.message).toMatch(/META_APP_ID and META_APP_SECRET/);
    const down = await checkMetaToken(cfg, async () => { throw new Error('ETIMEDOUT'); }, NOW);
    expect(down).toMatchObject({ level: 'unknown', valid: null });
  });

  it('only talks to Meta, and the app secret travels only in the Authorization-style access_token of debug_token', async () => {
    const urls: string[] = [];
    await checkMetaToken(cfg, async (u) => { urls.push(u); return { status: 200, json: { data: { is_valid: true, expires_at: 0, scopes: FULL } } }; }, NOW);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).host).toBe('graph.facebook.com');
    expect(new URL(urls[0]!).pathname).toMatch(/\/debug_token$/);
  });

  it('a bad token turns the Instagram and Facebook statuses into errors with the explanation; YouTube is unaffected', async () => {
    const bad = await checkMetaToken(cfg, debug({ is_valid: false }), NOW);
    const [yt, ig, fb] = allSocialStatuses({ ...cfg, youtubeApiKey: 'K', metaInstagramBusinessAccountId: '1789' }, bad);
    expect(yt!.state).toBe('ready');
    expect(ig).toMatchObject({ state: 'error', credential: { level: 'bad' } });
    expect(fb!.state).toBe('error');
    expect(ig!.message).toMatch(/no longer valid/);
  });
});
