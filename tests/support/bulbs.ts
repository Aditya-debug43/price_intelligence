import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.ts';
import { products, variants } from '@ci/database';
import type { GeminiHttp } from '@ci/connectors';
import { createOrganization } from '@ci/services';
import { createHarness, type Harness } from './harness.ts';
import { ApiClient } from './api-client.ts';
import { signUp } from './auth.ts';

/**
 * Support for the automatic-matching tests: a workspace with your shop and one or two competitor websites whose catalogues are SEEDED directly (so a test controls every title, option, code and
 * quantity), and an imitation of the Gemini API that answers from a table of verdicts, can be told to fail, and records which key sent each request. No test reaches Google.
 */

export const KEY1 = 'test-key-one-not-real-0123456789abcdef';
export const KEY2 = 'test-key-two-not-real-fedcba9876543210';

export interface Bulbs {
  h: Harness;
  app: FastifyInstance;
  owner: ApiClient;
  org: string;
  userId: string;
  sites: { source: string; woo: string; extra?: string };
  base: string;
  db: Harness['db']['worker'];
  seed(site: 'source' | 'woo' | 'extra', title: string, o?: SeedOptions): Promise<Seeded>;
  /** Another workspace (organisation) on the same server, with its own shop and competitor websites. */
  workspace(name: string, competitors?: 1 | 2): Promise<Bulbs>;
  close(): Promise<void>;
}

export interface SeedOptions {
  brand?: string;
  /** The selected option of the variant (e.g. a bulb code). */
  option?: string;
  price?: number;
  gtin?: string | null;
  qty?: [kind: string, total: number, label: string];
  category?: string;
}

export interface Seeded {
  productId: string;
  variantId: string;
  title: string;
  siteId: string;
}

let counter = 0;

async function workspace(h: Harness, app: FastifyInstance, owner: ApiClient, userId: string, name: string, competitors: 1 | 2): Promise<Bulbs> {
  const org = (await createOrganization(h.db.app, userId, name)).id;
  const base = `/api/v1/orgs/${org}`;
  const sites: Bulbs['sites'] = { source: '', woo: '' };
  const wanted: [keyof Bulbs['sites'], string, 'source' | 'competitor'][] = [['source', 'source', 'source'], ['woo', 'woo', 'competitor'], ...(competitors === 2 ? ([['extra', 'jsonld', 'competitor']] as [keyof Bulbs['sites'], string, 'source' | 'competitor'][]) : [])];
  for (const [key, fixture, role] of wanted) {
    const id = (await owner.post(`${base}/sites`, { url: h.fixtures.origin(fixture), role, name: `${key} shop` })).body.site.id as string;
    await owner.post(`${base}/sites/${id}/consent`, { status: 'confirmed', attest: true });
    sites[key] = id;
  }
  const db = h.db.worker;
  const seed: Bulbs['seed'] = async (site, title, o = {}) => {
    const siteId = sites[site]!;
    const slug = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${counter++}`;
    const url = `${h.fixtures.origin(site === 'source' ? 'source' : site === 'woo' ? 'woo' : 'jsonld')}/product/${slug}`;
    const [p] = await db.insert(products).values({ orgId: org, siteId, canonicalUrl: url, title, brand: o.brand ?? null, category: o.category ?? 'Car bulbs', attrs: {}, extractionMethod: 'test', extractionVersion: 'test' }).returning();
    const now = h.svc.clock();
    const [v] = await db.insert(variants).values({
      orgId: org, siteId, productId: p!.id, variantKey: o.option ?? 'default', title: o.option ?? 'Default Title', options: o.option ? { Bulb: o.option } : {}, availability: 'in_stock', url,
      price: o.price ?? 20, currency: 'USD', observedAt: now, gtin: o.gtin ?? null, qtyKind: o.qty?.[0] ?? null, qtyTotal: o.qty?.[1] ?? null, qtyLabel: o.qty?.[2] ?? null,
    }).returning();
    return { productId: p!.id, variantId: v!.id, title, siteId };
  };
  return {
    h, app, owner, org, userId, sites, base, db, seed,
    workspace: (n, c = 1) => workspace(h, app, owner, userId, n, c),
    close: async () => { await app.close(); await h.close(); },
  };
}

export async function createBulbs(opts: { env?: Record<string, string>; competitors?: 1 | 2; now?: string } = {}): Promise<Bulbs> {
  const h = await createHarness({ now: opts.now ?? '2026-11-04T12:00:00Z', extraEnv: { GEMINI_API_KEY: KEY1, GEMINI_RPM: '600', GEMINI_TPM: '100000000', GEMINI_MAX_CONCURRENCY: '1', ...(opts.env ?? {}) } });
  const app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  const owner = new ApiClient(app);
  await signUp(owner, h, { email: `bulbs-${Date.now()}-${counter++}@example.test`, password: 'Correct-Horse-9-Battery', displayName: 'Owner' });
  const userId = (await owner.get('/api/v1/auth/me')).body.user.id as string;
  return workspace(h, app, owner, userId, 'Bulbs', opts.competitors ?? 1);
}

// ── the imitation Gemini ──────────────────────────────────────────────────────────────────────────────────────────

type Wire = { t: string };
export interface Imitation {
  /** (source title | candidate title) → the model's verdict; anything else: no suitable match. */
  verdicts: Record<string, string>;
  /** Called before each request is answered; return a response to replace the normal answer (a failure, a quota answer). */
  intercept: ((call: { index: number; key: string; pairs: string[] }) => { status: number; json: unknown } | null) | null;
  handler: GeminiHttp;
  /** Every pair "source|candidate" asked about, in order, with the key that sent it. */
  asked: { pair: string; key: string }[];
}

export const okResponse = (decisions: unknown[]) => ({
  status: 200,
  json: { candidates: [{ content: { parts: [{ text: JSON.stringify({ decisions }) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 110 * Math.max(1, decisions.length), totalTokenCount: 1200 + 110 * Math.max(1, decisions.length) } },
});

export const quotaResponse = (kind: 'day' | 'minute', retry = '30s') => ({
  status: 429,
  json: {
    error: {
      code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: kind === 'day' ? 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' : 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaValue: kind === 'day' ? '1500' : '15' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: retry },
      ],
    },
  },
});

export function imitation(): Imitation {
  const im: Imitation = {
    verdicts: {},
    intercept: null,
    asked: [],
    handler: async (_url, init) => {
      const key = init.headers['x-goog-api-key'] ?? '';
      const req = JSON.parse(init.body!) as { contents: { parts: { text: string }[] }[] };
      const payload = JSON.parse(req.contents[0]!.parts[0]!.text) as { groups: { s: Wire; c: (Wire & { id: string })[] }[] };
      const pairs = payload.groups.flatMap((g) => g.c.map((c) => `${g.s.t}|${c.t}`));
      const index = im.asked.length;
      const forced = im.intercept?.({ index, key, pairs }) ?? null;
      if (forced) return forced;
      for (const p of pairs) im.asked.push({ pair: p, key });
      return okResponse(payload.groups.flatMap((g) => g.c.map((c) => {
        const type = im.verdicts[`${g.s.t}|${c.t}`] ?? 'no_match_uncertain';
        return { id: c.id, type, conf: 'high', for: type === 'no_match_uncertain' ? [] : [{ a: 'title', s: g.s.t, c: c.t }], against: [], missing: [], why: `${g.s.t} against ${c.t}`, price_ok: type === 'exact_item', review: false };
      })));
    },
  };
  return im;
}

export const titleOf = async (db: Bulbs['db'], variantId: string): Promise<string> => {
  const [r] = await db.select({ t: products.title }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(eq(variants.id, variantId));
  return r!.t;
};
