import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { alerts, auditEvents, integrationConnections, oauthStates, stockStates, variants } from '@ci/database';
import { decryptSecret } from '@ci/core';
import { IntegrationError, completeShopifyOAuth, disconnectIntegration, integrationOverview, runInventorySync, startScan, startShopifyOAuth } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';

/**
 * The whole Shopify connect flow — authorize URL, signed callback, token exchange, first sync, token refresh, a refresh that
 * Shopify refuses, and disconnect — run against a local imitation of Shopify's endpoints (global fetch is intercepted for
 * *.myshopify.com). This verifies OUR side of the integration; it is not a test against a real store or Shopify itself.
 */
const SECRET = 'shopify-test-secret';
const SHOP = 'demo-shop.myshopify.com';
const GOOD_CODE = 'good-code';

interface ShopState {
  gen: number;
  failRefresh: boolean;
  revoked: boolean;
  calls: { method: string; path: string }[];
  /** Items the imitation returns from GraphQL: sku → quantity (null = untracked). */
  inventory: { sku: string; qty: number | null }[];
}
const shop: ShopState = { gen: 1, failRefresh: false, revoked: false, calls: [], inventory: [] };
const access = () => `shpat_gen${shop.gen}`;
const refresh = () => `shprt_gen${shop.gen}`;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function shopifyFetch(realFetch: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
    if (!url.hostname.endsWith('.myshopify.com')) return realFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    shop.calls.push({ method, path: url.pathname });
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (url.pathname === '/admin/oauth/access_token') {
      if (body['client_id'] !== 'cid' || body['client_secret'] !== SECRET) return json(401, { error: 'invalid_client' });
      if (body['grant_type'] === 'refresh_token') {
        if (shop.failRefresh || body['refresh_token'] !== refresh()) return json(400, { error: 'invalid_grant' });
        shop.gen += 1;
      } else if (body['code'] !== GOOD_CODE) return json(400, { error: 'invalid_request' });
      return json(200, { access_token: access(), scope: 'read_products,read_inventory,read_locations', expires_in: 3600, refresh_token: refresh(), refresh_token_expires_in: 7_776_000 });
    }
    if (url.pathname === '/admin/api_permissions/current.json' && method === 'DELETE') {
      if (headers.get('x-shopify-access-token') !== access()) return json(401, {});
      shop.revoked = true;
      return new Response(null, { status: 200 });
    }
    if (url.pathname.endsWith('/graphql.json')) {
      if (headers.get('x-shopify-access-token') !== access()) return json(401, { errors: 'Invalid API key or access token' });
      return json(200, {
        data: {
          productVariants: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: shop.inventory.map((i, n) => ({
              id: `gid://shopify/ProductVariant/${n}`,
              sku: i.sku,
              title: 'Default Title',
              product: { title: `Product ${i.sku}` },
              inventoryItem: { tracked: i.qty !== null, inventoryLevels: { nodes: [{ location: { id: 'gid://shopify/Location/1', name: 'Shop floor' }, quantities: [{ name: 'available', quantity: i.qty ?? 0 }] }] } },
            })),
          },
        },
      });
    }
    return json(404, {});
  }) as typeof fetch;
}

let h: Harness;
let t: Tenant;
let other: Tenant;
let sourceId: string;
const rootDb = () => h.db.app;
const connRow = async (id: string) => (await h.db.worker.select().from(integrationConnections).where(eq(integrationConnections.id, id)))[0]!;

function signedCallback(state: string, over: Record<string, string> = {}): Record<string, string> {
  const q: Record<string, string> = { code: GOOD_CODE, shop: SHOP, state, timestamp: '1791990000', ...over };
  const { hmac: _ignore, ...rest } = q;
  const msg = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join('&');
  return { ...q, hmac: createHmac('sha256', SECRET).update(msg).digest('hex') };
}
const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

beforeAll(async () => {
  vi.stubGlobal('fetch', shopifyFetch(globalThis.fetch));
  h = await createHarness({ extraEnv: { SHOPIFY_CLIENT_ID: 'cid', SHOPIFY_CLIENT_SECRET: SECRET, SHOPIFY_REDIRECT_URI: 'http://localhost:4000/api/v1/integrations/shopify/callback' } });
  t = await h.newTenant('Shop');
  other = await h.newTenant('Other');
  sourceId = await t.addFixtureSite('source', 'source');
  await t.tx((tx) => startScan(h.svc, tx, t.orgId, sourceId, { kind: 'discovery', trigger: 'manual' }));
  await h.queue.drain();
  const src = h.fixtures.sites.source!;
  shop.inventory = [
    { sku: src.find(1)!.sku, qty: 4 }, // at/below the default threshold of 5
    { sku: src.find(2)!.sku, qty: 30 },
    { sku: src.find(3)!.sku, qty: null }, // the merchant does not track this item
    { sku: 'NOT-IN-THE-SHOP', qty: 7 },
  ];
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await h.close();
});

describe('connecting a Shopify store (read-only inventory)', () => {
  let connectionId = '';

  it('builds a read-only authorize URL, and refuses anything that is not a myshopify.com address', async () => {
    const { url } = await startShopifyOAuth(h.svc, rootDb(), t.orgId, t.userId, SHOP, sourceId);
    const u = new URL(url);
    expect(u.origin).toBe(`https://${SHOP}`);
    expect(u.pathname).toBe('/admin/oauth/authorize');
    expect(u.searchParams.get('scope')).toBe('read_products,read_inventory,read_locations');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('state')).toMatch(/^[\w-]{20,}$/);
    await expect(startShopifyOAuth(h.svc, rootDb(), t.orgId, t.userId, 'evil.example.com/x', sourceId)).rejects.toBeInstanceOf(IntegrationError);
  });

  it('rejects a callback that is unsigned, tampered, from another user, for another shop, or replayed', async () => {
    const { url } = await startShopifyOAuth(h.svc, rootDb(), t.orgId, t.userId, SHOP, sourceId);
    const state = stateOf(url);
    const q = signedCallback(state);

    await expect(completeShopifyOAuth(h.svc, rootDb(), t.userId, { ...q, hmac: 'deadbeef' })).rejects.toThrow(/could not be verified/);
    await expect(completeShopifyOAuth(h.svc, rootDb(), t.userId, { ...q, code: 'other-code' })).rejects.toThrow(/could not be verified/); // tampered after signing
    await expect(completeShopifyOAuth(h.svc, rootDb(), other.userId, q)).rejects.toThrow(/expired or does not belong to you/);
    await expect(completeShopifyOAuth(h.svc, rootDb(), t.userId, signedCallback(state, { shop: 'another-shop.myshopify.com' }))).rejects.toThrow(/expired or does not belong to you/);
    expect(await h.db.worker.select().from(integrationConnections).where(eq(integrationConnections.orgId, t.orgId))).toHaveLength(0); // nothing was connected
    const [st] = await h.db.worker.select().from(oauthStates).where(eq(oauthStates.state, state));
    expect(st!.usedAt).toBeNull(); // the failed attempts did not burn the legitimate state
  });

  it('connects: exchanges the code, stores ENCRYPTED expiring tokens, and queues the first inventory sync', async () => {
    const { url } = await startShopifyOAuth(h.svc, rootDb(), t.orgId, t.userId, SHOP, sourceId);
    const q = signedCallback(stateOf(url));
    const r = await completeShopifyOAuth(h.svc, rootDb(), t.userId, q);
    connectionId = r.connectionId;
    expect(r.orgId).toBe(t.orgId);

    const c = await connRow(connectionId);
    expect(c).toMatchObject({ provider: 'shopify', status: 'connected', shopDomain: SHOP, scopes: 'read_products,read_inventory,read_locations', isSimulated: false });
    expect(c.accessTokenEnc).toMatch(/^v1\./);
    expect(c.accessTokenEnc).not.toContain('shpat_');
    expect(decryptSecret(c.accessTokenEnc!, h.svc.keyRing!)).toBe('shpat_gen1');
    expect(decryptSecret(c.refreshTokenEnc!, h.svc.keyRing!)).toBe('shprt_gen1');
    expect(c.accessTokenExpiresAt!.getTime() - h.svc.clock().getTime()).toBe(3_600_000);

    await expect(completeShopifyOAuth(h.svc, rootDb(), t.userId, q)).rejects.toThrow(/expired or does not belong to you/); // single use
    // never exposed back to the browser or written to the audit trail
    const overview = JSON.stringify(await t.tx((tx) => integrationOverview(h.svc, tx, t.orgId)));
    expect(overview).not.toMatch(/shpat_|shprt_|accessTokenEnc|refreshTokenEnc/);
    const audit = JSON.stringify(await h.db.worker.select().from(auditEvents).where(eq(auditEvents.orgId, t.orgId)));
    expect(audit).not.toMatch(/shpat_|shprt_/);
    expect(audit).toContain('integration.shopify.connected');
  });

  it('the first sync (queued by the callback) applies real quantities, alerts once, reports unmatched SKUs and skips untracked items', async () => {
    await h.queue.drain(); // runs the queued sync-inventory job
    const src = h.fixtures.sites.source!;
    const variantOf = async (item: number) => (await h.db.worker.select().from(variants).where(and(eq(variants.siteId, sourceId), eq(variants.sku, src.find(item)!.sku))))[0]!;
    const low = (await h.db.worker.select().from(stockStates).where(eq(stockStates.variantId, (await variantOf(1)).id)))[0]!;
    expect(low).toMatchObject({ state: 'low_stock', quantity: 4, quantitySource: 'authorised_inventory' });
    expect((await h.db.worker.select().from(stockStates).where(eq(stockStates.variantId, (await variantOf(2)).id)))[0]).toMatchObject({ state: 'in_stock', quantity: 30, quantitySource: 'authorised_inventory' });
    const untracked = (await h.db.worker.select().from(stockStates).where(eq(stockStates.variantId, (await variantOf(3)).id)))[0];
    expect(untracked?.quantity ?? null).toBeNull(); // unknown, never zero

    const lowAlerts = await h.db.worker.select().from(alerts).where(and(eq(alerts.orgId, t.orgId), eq(alerts.type, 'low_stock')));
    expect(lowAlerts).toHaveLength(1);
    expect((lowAlerts[0]!.data as { quantitySource?: string }).quantitySource).toBe('authorised_inventory');

    const again = await t.tx((tx) => runInventorySync(h.svc, tx, t.orgId, connectionId));
    expect(again.unmatchedSkus).toEqual(['NOT-IN-THE-SHOP']);
    expect(again.untracked).toBe(1);
    expect(await h.db.worker.select().from(alerts).where(and(eq(alerts.orgId, t.orgId), eq(alerts.type, 'low_stock')))).toHaveLength(1); // no duplicate
    expect((await connRow(connectionId)).lastSyncAt).not.toBeNull();
  });

  it('refreshes the expiring token when it is about to expire, and stores the NEW pair', async () => {
    h.advance(2 * 3_600_000); // the 1 h access token has lapsed
    await t.tx((tx) => runInventorySync(h.svc, tx, t.orgId, connectionId));
    expect(shop.gen).toBe(2);
    const c = await connRow(connectionId);
    expect(decryptSecret(c.accessTokenEnc!, h.svc.keyRing!)).toBe('shpat_gen2');
    expect(decryptSecret(c.refreshTokenEnc!, h.svc.keyRing!)).toBe('shprt_gen2');
    expect(c.status).toBe('connected');
  });

  it('when Shopify refuses the refresh (revoked or expired grant) the connection says the store must be reconnected', async () => {
    shop.failRefresh = true;
    h.advance(2 * 3_600_000);
    // Called the way the worker job calls it (on the worker connection, not inside a transaction that would roll the failure record back).
    await expect(runInventorySync(h.svc, h.db.worker, t.orgId, connectionId)).rejects.toThrow(/reconnect|no longer valid/i);
    const c = await connRow(connectionId);
    expect(c.status).toBe('error');
    expect(c.lastError).toMatch(/reconnect|no longer valid/i);
    const issue = await h.db.worker.select().from(alerts).where(and(eq(alerts.orgId, t.orgId), eq(alerts.type, 'integration_issue')));
    expect(issue.length).toBeGreaterThan(0);
    expect(issue[0]!.body).toMatch(/Reconnect the store/);
    await expect(runInventorySync(h.svc, h.db.worker, t.orgId, connectionId)).rejects.toThrow(/not active/); // no further attempts until reconnected
  });

  it('disconnecting revokes access at Shopify and wipes the stored tokens locally', async () => {
    shop.failRefresh = false;
    // Reconnect first (a fresh authorization after the failure), then disconnect.
    const { url } = await startShopifyOAuth(h.svc, rootDb(), t.orgId, t.userId, SHOP, sourceId);
    const r = await completeShopifyOAuth(h.svc, rootDb(), t.userId, signedCallback(stateOf(url)));
    await h.queue.drain();
    expect((await connRow(r.connectionId)).status).toBe('connected');

    const out = await t.tx((tx) => disconnectIntegration(h.svc, tx, t.orgId, t.userId, r.connectionId));
    expect(out.revokedRemotely).toBe(true);
    expect(shop.revoked).toBe(true);
    expect(await connRow(r.connectionId)).toMatchObject({ status: 'revoked', accessTokenEnc: null, refreshTokenEnc: null });
    await expect(t.tx((tx) => runInventorySync(h.svc, tx, t.orgId, r.connectionId))).rejects.toThrow(/not active/);
  });

  it('another workspace can neither see nor sync this store connection', async () => {
    const mine = (await h.db.worker.select().from(integrationConnections).where(eq(integrationConnections.orgId, t.orgId)))[0]!;
    expect((await other.tx((tx) => integrationOverview(h.svc, tx, other.orgId))).connections).toHaveLength(0);
    await expect(other.tx((tx) => runInventorySync(h.svc, tx, other.orgId, mine.id))).rejects.toThrow(/not found/i);
  });
});
