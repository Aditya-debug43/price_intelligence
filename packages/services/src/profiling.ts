import { and, desc, eq } from 'drizzle-orm';
import { profileSite, type ProfilerOptions } from '@ci/connectors';
import type { SiteProfileData, SocialPlatform } from '@ci/shared';
import { siteProfiles, sites, socialAccounts, type DbLike } from '@ci/database';
import type { Services } from './context.ts';
import { recordSitePromotions } from './promotions.ts';

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

export function capabilitiesOf(svc: Pick<Services, 'config' | 'browser' | 'llm'>) {
  return { browserEnabled: !!svc.browser?.available && svc.config.BROWSER_RENDERING_ENABLED, aiEnabled: svc.llm.available };
}

function handleFromUrl(platform: SocialPlatform, url: string): string {
  const u = new URL(url);
  const segs = u.pathname.split('/').filter(Boolean);
  if (platform === 'youtube') return segs[0]?.startsWith('@') ? segs[0] : segs.length >= 2 ? segs[1]! : (segs[0] ?? url);
  return segs[0] ?? url;
}

/**
 * Inspects a website and stores a timestamped capability report. Profiling is a light, polite look
 * (robots.txt, homepage, sitemaps, a few sample pages — typically 10–20 requests). Catalogue collection is a
 * separate action that requires the customer's confirmed collection rules.
 */
export async function runProfile(svc: Services, orgId: string, siteId: string, over: Partial<ProfilerOptions> = {}): Promise<SiteProfileData> {
  const [site] = await svc.db.select().from(sites).where(and(eq(sites.id, siteId), eq(sites.orgId, orgId)));
  if (!site) throw new ProfileError('Website not found');
  const fetcher = svc.makeFetcher();
  const started = svc.clock();
  let data: SiteProfileData;
  try {
    data = await profileSite(`${site.origin}${site.entryPath ?? ''}`, {
      fetcher,
      capabilities: capabilitiesOf(svc),
      defaultCrawlDelayMs: site.crawlDelayMs,
      defaultMaxRequests: site.maxRequestsPerRun,
      now: svc.clock,
      siteRole: site.role,
      writtenPermission: site.writtenPermission,
      ...over,
    });
  } finally {
    await fetcher.close();
  }

  await svc.db.insert(siteProfiles).values({ orgId, siteId, status: data.status, summary: data.summary, platform: data.platform.id, data, durationMs: data.durationMs });
  const patch: Partial<typeof sites.$inferInsert> = {
    platform: data.platform.id,
    capabilityStatus: data.status,
    lastProfiledAt: started,
    updatedAt: svc.clock(),
  };
  if (site.currencySource === 'detected' && data.currency.detected && !data.currency.conflicting) patch.currency = data.currency.detected;
  await svc.db.update(sites).set(patch).where(eq(sites.id, siteId));

  // Social accounts discovered from the site's own links (the customer confirms them before use).
  for (const [platform, url] of [['facebook', data.social.facebook], ['instagram', data.social.instagram], ['youtube', data.social.youtube]] as const) {
    if (!url) continue;
    await svc.db
      .insert(socialAccounts)
      .values({ orgId, siteId, platform, handle: handleFromUrl(platform, url), url, discoveredFrom: 'site_link', confirmed: false })
      .onConflictDoNothing();
  }

  // Homepage promotions are only meaningful when the page was actually read.
  if (data.site.reachable && data.site.httpStatus !== null && data.site.httpStatus < 400 && data.status !== 'blocked' && data.status !== 'failed') {
    await recordSitePromotions(svc, svc.db, { id: siteId, orgId, origin: data.site.origin ?? site.origin, currency: (patch.currency as string | undefined) ?? site.currency }, data.promotions, data.site.finalUrl ?? site.url, svc.clock());
  }
  svc.log.info('site profiled', { siteId, status: data.status, platform: data.platform.id, requests: data.requestsMade, ms: data.durationMs });
  return data;
}

export async function loadLatestProfile(db: DbLike, siteId: string): Promise<{ data: SiteProfileData; createdAt: Date } | null> {
  const [p] = await db.select().from(siteProfiles).where(eq(siteProfiles.siteId, siteId)).orderBy(desc(siteProfiles.createdAt)).limit(1);
  return p ? { data: p.data, createdAt: p.createdAt } : null;
}
