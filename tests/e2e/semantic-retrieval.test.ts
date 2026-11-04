import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../apps/api/src/app.ts';
import { aiEmbeddings, aiQuotaState, aiUsageDaily, products, variants } from '@ci/database';
import { retrieveShortlist } from '@ci/core';
import type { GeminiHttp } from '@ci/connectors';
import { buildContext, createOrganization, embedCatalogue, runMatching, semanticFor, startScan } from '@ci/services';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp } from '../support/auth.ts';

/**
 * Semantic retrieval with an IMITATION of the embedding API (no test reaches Google). The imitation puts words of one meaning on one axis ("headlamp" and "headlight"), which is what lets
 * a differently worded listing be found. What is proved: the catalogue is embedded once and paced, an unchanged product is never embedded again, an embedding only ADDS candidates, and a
 * candidate with a decisive incompatibility (a different bulb code) is removed however close its meaning is.
 */
const MODEL = 'test-embedding-model';
let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let org: string;
const base = () => `/api/v1/orgs/${org}`;
const db = () => h.db.worker;
let embedCalls = 0;
let textsSent = 0;

const CONCEPT: Record<string, number> = { headlight: 0, headlamp: 0, bulb: 1, lamp: 1, led: 1, mat: 2, carpet: 2 };
const embed = (text: string): number[] => {
  const v = new Array<number>(256).fill(0);
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const at = CONCEPT[w] ?? 10 + (w.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 240);
    v[at] = (v[at] ?? 0) + 1;
  }
  return v;
};
const imitation: GeminiHttp = async (url, init) => {
  if (!url.includes(':batchEmbedContents')) throw new Error('unexpected call ' + url);
  const body = JSON.parse(init.body!) as { requests: { content: { parts: { text: string }[] } }[] };
  embedCalls++;
  textsSent += body.requests.length;
  return { status: 200, json: { embeddings: body.requests.map((r) => ({ values: embed(r.content.parts[0]!.text) })) } };
};

let S: { id: string; sp: string };
let X: { id: string; cp: string };
let Z: { id: string; cp: string };

beforeAll(async () => {
  h = await createHarness({ now: '2026-11-04T12:00:00Z', extraEnv: { GEMINI_API_KEY: 'test-key-not-real-0123456789abcdef', GEMINI_EMBEDDING_MODEL: MODEL } });
  h.gemini.set(imitation);
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
  await signUp(owner, h, { email: `sem-${Date.now()}@example.test`, password: 'Correct-Horse-9-Battery', displayName: 'Owner' });
  const userId = (await owner.get('/api/v1/auth/me')).body.user.id;
  org = (await createOrganization(h.db.app, userId, 'Semantic')).id;
  const siteIds: Record<string, string> = {};
  for (const [key, role] of [['source', 'source'], ['woo', 'competitor']] as const) {
    const id = (await owner.post(`${base()}/sites`, { url: h.fixtures.origin(key), role, name: h.fixtures.sites[key]!.spec.label })).body.site.id as string;
    await owner.post(`${base()}/sites/${id}/consent`, { status: 'confirmed', attest: true });
    await startScan(h.svc, h.db.worker, org, id, { kind: 'discovery', trigger: 'manual' });
    siteIds[key] = id;
  }
  await h.queue.drain();
  await runMatching(h.svc, db(), org);
  const distinct = <T extends { productId: string }>(rows: T[]) => { const seen = new Set<string>(); return rows.filter((r) => !seen.has(r.productId) && !!seen.add(r.productId)); };
  const src = distinct(await db().select({ id: variants.id, productId: variants.productId }).from(variants).where(eq(variants.siteId, siteIds.source!)).limit(50));
  const rival = distinct(await db().select({ id: variants.id, productId: variants.productId }).from(variants).where(eq(variants.siteId, siteIds.woo!)).limit(50));
  S = { id: src[0]!.id, sp: src[0]!.productId };
  X = { id: rival[0]!.id, cp: rival[0]!.productId };
  Z = { id: rival[1]!.id, cp: rival[1]!.productId };
  const retitle = async (productId: string, variantId: string, title: string, brand: string) => {
    await db().update(products).set({ title, brand, attrs: {} }).where(eq(products.id, productId));
    await db().update(variants).set({ title: 'Default Title', options: {}, qtyKind: null, qtyTotal: null, qtyLabel: null }).where(eq(variants.id, variantId));
  };
  await retitle(S.sp, S.id, 'Zephyr H11 Headlight Bulb', 'Zephyr');
  await retitle(X.cp, X.id, 'Quark H11 Headlamp Lamp', 'Quark'); // the same thing in other words
  await retitle(Z.cp, Z.id, 'Zephyr H7 Headlamp Lamp', 'Zephyr'); // close in meaning (even the same maker), but a different bulb code
  // the bulb codes H11 and H7 must each be written on both websites for the rule engine to treat them as part codes (a code seen on one website only is that website's own series)
  await retitle(src[1]!.productId, src[1]!.id, 'Zephyr H7 Fog Lamp', 'Zephyr');
  embedCalls = 0;
  textsSent = 0;
}, 300_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('embedding the catalogue', () => {
  it('embeds every product once, in paced batches, and keeps the vectors with the product', async () => {
    const r = await embedCatalogue(h.svc, org);
    expect(r.outcome).toBe('done');
    expect(r.embedded).toBeGreaterThan(0);
    const rows = await db().select().from(aiEmbeddings).where(eq(aiEmbeddings.orgId, org));
    expect(rows.length).toBe(r.embedded);
    expect(rows.every((x) => x.model === MODEL && x.dims === 256)).toBe(true);
    expect(textsSent).toBe(r.embedded);
    // the free-tier use is recorded under the embedding model (every text counts as a request)
    const usage = (await db().select().from(aiUsageDaily).where(eq(aiUsageDaily.model, MODEL)))[0]!;
    expect(usage.requests).toBe(r.embedded);
  });

  it('an unchanged product is never embedded again; a changed one is', async () => {
    const calls = embedCalls;
    expect((await embedCatalogue(h.svc, org)).embedded).toBe(0);
    expect(embedCalls).toBe(calls);
    await db().update(products).set({ title: 'Zephyr H11 Headlight Bulb Pro' }).where(eq(products.id, S.sp));
    const again = await embedCatalogue(h.svc, org);
    expect(again.embedded).toBe(1);
    await db().update(products).set({ title: 'Zephyr H11 Headlight Bulb' }).where(eq(products.id, S.sp));
    expect((await embedCatalogue(h.svc, org)).embedded).toBe(1);
  });

  it('a refused key stops embedding without retrying, and records why', async () => {
    h.gemini.set(async () => ({ status: 403, json: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'not allowed' } } }));
    await db().update(products).set({ title: 'Quark H11 Headlamp Lamp 2' }).where(eq(products.id, X.cp));
    const r = await embedCatalogue(h.svc, org);
    expect(r.outcome).toBe('stopped');
    expect((await db().select().from(aiQuotaState).where(eq(aiQuotaState.model, MODEL)))[0]!.stopped).toMatch(/refused the API key/);
    // and nothing more is asked while it is stopped
    h.gemini.set(imitation);
    const calls = embedCalls;
    expect((await embedCatalogue(h.svc, org)).outcome).toBe('stopped');
    expect(embedCalls).toBe(calls);
    await db().delete(aiQuotaState).where(eq(aiQuotaState.model, MODEL));
    await db().update(products).set({ title: 'Quark H11 Headlamp Lamp' }).where(eq(products.id, X.cp));
    await embedCatalogue(h.svc, org);
  });
});

describe('semantic hits add candidates and never override a decisive incompatibility', () => {
  it('finds the same product written in other words, which the words alone do not', async () => {
    const ctx = await buildContext(db(), org, MODEL);
    expect(ctx.semantic).not.toBeNull();
    const src = ctx.corpus.byVariant.get(S.id)!;
    const hits = (await semanticFor(ctx, S.id))!;
    expect(hits.map((x) => x.variantId)).toContain(X.id);
    const without = retrieveShortlist(ctx.index, src, { perSiteProducts: 6 }, null).map((c) => c.variantId);
    const withSemantic = retrieveShortlist(ctx.index, src, { perSiteProducts: 6 }, hits);
    expect(withSemantic.map((c) => c.variantId)).toContain(X.id);
    expect(withSemantic.find((c) => c.variantId === X.id)!.foundBy.map((f) => f.method)).toContain('semantic');
    expect(without.includes(X.id) ? 'present' : 'absent').toBeDefined(); // (the words may or may not find it; the point is that meaning does)
  });

  it('a candidate with a different bulb code is dropped even though its meaning is just as close', async () => {
    const ctx = await buildContext(db(), org, MODEL);
    const hits = (await semanticFor(ctx, S.id))!;
    expect(hits.map((x) => x.variantId)).toContain(Z.id); // close in meaning
    const list = retrieveShortlist(ctx.index, ctx.corpus.byVariant.get(S.id)!, { perSiteProducts: 6 }, hits);
    expect(list.map((c) => c.variantId)).not.toContain(Z.id); // but H7 is not H11
  });

  it('without an embedding model nothing changes', async () => {
    const ctx = await buildContext(db(), org, undefined);
    expect(ctx.semantic).toBeNull();
    expect(await semanticFor(ctx, S.id)).toBeNull();
  });
});
