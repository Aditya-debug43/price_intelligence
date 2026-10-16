import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { marketingActivities, products, socialAccounts } from '@ci/database';
import type { HttpJson } from '@ci/connectors';
import { buildApp } from '../../apps/api/src/app.ts';
import { clearSocialHealthCache, createOrganization, startScan, syncSocial } from '@ci/services';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';

/**
 * Marketing providers end to end, against LOCAL IMITATIONS of the YouTube and Meta APIs (no real provider is contacted):
 * engagement counts, provider failures (quota, revoked token, rate limit, missing approval), persisted backoff, credential change,
 * token health, the evidence-based summary, and the guarantee that no credential ever reaches the browser.
 */
const TEST_YT_KEY = 'test-youtube-key-AAAA';
const TEST_META_TOKEN = 'test-meta-token-BBBB';
const TEST_APP_SECRET = 'test-app-secret-CCCC';

let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let org: string;
let competitor: string;
let brand: string;
const PASSWORD = 'Correct-Horse-9-Battery';
const base = () => `/api/v1/orgs/${org}`;

// ── the imitation provider
const calls: string[] = [];
const behaviour = { youtube: 'ok' as 'ok' | 'quota' | 'badkey' | 'rate', meta: 'ok' as 'ok' | 'revoked' | 'rate' | 'permission', likes: 80, hideStats: false };
let debugToken: Record<string, unknown> = { is_valid: true, expires_at: 0, scopes: ['instagram_basic', 'pages_show_list', 'pages_read_engagement'] };

const imitation: HttpJson = async (url) => {
  calls.push(url);
  const u = new URL(url);
  if (u.host === 'www.googleapis.com') {
    if (behaviour.youtube === 'quota') return { status: 403, json: { error: { errors: [{ reason: 'quotaExceeded' }] } } };
    if (behaviour.youtube === 'badkey') return { status: 400, json: { error: { errors: [{ reason: 'keyInvalid' }] } } };
    if (behaviour.youtube === 'rate') return { status: 429, json: { error: {} }, headers: { 'retry-after': '1200' } };
    if (u.pathname.endsWith('/channels')) return { status: 200, json: { items: [{ id: 'UCrival', contentDetails: { relatedPlaylists: { uploads: 'UUrival' } } }] } };
    if (u.pathname.endsWith('/playlistItems')) {
      return { status: 200, json: { items: [
        { snippet: { title: 'Weekend sale: chocolate bars 2 for 1', description: 'Great deals', publishedAt: '2026-10-09T15:00:00Z', resourceId: { videoId: 'v1' } }, contentDetails: { videoId: 'v1', videoPublishedAt: '2026-10-09T15:00:00Z' } },
        { snippet: { title: 'Our new store tour', description: 'Come and see', publishedAt: '2026-10-07T15:00:00Z', resourceId: { videoId: 'v2' } }, contentDetails: { videoId: 'v2', videoPublishedAt: '2026-10-07T15:00:00Z' } },
      ] } };
    }
    return { status: 200, json: { items: behaviour.hideStats ? [] : [{ id: 'v1', statistics: { viewCount: '1200', likeCount: String(behaviour.likes), commentCount: '7' } }, { id: 'v2', statistics: { viewCount: '300', commentCount: '2' } }] } };
  }
  if (u.host === 'graph.facebook.com') {
    if (u.pathname.endsWith('/debug_token')) return { status: 200, json: { data: debugToken } };
    if (behaviour.meta === 'revoked') return { status: 400, json: { error: { code: 190, error_subcode: 458, message: 'The user has not authorized application' } } };
    if (behaviour.meta === 'rate') return { status: 400, json: { error: { code: 4, message: 'Application request limit reached' } }, headers: { 'retry-after': '900' } };
    if (behaviour.meta === 'permission') return { status: 403, json: { error: { code: 10, message: 'Application does not have permission for this action' } } };
    if (u.searchParams.get('fields')?.startsWith('business_discovery')) {
      return { status: 200, json: { business_discovery: { username: 'rival', media: { data: [
        { id: 'ig1', caption: 'Chocolate sale this weekend', permalink: 'https://www.instagram.com/p/ig1/', timestamp: '2026-10-02T15:00:00+0000', like_count: 42, comments_count: 3 },
        { id: 'ig2', caption: 'Chocolate lovers special offer', permalink: 'https://www.instagram.com/p/ig2/', timestamp: '2026-09-25T15:00:00+0000', like_count: 30 },
        { id: 'ig3', caption: 'Meet the team', permalink: 'https://www.instagram.com/p/ig3/', timestamp: '2026-10-05T15:00:00+0000' },
      ] } } } };
    }
    return { status: 200, json: { data: [
      { id: 'f1', message: 'Big sale this weekend on drinks', created_time: '2026-10-09T15:00:00+0000', permalink_url: 'https://facebook.com/rival/posts/f1', reactions: { summary: { total_count: 120 } }, comments: { summary: { total_count: 9 } }, shares: { count: 4 } },
      { id: 'f2', message: `Special offer: ${brand} multipacks`, created_time: '2026-10-02T15:00:00+0000', permalink_url: 'https://facebook.com/rival/posts/f2', reactions: { summary: { total_count: 60 } } },
      { id: 'f3', message: 'Weekend discount on everything', created_time: '2026-09-25T15:00:00+0000', permalink_url: 'https://facebook.com/rival/posts/f3' },
    ] } };
  }
  return { status: 404, json: {} };
};

const callsTo = (host: string) => calls.filter((c) => new URL(c).host === host).length;
// The fixture websites also advertise social links, which are discovered but stay unconfirmed (and unread) until a person confirms them.
const account = async (platform: string) => (await h.db.worker.select().from(socialAccounts).where(eq(socialAccounts.orgId, org))).find((a) => a.platform === platform && a.confirmed && a.discoveredFrom === 'manual')!;
const socialRows = async () => (await h.db.worker.select().from(marketingActivities).where(eq(marketingActivities.orgId, org))).filter((m) => m.platform !== 'site');
const sync = (manual = false) => syncSocial(h.svc, h.db.worker, org, { http: imitation, manual });
const stateOf = (rs: Awaited<ReturnType<typeof sync>>, platform: string) => rs.find((r) => r.platform === platform)!;

beforeAll(async () => {
  h = await createHarness({ extraEnv: { YOUTUBE_API_KEY: TEST_YT_KEY, META_ACCESS_TOKEN: TEST_META_TOKEN, META_INSTAGRAM_BUSINESS_ACCOUNT_ID: '17890000', META_APP_ID: '123456', META_APP_SECRET: TEST_APP_SECRET } });
  h.svc.socialHttp = imitation;
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
  await owner.post('/api/v1/auth/register', { email: `social-${Date.now()}@example.test`, password: PASSWORD, displayName: 'Social Owner' });
  const me = (await owner.get('/api/v1/auth/me')).body;
  org = (await createOrganization(h.db.app, me.user.id, 'Social Providers Demo', { mode: 'demo' })).id;
  const ids: Record<string, string> = {};
  for (const [key, role] of [['source', 'source'], ['woo', 'competitor']] as const) {
    ids[key] = (await owner.post(`${base()}/sites`, { url: h.fixtures.origin(key), role, name: h.fixtures.sites[key]!.spec.label })).body.site.id as string;
    await owner.post(`${base()}/sites/${ids[key]}/consent`, { status: 'confirmed', attest: true });
    await startScan(h.svc, h.db.worker, org, ids[key]!, { kind: 'discovery', trigger: 'manual' });
  }
  await h.queue.drain();
  competitor = ids.woo!;
  const brands = await h.db.worker.select({ brand: products.brand }).from(products).where(eq(products.orgId, org));
  brand = brands.find((b) => b.brand)!.brand!;
  for (const [platform, handle] of [['youtube', '@rivalstore'], ['instagram', '@rival'], ['facebook', 'rivalpage']] as const) {
    expect((await owner.post(`${base()}/social-accounts`, { siteId: competitor, platform, handle })).status).toBe(201);
  }
}, 180_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('reading public activity with engagement counts', () => {
  it('stores posts from all three providers with their public counts, and null where a count was not given', async () => {
    const r = await sync();
    expect(r.map((x) => [x.platform, x.state, x.posts])).toEqual(expect.arrayContaining([['youtube', 'ready', 2], ['instagram', 'ready', 3], ['facebook', 'ready', 3]]));
    const rows = await socialRows();
    const by = (url: string) => rows.find((m) => m.url?.includes(url))!;
    expect(by('v=v1').engagement).toEqual({ views: 1200, likes: 80, comments: 7, shares: null });
    expect(by('v=v2').engagement).toEqual({ views: 300, likes: null, comments: 2, shares: null }); // likes hidden: null, not 0
    expect(by('/p/ig1/').engagement).toEqual({ views: null, likes: 42, comments: 3, shares: null });
    expect(by('/p/ig3/').engagement).toBeNull();
    expect(by('/posts/f1').engagement).toEqual({ views: null, likes: 120, comments: 9, shares: 4 });
    expect(rows.every((m) => m.provenance === 'fixture' && m.extractionMethod === 'official_api')).toBe(true); // a fictional site, honestly labelled
  });

  it('syncing again refreshes the counts without duplicating posts', async () => {
    behaviour.likes = 95;
    await sync();
    const rows = await socialRows();
    expect(rows).toHaveLength(8);
    expect(rows.find((m) => m.url?.includes('v=v1'))!.engagement).toMatchObject({ likes: 95 });
  });

  it('when the platform stops giving counts, the last known counts stay with their own observation time', async () => {
    behaviour.hideStats = true;
    const before = (await socialRows()).find((m) => m.url?.includes('v=v1'))!;
    h.advance(3_600_000);
    await sync();
    const after = (await socialRows()).find((m) => m.url?.includes('v=v1'))!;
    expect(after.engagement).toEqual(before.engagement);
    expect(after.engagementObservedAt!.getTime()).toBe(before.engagementObservedAt!.getTime());
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime());
    behaviour.hideStats = false;
    behaviour.likes = 80;
  });
});

describe('quota and rate limits are respected, and remembered across restarts', () => {
  it('a used-up YouTube quota is recorded with the exact time it resets, and nothing else is affected', async () => {
    behaviour.youtube = 'quota';
    const r = await sync();
    expect(stateOf(r, 'youtube')).toMatchObject({ state: 'error' });
    expect(stateOf(r, 'youtube').message).toMatch(/quota/i);
    expect(stateOf(r, 'instagram').state).toBe('ready');
    const a = await account('youtube');
    expect(a).toMatchObject({ failureKind: 'quota', consecutiveFailures: 1 });
    // clock is 2026-10-14T13:00Z → next midnight Pacific (PDT) is 2026-10-15T07:00Z, plus a five-minute margin
    expect(a.nextAttemptAt!.toISOString()).toBe('2026-10-15T07:05:00.000Z');
  });

  it('until then neither the schedule nor a person asking makes another request to YouTube', async () => {
    const before = callsTo('www.googleapis.com');
    const scheduled = await sync(false);
    expect(stateOf(scheduled, 'youtube')).toMatchObject({ state: 'backing_off', nextAttemptAt: '2026-10-15T07:05:00.000Z' });
    expect(stateOf(scheduled, 'youtube').message).toMatch(/Waiting until 2026-10-15T07:05:00.000Z/);
    const manual = await sync(true);
    expect(stateOf(manual, 'youtube').state).toBe('backing_off'); // a person cannot override a quota
    expect(callsTo('www.googleapis.com')).toBe(before);
  });

  it('after the reset time it reads again and the failure is cleared', async () => {
    behaviour.youtube = 'ok';
    h.setNow('2026-10-15T07:06:00Z');
    const r = await sync();
    expect(stateOf(r, 'youtube')).toMatchObject({ state: 'ready', posts: 2 });
    expect(await account('youtube')).toMatchObject({ failureKind: null, consecutiveFailures: 0, nextAttemptAt: null, credentialFingerprint: null });
  });

  it('a provider’s Retry-After is honoured', async () => {
    behaviour.youtube = 'rate';
    const r = await sync();
    expect(stateOf(r, 'youtube').nextAttemptAt).toBe(new Date(new Date('2026-10-15T07:06:00Z').getTime() + 1200_000).toISOString());
    expect(await account('youtube')).toMatchObject({ failureKind: 'rate_limit' });
    behaviour.youtube = 'ok';
  });

  it('repeated Meta rate limits back off further each time', async () => {
    behaviour.meta = 'rate';
    h.setNow('2026-10-15T09:00:00Z');
    await sync();
    const first = (await account('facebook')).nextAttemptAt!.getTime();
    h.setNow(new Date(first + 60_000));
    await sync();
    const a = await account('facebook');
    expect(a.consecutiveFailures).toBe(2);
    // Retry-After (15 min) wins when the provider supplies it; the recorded wait is that, from the second attempt's time
    expect(a.nextAttemptAt!.getTime() - (first + 60_000)).toBe(900_000);
    behaviour.meta = 'ok';
    h.setNow(new Date(a.nextAttemptAt!.getTime() + 1000));
    await sync();
    expect(await account('facebook')).toMatchObject({ failureKind: null, consecutiveFailures: 0 });
  });
});

describe('a revoked or expired credential is not hammered, and replacing it starts fresh', () => {
  it('a revoked Meta grant is reported as needing a new token, and is not retried by the schedule', async () => {
    behaviour.meta = 'revoked';
    h.setNow('2026-10-16T12:00:00Z');
    const r = await sync();
    expect(stateOf(r, 'instagram')).toMatchObject({ state: 'needs_reconnect' });
    expect(stateOf(r, 'instagram').message).toMatch(/revoked/i);
    expect(stateOf(r, 'facebook').state).toBe('needs_reconnect');
    expect(await account('instagram')).toMatchObject({ failureKind: 'auth', nextAttemptAt: null, consecutiveFailures: 1 });
    const stored = await account('instagram');
    expect(stored.credentialFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(stored)).not.toContain(TEST_META_TOKEN); // only a one-way fingerprint is kept

    const before = callsTo('graph.facebook.com');
    h.advance(86_400_000);
    const again = await sync(false);
    expect(stateOf(again, 'instagram')).toMatchObject({ state: 'needs_reconnect' });
    expect(stateOf(again, 'instagram').message).toMatch(/Replace it/);
    expect(callsTo('graph.facebook.com')).toBe(before); // no request while the credential is unchanged
  });

  it('a person can try again, and the attempt is counted', async () => {
    const before = callsTo('graph.facebook.com');
    await sync(true);
    expect(callsTo('graph.facebook.com')).toBeGreaterThan(before);
    expect((await account('instagram')).consecutiveFailures).toBe(2);
  });

  it('replacing the credential starts fresh and the next scheduled sync works', async () => {
    behaviour.meta = 'ok';
    (h.svc.config as { META_ACCESS_TOKEN?: string }).META_ACCESS_TOKEN = 'test-meta-token-REPLACED';
    const r = await sync(false);
    expect(stateOf(r, 'instagram')).toMatchObject({ state: 'ready', posts: 3 });
    expect(stateOf(r, 'facebook')).toMatchObject({ state: 'ready', posts: 3 });
    expect(await account('instagram')).toMatchObject({ failureKind: null, consecutiveFailures: 0, credentialFingerprint: null });
    (h.svc.config as { META_ACCESS_TOKEN?: string }).META_ACCESS_TOKEN = TEST_META_TOKEN;
  });

  it('missing platform approval is re-checked daily, and a person may check sooner', async () => {
    behaviour.meta = 'permission';
    h.setNow('2026-10-20T12:00:00Z');
    const r = await sync();
    expect(stateOf(r, 'facebook')).toMatchObject({ state: 'requires_approval' });
    expect((await account('facebook')).nextAttemptAt!.toISOString()).toBe('2026-10-21T12:00:00.000Z');
    const quiet = await sync(false);
    expect(stateOf(quiet, 'facebook').state).toBe('backing_off');
    const before = callsTo('graph.facebook.com');
    const manual = await sync(true);
    expect(stateOf(manual, 'facebook').state).toBe('requires_approval'); // actually asked again
    expect(callsTo('graph.facebook.com')).toBeGreaterThan(before);
    behaviour.meta = 'ok';
    await sync(true);
  });

  it('a nonexistent YouTube key problem is an auth failure with the exact variable to fix', async () => {
    behaviour.youtube = 'badkey';
    h.setNow('2026-10-22T12:00:00Z');
    const r = await sync();
    expect(stateOf(r, 'youtube')).toMatchObject({ state: 'needs_reconnect' });
    expect(stateOf(r, 'youtube').message).toMatch(/YOUTUBE_API_KEY/);
    behaviour.youtube = 'ok';
    (h.svc.config as { YOUTUBE_API_KEY?: string }).YOUTUBE_API_KEY = 'test-youtube-key-NEW';
    expect(stateOf(await sync(false), 'youtube').state).toBe('ready');
    (h.svc.config as { YOUTUBE_API_KEY?: string }).YOUTUBE_API_KEY = TEST_YT_KEY;
  });
});

describe('the customer sees provider and token health, never a credential', () => {
  const providers = async () => (await owner.get(`${base()}/integrations`)).body.social.providers as { provider: string; state: string; message: string; credential?: { level: string; daysLeft: number | null; missingScopes: string[]; neverExpires: boolean } }[];

  it('a token that expires soon is a warning with the number of days', async () => {
    clearSocialHealthCache();
    h.setNow('2026-10-14T12:00:00Z');
    debugToken = { is_valid: true, expires_at: Math.floor(new Date('2026-10-19T12:00:00Z').getTime() / 1000), scopes: ['instagram_basic', 'pages_show_list', 'pages_read_engagement'] };
    const ig = (await providers()).find((p) => p.provider === 'instagram')!;
    expect(ig.credential).toMatchObject({ level: 'warning', daysLeft: 5 });
    expect(ig.state).toBe('ready'); // still works today — the warning is about tomorrow
  });

  it('is asked of Meta at most once an hour', async () => {
    const before = calls.filter((c) => c.includes('/debug_token')).length;
    await providers();
    await providers();
    expect(calls.filter((c) => c.includes('/debug_token')).length).toBe(before);
    h.advance(3_700_000);
    await providers();
    expect(calls.filter((c) => c.includes('/debug_token')).length).toBe(before + 1);
  });

  it('a revoked token turns Instagram and Facebook into errors that say what to do; YouTube is unaffected', async () => {
    clearSocialHealthCache();
    debugToken = { is_valid: false, error: { code: 190, message: 'The user has not authorized application 123456.' } };
    const ps = await providers();
    expect(ps.find((p) => p.provider === 'instagram')).toMatchObject({ state: 'error', credential: { level: 'bad' } });
    expect(ps.find((p) => p.provider === 'facebook')!.state).toBe('error');
    expect(ps.find((p) => p.provider === 'youtube')!.state).toBe('ready');
    expect(ps.find((p) => p.provider === 'instagram')!.message).toMatch(/META_ACCESS_TOKEN/);
    debugToken = { is_valid: true, expires_at: 0, scopes: ['instagram_basic'] };
    clearSocialHealthCache();
    expect((await providers()).find((p) => p.provider === 'instagram')!.credential).toMatchObject({ level: 'warning', missingScopes: ['pages_show_list', 'pages_read_engagement'] });
  });

  it('shows each account’s backoff state and why', async () => {
    const accounts = (await owner.get(`${base()}/integrations`)).body.social.accounts as { platform: string; confirmed: boolean; failureKind: string | null; nextAttemptAt: string | null; lastSyncStatus: string | null }[];
    expect(accounts.filter((a) => a.confirmed)).toHaveLength(3);
    expect(accounts.every((a) => 'failureKind' in a && 'nextAttemptAt' in a)).toBe(true);
  });

  it('no API response ever contains a credential or the app secret', async () => {
    const bodies = JSON.stringify([
      (await owner.get(`${base()}/integrations`)).body,
      (await owner.get(`${base()}/marketing?days=60`)).body,
      (await owner.get('/api/v1/meta')).body,
    ]);
    for (const secret of [TEST_YT_KEY, TEST_META_TOKEN, TEST_APP_SECRET, 'test-meta-token-REPLACED', 'test-youtube-key-NEW']) expect(bodies).not.toContain(secret);
  });
});

describe('the summary states only what the evidence supports', () => {
  type Summary = { headline: string; note: string; competitors: { siteId: string; total: number; promotionCount: number; themes: { term: string; items: number }[]; brandMentions: { brand: string; items: number }[]; timing: null | { items: number; busiest: { day: string; items: number }; sentence: string }; mostLiked: { value: number; platform: string }[]; mostViewed: { value: number; platform: string }[]; limitations: string[] }[] };
  let s: Summary;
  const mine = () => s.competitors.find((c) => c.siteId === competitor)!;

  it('is part of the marketing response, with the observed activity', async () => {
    h.setNow('2026-10-14T12:00:00Z');
    const body = (await owner.get(`${base()}/marketing?days=30`)).body;
    s = body.summary;
    expect(body.activity.filter((m: { platform: string }) => m.platform !== 'site')).toHaveLength(8);
    expect(body.activity.find((m: { url: string }) => m.url.includes('v=v1')).engagement).toMatchObject({ views: 1200, likes: 80 });
    expect(mine().total).toBeGreaterThanOrEqual(8); // plus whatever banners the website itself shows
  });

  it('finds recurring themes and the brand mentioned in a promotion', () => {
    expect(mine().themes.find((t) => t.term === 'chocolate')!.items).toBeGreaterThanOrEqual(3);
    expect(mine().brandMentions.map((b) => b.brand)).toContain(brand);
  });

  it('describes promotional timing because enough dated promotions exist, in the customer’s time zone', () => {
    expect(mine().promotionCount).toBeGreaterThanOrEqual(5);
    expect(mine().timing).not.toBeNull();
    expect(mine().timing!.busiest.day).toBe('Friday');
    expect(mine().timing!.sentence).toMatch(/published on a Friday \(America\/Aruba time\)/);
  });

  it('ranks most liked and most viewed separately — a view count is never compared with a like count', () => {
    expect(mine().mostViewed.map((x) => x.value)).toEqual([1200, 300]);
    expect(mine().mostLiked[0]).toMatchObject({ value: 120, platform: 'facebook' });
    expect(mine().mostLiked.length).toBeLessThanOrEqual(3);
    expect(mine().mostLiked.map((x) => x.value)).toEqual([...mine().mostLiked.map((x) => x.value)].sort((a, b) => b - a));
  });

  it('is explicit about limits and never claims paid advertising', () => {
    expect(mine().limitations.join(' ')).toMatch(/cannot see private campaigns/);
    expect(s.note).toMatch(/not evidence of paid advertising/);
    expect(JSON.stringify(s)).not.toMatch(/ad spend of|paid campaign (is|was) running/i);
  });

  it('with a window too short to include the posts, it says nothing was observed rather than inventing activity', async () => {
    h.setNow('2026-10-27T12:00:00Z'); // 13 days on (the login lasts 14): every post is older than the seven-day window
    const quiet = (await owner.get(`${base()}/marketing?days=7`)).body.summary as Summary;
    expect(quiet.headline).toMatch(/No marketing activity was observed/);
    expect(quiet.competitors.find((c) => c.siteId === competitor)).toMatchObject({ total: 0, timing: null });
  });
});

describe('who may do what', () => {
  it('another workspace sees none of this and cannot sync or read it', async () => {
    const stranger = new ApiClient(app);
    await stranger.post('/api/v1/auth/register', { email: `social-stranger-${Date.now()}@example.test`, password: PASSWORD, displayName: 'S' });
    const strangerOrg = (await stranger.post('/api/v1/orgs', { name: 'Stranger Co' })).body.organization.id as string;
    const m = (await stranger.get(`/api/v1/orgs/${strangerOrg}/marketing`)).body;
    expect(m.activity).toEqual([]);
    expect(m.summary.competitors).toEqual([]);
    expect((await stranger.get(`${base()}/marketing`)).status).toBe(404);
    expect((await stranger.post(`${base()}/social/sync`, {})).status).toBe(404);
  });

  it('a manual sync request is queued as a person’s request', async () => {
    h.setNow('2026-10-14T12:00:00Z');
    const r = await owner.post(`${base()}/social/sync`, {});
    expect(r.status).toBe(202);
    await h.queue.drain();
  });
});
