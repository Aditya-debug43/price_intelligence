import { sql } from 'drizzle-orm';
import type { MatchCounts, MatchCountsByRelationship } from '@ci/shared';
import type { DbLike } from '@ci/database';

/**
 * What each number on Match review, Products and the reports actually counts. The kinds of record must not be added together: a PAIR is one own variant against one competitor variant,
 * so one own variant with three competitor candidates is three pairs but ONE variant; a PARENT PRODUCT can hold several sellable variants. Every figure here says which of the three it is.
 *
 *  - confirmed: a person (or the auto-confirmation policy) confirmed the pair;  suggested: a current suggestion nobody has confirmed (not set aside, not rejected);
 *  - uncertain: own variants whose only live pairs are "related" or "not enough information";  no counterpart: own variants with no live pair of a positive kind at all;
 *  - directly comparable: own variants with a CONFIRMED identical-item pair whose packs are verified (listings show the same quantity and contents, or a person attested it) and that no changed
 *    product has put in doubt: the pairs that may enter the headline price position (a live price is still needed).
 */

const REL = ['exact', 'variant', 'equivalent', 'substitute', 'related'] as const;
const zero = (): MatchCountsByRelationship => ({ exact: 0, variant: 0, equivalent: 0, substitute: 0, related: 0 });

export async function loadMatchCounts(db: DbLike, orgId: string): Promise<MatchCounts> {
  const own = sql`(
    select v.id as vid, p.id as pid from variants v join products p on p.id = v.product_id join sites s on s.id = p.site_id
    where v.org_id = ${orgId} and s.role = 'source' and s.active and p.delisted_at is null
  )`;
  const rel = sql`coalesce(m.relationship, case m.match_class when 'identical' then 'exact' when 'different_pack' then 'variant' when 'comparable' then 'substitute' else 'non_match' end)`;
  const live = sql`(m.status = 'accepted' or (m.status in ('needs_review','auto') and m.superseded_at is null))`;
  const totals = await db.execute<{ parents: string; variants: string }>(sql`select count(distinct pid)::text as parents, count(*)::text as variants from ${own} o`);
  const byRel = await db.execute<{ rel: string; kind: string; pairs: string; variants: string }>(sql`
    select ${rel} as rel, case when m.status = 'accepted' then 'confirmed' else 'suggested' end as kind, count(*)::text as pairs, count(distinct m.source_variant_id)::text as variants
    from product_matches m join ${own} o on o.vid = m.source_variant_id
    where m.org_id = ${orgId} and ${live} group by 1, 2`);
  const confirmedAny = await db.execute<{ variants: string; products: string }>(sql`
    select count(distinct m.source_variant_id)::text as variants, count(distinct o.pid)::text as products
    from product_matches m join ${own} o on o.vid = m.source_variant_id
    where m.org_id = ${orgId} and m.status = 'accepted' and ${rel} in ('exact','variant','equivalent','substitute','related')`);
  const states = await db.execute<{ uncertain: string; none: string }>(sql`
    select
      count(*) filter (where exists (select 1 from product_matches m where m.source_variant_id = o.vid and ${live} and ${rel} in ('related','insufficient'))
                       and not exists (select 1 from product_matches m where m.source_variant_id = o.vid and ${live} and ${rel} in ('exact','variant','equivalent','substitute')))::text as uncertain,
      count(*) filter (where not exists (select 1 from product_matches m where m.source_variant_id = o.vid and ${live} and ${rel} in ('exact','variant','equivalent','substitute','related','insufficient')))::text as none
    from ${own} o`);
  const comparable = await db.execute<{ variants: string; products: string }>(sql`
    select count(distinct m.source_variant_id)::text as variants, count(distinct o.pid)::text as products
    from product_matches m join ${own} o on o.vid = m.source_variant_id
    where m.org_id = ${orgId} and m.status = 'accepted' and ${rel} = 'exact' and m.price_exclusion is null and not m.needs_reevaluation
      and (m.quantity_check->>'verdict' = 'same' or m.pack_attested_at is not null)
      and (m.bundle_check is null or m.bundle_check->>'verdict' = 'equivalent' or m.pack_attested_at is not null)`);
  const out: MatchCounts = {
    ownParentProducts: Number(totals.rows[0]?.parents ?? 0), ownVariants: Number(totals.rows[0]?.variants ?? 0),
    confirmedPairs: zero(), suggestedPairs: zero(), confirmedOwnVariants: zero(), suggestedOwnVariants: zero(),
    ownVariantsWithConfirmed: Number(confirmedAny.rows[0]?.variants ?? 0), ownProductsWithConfirmed: Number(confirmedAny.rows[0]?.products ?? 0),
    uncertainOwnVariants: Number(states.rows[0]?.uncertain ?? 0), noCounterpartOwnVariants: Number(states.rows[0]?.none ?? 0),
    directlyComparableOwnVariants: Number(comparable.rows[0]?.variants ?? 0), directlyComparableOwnProducts: Number(comparable.rows[0]?.products ?? 0),
  };
  for (const r of byRel.rows) {
    if (!(REL as readonly string[]).includes(r.rel)) continue;
    const k = r.rel as (typeof REL)[number];
    (r.kind === 'confirmed' ? out.confirmedPairs : out.suggestedPairs)[k] = Number(r.pairs);
    (r.kind === 'confirmed' ? out.confirmedOwnVariants : out.suggestedOwnVariants)[k] = Number(r.variants);
  }
  return out;
}

export interface NoCounterpartRow {
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string | null;
  brand: string | null;
  sku: string | null;
  price: number | null;
  currency: string | null;
  url: string | null;
}

/**
 * Your variants with no live pair at all: "no counterpart FOUND". It is a statement about what the matcher found, never that no competitor sells one; a person can search the whole competitor
 * catalogue from here (the same search as everywhere else) and record the right product.
 */
export async function listNoCounterpart(db: DbLike, orgId: string, f: { q?: string; page: number; pageSize: number }): Promise<{ rows: NoCounterpartRow[]; total: number }> {
  const limit = Math.min(Math.max(1, f.pageSize), 100);
  const offset = Math.max(0, (f.page - 1) * limit);
  const needle = f.q?.trim() ? `%${f.q.trim().toLowerCase().replace(/[%_]/g, ' ')}%` : null;
  const where = sql`
    v.org_id = ${orgId} and s.role = 'source' and s.active and p.delisted_at is null
    and not exists (select 1 from product_matches m where m.source_variant_id = v.id and (m.status = 'accepted' or (m.status in ('needs_review','auto') and m.superseded_at is null)))
    ${needle ? sql`and (lower(p.title) like ${needle} or lower(coalesce(p.brand, '')) like ${needle} or lower(coalesce(v.sku, '')) like ${needle})` : sql``}`;
  const rows = await db.execute<Record<string, unknown>>(sql`
    select v.id as "variantId", p.id as "productId", p.title, v.title as "variantTitle", p.brand, v.sku, v.price, v.currency, v.url
    from variants v join products p on p.id = v.product_id join sites s on s.id = p.site_id
    where ${where} order by p.title, v.title limit ${limit} offset ${offset}`);
  const total = await db.execute<{ n: string }>(sql`select count(*)::text as n from variants v join products p on p.id = v.product_id join sites s on s.id = p.site_id where ${where}`);
  return { total: Number(total.rows[0]?.n ?? 0), rows: rows.rows.map((r) => ({ ...(r as unknown as NoCounterpartRow), price: r['price'] === null || r['price'] === undefined ? null : Number(r['price']) })) };
}
