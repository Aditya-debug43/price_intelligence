import { isValidShopDomain } from '@ci/core';

/**
 * Authorised, read-only inventory access for the customer's OWN shop.
 *  - Shopify: OAuth authorization-code flow with expiring offline tokens (mandatory for all public apps from
 *    2027-01-01), scopes limited to read_products, read_inventory, read_locations. GraphQL Admin API.
 *  - Dev/simulated: a clearly-labelled in-database simulator used to exercise the alert workflow without a live store.
 * Nothing in this file writes to the merchant's store.
 */

export interface InventoryLevelRecord {
  locationId: string;
  locationName: string;
  /** Available units at the location; null when the item is not tracked there. */
  available: number | null;
}

export interface InventoryItemRecord {
  externalVariantId: string;
  sku: string | null;
  productTitle: string;
  variantTitle: string | null;
  /** False => the merchant does not track inventory for this item (quantity is NOT zero, it is unknown). */
  tracked: boolean;
  levels: InventoryLevelRecord[];
}

export interface InventoryProvider {
  readonly id: 'shopify' | 'dev_inventory';
  readonly simulated: boolean;
  listInventory(): Promise<InventoryItemRecord[]>;
}

// ───────────────────────────────────────────────────────── Shopify OAuth

export interface ShopifyAppConfig {
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
  apiVersion: string;
}

export function buildShopifyAuthorizeUrl(cfg: ShopifyAppConfig, shop: string, state: string): string {
  if (!isValidShopDomain(shop)) throw new Error('Invalid Shopify shop domain');
  const u = new URL(`https://${shop}/admin/oauth/authorize`);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('scope', cfg.scopes);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('state', state);
  return u.toString();
}

export interface ShopifyTokenSet {
  accessToken: string;
  refreshToken: string | null;
  scope: string;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
}

type PostJson = (url: string, body: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: Record<string, unknown> }>;

const defaultPost: PostJson = async (url, body, headers) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...(headers ?? {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty body */
  }
  return { status: res.status, json };
};

function toTokenSet(json: Record<string, unknown>, now: Date): ShopifyTokenSet {
  const expiresIn = Number(json['expires_in'] ?? NaN);
  const refreshIn = Number(json['refresh_token_expires_in'] ?? NaN);
  return {
    accessToken: String(json['access_token'] ?? ''),
    refreshToken: typeof json['refresh_token'] === 'string' ? json['refresh_token'] : null,
    scope: String(json['scope'] ?? ''),
    accessTokenExpiresAt: Number.isFinite(expiresIn) ? new Date(now.getTime() + expiresIn * 1000) : null,
    refreshTokenExpiresAt: Number.isFinite(refreshIn) ? new Date(now.getTime() + refreshIn * 1000) : null,
  };
}

/** Exchange the authorization code for an EXPIRING offline token (`expiring=1`) with a refresh token. */
export async function exchangeShopifyCode(cfg: ShopifyAppConfig, shop: string, code: string, post: PostJson = defaultPost, now = new Date()): Promise<ShopifyTokenSet> {
  if (!isValidShopDomain(shop)) throw new Error('Invalid Shopify shop domain');
  const r = await post(`https://${shop}/admin/oauth/access_token`, { client_id: cfg.clientId, client_secret: cfg.clientSecret, code, expiring: 1 });
  if (r.status !== 200 || !r.json['access_token']) throw new Error(`Shopify rejected the authorization code (HTTP ${r.status})`);
  return toTokenSet(r.json, now);
}

/** Refresh an expiring token. Each refresh issues a new token pair that MUST be stored atomically. */
export async function refreshShopifyToken(cfg: ShopifyAppConfig, shop: string, refreshToken: string, post: PostJson = defaultPost, now = new Date()): Promise<ShopifyTokenSet> {
  if (!isValidShopDomain(shop)) throw new Error('Invalid Shopify shop domain');
  const r = await post(`https://${shop}/admin/oauth/access_token`, { client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken });
  if (r.status !== 200 || !r.json['access_token']) {
    const err = new Error(r.json['error'] === 'invalid_grant' ? 'The Shopify refresh token is no longer valid; the store owner must reconnect' : `Shopify token refresh failed (HTTP ${r.status})`);
    (err as Error & { code?: string }).code = r.json['error'] === 'invalid_grant' ? 'reauthorize' : 'refresh_failed';
    throw err;
  }
  return toTokenSet(r.json, now);
}

/** Best-effort revocation: removes this app's access on the merchant side. Local deletion happens regardless. */
export async function revokeShopifyAccess(shop: string, accessToken: string): Promise<boolean> {
  if (!isValidShopDomain(shop)) return false;
  try {
    const res = await fetch(`https://${shop}/admin/api_permissions/current.json`, { method: 'DELETE', headers: { 'x-shopify-access-token': accessToken }, signal: AbortSignal.timeout(15_000) });
    return res.status === 200 || res.status === 204;
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────────────── Shopify GraphQL Admin read-only inventory

const INVENTORY_QUERY = /* GraphQL */ `
  query ReadInventory($cursor: String) {
    productVariants(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        sku
        title
        product { title }
        inventoryItem {
          tracked
          inventoryLevels(first: 5) {
            nodes {
              location { id name }
              quantities(names: ["available"]) { name quantity }
            }
          }
        }
      }
    }
  }`;

type Gql = (query: string, variables: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> }>;

export class ShopifyInventoryProvider implements InventoryProvider {
  readonly id = 'shopify' as const;
  readonly simulated = false;

  constructor(
    private readonly shop: string,
    private readonly apiVersion: string,
    private readonly getAccessToken: () => Promise<string>,
    private readonly gql?: Gql,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!isValidShopDomain(shop)) throw new Error('Invalid Shopify shop domain');
  }

  private async call(query: string, variables: Record<string, unknown>) {
    if (this.gql) return this.gql(query, variables);
    const token = await this.getAccessToken();
    const res = await fetch(`https://${this.shop}/admin/api/${this.apiVersion}/graphql.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    return { status: res.status, json };
  }

  async listInventory(): Promise<InventoryItemRecord[]> {
    const items: InventoryItemRecord[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 400; page++) {
      let r = await this.call(INVENTORY_QUERY, { cursor });
      // Cost-based throttling: back off and retry when Shopify reports THROTTLED.
      for (let attempt = 0; attempt < 4 && JSON.stringify(r.json['errors'] ?? '').includes('THROTTLED'); attempt++) {
        await this.sleep(1000 * 2 ** attempt);
        r = await this.call(INVENTORY_QUERY, { cursor });
      }
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Shopify rejected the access token (revoked or insufficient scope)'), { code: 'unauthorized' });
      if (r.status !== 200 || r.json['errors']) throw Object.assign(new Error(`Shopify GraphQL error: ${JSON.stringify(r.json['errors'] ?? r.status).slice(0, 300)}`), { code: 'graphql_error' });
      const data = (r.json['data'] as { productVariants?: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: unknown[] } } | undefined)?.productVariants;
      if (!data) break;
      for (const n of data.nodes as {
        id: string; sku?: string | null; title?: string; product?: { title?: string };
        inventoryItem?: { tracked?: boolean; inventoryLevels?: { nodes: { location: { id: string; name: string }; quantities: { name: string; quantity: number }[] }[] } };
      }[]) {
        const tracked = n.inventoryItem?.tracked === true;
        items.push({
          externalVariantId: n.id,
          sku: n.sku?.trim() || null,
          productTitle: n.product?.title ?? '',
          variantTitle: n.title && n.title !== 'Default Title' ? n.title : null,
          tracked,
          levels: (n.inventoryItem?.inventoryLevels?.nodes ?? []).map((l) => ({
            locationId: l.location.id,
            locationName: l.location.name,
            available: tracked ? (l.quantities.find((q) => q.name === 'available')?.quantity ?? null) : null,
          })),
        });
      }
      if (!data.pageInfo.hasNextPage) break;
      cursor = data.pageInfo.endCursor;
    }
    return items;
  }
}

// ───────────────────────────────────────────────────────── development simulator

export interface SimulatedRow {
  sku: string;
  productTitle: string;
  variantTitle?: string | null;
  tracked?: boolean;
  levels: { locationId: string; locationName: string; available: number | null }[];
}

/** Reads rows held in the connection's metadata. Always labelled SIMULATED in every UI and report. */
export class DevInventoryProvider implements InventoryProvider {
  readonly id = 'dev_inventory' as const;
  readonly simulated = true;
  constructor(private readonly rows: SimulatedRow[]) {}
  async listInventory(): Promise<InventoryItemRecord[]> {
    return this.rows.map((r) => ({
      externalVariantId: `sim:${r.sku}`,
      sku: r.sku,
      productTitle: r.productTitle,
      variantTitle: r.variantTitle ?? null,
      tracked: r.tracked ?? true,
      levels: r.levels,
    }));
  }
}
