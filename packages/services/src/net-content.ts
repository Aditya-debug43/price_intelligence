import { sql } from 'drizzle-orm';
import type { DbLike } from '@ci/database';

/**
 * The quantity a product page states under a LABEL ("Net weight: 500 g", "Net contents: 1 L", "Package size: 12 oz", "Pack size: 6 pack"), one short string per product.
 * Only these labels are read, and only the number and unit that follow: an unlabelled number in a description is never a quantity, and the result is only
 * used when the title, the variant's options and the shop's size hints state no quantity at all (core/quantity-policy.ts).
 */
const LABELLED_NET_CONTENT =
  '(?:net\\s*(?:wt\\.?|weight|contents?|volume|quantity|qty)|package\\s*size|pack\\s*size)\\s*[:\\-–]\\s*(\\d+(?:[.,]\\d+)?\\s*(?:fl\\.?\\s*oz|oz|ounces?|ml|cl|l|lt|ltr|liters?|litres?|g|gm|grams?|kg|kilograms?|lbs?|pounds?|ct|count|pcs|pieces?|pack))(?![a-z])';

export async function loadNetContent(db: DbLike, orgId: string, productIds?: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const filter = productIds ? sql`and p.id in (${sql.join(productIds.map((i) => sql`${i}::uuid`), sql`, `)})` : sql``;
  const res = await db.execute<{ id: string; c: string | null }>(
    sql`select p.id, (regexp_match(left(p.description, 4000), ${LABELLED_NET_CONTENT}, 'i'))[1] as c from products p where p.org_id = ${orgId} and p.description is not null ${filter}`,
  );
  for (const r of res.rows) if (r.c) out.set(r.id, r.c);
  return out;
}
