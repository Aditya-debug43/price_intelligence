import { and, eq } from 'drizzle-orm';
import { nextAttempt, sha256Hex, shouldSkipSync } from '@ci/core';
import { checkMetaToken, classifyPost, fetchSocial, type CredentialHealth, type HttpJson, type SocialConfig } from '@ci/connectors';
import type { SocialPlatform } from '@ci/shared';
import { marketingActivities, sites, socialAccounts, type DbLike } from '@ci/database';
import type { Services } from './context.ts';
import { provenanceFor } from './workspace.ts';

export function socialConfigOf(svc: Pick<Services, 'config'>): SocialConfig {
  const c = svc.config;
  return {
    youtubeApiKey: c.YOUTUBE_API_KEY,
    metaAccessToken: c.META_ACCESS_TOKEN,
    metaInstagramBusinessAccountId: c.META_INSTAGRAM_BUSINESS_ACCOUNT_ID,
    metaAppId: c.META_APP_ID,
    metaAppSecret: c.META_APP_SECRET,
  };
}

/**
 * A short one-way fingerprint of the credential an attempt used. Stored next to a failure so that replacing the credential starts fresh;
 * the credential itself is never stored (and a fingerprint of a high-entropy secret cannot be reversed).
 */
export function credentialFingerprint(platform: SocialPlatform, cfg: SocialConfig): string {
  const material = platform === 'youtube' ? [cfg.youtubeApiKey] : platform === 'instagram' ? [cfg.metaAccessToken, cfg.metaInstagramBusinessAccountId] : [cfg.metaAccessToken];
  return sha256Hex(`${platform}|${material.map((m) => m ?? '').join('|')}`).slice(0, 16);
}

export interface SocialSyncResult {
  accountId: string;
  platform: string;
  handle: string;
  site: string;
  /** ready | not_configured | requires_approval | error | needs_reconnect | backing_off */
  state: string;
  message: string;
  posts: number;
  nextAttemptAt?: string | null;
}

/**
 * Reads recent public activity for CONFIRMED accounts via official APIs. Unavailable integrations report why. A provider that refused or
 * rate-limited us is left alone until the retry policy says it may be asked again; a replaced credential starts fresh.
 * `manual` means a person asked for the sync: it can retry a bad credential or an early hiccup, but never overrides a quota or rate limit.
 */
export async function syncSocial(svc: Services, db: DbLike, orgId: string, opts: { http?: HttpJson; siteId?: string; manual?: boolean } = {}): Promise<SocialSyncResult[]> {
  const where = opts.siteId ? and(eq(socialAccounts.orgId, orgId), eq(socialAccounts.confirmed, true), eq(socialAccounts.siteId, opts.siteId)) : and(eq(socialAccounts.orgId, orgId), eq(socialAccounts.confirmed, true));
  const accts = await db.select().from(socialAccounts).where(where);
  const out: SocialSyncResult[] = [];
  const now = svc.clock();
  const cfg = socialConfigOf(svc);
  for (const a of accts) {
    const [site] = await db.select().from(sites).where(eq(sites.id, a.siteId));
    if (!site) continue;
    const fp = credentialFingerprint(a.platform, cfg);
    const skip = shouldSkipSync({ failureKind: a.failureKind, nextAttemptAt: a.nextAttemptAt, credentialFingerprint: a.credentialFingerprint }, fp, now, !!opts.manual);
    if (skip.skip) {
      out.push({ accountId: a.id, platform: a.platform, handle: a.handle, site: site.name, state: a.failureKind === 'auth' ? 'needs_reconnect' : 'backing_off', message: `${skip.why} Last problem: ${a.lastSyncMessage ?? 'unknown'}`, posts: 0, nextAttemptAt: a.nextAttemptAt?.toISOString() ?? null });
      continue;
    }

    const r = await fetchSocial(a.platform, cfg, { handle: a.handle, url: a.url, externalId: a.externalId }, opts.http);
    let count = 0;
    for (const p of r.posts) {
      const cls = classifyPost(`${p.title ?? ''} ${p.text ?? ''}`);
      const eng = p.engagement ? { views: p.engagement.views, likes: p.engagement.likes, comments: p.engagement.comments, shares: p.engagement.shares } : null;
      await db
        .insert(marketingActivities)
        .values({
          orgId, siteId: a.siteId, platform: a.platform, kind: p.kind, title: p.title, excerpt: p.text?.slice(0, 400) ?? null, url: p.url, publishedAt: p.publishedAt, firstSeenAt: now, lastSeenAt: now,
          classification: cls.classification, confidence: cls.confidence, extractionMethod: 'official_api', dedupeKey: `${a.platform}:${sha256Hex(p.externalId).slice(0, 20)}`, isFixture: site.isFixture,
          provenance: provenanceFor({ isFixture: site.isFixture, official: true }),
          engagement: eng, engagementObservedAt: eng ? now : null,
        })
        // Counts change over time: refresh them when the platform gives them; when it stops giving them, keep the last known counts with their own timestamp.
        .onConflictDoUpdate({ target: [marketingActivities.orgId, marketingActivities.siteId, marketingActivities.dedupeKey], set: eng ? { lastSeenAt: now, engagement: eng, engagementObservedAt: now } : { lastSeenAt: now } });
      count++;
    }

    let backoff: { failureKind: typeof a.failureKind; consecutiveFailures: number; nextAttemptAt: Date | null; credentialFingerprint: string | null };
    let state: string = r.state;
    let nextAttemptAt: Date | null = null;
    if (r.failure) {
      const failures = (a.credentialFingerprint === fp ? a.consecutiveFailures : 0) + 1;
      const decision = nextAttempt(r.failure, failures, now);
      nextAttemptAt = decision.nextAttemptAt;
      if (r.failure.kind === 'auth') state = 'needs_reconnect';
      backoff = { failureKind: r.failure.kind, consecutiveFailures: failures, nextAttemptAt, credentialFingerprint: fp };
    } else {
      backoff = { failureKind: null, consecutiveFailures: 0, nextAttemptAt: null, credentialFingerprint: null };
    }
    await db.update(socialAccounts).set({ lastSyncAt: now, lastSyncStatus: state, lastSyncMessage: r.message, externalId: r.externalId ?? a.externalId, ...backoff }).where(eq(socialAccounts.id, a.id));
    out.push({ accountId: a.id, platform: a.platform, handle: a.handle, site: site.name, state, message: r.message, posts: count, nextAttemptAt: nextAttemptAt?.toISOString() ?? null });
  }
  return out;
}

// ───────────────────────────────────────────────────────────── credential health (cached; costs no provider quota)

const HEALTH_TTL_MS = 60 * 60_000;
const healthCache = new Map<string, { at: number; health: CredentialHealth | null }>();

/**
 * Whether the configured Meta token is valid, when it expires and which permissions it carries — asked of Meta at most once an hour
 * per credential. Null when no Meta token is configured.
 */
export async function loadMetaTokenHealth(svc: Pick<Services, 'config' | 'clock'>, http?: HttpJson): Promise<CredentialHealth | null> {
  const cfg = socialConfigOf(svc);
  if (!cfg.metaAccessToken) return null;
  const key = sha256Hex(`${cfg.metaAccessToken}|${cfg.metaAppId ?? ''}|${cfg.metaAppSecret ?? ''}`).slice(0, 16);
  const now = svc.clock();
  const hit = healthCache.get(key);
  if (hit && now.getTime() - hit.at < HEALTH_TTL_MS && now.getTime() >= hit.at) return hit.health;
  const health = await checkMetaToken(cfg, http, now);
  healthCache.set(key, { at: now.getTime(), health });
  return health;
}

/** For tests: forget cached answers so a changed imitation is seen. */
export function clearSocialHealthCache(): void {
  healthCache.clear();
}
