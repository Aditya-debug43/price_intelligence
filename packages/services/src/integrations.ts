import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { decryptSecret, encryptSecret, isValidShopDomain, randomToken, verifyShopifyQueryHmac } from '@ci/core';
import {
  ShopifyInventoryProvider,
  allSocialStatuses,
  buildShopifyAuthorizeUrl,
  verifyYouTubeChannel,
  type YouTubeChannelInfo,
  type YouTubeSetup,
  exchangeShopifyCode,
  refreshShopifyToken,
  revokeShopifyAccess,
  type ShopifyAppConfig,
} from '@ci/connectors';
import { auditEvents, integrationConnections, marketingActivities, oauthStates, sites, socialAccounts, withTenant, type Db, type DbLike } from '@ci/database';
import type { Services } from './context.ts';
import { raiseAlert, emailAlertDigest, resolveClearedAlerts } from './alerts.ts';
import { applyInventory, type InventorySyncResult } from './stock.ts';
import { loadMetaTokenHealth, socialConfigOf } from './social-sync.ts';

export class IntegrationError extends Error {
  constructor(message: string, readonly code: 'not_configured' | 'invalid' | 'forbidden' | 'not_found' | 'state' | 'provider', readonly status = 400) {
    super(message);
    this.name = 'IntegrationError';
  }
}

/** Null when the Shopify app credentials/redirect are not configured — the UI then explains what is missing. */
export function shopifyAppConfig(svc: Pick<Services, 'config'>): ShopifyAppConfig | null {
  const c = svc.config;
  if (!c.SHOPIFY_CLIENT_ID || !c.SHOPIFY_CLIENT_SECRET || !c.SHOPIFY_REDIRECT_URI) return null;
  return { clientId: c.SHOPIFY_CLIENT_ID, clientSecret: c.SHOPIFY_CLIENT_SECRET, scopes: c.SHOPIFY_SCOPES, redirectUri: c.SHOPIFY_REDIRECT_URI, apiVersion: c.SHOPIFY_API_VERSION };
}

const SAFE_COLUMNS = {
  id: integrationConnections.id,
  provider: integrationConnections.provider,
  siteId: integrationConnections.siteId,
  status: integrationConnections.status,
  shopDomain: integrationConnections.shopDomain,
  scopes: integrationConnections.scopes,
  connectedAt: integrationConnections.connectedAt,
  revokedAt: integrationConnections.revokedAt,
  lastSyncAt: integrationConnections.lastSyncAt,
  lastError: integrationConnections.lastError,
  accessTokenExpiresAt: integrationConnections.accessTokenExpiresAt,
  createdAt: integrationConnections.createdAt,
} as const;

export async function integrationOverview(svc: Services, db: DbLike, orgId: string) {
  const shop = shopifyAppConfig(svc);
  const missing: string[] = [];
  if (!svc.config.SHOPIFY_CLIENT_ID) missing.push('SHOPIFY_CLIENT_ID');
  if (!svc.config.SHOPIFY_CLIENT_SECRET) missing.push('SHOPIFY_CLIENT_SECRET');
  if (!svc.config.SHOPIFY_REDIRECT_URI) missing.push('SHOPIFY_REDIRECT_URI');
  if (!svc.keyRing) missing.push('TOKEN_ENCRYPTION_KEY');
  const connections = await db.select(SAFE_COLUMNS).from(integrationConnections).where(eq(integrationConnections.orgId, orgId)).orderBy(desc(integrationConnections.createdAt));
  const accounts = await db
    .select({ id: socialAccounts.id, siteId: socialAccounts.siteId, siteName: sites.name, siteRole: sites.role, platform: socialAccounts.platform, handle: socialAccounts.handle, url: socialAccounts.url, discoveredFrom: socialAccounts.discoveredFrom, confirmed: socialAccounts.confirmed, externalId: socialAccounts.externalId, externalTitle: socialAccounts.externalTitle, verifiedAt: socialAccounts.verifiedAt, syncingSince: socialAccounts.syncingSince, lastSyncAt: socialAccounts.lastSyncAt, lastSyncStatus: socialAccounts.lastSyncStatus, lastSyncMessage: socialAccounts.lastSyncMessage, failureKind: socialAccounts.failureKind, nextAttemptAt: socialAccounts.nextAttemptAt, consecutiveFailures: socialAccounts.consecutiveFailures })
    .from(socialAccounts)
    .innerJoin(sites, eq(sites.id, socialAccounts.siteId))
    .where(eq(socialAccounts.orgId, orgId));
  const now = svc.clock();
  const yt = accounts.filter((a) => a.platform === 'youtube');
  const failing = yt.filter((a) => a.confirmed && a.failureKind);
  const youtube: YouTubeSetup = {
    connected: yt.filter((a) => a.confirmed).length,
    unconnected: yt.filter((a) => !a.confirmed).length,
    // a read that started long ago and never ended (a restart) is not "running"
    collecting: yt.some((a) => a.confirmed && a.syncingSince && now.getTime() - a.syncingSince.getTime() < 30 * 60_000),
    problem: failing[0] ? `${failing[0].siteName}: ${failing[0].lastSyncMessage ?? 'the last read failed'}` : null,
    problems: failing.length,
  };
  return {
    shopify: {
      configured: !!shop && !!svc.keyRing,
      missing,
      scopes: svc.config.SHOPIFY_SCOPES,
      apiVersion: svc.config.SHOPIFY_API_VERSION,
      readOnly: true,
      note: 'Read-only access (products, inventory, locations). Tokens are encrypted at rest, expire hourly and are refreshed automatically; disconnecting revokes access.',
    },
    connections,
    social: { providers: allSocialStatuses(socialConfigOf(svc), await loadMetaTokenHealth(svc, svc.socialHttp), youtube), accounts: accounts.map(({ syncingSince, ...a }) => ({ ...a, syncing: !!syncingSince && now.getTime() - syncingSince.getTime() < 30 * 60_000 })) },
  };
}

// ───────────────────────────────────────────────────────────── Shopify OAuth

export async function startShopifyOAuth(svc: Services, db: Db, orgId: string, userId: string, shopInput: string, siteId?: string): Promise<{ url: string }> {
  const cfg = shopifyAppConfig(svc);
  if (!cfg || !svc.keyRing) throw new IntegrationError('Shopify is not configured on this server. An administrator must set the Shopify app credentials and the token encryption key.', 'not_configured', 501);
  const shop = shopInput.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const domain = shop.includes('.') ? shop : `${shop}.myshopify.com`;
  if (!isValidShopDomain(domain)) throw new IntegrationError('Enter your store’s myshopify.com address, for example my-store.myshopify.com.', 'invalid');
  const state = randomToken(24);
  await db.insert(oauthStates).values({ orgId, userId, provider: 'shopify', state, shop: domain, siteId: siteId ?? null, expiresAt: new Date(svc.clock().getTime() + 10 * 60_000) });
  await withTenant(db, orgId, (tx) => tx.insert(auditEvents).values({ orgId, userId, action: 'integration.shopify.start', target: domain }));
  return { url: buildShopifyAuthorizeUrl(cfg, domain, state) };
}

export async function completeShopifyOAuth(svc: Services, db: Db, userId: string, query: Record<string, string>): Promise<{ orgId: string; connectionId: string }> {
  const cfg = shopifyAppConfig(svc);
  if (!cfg || !svc.keyRing) throw new IntegrationError('Shopify is not configured on this server.', 'not_configured', 501);
  if (!verifyShopifyQueryHmac(query, cfg.clientSecret)) throw new IntegrationError('The Shopify response could not be verified.', 'state', 400);
  const shop = (query['shop'] ?? '').toLowerCase();
  if (!isValidShopDomain(shop)) throw new IntegrationError('Invalid shop domain.', 'invalid');
  const [st] = await db.select().from(oauthStates).where(eq(oauthStates.state, query['state'] ?? ''));
  if (!st || st.usedAt || st.expiresAt < svc.clock() || st.userId !== userId || st.shop !== shop) throw new IntegrationError('This connection request has expired or does not belong to you. Start again.', 'state', 400);
  await db.update(oauthStates).set({ usedAt: svc.clock() }).where(eq(oauthStates.id, st.id));
  if (!query['code']) throw new IntegrationError('Shopify did not return an authorization code.', 'provider');
  const tokens = await exchangeShopifyCode(cfg, shop, query['code'], undefined, svc.clock());
  const conn = await withTenant(db, st.orgId, async (tx) => {
    const [row] = await tx
      .insert(integrationConnections)
      .values({
        orgId: st.orgId, provider: 'shopify', siteId: st.siteId, status: 'connected', shopDomain: shop, scopes: tokens.scope,
        accessTokenEnc: encryptSecret(tokens.accessToken, svc.keyRing!), refreshTokenEnc: tokens.refreshToken ? encryptSecret(tokens.refreshToken, svc.keyRing!) : null,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt, refreshTokenExpiresAt: tokens.refreshTokenExpiresAt, connectedBy: userId, connectedAt: svc.clock(),
      })
      .returning({ id: integrationConnections.id });
    await tx.insert(auditEvents).values({ orgId: st.orgId, userId, action: 'integration.shopify.connected', target: shop, meta: { scopes: tokens.scope } });
    return row!;
  });
  await svc.queue.enqueue('sync-inventory', { orgId: st.orgId, connectionId: conn.id }, { singletonKey: `inv:${conn.id}:first` });
  return { orgId: st.orgId, connectionId: conn.id };
}

/** Returns a valid access token, refreshing an expiring one under a row lock so concurrent callers can't invalidate each other. */
export async function getShopifyAccessToken(svc: Services, connectionId: string): Promise<string> {
  const cfg = shopifyAppConfig(svc);
  if (!cfg || !svc.keyRing) throw new IntegrationError('Shopify is not configured on this server.', 'not_configured', 501);
  const ring = svc.keyRing;
  return svc.db.transaction(async (tx) => {
    const [c] = await tx.select().from(integrationConnections).where(eq(integrationConnections.id, connectionId)).for('update');
    if (!c || c.status !== 'connected' || !c.accessTokenEnc || !c.shopDomain) throw new IntegrationError('This inventory connection is not active.', 'forbidden', 409);
    const now = svc.clock();
    const stillValid = !c.accessTokenExpiresAt || c.accessTokenExpiresAt.getTime() - now.getTime() > 5 * 60_000;
    if (stillValid) return decryptSecret(c.accessTokenEnc, ring);
    if (!c.refreshTokenEnc || (c.refreshTokenExpiresAt && c.refreshTokenExpiresAt < now)) {
      await tx.update(integrationConnections).set({ status: 'error', lastError: 'The Shopify authorization expired. The store owner must reconnect.' }).where(eq(integrationConnections.id, c.id));
      throw Object.assign(new IntegrationError('The Shopify authorization expired. The store owner must reconnect.', 'forbidden', 401), { reauthorize: true });
    }
    try {
      const t = await refreshShopifyToken(cfg, c.shopDomain, decryptSecret(c.refreshTokenEnc, ring), undefined, now);
      await tx
        .update(integrationConnections)
        .set({ accessTokenEnc: encryptSecret(t.accessToken, ring), refreshTokenEnc: t.refreshToken ? encryptSecret(t.refreshToken, ring) : c.refreshTokenEnc, accessTokenExpiresAt: t.accessTokenExpiresAt, refreshTokenExpiresAt: t.refreshTokenExpiresAt ?? c.refreshTokenExpiresAt, lastError: null })
        .where(eq(integrationConnections.id, c.id));
      return t.accessToken;
    } catch (e) {
      if ((e as { code?: string }).code === 'reauthorize') {
        await tx.update(integrationConnections).set({ status: 'error', lastError: (e as Error).message }).where(eq(integrationConnections.id, c.id));
      }
      throw e;
    }
  });
}

// ───────────────────────────────────────────────────────────── sync + lifecycle

/** Reads inventory from the connection's provider and applies it to the own shop's variants (alerts are deduplicated). */
export async function runInventorySync(svc: Services, db: DbLike, orgId: string, connectionId: string): Promise<InventorySyncResult> {
  const [c] = await db.select().from(integrationConnections).where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.orgId, orgId)));
  if (!c) throw new IntegrationError('Connection not found.', 'not_found', 404);
  if (c.status !== 'connected') throw new IntegrationError('This connection is not active.', 'forbidden', 409);
  let provider;
  if (c.provider === 'shopify' && c.shopDomain) provider = new ShopifyInventoryProvider(c.shopDomain, svc.config.SHOPIFY_API_VERSION, () => getShopifyAccessToken(svc, c.id));
  else throw new IntegrationError('Unsupported inventory provider.', 'invalid');
  try {
    const items = await provider.listInventory();
    const result = await applyInventory(svc, db, { orgId, connectionId, items });
    await resolveClearedAlerts(db, { orgId, types: ['integration_issue'], connectionId, note: 'The inventory sync succeeded again.', now: svc.clock() });
    return result;
  } catch (e) {
    // A revoked, expired or refused grant cannot heal itself: flag the connection so the owner is told to reconnect.
    const code = (e as { code?: string }).code;
    const reauth = code === 'unauthorized' || code === 'reauthorize' || (e as { reauthorize?: boolean }).reauthorize === true;
    await db.update(integrationConnections).set({ lastError: (e as Error).message.slice(0, 300), ...(reauth ? { status: 'error' as const } : {}) }).where(eq(integrationConnections.id, connectionId));
    const id = await raiseAlert(db, {
      orgId, type: 'integration_issue', severity: 'warning', title: 'Inventory sync problem', body: `${(e as Error).message}${reauth ? ' Reconnect the store in Settings → Integrations.' : ''}`,
      dedupeKey: `integration:${connectionId}:${svc.clock().toISOString().slice(0, 10)}`, data: { connectionId },
    });
    if (id) await emailAlertDigest(svc, db, orgId, [id], 'integration');
    throw e;
  }
}

export async function disconnectIntegration(svc: Services, db: DbLike, orgId: string, userId: string, connectionId: string): Promise<{ revokedRemotely: boolean }> {
  const [c] = await db.select().from(integrationConnections).where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.orgId, orgId)));
  if (!c) throw new IntegrationError('Connection not found.', 'not_found', 404);
  let revokedRemotely = false;
  if (c.provider === 'shopify' && c.accessTokenEnc && c.shopDomain && svc.keyRing) {
    try {
      revokedRemotely = await revokeShopifyAccess(c.shopDomain, decryptSecret(c.accessTokenEnc, svc.keyRing));
    } catch {
      /* local revocation below always happens */
    }
  }
  await db
    .update(integrationConnections)
    .set({ status: 'revoked', revokedAt: svc.clock(), accessTokenEnc: null, refreshTokenEnc: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null, lastError: null })
    .where(eq(integrationConnections.id, connectionId));
  await db.insert(auditEvents).values({ orgId, userId, action: 'integration.disconnected', target: connectionId, meta: { provider: c.provider, revokedRemotely } });
  await resolveClearedAlerts(db, { orgId, types: ['integration_issue'], connectionId, note: 'The connection was disconnected.', now: svc.clock() });
  return { revokedRemotely };
}

/** Webhook-driven revocation (app/uninstalled). Runs in the worker because the lookup spans organisations. */
export async function handleShopifyUninstalled(svc: Services, shop: string): Promise<number> {
  const rows = await svc.db.select({ id: integrationConnections.id, orgId: integrationConnections.orgId }).from(integrationConnections).where(and(eq(integrationConnections.shopDomain, shop), eq(integrationConnections.provider, 'shopify')));
  for (const r of rows) {
    await svc.db.update(integrationConnections).set({ status: 'revoked', revokedAt: svc.clock(), accessTokenEnc: null, refreshTokenEnc: null, lastError: 'The app was uninstalled in Shopify.' }).where(eq(integrationConnections.id, r.id));
    await raiseAlert(svc.db, { orgId: r.orgId, type: 'integration_issue', severity: 'warning', title: 'Shopify connection removed', body: 'The app was uninstalled in Shopify, so authorised inventory counts are no longer available.', dedupeKey: `integration:${r.id}:uninstalled`, data: { connectionId: r.id } });
  }
  return rows.length;
}

type SocialSvc = Pick<Services, 'config' | 'socialHttp' | 'clock'>;

/**
 * Asks YouTube which channel a mapping really is, and refuses one that is not a single, exact, unclaimed channel: an address YouTube cannot resolve, a handle that belongs to a different
 * channel, a missing key, or a channel already connected to another website of the workspace (a channel belongs to one website).
 */
async function verifiedChannel(svc: SocialSvc, db: DbLike, orgId: string, a: { siteId: string; handle: string; url?: string | null; externalId?: string | null; id?: string }): Promise<YouTubeChannelInfo> {
  const v = await verifyYouTubeChannel(socialConfigOf(svc), { handle: a.handle, url: a.url, externalId: a.externalId }, svc.socialHttp);
  if (!v.ok) throw new IntegrationError(v.message, v.notConfigured ? 'not_configured' : 'invalid', v.notConfigured ? 409 : 422);
  const clash = await db
    .select({ site: sites.name, siteId: socialAccounts.siteId })
    .from(socialAccounts)
    .innerJoin(sites, eq(sites.id, socialAccounts.siteId))
    .where(and(eq(socialAccounts.orgId, orgId), eq(socialAccounts.platform, 'youtube'), eq(socialAccounts.externalId, v.channel.channelId), eq(socialAccounts.confirmed, true), ne(socialAccounts.siteId, a.siteId)));
  if (clash[0]) throw new IntegrationError(`This channel (“${v.channel.title ?? v.channel.channelId}”) is already connected to ${clash[0].site}. A channel belongs to one website, so it was not connected here.`, 'invalid', 409);
  return v.channel;
}

export async function confirmSocialAccount(svc: SocialSvc, db: DbLike, orgId: string, userId: string, accountId: string, confirmed: boolean) {
  const [current] = await db.select().from(socialAccounts).where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.orgId, orgId)));
  if (!current) throw new IntegrationError('Account not found.', 'not_found', 404);
  // a YouTube channel is checked against YouTube itself before it is used: only a channel that really is the one named gets connected
  const channel = confirmed && current.platform === 'youtube' ? await verifiedChannel(svc, db, orgId, current) : null;
  const [r] = await db
    .update(socialAccounts)
    .set({ confirmed, confirmedBy: confirmed ? userId : null, ...(channel ? { externalId: channel.channelId, externalTitle: channel.title, verifiedAt: svc.clock() } : {}) })
    .where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.orgId, orgId)))
    .returning();
  return r!;
}

/**
 * A mapping entered by a person. A YouTube channel may be given as an address, a @handle or a channel id; it is verified with YouTube first and nothing is saved if it is not exactly
 * that channel. The same channel entered twice for a website is one mapping.
 */
export async function addSocialAccount(svc: SocialSvc, db: DbLike, orgId: string, userId: string, p: { siteId: string; platform: 'facebook' | 'instagram' | 'youtube'; handle: string; url?: string }) {
  const [site] = await db.select().from(sites).where(and(eq(sites.id, p.siteId), eq(sites.orgId, orgId)));
  if (!site) throw new IntegrationError('Website not found.', 'not_found', 404);
  if (p.platform === 'youtube') {
    const channel = await verifiedChannel(svc, db, orgId, { siteId: p.siteId, handle: p.handle, url: p.url ?? null });
    const handle = channel.customUrl ?? channel.channelId;
    const verified = { externalId: channel.channelId, externalTitle: channel.title, verifiedAt: svc.clock(), confirmed: true, confirmedBy: userId };
    // the same channel already mapped for this website (found on its own site, or entered before in another form): that mapping is the one that is connected
    const [same] = await db.select().from(socialAccounts).where(and(eq(socialAccounts.orgId, orgId), eq(socialAccounts.siteId, p.siteId), eq(socialAccounts.platform, 'youtube'), eq(socialAccounts.externalId, channel.channelId)));
    const [byHandle] = same ? [] : await db.select().from(socialAccounts).where(and(eq(socialAccounts.siteId, p.siteId), eq(socialAccounts.platform, 'youtube'), eq(socialAccounts.handle, handle)));
    const existing = same ?? byHandle;
    if (existing) {
      const [row] = await db.update(socialAccounts).set(verified).where(eq(socialAccounts.id, existing.id)).returning();
      return row!;
    }
    const [row] = await db
      .insert(socialAccounts)
      .values({ orgId, siteId: p.siteId, platform: 'youtube', handle, url: `https://www.youtube.com/${channel.customUrl ?? `channel/${channel.channelId}`}`, discoveredFrom: 'manual', ...verified })
      .returning();
    return row!;
  }
  const [row] = await db
    .insert(socialAccounts)
    .values({ orgId, siteId: p.siteId, platform: p.platform, handle: p.handle.trim(), url: p.url ?? null, discoveredFrom: 'manual', confirmed: true, confirmedBy: userId })
    .onConflictDoUpdate({ target: [socialAccounts.siteId, socialAccounts.platform, socialAccounts.handle], set: { confirmed: true, confirmedBy: userId } })
    .returning();
  return row!;
}

/**
 * Removes a wrong mapping. What its channel published is then no longer attributed to the website (unless another mapping of the same website still names that channel); every other
 * observation, and every other website, is untouched.
 */
export async function removeSocialAccount(db: DbLike, orgId: string, userId: string, accountId: string): Promise<{ removedVideos: number }> {
  const [a] = await db.select().from(socialAccounts).where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.orgId, orgId)));
  if (!a) throw new IntegrationError('Account not found.', 'not_found', 404);
  let removedVideos = 0;
  await db.delete(socialAccounts).where(eq(socialAccounts.id, accountId));
  if (a.platform === 'youtube' && a.externalId) {
    const [other] = await db.select({ id: socialAccounts.id }).from(socialAccounts).where(and(eq(socialAccounts.orgId, orgId), eq(socialAccounts.siteId, a.siteId), eq(socialAccounts.platform, 'youtube'), eq(socialAccounts.externalId, a.externalId)));
    if (!other) {
      const gone = await db
        .delete(marketingActivities)
        .where(and(eq(marketingActivities.orgId, orgId), eq(marketingActivities.siteId, a.siteId), eq(marketingActivities.platform, 'youtube'), sql`${marketingActivities.details}->>'channelId' = ${a.externalId}`))
        .returning({ id: marketingActivities.id });
      removedVideos = gone.length;
    }
  }
  await db.insert(auditEvents).values({ orgId, userId, action: 'social.removed', target: accountId, meta: { platform: a.platform, handle: a.handle, siteId: a.siteId, removedVideos } });
  return { removedVideos };
}
