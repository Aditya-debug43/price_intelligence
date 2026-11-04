import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../apps/api/src/app.ts';
import { auditEvents, productMatches, products, variants } from '@ci/database';
import { createOrganization, runMatching, startScan } from '@ci/services';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp } from '../support/auth.ts';

/**
 * Price safety and the compatible-equivalent relationship. A person's confirmation says what two products ARE; it does not say their packs hold the same quantity and contents, so a
 * pair the listings do not settle counts in a direct price comparison only after an explicit "same pack" attestation (which never overrides a quantity shown to differ). A pair a changed
 * product put in doubt is not counted until it is checked. A delisted best candidate never hides a live runner-up, and the other valid candidates stay inspectable. A compatible equivalent
 * has its own relationship and its own price view: never the identical-item price position, never a substitute.
 */
let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let org: string;
let userId: string;
const base = () => `/api/v1/orgs/${org}`;
const db = () => h.db.worker;

type Pair = { key: string; s: string; c: string; sp: string; cp: string; id?: string };
const pairs: Record<string, Pair> = {};
let spare: { c: string; cp: string };

const retitle = async (p: { s: string; sp: string; c: string; cp: string }, source: string, rival: string, size: { s?: [string, number, string]; c?: [string, number, string] } = {}, brand = 'Acme') => {
  for (const [productId, variantId, title, sz] of [[p.sp, p.s, source, size.s], [p.cp, p.c, rival, size.c]] as const) {
    await db().update(products).set({ title, brand, attrs: {} }).where(eq(products.id, productId));
    await db().update(variants).set({ title: 'Default Title', options: {}, qtyKind: sz?.[0] ?? null, qtyTotal: sz?.[1] ?? null, qtyLabel: sz?.[2] ?? null }).where(eq(variants.id, variantId));
  }
};
const manual = async (p: Pair, relationship: string, note = 'Checked') => {
  const r = await owner.post(`${base()}/matches/manual`, { sourceVariantId: p.s, competitorVariantId: p.c, relationship, note });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  p.id = r.body.match.id as string;
};
type Cell = { variantId: string; directlyComparable: boolean; caveats: string[]; relationship: string; packAttested?: boolean; alternatives?: { variantId: string }[]; quantity?: { verdict: string } };
const comparison = async (view = 'prices') => (await owner.get(`${base()}/comparison?pageSize=500&view=${view}&include=confirmed`)).body.rows as { sourceVariantId: string; cells: Cell[] }[];
const cellOf = (rows: Awaited<ReturnType<typeof comparison>>, p: { s: string; c: string }) => rows.find((r) => r.sourceVariantId === p.s)?.cells.find((c) => c.variantId === p.c);
const attest = (p: Pair, attested: boolean, note?: string) => owner.post(`${base()}/matches/${p.id}/pack-attestation`, { attested, ...(note ? { note } : {}) });

beforeAll(async () => {
  h = await createHarness({ now: '2026-11-04T12:00:00Z' });
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
  await signUp(owner, h, { email: `ps-${Date.now()}@example.test`, password: 'Correct-Horse-9-Battery', displayName: 'Owner' });
  userId = (await owner.get('/api/v1/auth/me')).body.user.id;
  org = (await createOrganization(h.db.app, userId, 'Price safety')).id;
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
  const src = distinct(await db().select({ id: variants.id, productId: variants.productId }).from(variants).where(eq(variants.siteId, siteIds.source!)).limit(200));
  const rival = distinct(await db().select({ id: variants.id, productId: variants.productId }).from(variants).where(eq(variants.siteId, siteIds.woo!)).limit(200));
  expect(src.length).toBeGreaterThanOrEqual(6);
  expect(rival.length).toBeGreaterThanOrEqual(8);
  ['juice', 'oil', 'honey', 'moved', 'bulb', 'twin'].forEach((key, i) => { pairs[key] = { key, s: src[i]!.id, sp: src[i]!.productId, c: rival[i]!.id, cp: rival[i]!.productId }; });
  spare = { c: rival[6]!.id, cp: rival[6]!.productId };
  await db().delete(productMatches).where(eq(productMatches.orgId, org));
  await retitle(pairs.juice!, 'Acme Orange Juice 1 L', 'Acme Orange Juice 1000 ml', { s: ['volume', 1000, '1 L'], c: ['volume', 1000, '1000 ml'] });
  await retitle(pairs.oil!, 'Acme Cooking Oil 10 L', 'Acme Cooking Oil 20 L', { s: ['volume', 10000, '10 L'], c: ['volume', 20000, '20 L'] });
  await retitle(pairs.honey!, 'Acme Wild Honey', 'Acme Wild Honey');
  await retitle(pairs.moved!, 'Acme Rice 1 kg', 'Acme Rice 1000 g', { s: ['mass', 1000, '1 kg'], c: ['mass', 1000, '1000 g'] });
  await retitle(pairs.bulb!, 'Sealight H11 LED Headlight Bulbs', 'Auxito H11 LED Headlight Bulbs', {}, 'Sealight');
  await retitle(pairs.twin!, 'Acme Tea 100 g', 'Acme Tea 100 g', { s: ['mass', 100, '100 g'], c: ['mass', 100, '100 g'] });
  await retitle({ s: pairs.twin!.s, sp: pairs.twin!.sp, c: spare.c, cp: spare.cp }, 'Acme Tea 100 g', 'Acme Tea 100 g (second listing)', { s: ['mass', 100, '100 g'], c: ['mass', 100, '100 g'] });
}, 240_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('a confirmation is not an attestation of the pack', () => {
  it('a confirmed pair whose listings do not state a quantity is NOT a direct price comparison, and says why', async () => {
    await manual(pairs.honey!, 'exact');
    const cell = cellOf(await comparison(), pairs.honey!)!;
    expect(cell.quantity?.verdict).toBe('unknown');
    expect(cell.directlyComparable).toBe(false);
    expect(cell.caveats.join(' ')).toMatch(/nobody has verified that the two packs hold the same quantity/);
  });

  it('a pair whose listings show the same quantity still counts without any attestation', async () => {
    await manual(pairs.juice!, 'exact');
    expect(cellOf(await comparison(), pairs.juice!)!.directlyComparable).toBe(true);
    expect((await attest(pairs.juice!, true)).status).toBe(409); // nothing to attest
  });

  it('an explicit attestation supplies the missing evidence, is recorded, and can be withdrawn', async () => {
    const before = await db().select().from(productMatches).where(eq(productMatches.id, pairs.honey!.id!));
    const res = await attest(pairs.honey!, true, 'Checked both jars on the shelf');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(cellOf(await comparison(), pairs.honey!)).toMatchObject({ directlyComparable: true, packAttested: true });
    const [row] = await db().select().from(productMatches).where(eq(productMatches.id, pairs.honey!.id!));
    expect(row).toMatchObject({ packAttestedBy: userId, packAttestationNote: 'Checked both jars on the shelf' });
    // the person's decision itself is untouched
    expect({ status: row!.status, relationship: row!.relationship, decidedBy: row!.decidedBy, decisionNote: row!.decisionNote }).toEqual({ status: before[0]!.status, relationship: before[0]!.relationship, decidedBy: before[0]!.decidedBy, decisionNote: before[0]!.decisionNote });
    expect((await db().select().from(auditEvents)).some((e) => e.action === 'match.attest_pack' && e.target === pairs.honey!.id)).toBe(true);
    expect((await attest(pairs.honey!, false)).status).toBe(200);
    expect(cellOf(await comparison(), pairs.honey!)!.directlyComparable).toBe(false);
    await attest(pairs.honey!, true);
  });

  it('an attestation never overrides a quantity shown to differ', async () => {
    await manual(pairs.oil!, 'exact');
    expect(cellOf(await comparison(), pairs.oil!)).toBeUndefined(); // left out of price comparison by the quantity policy
    expect((await attest(pairs.oil!, true)).status).toBe(409);
  });

  it('only a confirmed pair can be attested, and only an administrator can', async () => {
    const [waiting] = await db().insert(productMatches).values({ orgId: org, sourceVariantId: pairs.bulb!.s, competitorVariantId: pairs.bulb!.c, competitorSiteId: (await db().select().from(variants).where(eq(variants.id, pairs.bulb!.c)))[0]!.siteId, matchClass: 'comparable', confidence: 0.6, status: 'needs_review', method: 'name_similarity', reasons: ['x'], relationship: 'substitute', tier: 'medium' }).returning();
    expect((await owner.post(`${base()}/matches/${waiting!.id}/pack-attestation`, { attested: true })).status).toBe(409);
    await db().delete(productMatches).where(eq(productMatches.id, waiting!.id));
  });
});

describe('a pair a changed product put in doubt is not counted until it is checked', () => {
  it('needs-reevaluation keeps the pair out of the direct comparison, and keeping the decision brings it back', async () => {
    await manual(pairs.moved!, 'exact');
    expect(cellOf(await comparison(), pairs.moved!)!.directlyComparable).toBe(true);
    await db().update(productMatches).set({ needsReevaluation: true }).where(eq(productMatches.id, pairs.moved!.id!));
    const flagged = cellOf(await comparison(), pairs.moved!)!;
    expect(flagged.directlyComparable).toBe(false);
    expect(flagged.caveats.join(' ')).toMatch(/not counted in a price comparison until you have checked/);
    expect((await owner.post(`${base()}/matches/${pairs.moved!.id}/decision`, { decision: 'accept' })).status).toBe(200); // "Keep my decision"
    expect(cellOf(await comparison(), pairs.moved!)!.directlyComparable).toBe(true);
  });
});

describe('the candidate shown is the best LIVE one, and the others stay inspectable', () => {
  it('a delisted best candidate does not hide a live runner-up', async () => {
    const second = { ...pairs.twin!, c: spare.c, cp: spare.cp };
    await manual(pairs.twin!, 'exact');
    await manual(second as Pair, 'exact');
    const rows = await comparison();
    const shown = rows.find((r) => r.sourceVariantId === pairs.twin!.s)!.cells;
    expect(shown).toHaveLength(1); // one website, one cell
    const first = shown[0]!;
    expect((first.alternatives ?? []).length).toBe(1); // the other candidate is listed, not hidden
    const other = first.variantId === pairs.twin!.c ? spare : { c: pairs.twin!.c, cp: pairs.twin!.cp };
    expect(first.alternatives![0]!.variantId).toBe(other.c);
    await db().update(products).set({ delistedAt: new Date('2026-11-04T10:00:00Z') }).where(eq(products.id, first.variantId === pairs.twin!.c ? pairs.twin!.cp : spare.cp));
    const after = (await comparison()).find((r) => r.sourceVariantId === pairs.twin!.s)!.cells;
    expect(after).toHaveLength(1);
    expect(after[0]!.variantId).toBe(other.c); // the live runner-up is now the one shown
  });
});

describe('a compatible equivalent is its own relationship and its own price view', () => {
  it('is stored as a comparable pair with the relationship "equivalent", never as a substitute or the same product', async () => {
    await manual(pairs.bulb!, 'equivalent', 'Same H11 socket and fit, other maker');
    const [m] = await db().select().from(productMatches).where(eq(productMatches.id, pairs.bulb!.id!));
    expect(m).toMatchObject({ relationship: 'equivalent', matchClass: 'comparable', status: 'accepted' });
  });

  it('appears in the Equivalents view only: not in the same-product view and not among the substitutes', async () => {
    expect(cellOf(await comparison('prices'), pairs.bulb!)).toBeUndefined();
    expect(cellOf(await comparison('substitutes'), pairs.bulb!)).toBeUndefined();
    const cell = cellOf(await comparison('equivalents'), pairs.bulb!)!;
    expect(cell).toBeDefined();
    expect(cell.relationship).toBe('equivalent');
    expect(cell.directlyComparable).toBe(false); // never the identical-item price position
    expect(cell.caveats.join(' ')).toMatch(/compatible equivalent from another maker/);
  });

  it('can be chosen in a decision on an existing pair', async () => {
    const [w] = await db().select().from(variants).where(eq(variants.id, pairs.bulb!.c));
    expect(w).toBeDefined();
    const r = await owner.post(`${base()}/matches/${pairs.bulb!.id}/decision`, { decision: 'reclassify', relationship: 'substitute' });
    expect(r.status).toBe(200);
    expect(cellOf(await comparison('equivalents'), pairs.bulb!)).toBeUndefined();
    expect(cellOf(await comparison('substitutes'), pairs.bulb!)).toBeDefined();
    expect((await owner.post(`${base()}/matches/${pairs.bulb!.id}/decision`, { decision: 'reclassify', relationship: 'equivalent' })).status).toBe(200);
    expect(cellOf(await comparison('equivalents'), pairs.bulb!)).toBeDefined();
  });
});
