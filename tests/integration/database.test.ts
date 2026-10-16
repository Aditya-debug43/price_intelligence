import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, priceObservations, products, reports, sites, variants, withTenant, RLS_EXEMPT_TABLES } from '@ci/database';
import { connectTestDb, seedOrg, type TestDb } from '../support/db.ts';

let t: TestDb;
let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
let siteA: string;
let siteB: string;

beforeAll(async () => {
  t = connectTestDb();
  A = await seedOrg(t.worker, 'Org A');
  B = await seedOrg(t.worker, 'Org B');
  const mk = async (orgId: string, host: string) => {
    const [s] = await t.worker
      .insert(sites)
      .values({ orgId, url: `https://${host}/`, origin: `https://${host}`, hostname: host, name: host, role: 'competitor' })
      .returning();
    return s!.id;
  };
  siteA = await mk(A.org.id, 'a.example.com');
  siteB = await mk(B.org.id, 'b.example.com');
});

afterAll(async () => {
  await t.close();
});

describe('migrations', () => {
  it('create the expected core tables', async () => {
    const { rows } = await t.admin.query("select table_name from information_schema.tables where table_schema='public'");
    const names = rows.map((r) => r.table_name as string);
    for (const expected of ['users', 'organizations', 'memberships', 'sites', 'site_profiles', 'products', 'variants', 'price_observations', 'stock_observations', 'offers', 'product_matches', 'reports', 'alerts', 'integration_connections', 'scan_runs', 'crawl_queue', 'evidence']) {
      expect(names).toContain(expected);
    }
  });

  it('enables AND forces row-level security with a policy on every tenant table (except documented exemptions)', async () => {
    const { rows } = await t.admin.query(`
      select c.relname as table_name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname and p.policyname='tenant_isolation') as has_policy
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join information_schema.columns col on col.table_schema='public' and col.table_name=c.relname and col.column_name='org_id'
      where c.relkind = 'r'`);
    expect(rows.length).toBeGreaterThan(20);
    const uncovered = rows.filter((r) => !RLS_EXEMPT_TABLES[r.table_name as string] && !(r.rls && r.forced && r.has_policy));
    expect(uncovered.map((r) => r.table_name)).toEqual([]);
  });
});

describe('row-level security (enforced in the database, not just the app)', () => {
  it('a tenant only sees its own rows', async () => {
    const seenByA = await withTenant(t.app, A.org.id, (tx) => tx.select().from(sites));
    expect(seenByA.map((s) => s.id)).toEqual([siteA]);
    const seenByB = await withTenant(t.app, B.org.id, (tx) => tx.select().from(sites));
    expect(seenByB.map((s) => s.id)).toEqual([siteB]);
  });

  it('fails closed when no tenant is bound', async () => {
    expect(await t.app.select().from(sites)).toEqual([]);
  });

  it('cannot read another tenant row even when filtering for it explicitly', async () => {
    const rows = await withTenant(t.app, A.org.id, (tx) => tx.select().from(sites).where(eq(sites.id, siteB)));
    expect(rows).toEqual([]);
  });

  it('rejects inserting a row for a different tenant', async () => {
    await expect(
      withTenant(t.app, A.org.id, (tx) =>
        tx.insert(sites).values({ orgId: B.org.id, url: 'https://evil.example.com/', origin: 'https://evil.example.com', hostname: 'evil.example.com', name: 'x', role: 'competitor' }),
      ),
    ).rejects.toThrow();
  });

  it('cannot update or delete another tenant rows (affects zero rows)', async () => {
    const upd = await withTenant(t.app, A.org.id, (tx) => tx.update(sites).set({ name: 'pwned' }).where(eq(sites.id, siteB)).returning());
    expect(upd).toEqual([]);
    const del = await withTenant(t.app, A.org.id, (tx) => tx.delete(sites).where(eq(sites.id, siteB)).returning());
    expect(del).toEqual([]);
    const [still] = await t.worker.select().from(sites).where(eq(sites.id, siteB));
    expect(still!.name).toBe('b.example.com');
  });

  it('cannot move a row to another tenant via UPDATE', async () => {
    await expect(withTenant(t.app, A.org.id, (tx) => tx.update(sites).set({ orgId: B.org.id }).where(eq(sites.id, siteA)))).rejects.toThrow();
  });

  it('isolates child tables (products, variants, observations) the same way', async () => {
    const [p] = await t.worker
      .insert(products)
      .values({ orgId: B.org.id, siteId: siteB, canonicalUrl: 'https://b.example.com/p/1', title: 'Secret B product', extractionMethod: 'json_ld', extractionVersion: '1' })
      .returning();
    const [v] = await t.worker.insert(variants).values({ orgId: B.org.id, siteId: siteB, productId: p!.id, variantKey: 'default', url: p!.canonicalUrl, price: 9.99, currency: 'USD' }).returning();
    await t.worker.insert(priceObservations).values({ orgId: B.org.id, siteId: siteB, variantId: v!.id, observedAt: new Date(), price: 9.99, currency: 'USD', sourceUrl: p!.canonicalUrl, extractionMethod: 'json_ld', extractionVersion: '1' });

    for (const table of [products, variants, priceObservations]) {
      expect(await withTenant(t.app, A.org.id, (tx) => tx.select().from(table))).toEqual([]);
      expect((await withTenant(t.app, B.org.id, (tx) => tx.select().from(table))).length).toBe(1);
    }
  });

  it('rejects a malformed tenant id instead of running unscoped', async () => {
    await expect(withTenant(t.app, "x'; drop table sites; --", async () => 1)).rejects.toThrow(/UUID/);
  });

  it('the worker role (BYPASSRLS) can span tenants; the app role is not a superuser or BYPASSRLS role', async () => {
    const all = await t.worker.select().from(sites);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const { rows } = await t.admin.query("select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('ci_app','ci_worker') order by rolname");
    expect(rows).toEqual([
      { rolname: 'ci_app', rolsuper: false, rolbypassrls: false },
      { rolname: 'ci_worker', rolsuper: false, rolbypassrls: true },
    ]);
  });
});

describe('data integrity guards', () => {
  it('observations are append-only', async () => {
    const [obs] = await t.worker.select().from(priceObservations).where(eq(priceObservations.orgId, B.org.id));
    await expect(t.worker.update(priceObservations).set({ price: 1 }).where(eq(priceObservations.id, obs!.id))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/append-only/) } });
  });

  it('published report snapshots are immutable but drafts can be completed', async () => {
    const [r] = await t.worker.insert(reports).values({ orgId: A.org.id, kind: 'manual', periodDate: '2026-10-13', title: 'R', status: 'generating' }).returning();
    await t.worker.update(reports).set({ status: 'ready', data: { a: 1 }, dataHash: 'h1' }).where(eq(reports.id, r!.id));
    await expect(t.worker.update(reports).set({ data: { a: 2 } }).where(eq(reports.id, r!.id))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/immutable/) } });
    // non-snapshot metadata may still change
    await t.worker.update(reports).set({ summaryText: 'edited summary' }).where(eq(reports.id, r!.id));
  });

  it('allows at most one active source site per organisation', async () => {
    const mk = (host: string) =>
      t.worker.insert(sites).values({ orgId: A.org.id, url: `https://${host}/`, origin: `https://${host}`, hostname: host, name: host, role: 'source' });
    await mk('source1.example.com');
    await expect(mk('source2.example.com')).rejects.toThrow();
  });

  it('prevents duplicate sites per organisation but allows the same host in different organisations', async () => {
    await expect(
      t.worker.insert(sites).values({ orgId: A.org.id, url: 'https://a.example.com/', origin: 'https://a.example.com', hostname: 'a.example.com', name: 'dup', role: 'competitor' }),
    ).rejects.toThrow();
    await t.worker.insert(sites).values({ orgId: B.org.id, url: 'https://a.example.com/', origin: 'https://a.example.com', hostname: 'a.example.com', name: 'same host, other org', role: 'competitor' });
    const cnt = await t.worker.select().from(sites).where(and(eq(sites.hostname, 'a.example.com')));
    expect(cnt.length).toBe(2);
  });
});
