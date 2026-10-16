import type { SocialPlatform } from '@ci/shared';

/**
 * Social providers use OFFICIAL APIs only. Nothing here scrapes social sites, and a provider that lacks credentials
 * or platform approval reports exactly what is missing instead of pretending to be connected.
 * "Observed activity" is never evidence of a paid campaign: ad status is always `not_determined`.
 */

export interface PostEngagement {
  /** A count the platform did not provide is null — never zero. */
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}

export interface SocialPost {
  externalId: string;
  title: string | null;
  text: string | null;
  url: string;
  publishedAt: Date | null;
  kind: 'video' | 'social_post';
  engagement?: PostEngagement | null;
}

/** Why a request failed, in terms the retry policy understands (see `nextAttempt` in @ci/core). */
export type SocialFailureKind = 'quota' | 'rate_limit' | 'transient' | 'permission' | 'not_found' | 'auth';

export interface SocialFailure {
  kind: SocialFailureKind;
  retryAfterSeconds?: number | null;
}

export interface CredentialHealth {
  checkedAt: Date;
  level: 'ok' | 'warning' | 'bad' | 'unknown';
  valid: boolean | null;
  /** Null when the token does not expire (e.g. a system-user token) or when expiry is unknown. */
  expiresAt: Date | null;
  neverExpires: boolean;
  daysLeft: number | null;
  scopes: string[];
  missingScopes: string[];
  message: string;
}

export interface SocialProviderStatus {
  provider: SocialPlatform;
  state: 'ready' | 'not_configured' | 'requires_approval' | 'error';
  message: string;
  requirements: string[];
  docsUrl: string;
  /** What this integration can and cannot tell you — shown in the UI. */
  limits: string[];
  /** Token validity/expiry/permissions, when the provider lets us check without spending quota. */
  credential?: CredentialHealth;
}

export interface HttpJson {
  (url: string, init?: { headers?: Record<string, string> }): Promise<{ status: number; json: unknown; headers?: Record<string, string> }>;
}

export const defaultHttpJson: HttpJson = async (url, init) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetch(url, { headers: init?.headers, signal: ac.signal });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON error body */
    }
    const headers: Record<string, string> = {};
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) headers['retry-after'] = retryAfter;
    return { status: res.status, json, headers };
  } finally {
    clearTimeout(t);
  }
};

export interface SocialConfig {
  youtubeApiKey?: string;
  metaAccessToken?: string;
  metaInstagramBusinessAccountId?: string;
  metaGraphVersion?: string;
  /** Needed only to ask Meta whether the token is still valid and when it expires. */
  metaAppId?: string;
  metaAppSecret?: string;
}

export interface SocialFetchResult {
  ok: boolean;
  state: SocialProviderStatus['state'];
  message: string;
  posts: SocialPost[];
  externalId?: string;
  /** Present when ok is false because of a provider answer or a network problem (not when merely not configured). */
  failure?: SocialFailure;
}

export interface AccountRef {
  handle: string;
  url?: string | null;
  externalId?: string | null;
}

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const retryAfterOf = (r: { headers?: Record<string, string> }): number | null => {
  const n = Number(r.headers?.['retry-after']);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const hasAny = (e: PostEngagement) => e.views !== null || e.likes !== null || e.comments !== null || e.shares !== null;

// ───────────────────────────────────────────────────────── YouTube Data API v3

export function youtubeStatus(cfg: SocialConfig): SocialProviderStatus {
  return {
    provider: 'youtube',
    state: cfg.youtubeApiKey ? 'ready' : 'not_configured',
    message: cfg.youtubeApiKey
      ? 'YouTube Data API key configured. Public channel uploads can be read. (An API key does not expire; if it is revoked or its quota is used up, the next sync says so.)'
      : 'No YouTube API key is configured, so channel uploads are not collected.',
    requirements: ['Create a Google Cloud project, enable “YouTube Data API v3” and create an API key', 'Set YOUTUBE_API_KEY (free default quota: 10,000 units/day; this integration uses about 3 units per channel per sync)'],
    docsUrl: 'https://developers.google.com/youtube/v3/getting-started',
    limits: ['Public uploads only: titles, descriptions, publish dates and public view/like/comment counts when the channel shows them', 'Cannot tell whether a video is a paid advertisement and shows no ad spend'],
  };
}

function ytChannelQuery(handle: string, url?: string | null): string | null {
  const h = handle.trim();
  if (/^UC[\w-]{20,}$/.test(h)) return `id=${encodeURIComponent(h)}`;
  const fromUrl = url ? url.match(/youtube\.com\/(channel\/(UC[\w-]+)|user\/([\w.-]+)|(@[\w.-]+))/) : null;
  if (fromUrl?.[2]) return `id=${encodeURIComponent(fromUrl[2])}`;
  if (fromUrl?.[3]) return `forUsername=${encodeURIComponent(fromUrl[3])}`;
  const at = fromUrl?.[4] ?? (h.startsWith('@') ? h : `@${h}`);
  return `forHandle=${encodeURIComponent(at)}`;
}

const fail = (state: SocialProviderStatus['state'], message: string, failure: SocialFailure): SocialFetchResult => ({ ok: false, state, message, posts: [], failure });

export async function fetchYouTube(cfg: SocialConfig, account: AccountRef, http: HttpJson = defaultHttpJson): Promise<SocialFetchResult> {
  if (!cfg.youtubeApiKey) return { ok: false, state: 'not_configured', message: youtubeStatus(cfg).message, posts: [] };
  const q = ytChannelQuery(account.handle, account.url);
  if (!q) return fail('error', 'Could not interpret the YouTube handle', { kind: 'not_found' });
  const base = 'https://www.googleapis.com/youtube/v3';
  const key = `key=${encodeURIComponent(cfg.youtubeApiKey)}`;
  try {
    const ch = await http(`${base}/channels?part=contentDetails,snippet&${q}&${key}`);
    const err = youtubeError(ch);
    if (err) return fail('error', err.message, err.failure);
    const item = o(arr(o(ch.json)['items'])[0]);
    const uploads = s(o(o(item['contentDetails'])['relatedPlaylists'])['uploads']);
    const channelId = s(item['id']);
    if (!uploads || !channelId) return fail('error', 'No YouTube channel matched this handle. Check the account mapping.', { kind: 'not_found' });
    const pl = await http(`${base}/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(uploads)}&maxResults=15&${key}`);
    const err2 = youtubeError(pl);
    if (err2) return fail('error', err2.message, err2.failure);
    const posts: SocialPost[] = arr(o(pl.json)['items']).map((it) => {
      const sn = o(o(it)['snippet']);
      const vid = s(o(o(it)['contentDetails'])['videoId']) ?? s(o(sn['resourceId'])['videoId']);
      const published = s(o(o(it)['contentDetails'])['videoPublishedAt']) ?? s(sn['publishedAt']);
      return {
        externalId: vid ?? '',
        title: s(sn['title']),
        text: (s(sn['description']) ?? '').slice(0, 500) || null,
        url: `https://www.youtube.com/watch?v=${vid}`,
        publishedAt: published ? new Date(published) : null,
        kind: 'video' as const,
      };
    }).filter((p) => p.externalId && p.title && p.title !== 'Private video' && p.title !== 'Deleted video');

    // Public counts, one cheap call for all videos. If it fails the posts are still valid; the counts are simply unavailable.
    let counts = '';
    if (posts.length) {
      const st = await http(`${base}/videos?part=statistics&id=${posts.map((p) => encodeURIComponent(p.externalId)).join(',')}&${key}`);
      const e3 = youtubeError(st);
      if (!e3) {
        const byId = new Map(arr(o(st.json)['items']).map((v) => [s(o(v)['id']) ?? '', o(o(v)['statistics'])] as const));
        for (const p of posts) {
          const stats = byId.get(p.externalId);
          const eng: PostEngagement = { views: num(stats?.['viewCount']), likes: num(stats?.['likeCount']), comments: num(stats?.['commentCount']), shares: null };
          p.engagement = hasAny(eng) ? eng : null;
        }
      } else {
        counts = ` View and like counts were not available (${e3.message})`;
      }
    }
    return { ok: true, state: 'ready', message: `Read ${posts.length} recent upload(s).${counts}`, posts, externalId: channelId };
  } catch (e) {
    return fail('error', `YouTube request failed: ${(e as Error).message}`, { kind: 'transient' });
  }
}

function youtubeError(r: { status: number; json: unknown; headers?: Record<string, string> }): { message: string; failure: SocialFailure } | null {
  if (r.status >= 200 && r.status < 300) return null;
  const e = o(o(r.json)['error']);
  const reason = s(o(arr(e['errors'])[0])['reason']);
  const status = s(e['status']);
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') return { message: 'The daily YouTube API quota is used up. Collection resumes after the quota resets (midnight Pacific Time).', failure: { kind: 'quota' } };
  if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || r.status === 429) return { message: 'YouTube asked us to slow down; trying again later.', failure: { kind: 'rate_limit', retryAfterSeconds: retryAfterOf(r) } };
  if (reason === 'keyInvalid' || reason === 'API_KEY_INVALID' || status === 'INVALID_ARGUMENT' && /api key/i.test(s(e['message']) ?? '')) return { message: 'The YouTube API key was rejected. Check YOUTUBE_API_KEY.', failure: { kind: 'auth' } };
  if (reason === 'keyExpired' || reason === 'ipRefererBlocked' || reason === 'forbidden' || reason === 'accessNotConfigured' || r.status === 403 || r.status === 401) return { message: `YouTube refused the request (${reason ?? 'forbidden'}). The API may not be enabled for this key, or the key is restricted.`, failure: { kind: 'auth' } };
  if (r.status === 404) return { message: 'YouTube could not find that resource.', failure: { kind: 'not_found' } };
  if (r.status >= 500) return { message: `YouTube had a problem (HTTP ${r.status}); trying again later.`, failure: { kind: 'transient' } };
  return { message: `YouTube API error (HTTP ${r.status}${reason ? `, ${reason}` : ''})`, failure: { kind: 'transient' } };
}

// ───────────────────────────────────────────────────────── Meta token health (shared by Instagram and Facebook)

/** Scopes the Instagram Business Discovery and Page reads rely on. Missing ones are reported, never assumed. */
export const REQUIRED_META_SCOPES = ['instagram_basic', 'pages_show_list', 'pages_read_engagement'] as const;
const WARN_DAYS = 14;

/**
 * Asks Meta (debug_token) whether the token is valid, when it expires, and which permissions it carries. Costs no API quota.
 * Returns null when no token is configured. Without META_APP_ID/META_APP_SECRET the check cannot run, and that is said plainly.
 */
export async function checkMetaToken(cfg: SocialConfig, http: HttpJson = defaultHttpJson, now: Date = new Date()): Promise<CredentialHealth | null> {
  if (!cfg.metaAccessToken) return null;
  const unknown = (message: string): CredentialHealth => ({ checkedAt: now, level: 'unknown', valid: null, expiresAt: null, neverExpires: false, daysLeft: null, scopes: [], missingScopes: [], message });
  if (!cfg.metaAppId || !cfg.metaAppSecret) return unknown('The token’s expiry cannot be checked. Set META_APP_ID and META_APP_SECRET so Shelfwatch can ask Meta whether the token is still valid and when it expires.');
  const v = cfg.metaGraphVersion ?? 'v21.0';
  try {
    const r = await http(`https://graph.facebook.com/${v}/debug_token?input_token=${encodeURIComponent(cfg.metaAccessToken)}&access_token=${encodeURIComponent(`${cfg.metaAppId}|${cfg.metaAppSecret}`)}`);
    if (r.status < 200 || r.status >= 300) {
      const g = graphError(r, 'Meta');
      return g?.failure.kind === 'auth' || g?.failure.kind === 'permission'
        ? { ...unknown(`Meta did not accept the app credentials used to check the token (${g.message}). Check META_APP_ID and META_APP_SECRET.`), level: 'warning' }
        : unknown(`The token could not be checked right now: ${g?.message ?? `HTTP ${r.status}`}`);
    }
    const d = o(o(r.json)['data']);
    const valid = d['is_valid'] === true;
    const expiresRaw = num(d['expires_at']);
    const neverExpires = valid && (expiresRaw === 0 || expiresRaw === null);
    const expiresAt = expiresRaw && expiresRaw > 0 ? new Date(expiresRaw * 1000) : null;
    const dataAccessRaw = num(d['data_access_expires_at']);
    const dataAccessAt = dataAccessRaw && dataAccessRaw > 0 ? new Date(dataAccessRaw * 1000) : null;
    const scopes = arr(d['scopes']).filter((x): x is string => typeof x === 'string');
    const missingScopes = valid && scopes.length ? REQUIRED_META_SCOPES.filter((x) => !scopes.includes(x)) : [];
    const daysLeft = expiresAt ? Math.floor((expiresAt.getTime() - now.getTime()) / 86_400_000) : null;
    const dataDaysLeft = dataAccessAt ? Math.floor((dataAccessAt.getTime() - now.getTime()) / 86_400_000) : null;
    const base = { checkedAt: now, valid, expiresAt, neverExpires, daysLeft, scopes, missingScopes: [...missingScopes] };
    if (!valid) {
      const why = s(o(d['error'])['message']);
      return { ...base, level: 'bad', message: `Meta says this token is no longer valid${why ? ` (${why})` : ''}. It may have expired, been revoked, or the app was removed. Create a new token and update META_ACCESS_TOKEN.` };
    }
    if (expiresAt && expiresAt <= now) return { ...base, level: 'bad', valid: false, message: 'This token has expired. Create a new token and update META_ACCESS_TOKEN.' };
    if (daysLeft !== null && daysLeft <= WARN_DAYS) return { ...base, level: 'warning', message: `This token expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Create a new one before then (a Business Manager system-user token does not expire).` };
    if (dataDaysLeft !== null && dataDaysLeft <= WARN_DAYS) return { ...base, level: 'warning', message: `Data access for this token expires in ${dataDaysLeft} day${dataDaysLeft === 1 ? '' : 's'}; the person who authorised it must re-authorise.` };
    if (missingScopes.length) return { ...base, level: 'warning', message: `The token is valid but lacks permission${missingScopes.length === 1 ? '' : 's'}: ${missingScopes.join(', ')}. Reads that need ${missingScopes.length === 1 ? 'it' : 'them'} will be refused.` };
    return { ...base, level: 'ok', message: neverExpires ? 'The token is valid and does not expire.' : `The token is valid${expiresAt ? ` and expires in ${daysLeft} days` : ''}.` };
  } catch (e) {
    return unknown(`The token could not be checked right now: ${(e as Error).message}`);
  }
}

// ───────────────────────────────────────────────────────── Instagram (Business Discovery)

export function instagramStatus(cfg: SocialConfig, health?: CredentialHealth | null): SocialProviderStatus {
  const ready = !!(cfg.metaAccessToken && cfg.metaInstagramBusinessAccountId);
  const bad = ready && health?.level === 'bad';
  return {
    provider: 'instagram',
    state: bad ? 'error' : ready ? 'ready' : 'not_configured',
    message: bad
      ? health!.message
      : ready
        ? 'An Instagram professional account token is configured. Public posts of other professional accounts can be read via Business Discovery (not verified live in this project).'
        : 'Instagram is not connected. Reading a competitor’s public posts needs an access token from YOUR Instagram professional account and a Meta app.',
    requirements: [
      'An Instagram Business or Creator account connected to a Facebook Page',
      'A Meta developer app with instagram_basic and pages_show_list; production use needs App Review (Advanced Access) and Business Verification',
      'The competitor’s account must itself be a professional (Business/Creator) account',
      'Set META_ACCESS_TOKEN and META_INSTAGRAM_BUSINESS_ACCOUNT_ID (and META_APP_ID + META_APP_SECRET so the token’s expiry can be checked)',
    ],
    docsUrl: 'https://developers.facebook.com/docs/instagram-platform/',
    limits: ['Public profile fields and media of professional accounts only, with like and comment counts where Instagram returns them', 'Stories, private accounts, comments from individuals and hashtag/keyword discovery are not available', 'Does not reveal whether a post is boosted or an ad'],
    ...(health ? { credential: health } : {}),
  };
}

export async function fetchInstagram(cfg: SocialConfig, account: AccountRef, http: HttpJson = defaultHttpJson): Promise<SocialFetchResult> {
  const status = instagramStatus(cfg);
  if (status.state !== 'ready') return { ok: false, state: 'not_configured', message: status.message, posts: [] };
  const v = cfg.metaGraphVersion ?? 'v21.0';
  const username = account.handle.replace(/^@/, '');
  const fields = `business_discovery.username(${username}){username,name,media_count,media.limit(12){id,caption,media_type,permalink,timestamp,like_count,comments_count}}`;
  try {
    const r = await http(`https://graph.facebook.com/${v}/${encodeURIComponent(cfg.metaInstagramBusinessAccountId!)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(cfg.metaAccessToken!)}`);
    const err = graphError(r, 'Instagram');
    if (err) return fail(err.state, err.message, err.failure);
    const bd = o(o(r.json)['business_discovery']);
    const posts: SocialPost[] = arr(o(bd['media'])['data']).map((m) => {
      const mm = o(m);
      const caption = s(mm['caption']);
      const eng: PostEngagement = { views: null, likes: num(mm['like_count']), comments: num(mm['comments_count']), shares: null };
      return {
        externalId: s(mm['id']) ?? '',
        title: caption ? caption.split('\n')[0]!.slice(0, 120) : null,
        text: caption ? caption.slice(0, 500) : null,
        url: s(mm['permalink']) ?? '',
        publishedAt: s(mm['timestamp']) ? new Date(s(mm['timestamp'])!) : null,
        kind: 'social_post' as const,
        engagement: hasAny(eng) ? eng : null,
      };
    }).filter((p) => p.externalId && p.url);
    return { ok: true, state: 'ready', message: `Read ${posts.length} recent post(s)`, posts, externalId: s(bd['username']) ?? username };
  } catch (e) {
    return fail('error', `Instagram request failed: ${(e as Error).message}`, { kind: 'transient' });
  }
}

// ───────────────────────────────────────────────────────── Facebook Pages

export function facebookStatus(cfg: SocialConfig, health?: CredentialHealth | null): SocialProviderStatus {
  const bad = !!cfg.metaAccessToken && health?.level === 'bad';
  return {
    provider: 'facebook',
    state: bad ? 'error' : cfg.metaAccessToken ? 'requires_approval' : 'not_configured',
    message: bad
      ? health!.message
      : cfg.metaAccessToken
        ? 'A Meta token is configured, but reading OTHER Pages’ public posts needs the “Page Public Content Access” feature (App Review + Business Verification). Requests will fail until Meta approves it.'
        : 'Facebook is not connected. Reading public Page content needs a Meta app approved for Page Public Content Access.',
    requirements: [
      'A Meta developer app connected to a verified Business',
      'App Review approval for the “Page Public Content Access” feature (read public posts of Pages you do not manage)',
      'Set META_APP_ID, META_APP_SECRET and META_ACCESS_TOKEN',
      'Alternative with no review: the Page owner can connect their OWN Page (pages_read_engagement) — only useful for your own marketing',
    ],
    docsUrl: 'https://developers.facebook.com/docs/features-reference/page-public-content-access',
    limits: ['Public posts of Pages only, with reaction, comment and share counts where Facebook returns them', 'No data about private groups or individuals’ comments is collected', 'Does not reveal whether a post is boosted or an ad (Meta’s Ad Library is a separate product)'],
    ...(health ? { credential: health } : {}),
  };
}

export async function fetchFacebook(cfg: SocialConfig, account: AccountRef, http: HttpJson = defaultHttpJson): Promise<SocialFetchResult> {
  if (!cfg.metaAccessToken) return { ok: false, state: 'not_configured', message: facebookStatus(cfg).message, posts: [] };
  const v = cfg.metaGraphVersion ?? 'v21.0';
  const fields = 'id,message,created_time,permalink_url,shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)';
  try {
    const r = await http(`https://graph.facebook.com/${v}/${encodeURIComponent(account.handle)}/posts?fields=${encodeURIComponent(fields)}&limit=12&access_token=${encodeURIComponent(cfg.metaAccessToken)}`);
    const err = graphError(r, 'Facebook');
    if (err) return fail(err.state, err.message, err.failure);
    const posts: SocialPost[] = arr(o(r.json)['data']).map((p) => {
      const pp = o(p);
      const msg = s(pp['message']);
      const eng: PostEngagement = {
        views: null,
        likes: num(o(o(pp['reactions'])['summary'])['total_count']),
        comments: num(o(o(pp['comments'])['summary'])['total_count']),
        shares: num(o(pp['shares'])['count']),
      };
      return {
        externalId: s(pp['id']) ?? '',
        title: msg ? msg.split('\n')[0]!.slice(0, 120) : null,
        text: msg ? msg.slice(0, 500) : null,
        url: s(pp['permalink_url']) ?? '',
        publishedAt: s(pp['created_time']) ? new Date(s(pp['created_time'])!) : null,
        kind: 'social_post' as const,
        engagement: hasAny(eng) ? eng : null,
      };
    }).filter((p) => p.externalId && p.url);
    return { ok: true, state: 'ready', message: `Read ${posts.length} recent post(s)`, posts, externalId: account.handle };
  } catch (e) {
    return fail('error', `Facebook request failed: ${(e as Error).message}`, { kind: 'transient' });
  }
}

/** OAuthException sub-codes meaning the grant itself is gone: password changed, user logged out, app removed, permission revoked, session expired. */
const REVOKED_SUBCODES = [458, 459, 460, 463, 467];

function graphError(r: { status: number; json: unknown; headers?: Record<string, string> }, name: string): { state: SocialProviderStatus['state']; message: string; failure: SocialFailure } | null {
  if (r.status >= 200 && r.status < 300) return null;
  const e = o(o(r.json)['error']);
  const code = Number(e['code'] ?? 0);
  const sub = Number(e['error_subcode'] ?? 0);
  const msg = s(e['message']) ?? `HTTP ${r.status}`;
  if (code === 190 || code === 102 || REVOKED_SUBCODES.includes(sub)) {
    const revoked = REVOKED_SUBCODES.includes(sub) && sub !== 463 && sub !== 467;
    return { state: 'error', message: revoked ? `${name} access was revoked (the grant was removed or the account’s password/session changed). Reconnect the account and update the token.` : `${name} access token is invalid or expired. Reconnect the account.`, failure: { kind: 'auth' } };
  }
  if ([4, 17, 32, 613, 80001, 80002, 80006].includes(code) || r.status === 429) return { state: 'error', message: `${name} rate limit reached; trying again later.`, failure: { kind: 'rate_limit', retryAfterSeconds: retryAfterOf(r) } };
  if (code === 10 || (code >= 200 && code <= 299)) {
    return { state: 'requires_approval', message: `${name} refused access (${msg}). The app lacks a required permission/feature — typically App Review or Business Verification is still outstanding.`, failure: { kind: 'permission' } };
  }
  if (code === 100) return { state: 'error', message: `${name} could not find that account, or it is not a public professional account (${msg}).`, failure: { kind: 'not_found' } };
  if (r.status >= 500 || code === 1 || code === 2) return { state: 'error', message: `${name} had a problem (HTTP ${r.status}); trying again later.`, failure: { kind: 'transient' } };
  return { state: 'error', message: `${name} API error: ${msg}`, failure: { kind: 'transient' } };
}

export function allSocialStatuses(cfg: SocialConfig, health?: CredentialHealth | null): SocialProviderStatus[] {
  return [youtubeStatus(cfg), instagramStatus(cfg, health), facebookStatus(cfg, health)];
}

export async function fetchSocial(platform: SocialPlatform, cfg: SocialConfig, account: AccountRef, http?: HttpJson): Promise<SocialFetchResult> {
  switch (platform) {
    case 'youtube':
      return fetchYouTube(cfg, account, http);
    case 'instagram':
      return fetchInstagram(cfg, account, http);
    case 'facebook':
      return fetchFacebook(cfg, account, http);
  }
}

const PROMO_WORDS = /\b(sale|off|discount|deal|offer|promo|special|save|free|% ?off|2 ?for|buy \d|coupon|code|clearance|black friday|cyber|weekend|ofertas?|korting|aanbieding)\b/i;
const LAUNCH_WORDS = /\b(new|introducing|launch|launching|now available|arrives?|just landed|coming soon|nuevo|nieuw)\b/i;
const SEASON_WORDS = /\b(christmas|holiday|easter|mother'?s day|father'?s day|valentine|halloween|thanksgiving|summer|back to school|carnival|new year|independence|dia de|kerst|pasen)\b/i;

/** Rule-based, explainable classification of a post. Confidence stays modest: keywords are weak evidence. */
export function classifyPost(text: string): { classification: 'promotion' | 'product_launch' | 'seasonal' | 'brand_content' | 'unclassified'; confidence: number } {
  const t = text || '';
  if (!t.trim()) return { classification: 'unclassified', confidence: 0.3 };
  if (PROMO_WORDS.test(t)) return { classification: 'promotion', confidence: 0.65 };
  if (LAUNCH_WORDS.test(t)) return { classification: 'product_launch', confidence: 0.55 };
  if (SEASON_WORDS.test(t)) return { classification: 'seasonal', confidence: 0.5 };
  return { classification: 'brand_content', confidence: 0.4 };
}
