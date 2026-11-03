import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { auditEvents, marketingActivities, socialAccounts } from '@ci/database';
import type { HttpJson } from '@ci/connectors';
import { buildApp } from '../../apps/api/src/app.ts';
import { createOrganization, startScan, syncSocial } from '@ci/services';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp } from '../support/auth.ts';

/**
 * YouTube collection end to end, against a LOCAL IMITATION of the YouTube Data API v3 (no real provider is contacted; shapes follow the documented responses).
 * What is proved: only a channel YouTube itself confirms is connected; videos land under the right competitor, once, with their real dates and honest counts;
 * a failing channel never disturbs another competitor or the website observations; and the API key travels only in a request header, never into an address, a stored
 * message or any response.
 */
const TEST_KEY = 'test-youtube-key-DDDD';
const PASSWORD = 'Correct-Horse-9-Battery';
const DAY = 86_400_000;

let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let org: string;
let woo: string;
let jsonld: string;
let wooName: string;
const base = () => `/api/v1/orgs/${org}`;

// ── the imitation YouTube
interface Chan { id: string; title: string; customUrl: string; uploads: string }
const CH: Record<string, Chan> = {
  woo: { id: 'UCwoowoowoowoowoowoowoo01', title: 'Fixture Mart Official', customUrl: '@fixturewoo', uploads: 'UUwoo' },
  woo2: { id: 'UCwoowoowoowoowoowoowoo02', title: 'Fixture Mart Kids', customUrl: '@fixturemartkids', uploads: 'UUwoo2' },
  jsonld: { id: 'UCjsonldjsonldjsonldjso03', title: 'Fixture Superstore', customUrl: '@fixturejsonld', uploads: 'UUjsonld' },
};
const byHandle = (handle: string) => Object.values(CH).find((c) => c.customUrl.toLowerCase() === handle.toLowerCase());
const byId = (id: string) => Object.values(CH).find((c) => c.id === id);

const behaviour = { mode: 'ok' as 'ok' | 'quota' | 'badkey' | 'disabled' | 'throw', deleted: new Set<string>(), unresolvable: new Set<string>(), likes: 80 };
const calls: string[] = [];
const keysSeen: (string | undefined)[] = [];

/** [id, days before the test clock, statistics (undefined = none given), visible to videos.list]. Newest first, as a real uploads playlist is. */
const VIDEOS: Record<string, [string, number, Record<string, string> | undefined, boolean][]> = {
  UUwoo: [
    ['w1', 2, { viewCount: '1200', likeCount: '80', commentCount: '7' }, true],
    ['wdel', 5, undefined, false], // in the playlist, but private or deleted: videos.list does not return it
    ['w2', 10, undefined, true], // no statistics at all
    ['w3', 20, { viewCount: '50', commentCount: '0' }, true], // likes hidden by the channel; zero comments is a real zero
    ['wold', 45, { viewCount: '9' }, true], // outside the 30-day window
    ['wold2', 60, { viewCount: '9' }, true],
    ['wold3', 80, { viewCount: '9' }, true],
  ],
  UUwoo2: [['k1', 4, { viewCount: '15', likeCount: '2', commentCount: '1' }, true]],
  UUjsonld: [['j1', 3, { viewCount: '400', likeCount: '30', commentCount: '5' }, true]],
};
const published = (days: number) => new Date(h.svc.clock().getTime() - days * DAY).toISOString();
const PAGE = 2;

const imitation: HttpJson = async (url, init) => {
  calls.push(url);
  const u = new URL(url);
  if (u.host !== 'www.googleapis.com') return { status: 404, json: {} };
  keysSeen.push(init?.headers?.['x-goog-api-key']);
  if (behaviour.mode === 'throw') throw new Error(`connect ETIMEDOUT while calling ${url} with key=${TEST_KEY}`);
  if (init?.headers?.['x-goog-api-key'] !== TEST_KEY || behaviour.mode === 'badkey') return { status: 400, json: { error: { errors: [{ reason: 'keyInvalid' }] } } };
  if (behaviour.mode === 'quota') return { status: 403, json: { error: { errors: [{ reason: 'quotaExceeded' }] } } };
  if (behaviour.mode === 'disabled') return { status: 403, json: { error: { errors: [{ reason: 'accessNotConfigured' }], message: 'YouTube Data API v3 has not been used in project 1 before or it is disabled.' } } };
  if (u.pathname.endsWith('/channels')) {
    const handle = u.searchParams.get('forHandle');
    const id = u.searchParams.get('id');
    let c = handle ? byHandle(handle) : id ? byId(id) : undefined;
    if (handle === '@lookalike') c = CH.woo; // a search-like answer for a different handle: the app must notice it is not that channel's address
    if (!c || behaviour.deleted.has(c.id) || behaviour.unresolvable.has(c.id)) return { status: 200, json: { pageInfo: { totalResults: 0 } } };
    return { status: 200, json: { items: [{ id: c.id, snippet: { title: c.title, customUrl: c.customUrl }, contentDetails: { relatedPlaylists: { uploads: c.uploads } } }] } };
  }
  if (u.pathname.endsWith('/playlistItems')) {
    const list = VIDEOS[u.searchParams.get('playlistId')!] ?? [];
    const offset = Number(u.searchParams.get('pageToken') ?? 0);
    const items = list.slice(offset, offset + PAGE).map(([id, days]) => ({ contentDetails: { videoId: id, videoPublishedAt: published(days) } }));
    return { status: 200, json: { items, ...(offset + PAGE < list.length ? { nextPageToken: String(offset + PAGE) } : {}) } };
  }
  if (u.pathname.endsWith('/videos')) {
    const wanted = new Set((u.searchParams.get('id') ?? '').split(','));
    const out: unknown[] = [];
    for (const [playlist, list] of Object.entries(VIDEOS)) {
      const chan = Object.values(CH).find((c) => c.uploads === playlist)!;
      for (const [id, days, stats, visible] of list) {
        if (!wanted.has(id) || !visible) continue;
        const statistics = stats && id === 'w1' ? { ...stats, likeCount: String(behaviour.likes) } : stats;
        out.push({
          id,
          snippet: { title: `Video ${id}`, description: `About ${id}`, publishedAt: published(days), channelId: chan.id, channelTitle: chan.title, thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } } },
          contentDetails: { duration: 'PT4M5S' },
          ...(statistics ? { statistics } : {}),
        });
      }
    }
    return { status: 200, json: { items: out } };
  }
  return { status: 404, json: {} };
};

const accounts = async () => (await h.db.worker.select().from(socialAccounts).where(eq(socialAccounts.orgId, org))).filter((a) => a.platform === 'youtube');
const accountOf = async (siteId: string, handle: string) => (await accounts()).find((a) => a.siteId === siteId && a.handle.toLowerCase() === handle.toLowerCase());
const accountFor = async (c: Chan) => (await accounts()).find((a) => a.externalId === c.id && a.confirmed)!;
const youtubeRows = async (siteId?: string) => (await h.db.worker.select().from(marketingActivities).where(eq(marketingActivities.orgId, org))).filter((m) => m.platform === 'youtube' && (!siteId || m.siteId === siteId));
const siteRows = async () => (await h.db.worker.select().from(marketingActivities).where(and(eq(marketingActivities.orgId, org), eq(marketingActivities.platform, 'site')))).sort((a, b) => a.id.localeCompare(b.id));
const idOf = (url: string | null) => url?.split('v=')[1];
const overview = async () => (await owner.get(`${base()}/integrations`)).body.social as { providers: { provider: string; state: string; message: string }[]; accounts: { id: string; siteId: string; platform: string; handle: string; confirmed: boolean; externalId: string | null; externalTitle: string | null; verifiedAt: string | null; syncing: boolean; lastSyncStatus: string | null }[] };
const card = async (provider = 'youtube') => (await overview()).providers.find((p) => p.provider === provider)!;
const syncNow = (manual = true) => syncSocial(h.svc, h.db.worker, org, { http: imitation, manual });
const add = (siteId: string, handle: string, url?: string) => owner.post(`${base()}/social-accounts`, { siteId, platform: 'youtube', handle, ...(url ? { url } : {}) });

beforeAll(async () => {
  // only YouTube is configured: Instagram and Facebook must stay "not set up" throughout
  h = await createHarness({ extraEnv: { YOUTUBE_API_KEY: TEST_KEY } });
  h.svc.socialHttp = imitation;
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
  await signUp(owner, h, { email: `yt-${Date.now()}@example.test`, password: PASSWORD, displayName: 'YouTube Owner' });
  const me = (await owner.get('/api/v1/auth/me')).body;
  org = (await createOrganization(h.db.app, me.user.id, 'YouTube Collection')).id;
  const ids: Record<string, string> = {};
  for (const [key, role] of [['source', 'source'], ['woo', 'competitor'], ['jsonld', 'competitor']] as const) {
    ids[key] = (await owner.post(`${base()}/sites`, { url: h.fixtures.origin(key), role, name: h.fixtures.sites[key]!.spec.label })).body.site.id as string;
    await owner.post(`${base()}/sites/${ids[key]}/consent`, { status: 'confirmed', attest: true });
    await startScan(h.svc, h.db.worker, org, ids[key]!, { kind: 'discovery', trigger: 'manual' });
  }
  await h.queue.drain();
  woo = ids.woo!;
  jsonld = ids.jsonld!;
  wooName = h.fixtures.sites.woo!.spec.label;
  // a banner the website itself showed: it must be untouched by anything YouTube does
  await h.db.worker.insert(marketingActivities).values({ orgId: org, siteId: woo, platform: 'site', kind: 'promo_banner', title: 'Spring sale: 20% off', url: `${h.fixtures.origin('woo')}/`, firstSeenAt: h.svc.clock(), lastSeenAt: h.svc.clock(), classification: 'promotion', confidence: 0.6, extractionMethod: 'html_banner', dedupeKey: 'site:test-banner', provenance: 'public_web' });
}, 240_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('before any channel is connected, a key alone is never shown as "connected"', () => {
  it('says the channel setup is missing, and reads nothing from YouTube', async () => {
    const found = (await accounts()).filter((a) => a.discoveredFrom === 'site_link');
    expect(found.length).toBeGreaterThanOrEqual(2); // the fictional websites link their YouTube channels in their footers
    expect(found.every((a) => !a.confirmed && !a.externalId)).toBe(true);
    const c = await card();
    expect(c.state).toBe('needs_channel_setup');
    expect(c.message).toMatch(/no competitor channel is connected/);
    expect(c.message).toMatch(/waiting to be checked and connected/);
    expect(await syncNow()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('without a key it says "not set up"; Instagram and Facebook are not set up either', async () => {
    const cfg = h.svc.config as { YOUTUBE_API_KEY?: string };
    cfg.YOUTUBE_API_KEY = undefined;
    expect((await card()).state).toBe('not_configured');
    cfg.YOUTUBE_API_KEY = TEST_KEY;
    expect((await card('instagram')).state).toBe('not_configured');
    expect((await card('facebook')).state).toBe('not_configured');
  });
});

describe('only a channel YouTube itself confirms is connected', () => {
  const before = async () => (await accounts()).length;

  it('refuses a handle YouTube answers with a different channel (never matched by similar name)', async () => {
    const n = await before();
    const r = await add(woo, '@lookalike');
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/may be a different channel/);
    expect(await before()).toBe(n);
  });

  it('refuses an older /c/ custom address with instructions, without spending a request', async () => {
    const used = calls.length;
    const r = await add(woo, 'https://www.youtube.com/c/FixtureMart');
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/cannot turn it into a channel/);
    expect(r.body.error.message).toMatch(/@handle|channel\/UC/);
    expect(calls.length).toBe(used);
  });

  it('refuses a channel that does not exist, junk, and an unknown website', async () => {
    expect((await add(woo, '@doesnotexist')).body.error.message).toMatch(/no channel/i);
    expect((await add(woo, 'not a handle!!')).status).toBe(422);
    expect((await add('00000000-0000-4000-8000-000000000000', '@fixturewoo')).status).toBe(404);
  });

  it('a discovered channel YouTube cannot resolve stays unconfirmed', async () => {
    const found = (await accounts()).find((a) => a.siteId === jsonld && a.discoveredFrom === 'site_link')!;
    behaviour.unresolvable.add(CH.jsonld!.id);
    const r = await owner.patch(`${base()}/social-accounts/${found.id}`, { confirmed: true });
    expect(r.status).toBe(422);
    expect((await accounts()).find((a) => a.id === found.id)).toMatchObject({ confirmed: false, externalId: null });
    behaviour.unresolvable.delete(CH.jsonld!.id);
  });

  it('confirming a discovered channel checks it with YouTube first, and records the channel as YouTube names it', async () => {
    const found = (await accounts()).find((a) => a.siteId === woo && a.discoveredFrom === 'site_link')!;
    const r = await owner.patch(`${base()}/social-accounts/${found.id}`, { confirmed: true });
    expect(r.status).toBe(200);
    expect(await accountOf(woo, found.handle)).toMatchObject({ confirmed: true, externalId: CH.woo!.id, externalTitle: 'Fixture Mart Official' });
    expect((await accountOf(woo, found.handle))!.verifiedAt).not.toBeNull();
  });
});

describe('collection: the right competitor, once, with real dates and honest counts', () => {
  let siteBefore: Awaited<ReturnType<typeof siteRows>>;

  it('connecting the channel reads it straight away (a background job, not the page load)', async () => {
    siteBefore = await siteRows();
    expect(siteBefore.length).toBeGreaterThanOrEqual(1);
    await h.queue.drain();
    const rows = await youtubeRows(woo);
    expect(rows.map((m) => idOf(m.url)).sort()).toEqual(['w1', 'w2', 'w3']);
  });

  it('keeps only videos published in the last 30 days, and skips private or deleted ones', async () => {
    const ids = (await youtubeRows()).map((m) => idOf(m.url));
    expect(ids).not.toContain('wold'); // 45 days ago
    expect(ids).not.toContain('wdel'); // listed in the playlist, but not available
    const a = (await accounts()).find((x) => x.siteId === woo && x.confirmed)!;
    expect(a.lastSyncStatus).toBe('ready');
    expect(a.lastSyncMessage).toMatch(/Read 3 upload\(s\) published in the last 30 days/);
    expect(a.lastSyncMessage).toMatch(/1 video\(s\) in the playlist were private or removed/);
  });

  it('pages through the uploads playlist and stops once it reaches videos older than the window', async () => {
    const playlistCalls = calls.filter((c) => c.includes('/playlistItems') && /playlistId=UUwoo(&|$)/.test(c));
    // pages of two: [w1, wdel] [w2, w3] [wold, wold2] — the fourth page (wold3) is never asked for, and no search call is ever made
    expect(playlistCalls).toHaveLength(3);
    expect(calls.some((c) => c.includes('pageToken=6'))).toBe(false);
    expect(calls.some((c) => c.includes('/search'))).toBe(false);
  });

  it('stores each video under the competitor that owns the channel, with everything YouTube gave', async () => {
    const rows = await youtubeRows();
    expect(rows.every((m) => m.siteId === woo)).toBe(true);
    const w1 = rows.find((m) => idOf(m.url) === 'w1')!;
    expect(w1).toMatchObject({ platform: 'youtube', kind: 'video', title: 'Video w1', url: 'https://www.youtube.com/watch?v=w1', provenance: 'official_api', extractionMethod: 'official_api' });
    expect(w1.details).toMatchObject({ videoId: 'w1', channelId: CH.woo!.id, channelTitle: 'Fixture Mart Official', thumbnailUrl: 'https://i.ytimg.com/vi/w1/hqdefault.jpg', durationSeconds: 245 });
    expect(w1.excerpt).toBe('About w1');
  });

  it('keeps the publication date apart from the first-seen date', async () => {
    const w1 = (await youtubeRows()).find((m) => idOf(m.url) === 'w1')!;
    expect(w1.publishedAt!.toISOString()).toBe(published(2));
    expect(w1.firstSeenAt.toISOString()).toBe(h.svc.clock().toISOString());
    expect(w1.firstSeenAt.getTime()).toBeGreaterThan(w1.publishedAt!.getTime());
  });

  it('never invents a count: a count YouTube did not give is null, a real zero stays zero', async () => {
    const rows = await youtubeRows();
    const eng = (id: string) => rows.find((m) => idOf(m.url) === id)!.engagement;
    expect(eng('w1')).toEqual({ views: 1200, likes: 80, comments: 7, shares: null });
    expect(eng('w2')).toBeNull(); // no statistics at all
    expect(eng('w3')).toEqual({ views: 50, likes: null, comments: 0, shares: null });
  });

  it('a second collection adds no duplicates, keeps first-seen and publication dates, and refreshes counts', async () => {
    const first = await youtubeRows();
    h.advance(3_600_000);
    behaviour.likes = 95;
    await syncNow();
    const second = await youtubeRows();
    expect(second).toHaveLength(first.length);
    expect(new Set(second.map((m) => m.dedupeKey)).size).toBe(second.length);
    for (const row of second) {
      const was = first.find((m) => m.id === row.id)!;
      expect(was).toBeDefined(); // the very same row, not a new one
      expect(row.firstSeenAt.getTime()).toBe(was.firstSeenAt.getTime());
      expect(row.publishedAt!.getTime()).toBe(was.publishedAt!.getTime());
      expect(row.lastSeenAt.getTime()).toBeGreaterThan(was.lastSeenAt.getTime());
    }
    expect(second.find((m) => idOf(m.url) === 'w1')!.engagement).toMatchObject({ likes: 95 });
    behaviour.likes = 80;
  });

  it('website observations are untouched by everything YouTube did', async () => {
    expect(await siteRows()).toEqual(siteBefore);
  });
});

describe('the Marketing page data', () => {
  it('lists the videos under the right competitor beside the website observation, never as paid advertising', async () => {
    const body = (await owner.get(`${base()}/marketing?days=30`)).body;
    const yt = body.activity.filter((m: { platform: string }) => m.platform === 'youtube');
    expect(yt).toHaveLength(3);
    expect(yt.every((m: { siteId: string; siteName: string; paidStatus: string }) => m.siteId === woo && m.siteName === wooName && m.paidStatus === 'not_determined')).toBe(true);
    expect(yt.find((m: { url: string }) => m.url.endsWith('v=w1'))).toMatchObject({ details: { videoId: 'w1', channelTitle: 'Fixture Mart Official' }, engagement: { views: 1200 } });
    expect(body.activity.some((m: { platform: string; title: string }) => m.platform === 'site' && m.title === 'Spring sale: 20% off')).toBe(true);
    expect(body.activity.some((m: { platform: string }) => m.platform === 'instagram' || m.platform === 'facebook')).toBe(false);
    const summary = body.summary.competitors.find((c: { siteId: string }) => c.siteId === woo);
    expect(summary.byPlatform.youtube).toBe(3);
    expect(JSON.stringify(body.summary)).not.toMatch(/ad spend of|paid campaign (is|was) running|sponsor/i);
  });

  it('the window is by publication date, not by when a video was seen', async () => {
    const w3 = (await owner.get(`${base()}/marketing?days=30`)).body.activity.find((m: { url: string }) => m.url.endsWith('v=w3'));
    expect(new Date(w3.publishedAt).getTime()).toBe(h.svc.clock().getTime() - 20 * DAY - 3_600_000); // published 20 days before the first collection
    const narrow = (await owner.get(`${base()}/marketing?days=7&platform=youtube`)).body.activity as { url: string }[];
    expect(narrow.map((m) => idOf(m.url))).toEqual(['w1']); // only what was PUBLISHED in the last 7 days, although every video was seen today
  });
});

describe('several channels, several competitors', () => {
  it('connects a second competitor by its exact @handle, and a second channel for the same competitor', async () => {
    const a = await add(jsonld, '@fixturejsonld');
    expect(a.status).toBe(201);
    expect(a.body.account).toMatchObject({ confirmed: true, externalId: CH.jsonld!.id, externalTitle: 'Fixture Superstore', discoveredFrom: expect.stringMatching(/site_link|manual/) });
    const b = await add(woo, 'https://www.youtube.com/@fixturemartkids');
    expect(b.status).toBe(201);
    await h.queue.drain();
    expect((await youtubeRows(jsonld)).map((m) => idOf(m.url))).toEqual(['j1']);
    expect((await youtubeRows(woo)).map((m) => idOf(m.url)).sort()).toEqual(['k1', 'w1', 'w2', 'w3']);
    expect((await accounts()).filter((x) => x.siteId === woo && x.confirmed)).toHaveLength(2);
    expect((await card()).message).toMatch(/Connected: 3 competitor channels are read/);
  });

  it('the same channel entered again — by its id — is the same mapping, not a second one', async () => {
    const n = (await accounts()).length;
    const r = await add(woo, CH.woo!.id);
    expect(r.status).toBe(201);
    expect(r.body.account.externalId).toBe(CH.woo!.id);
    expect((await accounts()).length).toBe(n);
  });

  it('a channel belongs to one website: it is refused for another', async () => {
    const r = await add(jsonld, `https://www.youtube.com/channel/${CH.woo!.id}`);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/already connected to/);
    expect((await youtubeRows(jsonld)).map((m) => idOf(m.url))).toEqual(['j1']);
  });
});

describe('one failing channel never disturbs another competitor or the website observations', () => {
  it('a deleted channel is that competitor’s error alone', async () => {
    const siteBefore = await siteRows();
    const wooBefore = await youtubeRows(woo);
    behaviour.deleted.add(CH.jsonld!.id);
    h.advance(3_600_000);
    const r = await syncNow();
    const jr = r.find((x) => x.platform === 'youtube' && x.site !== wooName)!;
    expect(jr).toMatchObject({ state: 'error' });
    expect(jr.message).toMatch(/no channel/i);
    expect(r.filter((x) => x.site === wooName).every((x) => x.state === 'ready')).toBe(true);
    expect(await accountFor(CH.jsonld!)).toMatchObject({ failureKind: 'not_found', consecutiveFailures: 1 });
    expect((await youtubeRows(woo)).map((m) => m.id).sort()).toEqual(wooBefore.map((m) => m.id).sort());
    expect((await youtubeRows(jsonld)).map((m) => idOf(m.url))).toEqual(['j1']); // what was already read stays, honestly dated
    expect(await siteRows()).toEqual(siteBefore);
    const c = await card();
    expect(c.state).toBe('error');
    expect(c.message).toMatch(/no channel/i);
  });

  it('when the channel is back, a new read clears the problem', async () => {
    behaviour.deleted.delete(CH.jsonld!.id);
    h.advance(3_600_000);
    await syncNow();
    expect(await accountFor(CH.jsonld!)).toMatchObject({ failureKind: null, consecutiveFailures: 0, lastSyncStatus: 'ready' });
    expect((await card()).state).toBe('ready');
  });
});

describe('every failure of the key or the quota is reported, remembered and never leaks the key', () => {
  it('a used-up quota is a failure with a reset time; asking again does not spend more', async () => {
    behaviour.mode = 'quota';
    h.advance(3_600_000);
    const r = await syncNow();
    expect(r.filter((x) => x.platform === 'youtube').every((x) => x.state === 'error' && /quota/i.test(x.message))).toBe(true);
    expect((await accountFor(CH.woo!)).failureKind).toBe('quota');
    const used = calls.length;
    expect((await syncNow()).every((x) => x.state === 'backing_off')).toBe(true);
    expect(calls.length).toBe(used);
    expect((await card()).state).toBe('error');
    behaviour.mode = 'ok';
  });

  it('an invalid key is reported with the variable to fix; a project without the API enabled says so', async () => {
    behaviour.mode = 'badkey';
    h.setNow(new Date(h.svc.clock().getTime() + 2 * DAY)); // past the quota reset
    let r = await syncNow();
    expect(r.find((x) => x.platform === 'youtube')).toMatchObject({ state: 'needs_reconnect' });
    expect(r.find((x) => x.platform === 'youtube')!.message).toMatch(/YOUTUBE_API_KEY/);
    const rejected = await add(woo, '@fixturemartkids');
    expect(rejected.status).toBe(422); // a channel is never saved on the word of a key YouTube refuses
    expect(rejected.body.error.message).toMatch(/key was rejected/);
    behaviour.mode = 'disabled';
    r = await syncNow(); // a person may try again after fixing the key
    expect(r.find((x) => x.platform === 'youtube')!.message).toMatch(/not enabled/i);
    behaviour.mode = 'ok';
  });

  it('a network error that quotes the key is stored without it', async () => {
    behaviour.mode = 'throw';
    (h.svc.config as { YOUTUBE_API_KEY?: string }).YOUTUBE_API_KEY = TEST_KEY;
    h.advance(3_600_000);
    await syncNow();
    const stored = JSON.stringify(await accounts());
    expect(stored).not.toContain(TEST_KEY);
    expect(stored).toContain('[key]');
    behaviour.mode = 'ok';
    h.advance(3_600_000);
    const r = await syncNow();
    expect(r.filter((x) => x.platform === 'youtube').every((x) => x.state === 'ready')).toBe(true);
  });

  it('the key is sent only in a request header — never in an address, a stored message or any response', async () => {
    expect(calls.every((c) => !c.includes(TEST_KEY) && !/[?&]key=/.test(c))).toBe(true);
    expect(keysSeen.length).toBeGreaterThan(10);
    expect(keysSeen.every((k) => k === TEST_KEY)).toBe(true);
    const bodies = JSON.stringify([
      (await owner.get(`${base()}/integrations`)).body,
      (await owner.get(`${base()}/marketing?days=60`)).body,
      (await owner.get('/api/v1/meta')).body,
    ]);
    expect(bodies).not.toContain(TEST_KEY);
    const rows = JSON.stringify([await accounts(), await youtubeRows()]);
    expect(rows).not.toContain(TEST_KEY);
  });
});

describe('collecting, and the evidence of a read in progress', () => {
  it('shows "collecting" while a read runs, and ignores a mark left behind by a restart', async () => {
    const a = (await accounts()).find((x) => x.siteId === woo && x.confirmed)!;
    await h.db.worker.update(socialAccounts).set({ syncingSince: h.svc.clock() }).where(eq(socialAccounts.id, a.id));
    expect((await card()).state).toBe('collecting');
    expect((await overview()).accounts.find((x) => x.id === a.id)!.syncing).toBe(true);
    h.advance(31 * 60_000);
    expect((await card()).state).toBe('ready');
    expect((await overview()).accounts.find((x) => x.id === a.id)!.syncing).toBe(false);
    await h.db.worker.update(socialAccounts).set({ syncingSince: null }).where(eq(socialAccounts.id, a.id));
  });
});

describe('removing a wrong mapping', () => {
  it('removes the mapping and what its channel published, and nothing else', async () => {
    const kids = (await accounts()).find((x) => x.siteId === woo && x.externalId === CH.woo2!.id)!;
    const stranger = new ApiClient(app);
    await signUp(stranger, h, { email: `yt-stranger-${Date.now()}@example.test`, password: PASSWORD, displayName: 'S' });
    expect((await stranger.delete(`${base()}/social-accounts/${kids.id}`)).status).toBe(404);
    expect((await accounts()).some((x) => x.id === kids.id)).toBe(true);

    const siteBefore = await siteRows();
    const r = await owner.delete(`${base()}/social-accounts/${kids.id}`);
    expect(r.status).toBe(200);
    expect(r.body.removedVideos).toBe(1);
    expect((await accounts()).some((x) => x.id === kids.id)).toBe(false);
    expect((await youtubeRows(woo)).map((m) => idOf(m.url)).sort()).toEqual(['w1', 'w2', 'w3']);
    expect((await youtubeRows(jsonld)).map((m) => idOf(m.url))).toEqual(['j1']);
    expect(await siteRows()).toEqual(siteBefore);
    const audit = (await h.db.worker.select().from(auditEvents).where(eq(auditEvents.orgId, org))).find((e) => e.action === 'social.removed')!;
    expect(audit.meta).toMatchObject({ platform: 'youtube', removedVideos: 1 });
    expect((await owner.delete(`${base()}/social-accounts/${kids.id}`)).status).toBe(404);
  });
});

describe('who may do what', () => {
  it('a channel cannot be added to, confirmed for or removed from another workspace’s website', async () => {
    const stranger = new ApiClient(app);
    await signUp(stranger, h, { email: `yt-stranger2-${Date.now()}@example.test`, password: PASSWORD, displayName: 'S2' });
    const strangerOrg = (await stranger.post('/api/v1/orgs', { name: 'Stranger YT' })).body.organization.id as string;
    expect((await stranger.post(`/api/v1/orgs/${strangerOrg}/social-accounts`, { siteId: woo, platform: 'youtube', handle: '@fixturewoo' })).status).toBe(404);
    const mine = (await accounts()).find((x) => x.siteId === woo)!;
    expect((await stranger.patch(`/api/v1/orgs/${strangerOrg}/social-accounts/${mine.id}`, { confirmed: false })).status).toBe(404);
  });
});
