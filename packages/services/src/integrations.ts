import { and, desc, eq } from 'drizzle-orm';
import { decryptSecret, encryptSecret, isValidShopDomain, randomToken, verifyShopifyQueryHmac } from '@ci/core';
import {
  DevInventoryProvider,
  ShopifyInventoryProvider,
  allSocialStatuses,
  buildShopifyAuthorizeUrl,
  exchangeShopifyCode,
  refreshShopifyToken,
  revokeShopifyAccess,
  type ShopifyAppConfig,
  type SimulatedRow,
} from '@ci/connectors';
import { auditEvents, integrationConnections, oauthStates, products, sites, socialAccounts, variants, withTenant, type Db, type DbLike } from '@ci/database';
import type { Services } from './context.ts';
import { raiseAlert, emailAlertDigest, resolveClearedAlerts } from './alerts.ts';
import { applyInventory, type InventorySyncResult } from './stock.ts';
import { loadMetaTokenHealth, socialConfigOf } from './social-sync.ts';
import { getOrgMode } from './workspace.ts';

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
  isSimulated: integrationConnections.isSimulated,
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
    .select({ id: socialAccounts.id, siteId: socialAccounts.siteId, siteName: sites.name, platform: socialAccounts.platform, handle: socialAccounts.handle, url: socialAccounts.url, discoveredFrom: socialAccounts.discoveredFrom, confirmed: socialAccounts.confirmed, lastSyncAt: socialAccounts.lastSyncAt, lastSyncStatus: socialAccounts.lastSyncStatus, lastSyncMessage: socialAccounts.lastSyncMessage, failureKind: socialAccounts.failureKind, nextAttemptAt: socialAccounts.nextAttemptAt, consecutiveFailures: socialAccounts.consecutiveFailures })
    .from(socialAccounts)
    .innerJoin(sites, eq(sites.id, socialAccounts.siteId))
    .where(eq(socialAccounts.orgId, orgId));
  return {
    shopify: {
      configured: !!shop && !!svc.keyRing,
      missing,
      scopes: svc.config.SHOPIFY_SCOPES,
      apiVersion: svc.config.SHOPIFY_API_VERSION,
      readOnly: true,
      note: 'Read-only access (products, inventory, locations). Tokens are encrypted at rest, expire hourly and are refreshed automatically; disconnecting revokes access.',
    },
    devInventoryAvailable: !svc.config.isProduction && (await getOrgMode(db, orgId)) === 'demo',
    connections,
    social: { providers: allSocialStatuses(socialConfigOf(svc), await loadMetaTokenHealth(svc, svc.socialHttp)), accounts },
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

// ───────────────────────────────────────────────────────────── dev/simulated inventory

/** The simulator invents inventory quantities, so it exists only in demo workspaces — never in a live one, whatever the environment flags say. */
async function assertSimulatorAllowed(svc: Services, db: DbLike, orgId: string): Promise<void> {
  if (svc.config.isProduction) throw new IntegrationError('The inventory simulator is disabled in production.', 'forbidden', 403);
  if ((await getOrgMode(db, orgId)) !== 'demo') throw new IntegrationError('The inventory simulator is only available in demo workspaces. A live workspace only ever shows real inventory from an authorised connection.', 'forbidden', 403);
}

export async function createDevInventory(svc: Services, db: DbLike, orgId: string, userId: string): Promise<{ connectionId: string; rows: number }> {
  await assertSimulatorAllowed(svc, db, orgId);
  const [source] = await db.select().from(sites).where(and(eq(sites.orgId, orgId), eq(sites.role, 'source'), eq(sites.active, true)));
  if (!source) throw new IntegrationError('Add your own website first.', 'invalid');
  const rows = await db
    .select({ sku: variants.sku, title: products.title, vTitle: variants.title, availability: variants.availability })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(eq(variants.siteId, source.id));
  const sim: SimulatedRow[] = rows
    .filter((r) => r.sku)
    .map((r) => ({ sku: r.sku!, productTitle: r.title, variantTitle: r.vTitle, tracked: true, levels: [{ locationId: 'sim-main', locationName: 'Main warehouse (simulated)', available: r.availability === 'out_of_stock' ? 0 : 12 }] }));
  const [conn] = await db
    .insert(integrationConnections)
    .values({ orgId, provider: 'dev_inventory', siteId: source.id, status: 'connected', isSimulated: true, connectedBy: userId, connectedAt: svc.clock(), meta: { simulatedInventory: sim, label: 'SIMULATED inventory for development' } })
    .returning({ id: integrationConnections.id });
  await db.insert(auditEvents).values({ orgId, userId, action: 'integration.dev_inventory.created', target: conn!.id });
  return { connectionId: conn!.id, rows: sim.length };
}

export async function simulateQuantity(svc: Services, db: DbLike, orgId: string, connectionId: string, p: { sku: string; locationName: string; quantity: number | null }): Promise<InventorySyncResult> {
  await assertSimulatorAllowed(svc, db, orgId);
  const [c] = await db.select().from(integrationConnections).where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.orgId, orgId)));
  if (!c || c.provider !== 'dev_inventory') throw new IntegrationError('Simulated connection not found.', 'not_found', 404);
  const sim = ((c.meta['simulatedInventory'] as SimulatedRow[] | undefined) ?? []).map((r) => ({ ...r, levels: r.levels.map((l) => ({ ...l })) }));
  const row = sim.find((r) => r.sku.toLowerCase() === p.sku.toLowerCase());
  if (!row) throw new IntegrationError(`SKU ${p.sku} is not in the simulated inventory.`, 'not_found', 404);
  const level = row.levels.find((l) => l.locationName === p.locationName) ?? row.levels[0]!;
  level.available = p.quantity;
  row.tracked = p.quantity !== null;
  await db.update(integrationConnections).set({ meta: { ...c.meta, simulatedInventory: sim } }).where(eq(integrationConnections.id, c.id));
  return runInventorySync(svc, db, orgId, connectionId);
}

// ───────────────────────────────────────────────────────────── sync + lifecycle

/** Reads inventory from the connection's provider and applies it to the own shop's variants (alerts are deduplicated). */
export async function runInventorySync(svc: Services, db: DbLike, orgId: string, connectionId: string): Promise<InventorySyncResult> {
  const [c] = await db.select().from(integrationConnections).where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.orgId, orgId)));
  if (!c) throw new IntegrationError('Connection not found.', 'not_found', 404);
  if (c.status !== 'connected') throw new IntegrationError('This connection is not active.', 'forbidden', 409);
  let provider;
  if (c.provider === 'dev_inventory') provider = new DevInventoryProvider((c.meta['simulatedInventory'] as SimulatedRow[] | undefined) ?? []);
  else if (c.provider === 'shopify' && c.shopDomain) provider = new ShopifyInventoryProvider(c.shopDomain, svc.config.SHOPIFY_API_VERSION, () => getShopifyAccessToken(svc, c.id));
  else throw new IntegrationError('Unsupported inventory provider.', 'invalid');
  try {
    const items = await provider.listInventory();
    const result = await applyInventory(svc, db, { orgId, connectionId, items, simulated: provider.simulated });
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

export async function confirmSocialAccount(db: DbLike, orgId: string, userId: string, accountId: string, confirmed: boolean) {
  const [r] = await db.update(socialAccounts).set({ confirmed, confirmedBy: confirmed ? userId : null }).where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.orgId, orgId))).returning();
  if (!r) throw new IntegrationError('Account not found.', 'not_found', 404);
  return r;
}

export async function addSocialAccount(db: DbLike, orgId: string, userId: string, p: { siteId: string; platform: 'facebook' | 'instagram' | 'youtube'; handle: string; url?: string }) {
  const [site] = await db.select().from(sites).where(and(eq(sites.id, p.siteId), eq(sites.orgId, orgId)));
  if (!site) throw new IntegrationError('Website not found.', 'not_found', 404);
  const [row] = await db
    .insert(socialAccounts)
    .values({ orgId, siteId: p.siteId, platform: p.platform, handle: p.handle.trim(), url: p.url ?? null, discoveredFrom: 'manual', confirmed: true, confirmedBy: userId })
    .onConflictDoUpdate({ target: [socialAccounts.siteId, socialAccounts.platform, socialAccounts.handle], set: { confirmed: true, confirmedBy: userId } })
    .returning();
  return row!;
}
