import { compactBrand, normalizeBrand, normalizeText } from './text.ts';

/**
 * A "brand" field is only worth something when it names the maker of the product. Many shops fill the platform's vendor field with something
 * else — the shop's own name ("Ling & Sons Food Market" on every product), the country ("Aruba" on 96 % of a grocery catalogue), or the
 * platform's default ("Your Brand", "Acme"). Used as a brand it does harm: two shops' identical products look like products of different
 * brands ("Aruba" vs "Ling and Sons Food Market"), so they can never be matched as the same product.
 *
 * The test is about the data, not about any shop: a label that is shared by many of a shop's products but almost never appears in those
 * products' own names is a label for the shop, not a brand. (A real brand — "Dove", "Heinz" — is part of what its products are called.)
 */
export interface BrandUse {
  siteId: string;
  brand: string | null;
  title: string;
}

/** Words that are never a brand when they are the whole value. */
const PLACEHOLDER_WORDS = new Set(['yourbrand', 'brand', 'brandname', 'default', 'vendor', 'supplier', 'manufacturer', 'unknown', 'na', 'none', 'null', 'generic', 'store', 'shop', 'test', 'demo', 'sample', 'acme', 'company', 'myshop', 'mystore']);

/** A label this common on a shop (and absent from the product names) is the shop's own label. */
const SHARED_MIN_PRODUCTS = 20;
/** Share of a label's products whose name contains the label below which it does not look like part of the products' names. */
const IN_TITLE_MIN_SHARE = 0.1;

const hasPhrase = (haystack: string, phrase: string): boolean => phrase.length > 0 && ` ${haystack} `.includes(` ${phrase} `);

/**
 * The (shop, brand label) pairs that are not brands. Keys are `${siteId}|${compactBrand}`; use {@link isPlaceholderBrand}.
 */
export function placeholderBrandKeys(rows: BrandUse[]): Set<string> {
  const bySite = new Map<string, Map<string, { label: string; raw: string; n: number; inTitle: number }>>();
  const siteTotals = new Map<string, number>();
  for (const r of rows) {
    siteTotals.set(r.siteId, (siteTotals.get(r.siteId) ?? 0) + 1);
    const phrase = normalizeBrand(r.brand);
    const key = compactBrand(r.brand);
    if (!phrase || !key) continue;
    const groups = bySite.get(r.siteId) ?? new Map();
    const g = groups.get(key) ?? { label: phrase, raw: normalizeText(r.brand).replace(/ /g, ""), n: 0, inTitle: 0 };
    g.n += 1;
    if (hasPhrase(normalizeText(r.title), phrase) || hasPhrase(normalizeText(r.title).replace(/ /g, ''), key)) g.inTitle += 1;
    groups.set(key, g);
    bySite.set(r.siteId, groups);
  }
  const out = new Set<string>();
  for (const [siteId, groups] of bySite) {
    const total = siteTotals.get(siteId) ?? 0;
    for (const [key, g] of groups) {
      const share = g.inTitle / g.n;
      const placeholder =
        PLACEHOLDER_WORDS.has(g.raw) ||
        // shared by many products of the shop, and not part of their names
        (g.n >= SHARED_MIN_PRODUCTS && share < IN_TITLE_MIN_SHARE) ||
        // a small shop whose products almost all carry one label that no product name contains
        (total >= 8 && g.n / total >= 0.5 && g.inTitle === 0);
      if (placeholder) out.add(`${siteId}|${key}`);
    }
  }
  return out;
}

export const isPlaceholderBrand = (placeholders: Set<string>, siteId: string, brand: string | null | undefined): boolean => {
  const key = compactBrand(brand);
  return key !== '' && placeholders.has(`${siteId}|${key}`);
};
