import { isIP } from 'node:net';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { forbiddenAddressReason, forbiddenHostnameReason, normalizeSiteUrl, UrlValidationError } from '@ci/core';
import { DEFAULTS, type AddSiteInput, type SiteRole } from '@ci/shared';
import { auditEvents, consentLog, scanRuns, siteProfiles, sites, type DbLike } from '@ci/database';
import type { Services } from './context.ts';

export class SiteError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_url' | 'unsafe' | 'limit' | 'duplicate' | 'not_found' | 'consent_required' | 'conflict' | 'bad_request',
    readonly status = 400,
  ) {
    super(message);
    this.name = 'SiteError';
  }
}

export const CONSENT_TEXT_VERSION = 'v2';
export const CONSENT_TEXT = {
  source:
    'This is my own business website, or I am authorised by its owner to have it analysed. Shelfwatch will read its public pages; exact stock counts need a separate connection that the store itself authorises.',
  competitor:
    'I understand that Shelfwatch will collect only what this website shows to every visitor, at a polite pace, following its robots.txt, without signing in, solving challenges or bypassing protections, and that it stops if the website refuses. This is my confirmation, not the website owner’s approval. I have checked that the website’s terms of use and the law that applies to me allow me to use this information for my own business analysis, and I accept responsibility for that.',
} as const;

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'));
}

/**
 * Resolves a hostname and verifies every address is public. Throws SiteError when it is not. There is no exception for loopback,
 * private or internal addresses, and no setting that creates one.
 */
export async function assertPublicHost(svc: Pick<Services, 'resolver'>, bareHostname: string): Promise<void> {
  if (isLoopback(bareHostname)) throw new SiteError('Local and private addresses cannot be added: they are blocked for security reasons.', 'unsafe');
  const reason = forbiddenHostnameReason(bareHostname);
  if (reason) throw new SiteError(`This address cannot be used: ${reason}.`, 'unsafe');
  if (isIP(bareHostname.replace(/^\[|\]$/g, ''))) return;
  let addrs: { address: string }[];
  let timer: NodeJS.Timeout | undefined;
  try {
    addrs = await Promise.race([
      svc.resolver(bareHostname),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error('DNS lookup timed out')), 6000);
      }),
    ]);
  } catch {
    throw new SiteError(`The domain "${bareHostname}" could not be found. Check the spelling.`, 'invalid_url');
  } finally {
    clearTimeout(timer);
  }
  const bad = addrs.find((a) => forbiddenAddressReason(a.address));
  if (!addrs.length || bad) throw new SiteError('This domain points to a private or internal network and cannot be added.', 'unsafe');
}

/** Collection only ever uses the standard web ports (80/443), so another port is refused when the website is added rather than failing later. */
function assertStandardPort(href: string): void {
  const port = new URL(href).port;
  if (port !== '' && port !== '80' && port !== '443') {
    throw new SiteError(`Only standard web addresses (ports 80 and 443) can be collected. Remove “:${port}” from the address.`, 'invalid_url');
  }
}

export async function addSite(svc: Services, db: DbLike, orgId: string, actorUserId: string, input: AddSiteInput) {
  let norm;
  try {
    norm = normalizeSiteUrl(input.url);
  } catch (e) {
    throw new SiteError(e instanceof UrlValidationError ? e.message : 'The URL is not valid.', 'invalid_url');
  }
  await assertPublicHost(svc, norm.bareHostname);
  assertStandardPort(norm.href);

  const existing = await db.select().from(sites).where(and(eq(sites.orgId, orgId), eq(sites.active, true)));
  if (existing.some((s) => s.hostname === norm.hostname)) throw new SiteError('This website is already in your workspace.', 'duplicate', 409);
  if (input.role === 'source' && existing.some((s) => s.role === 'source')) throw new SiteError('You already have a source website. Edit or remove it first.', 'conflict', 409);
  if (input.role === 'competitor' && existing.filter((s) => s.role === 'competitor').length >= DEFAULTS.maxCompetitors) {
    throw new SiteError(`A workspace can track up to ${DEFAULTS.maxCompetitors} competitors.`, 'limit', 409);
  }
  const [row] = await db
    .insert(sites)
    .values({
      orgId,
      url: norm.href,
      origin: norm.origin,
      entryPath: norm.entryPath,
      hostname: norm.hostname,
      name: input.name?.trim() || norm.bareHostname.replace(/^www\./, ''),
      role: input.role,
      consentStatus: 'pending',
      crawlDelayMs: svc.config.COLLECTOR_DEFAULT_DELAY_MS,
      maxRequestsPerRun: svc.config.COLLECTOR_DEFAULT_MAX_REQUESTS,
    })
    .returning();
  await db.insert(auditEvents).values({ orgId, userId: actorUserId, action: 'site.add', target: row!.id, meta: { role: input.role, host: norm.hostname } });
  return row!;
}

export async function updateSite(
  svc: Services,
  db: DbLike,
  orgId: string,
  actorUserId: string,
  siteId: string,
  patch: { url?: string; name?: string; active?: boolean; crawlDelayMs?: number; maxRequestsPerRun?: number; currency?: string | null },
) {
  const [site] = await db.select().from(sites).where(and(eq(sites.id, siteId), eq(sites.orgId, orgId)));
  if (!site) throw new SiteError('Website not found.', 'not_found', 404);
  const set: Partial<typeof sites.$inferInsert> = { updatedAt: svc.clock() };
  if (patch.url !== undefined) {
    let norm;
    try {
      norm = normalizeSiteUrl(patch.url);
    } catch (e) {
      throw new SiteError(e instanceof UrlValidationError ? e.message : 'The URL is not valid.', 'invalid_url');
    }
    if (norm.bareHostname !== new URL(site.origin).hostname) {
      // Everything stored under a website — products, prices, page copies, offers, alerts, the customer's confirmation — belongs to that website.
      // Re-pointing it at another one would leave the old website's data standing in for the new one's, so a different website is a new entry.
      throw new SiteError(
        'To track a different website, remove this one and add the new address. Its collected products, prices and history belong to the website they came from and cannot be moved to another one.',
        'conflict',
        409,
      );
    }
    // Same website (for example http → https, or a different start page): the address can change; the checks still apply.
    await assertPublicHost(svc, norm.bareHostname);
    assertStandardPort(norm.href);
    Object.assign(set, { url: norm.href, origin: norm.origin, entryPath: norm.entryPath });
  }
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.crawlDelayMs !== undefined) set.crawlDelayMs = patch.crawlDelayMs;
  if (patch.maxRequestsPerRun !== undefined) set.maxRequestsPerRun = patch.maxRequestsPerRun;
  if (patch.currency !== undefined) {
    set.currency = patch.currency ? patch.currency.toUpperCase() : null;
    set.currencySource = patch.currency ? 'user' : 'detected';
  }
  const [row] = await db.update(sites).set(set).where(eq(sites.id, siteId)).returning();
  await db.insert(auditEvents).values({ orgId, userId: actorUserId, action: 'site.update', target: siteId, meta: { fields: Object.keys(patch) } });
  return row!;
}

export async function removeSite(db: DbLike, orgId: string, actorUserId: string, siteId: string) {
  const [site] = await db.select().from(sites).where(and(eq(sites.id, siteId), eq(sites.orgId, orgId)));
  if (!site) throw new SiteError('Website not found.', 'not_found', 404);
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.insert(auditEvents).values({ orgId, userId: actorUserId, action: 'site.remove', target: siteId, meta: { host: site.hostname } });
}

export async function setConsent(
  svc: Services,
  db: DbLike,
  orgId: string,
  actorUserId: string,
  siteId: string,
  input: { status: 'confirmed' | 'revoked'; note?: string; attest?: boolean },
) {
  const [site] = await db.select().from(sites).where(and(eq(sites.id, siteId), eq(sites.orgId, orgId)));
  if (!site) throw new SiteError('Website not found.', 'not_found', 404);
  if (input.status === 'confirmed' && !input.attest) throw new SiteError('Please tick the confirmation to continue.', 'bad_request');
  const text = site.role === 'source' ? CONSENT_TEXT.source : CONSENT_TEXT.competitor;
  const note = input.status === 'confirmed' ? `${text} [${CONSENT_TEXT_VERSION}]${input.note ? ` — ${input.note}` : ''}` : (input.note ?? 'Collection stopped by the customer');
  const now = svc.clock();
  const [row] = await db
    .update(sites)
    .set({ consentStatus: input.status, consentNote: note, consentAt: now, consentBy: actorUserId, updatedAt: now })
    .where(eq(sites.id, siteId))
    .returning();
  await db.insert(consentLog).values({ orgId, siteId, kind: 'collect_site', status: input.status, note, actorUserId });
  await db.insert(auditEvents).values({ orgId, userId: actorUserId, action: `consent.${input.status}`, target: siteId });
  if (input.status === 'revoked') {
    await db.update(scanRuns).set({ status: 'cancelled', finishedAt: now, error: 'Cancelled: the customer stopped collection from this website' }).where(and(eq(scanRuns.siteId, siteId), inArray(scanRuns.status, ['queued', 'running'])));
  }
  return row!;
}

export interface SiteListItem {
  id: string;
  name: string;
  url: string;
  /** The page the customer pointed at when it was not the home page; null for a bare address. */
  entryPath: string | null;
  hostname: string;
  role: SiteRole;
  active: boolean;
  consentStatus: string;
  consentAt: Date | null;
  platform: string | null;
  currency: string | null;
  currencySource: string;
  capabilityStatus: string | null;
  lastProfiledAt: Date | null;
  crawlDelayMs: number;
  maxRequestsPerRun: number;
  productCount: number;
  lastScan: { id: string; status: string; kind: string; finishedAt: Date | null; productsSaved: number; isComplete: boolean } | null;
}

export async function listSites(db: DbLike, orgId: string): Promise<SiteListItem[]> {
  const rows = await db.select().from(sites).where(eq(sites.orgId, orgId)).orderBy(desc(sites.role), sites.name);
  if (!rows.length) return [];
  const counts = await db.execute<{ site_id: string; n: string }>(sql`select site_id, count(*)::text as n from products where org_id = ${orgId} and delisted_at is null group by site_id`);
  const countBy = new Map(counts.rows.map((r) => [r.site_id, Number(r.n)]));
  const runs = await db
    .select()
    .from(scanRuns)
    .where(eq(scanRuns.orgId, orgId))
    .orderBy(desc(scanRuns.createdAt))
    .limit(200);
  const lastBy = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!lastBy.has(r.siteId)) lastBy.set(r.siteId, r);
  return rows.map((s) => {
    const r = lastBy.get(s.id);
    return {
      id: s.id, name: s.name, url: s.url, entryPath: s.entryPath, hostname: s.hostname, role: s.role, active: s.active,
      consentStatus: s.consentStatus, consentAt: s.consentAt, platform: s.platform, currency: s.currency, currencySource: s.currencySource,
      capabilityStatus: s.capabilityStatus, lastProfiledAt: s.lastProfiledAt, crawlDelayMs: s.crawlDelayMs, maxRequestsPerRun: s.maxRequestsPerRun,
      productCount: countBy.get(s.id) ?? 0,
      lastScan: r ? { id: r.id, status: r.status, kind: r.kind, finishedAt: r.finishedAt, productsSaved: r.productsSaved, isComplete: r.isComplete } : null,
    };
  });
}

export async function getSite(db: DbLike, orgId: string, siteId: string) {
  const [s] = await db.select().from(sites).where(and(eq(sites.id, siteId), eq(sites.orgId, orgId)));
  if (!s) throw new SiteError('Website not found.', 'not_found', 404);
  return s;
}

export async function latestProfile(db: DbLike, orgId: string, siteId: string) {
  const [p] = await db.select().from(siteProfiles).where(and(eq(siteProfiles.siteId, siteId), eq(siteProfiles.orgId, orgId))).orderBy(desc(siteProfiles.createdAt)).limit(1);
  return p ?? null;
}

export async function profileHistory(db: DbLike, orgId: string, siteId: string, limit = 20) {
  return db
    .select({ id: siteProfiles.id, status: siteProfiles.status, summary: siteProfiles.summary, platform: siteProfiles.platform, createdAt: siteProfiles.createdAt, durationMs: siteProfiles.durationMs })
    .from(siteProfiles)
    .where(and(eq(siteProfiles.siteId, siteId), eq(siteProfiles.orgId, orgId)))
    .orderBy(desc(siteProfiles.createdAt))
    .limit(limit);
}
