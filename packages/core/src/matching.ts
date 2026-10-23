import type { MatchClass, MatchStatus } from '@ci/shared';
import { normalizeGtin } from './gtin.ts';
import {
  compareQuantities,
  parseQuantity,
  reinterpretOzForBeverage,
  stripQuantityText,
  type ParsedQuantity,
  type QuantityRelation,
} from './quantity.ts';
import {
  compactBrand,
  coreNameTokens,
  inferBrandFromTitle,
  nameSimilarity,
  normalizeBrand,
  normalizeText,
} from './text.ts';

/**
 * Progressive product matching pipeline:
 *   1. valid GTIN equality
 *   2. brand + manufacturer part number / model
 *   3. brand + variant attributes (size/pack) + normalised name similarity
 *   4. cross-brand comparable products (unit-price comparison only)
 *   5. optional AI adjudication (never auto-accepted)  → 6. human review
 *
 * Hard rule: name similarity alone can never prove identity. A name-only "identical" match requires the same
 * known brand on both sides AND a verified equal total size, and its confidence is capped at 0.9.
 */

export interface MatchableVariant {
  variantId: string;
  productId: string;
  siteId: string;
  title: string;
  variantTitle: string | null;
  brand: string | null;
  category: string | null;
  gtin: string | null;
  sku: string | null;
  mpn: string | null;
  model: string | null;
  /** Free-form size hints from structured data (e.g. "355 ml", "12 pack"). */
  sizeHints: (string | null | undefined)[];
  /** Other words the shop attaches to the product (its tags: "Beer", "Soft Drinks"): read only to tell fluid ounces from weight ounces. */
  context?: string | null;
}

export interface PreparedVariant extends MatchableVariant {
  fullTitle: string;
  brandKey: string; // compacted normalised brand, '' when unknown
  brandInferred: boolean;
  gtin14: string | null;
  mpnKey: string | null;
  skuKey: string | null;
  core: string[];
  qty: ParsedQuantity;
  categoryTokens: string[];
}

export interface MatchCandidate {
  sourceVariantId: string;
  competitorVariantId: string;
  competitorSiteId: string;
  matchClass: MatchClass;
  confidence: number;
  status: MatchStatus;
  method: 'gtin' | 'brand_model' | 'attributes' | 'name_similarity' | 'cross_brand' | 'ai';
  reasons: string[];
  components: {
    nameSimilarity: number | null;
    brand: 'same' | 'different' | 'unknown';
    quantity: QuantityRelation;
    category: 'compatible' | 'conflicting' | 'unknown';
    gtin: 'equal' | 'different' | 'unavailable';
  };
}

const keyify = (s: string | null | undefined): string | null => {
  const k = normalizeText(s).replace(/ /g, '');
  return k.length >= 3 ? k : null;
};

export function collectKnownBrands(variants: MatchableVariant[]): Set<string> {
  const set = new Set<string>();
  for (const v of variants) {
    const b = normalizeBrand(v.brand);
    if (b.length >= 2) {
      set.add(b);
      set.add(b.replace(/ /g, ''));
    }
  }
  return set;
}

export function prepareVariant(v: MatchableVariant, knownBrands: Set<string>): PreparedVariant {
  const fullTitle = [v.title, v.variantTitle && v.variantTitle.toLowerCase() !== 'default title' ? v.variantTitle : null]
    .filter(Boolean)
    .join(' ');
  let brand = v.brand;
  let inferred = false;
  if (!normalizeBrand(brand)) {
    const guess = inferBrandFromTitle(v.title, knownBrands);
    if (guess) {
      brand = guess;
      inferred = true;
    }
  }
  const qty = reinterpretOzForBeverage(parseQuantity(fullTitle, ...v.sizeHints), `${fullTitle} ${v.category ?? ''} ${v.context ?? ''}`);
  return {
    ...v,
    fullTitle,
    brand,
    brandKey: compactBrand(brand),
    brandInferred: inferred,
    gtin14: normalizeGtin(v.gtin),
    mpnKey: keyify(v.mpn) ?? keyify(v.model),
    skuKey: keyify(v.sku),
    core: coreNameTokens(fullTitle, brand),
    qty,
    categoryTokens: normalizeText(v.category).split(' ').filter((t) => t.length > 2),
  };
}

function categoryCompat(a: PreparedVariant, b: PreparedVariant): 'compatible' | 'conflicting' | 'unknown' {
  if (!a.categoryTokens.length || !b.categoryTokens.length) return 'unknown';
  const sa = new Set(a.categoryTokens);
  for (const t of b.categoryTokens) if (sa.has(t)) return 'compatible';
  return 'conflicting';
}

function isSubset(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  const set = new Set(big);
  return small.every((t) => set.has(t));
}

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
const r2 = (n: number) => Math.round(n * 100) / 100;

export const AUTO_ACCEPT_THRESHOLD = 0.85;

/**
 * Words that name a variety, flavour or formulation: two products whose names differ in one of them ("Vanilla" vs "Original", "Light" vs
 * regular, "Unsweetened", "Vegan", "15 Grain" vs "Whole Wheat") are different products even when everything else in the name agrees. Stems, as
 * produced by `coreNameTokens`. A name that differs only in ordinary words ("Deli Fresh", "Natural") is not affected.
 */
const VARIANT_WORDS = new Set([
  'vanilla', 'chocolate', 'strawberry', 'banana', 'lemon', 'lime', 'orange', 'cherry', 'grape', 'apple', 'mango', 'peach', 'pineapple', 'coconut', 'caramel',
  'mint', 'honey', 'cinnamon', 'berry', 'blueberry', 'raspberry', 'cranberry', 'watermelon', 'tropical', 'punch', 'diet', 'zero', 'light', 'lite', 'regular',
  'sugar', 'sugarfree', 'decaf', 'caffeine', 'free', 'whole', 'skim', 'reduced', 'fat', 'lowfat', 'nonfat', 'unsweetened', 'sweetened', 'unsalted', 'salted',
  'spicy', 'mild', 'hot', 'sweet', 'sour', 'dark', 'white', 'brown', 'wheat', 'grain', 'multigrain', 'organic', 'vegan', 'gluten', 'calcium', 'protein',
  'plain', 'creamy', 'crunchy', 'chunky', 'smooth', 'extra', 'strong', 'double', 'mini', 'jumbo', 'xl', 'family', 'kid', 'pulp', 'seedless', 'sparkling', 'still',
]);

/** The variety/flavour words in which two names differ (words present in one name and not the other). */
export function variantDifference(a: string[], b: string[]): string[] {
  const sa = new Set(a);
  const sb = new Set(b);
  return [...new Set([...a.filter((t) => !sb.has(t)), ...b.filter((t) => !sa.has(t))].filter((t) => VARIANT_WORDS.has(t)))];
}

/**
 * A year written in a name ("Kim Crawford Sauvignon Blanc 2013") is a vintage or edition: a listing without it, or with another, may be a different
 * product. A number that is part of a size ("Fish Oil 2000 mg", "2000 ct") is not a year.
 */
const YEAR_RE = /(?<![\d.,$#-])(19[5-9]\d|20[0-3]\d)(?!\d)(?![.,]\d)(?!\s*(?:mg|mcg|g|kg|ml|cl|l|oz|lbs?|ct|count|pk|pack|iu|w|watts?|cal|kcal|sheets?|ft|in|cm|mm|pcs|pieces?|%)\b)/gi;
export const yearsIn = (title: string): string[] => [...new Set([...title.matchAll(YEAR_RE)].map((m) => m[1]!))].sort();

/**
 * Numbers of three or four digits that belong to a product's name ("Jose Cuervo 1800 Silver", "100% Juice") — not a size, a pack count or a year.
 * A number in one name that appears nowhere in the other ("1800 Silver" vs "Silver") usually marks a different product line.
 */
export function modelNumbersIn(title: string): string[] {
  const stripped = stripQuantityText(title);
  return [...new Set([...stripped.matchAll(/(?<![\d.,$#-])(\d{3,4})(?!\d)(?![.,]\d)/g)].map((m) => m[1]!))].filter((n) => Number(n) < 1950 || Number(n) > 2039).sort();
}
const digitRuns = (t: string) => new Set(t.match(/\d+/g) ?? []);

/**
 * Small numbers that carry a label and so identify the product: "Size 4" nappies, "Stage 2" baby food, "Step 3", "No. 5", "#2". Bare digits are
 * ignored when names are compared, which would make "Size 4" and "Size 5" look identical.
 */
const LABELLED_NUMBER = /\b(size|stage|step|level|grade|no|nr|number)\.?\s*#?\s*(\d{1,2})\b|#\s?(\d{1,2})\b/gi;
export function labelledNumbersIn(title: string): string[] {
  return [...new Set([...title.matchAll(LABELLED_NUMBER)].map((m) => `${(m[1] ?? '#').toLowerCase()} ${m[2] ?? m[3]}`))].sort();
}

const packOf = (q: { packCount: number | null }) => q.packCount ?? 1;

/**
 * Scores one pair. Two things the name-and-size evidence alone gets wrong are corrected here, whatever the route to "identical":
 *  • names that differ in a flavour, variety or formulation are not the same product (they stay proposals, as "comparable");
 *  • the same total split differently (one 3 L bottle vs 6 × 500 ml) is a different pack, compared per unit.
 * Identity from a barcode, or from brand + model number, is not touched.
 */
export function scorePair(a: PreparedVariant, b: PreparedVariant): MatchCandidate | null {
  const m = scorePairCore(a, b);
  // a name-based "identical" or "same product, other size" is only as good as the names: the checks below can send it back to a proposal
  if (!m || (m.matchClass !== 'identical' && m.matchClass !== 'different_pack') || m.method === 'gtin' || m.method === 'brand_model') return m;
  const diff = variantDifference(a.core, b.core);
  if (diff.length) {
    return { ...m, matchClass: 'comparable', status: 'needs_review', confidence: Math.min(m.confidence, 0.6), reasons: [...m.reasons.filter((r) => !/Names and sizes agree/.test(r)), `The names differ in a variety or flavour (${diff.join(', ')}), so these may be different products`] };
  }
  const [ya, yb] = [yearsIn(a.fullTitle), yearsIn(b.fullTitle)];
  if (ya.join() !== yb.join()) {
    const years = [...new Set([...ya, ...yb])].join(', ');
    return { ...m, matchClass: 'comparable', status: 'needs_review', confidence: Math.min(m.confidence, 0.6), reasons: [...m.reasons.filter((r) => !/Names and sizes agree/.test(r)), `One name gives a year (${years}) that the other does not, so these may be different vintages or editions`] };
  }
  if (m.matchClass === 'identical' && packOf(a.qty) !== packOf(b.qty)) {
    return { ...m, matchClass: 'different_pack', status: 'needs_review', confidence: Math.min(m.confidence, 0.7), reasons: [...m.reasons, `The total is the same but the pack is different (${a.qty.label ?? '?'} vs ${b.qty.label ?? '?'}): compare per unit`] };
  }
  const lone = [...modelNumbersIn(a.fullTitle).filter((n) => !digitRuns(b.fullTitle).has(n)), ...modelNumbersIn(b.fullTitle).filter((n) => !digitRuns(a.fullTitle).has(n))];
  if (lone.length) {
    return { ...m, matchClass: 'comparable', status: 'needs_review', confidence: Math.min(m.confidence, 0.6), reasons: [...m.reasons.filter((r) => !/Names and sizes agree/.test(r)), `One name has the number ${[...new Set(lone)].join(', ')} that the other does not (a model or product-line number?), so these may be different products`] };
  }
  const [la, lb] = [labelledNumbersIn(a.fullTitle), labelledNumbersIn(b.fullTitle)];
  if (la.join() !== lb.join()) {
    const differing = [...new Set([...la, ...lb])].filter((x) => !(la.includes(x) && lb.includes(x)));
    return { ...m, matchClass: 'comparable', status: 'needs_review', confidence: Math.min(m.confidence, 0.6), reasons: [...m.reasons.filter((r) => !/Names and sizes agree/.test(r)), `The names differ in a numbered size or stage (${differing.join(' / ')}), so these may be different products`] };
  }
  return m;
}

function scorePairCore(a: PreparedVariant, b: PreparedVariant): MatchCandidate | null {
  const reasons: string[] = [];
  const qtyRel = compareQuantities(a.qty, b.qty);
  const cat = categoryCompat(a, b);
  const brand: 'same' | 'different' | 'unknown' =
    a.brandKey && b.brandKey ? (a.brandKey === b.brandKey ? 'same' : 'different') : 'unknown';
  const gtinState: 'equal' | 'different' | 'unavailable' =
    a.gtin14 && b.gtin14 ? (a.gtin14 === b.gtin14 ? 'equal' : 'different') : 'unavailable';
  const sim = nameSimilarity(a.core, b.core);

  const base = {
    sourceVariantId: a.variantId,
    competitorVariantId: b.variantId,
    competitorSiteId: b.siteId,
  };
  const comps = (): MatchCandidate['components'] => ({
    nameSimilarity: r2(sim),
    brand,
    quantity: qtyRel,
    category: cat,
    gtin: gtinState,
  });

  // 1 ── GTIN
  if (gtinState === 'equal') {
    if (qtyRel === 'different_total' || qtyRel === 'incompatible') {
      return {
        ...base,
        matchClass: 'identical',
        confidence: 0.82,
        status: 'needs_review',
        method: 'gtin',
        reasons: [
          `Same GTIN ${a.gtin14}`,
          `but the sizes parsed from the titles differ (${a.qty.label ?? '?'} vs ${b.qty.label ?? '?'}); please confirm`,
        ],
        components: comps(),
      };
    }
    reasons.push(`Same valid GTIN ${a.gtin14}`);
    return { ...base, matchClass: 'identical', confidence: 0.98, status: 'auto', method: 'gtin', reasons, components: comps() };
  }

  // 2 ── brand + manufacturer part number / model
  if (brand === 'same' && a.mpnKey && b.mpnKey && a.mpnKey === b.mpnKey && a.mpnKey.length >= 4) {
    if (qtyRel === 'different_total') {
      return {
        ...base,
        matchClass: 'different_pack',
        confidence: 0.86,
        status: 'auto',
        method: 'brand_model',
        reasons: [`Same brand and model/MPN "${a.mpnKey}" but different pack size (${a.qty.label} vs ${b.qty.label})`],
        components: comps(),
      };
    }
    return {
      ...base,
      matchClass: 'identical',
      confidence: 0.93,
      status: 'auto',
      method: 'brand_model',
      reasons: [`Same brand and model/MPN "${a.mpnKey}"`],
      components: comps(),
    };
  }

  // Names that share nothing cannot match by attributes.
  if (a.core.length === 0 || b.core.length === 0) return null;
  const strongSku = brand === 'same' && a.skuKey !== null && a.skuKey === b.skuKey && a.skuKey.length >= 5;
  if (strongSku) reasons.push(`Same brand and SKU "${a.skuKey}"`);

  // GTINs exist on both sides but differ: strong signal against identity.
  const gtinPenalty = gtinState === 'different' ? 0.12 : 0;
  if (gtinState === 'different') reasons.push('Both products have valid but different GTINs');

  // 3 ── same brand: attributes + name
  if (brand === 'same') {
    if (sim >= 0.8) {
      if (qtyRel === 'same_total') {
        // Identity by name only: capped at 0.9, auto-accepted only when similarity is very high.
        let conf = clamp(0.5 + 0.38 * sim + (cat === 'compatible' ? 0.02 : 0) + (strongSku ? 0.05 : 0) - gtinPenalty, 0, 0.9);
        reasons.push(`Same brand "${a.brand}"`, `Same total size (${a.qty.label})`, `Name similarity ${r2(sim)}`);
        if (cat === 'conflicting') {
          conf -= 0.1;
          reasons.push('Categories look different');
        }
        const status: MatchStatus = conf >= AUTO_ACCEPT_THRESHOLD && sim >= 0.9 && gtinState !== 'different' ? 'auto' : 'needs_review';
        return { ...base, matchClass: 'identical', confidence: r2(conf), status, method: 'attributes', reasons, components: comps() };
      }
      if (qtyRel === 'different_total') {
        reasons.push(`Same brand "${a.brand}"`, `Same product, different size (${a.qty.label} vs ${b.qty.label})`, `Name similarity ${r2(sim)}`);
        const conf = clamp(0.5 + 0.35 * sim - gtinPenalty, 0, 0.88);
        return {
          ...base,
          matchClass: 'different_pack',
          confidence: r2(conf),
          status: conf >= AUTO_ACCEPT_THRESHOLD - 0.05 && sim >= 0.9 ? 'auto' : 'needs_review',
          method: 'attributes',
          reasons,
          components: comps(),
        };
      }
      // Size unknown/incompatible on one side: can't claim identity.
      reasons.push(`Same brand "${a.brand}"`, `Name similarity ${r2(sim)}`, 'Size could not be verified on both products');
      return {
        ...base,
        matchClass: 'identical',
        confidence: r2(Math.min(0.7, 0.4 + 0.3 * sim)),
        status: 'needs_review',
        method: 'name_similarity',
        reasons,
        components: comps(),
      };
    }
    // One name is entirely contained in the other ("Heinz Ketchup" vs "Heinz Tomato Ketchup"): plausible match,
    // but a descriptor may distinguish different products ("Milk" vs "Chocolate Milk"), so a human must confirm.
    if (isSubset(a.core, b.core) && cat !== 'conflicting') {
      const cls: MatchClass = qtyRel === 'different_total' ? 'different_pack' : qtyRel === 'same_total' ? 'identical' : 'comparable';
      reasons.push(
        `Same brand "${a.brand}"`,
        'One product name is contained in the other; a descriptor may distinguish them',
        qtyRel === 'unknown' || qtyRel === 'incompatible' ? 'Size could not be compared' : `Sizes: ${a.qty.label} vs ${b.qty.label}`,
      );
      return {
        ...base,
        matchClass: cls,
        confidence: r2(0.5 + 0.1 * sim),
        status: 'needs_review',
        method: 'name_similarity',
        reasons,
        components: comps(),
      };
    }
    if (sim >= 0.55 && cat !== 'conflicting') {
      reasons.push(`Same brand "${a.brand}"`, `Related product (name similarity ${r2(sim)})`);
      return {
        ...base,
        matchClass: 'comparable',
        confidence: r2(0.35 + 0.4 * sim),
        status: 'needs_review',
        method: 'name_similarity',
        reasons,
        components: comps(),
      };
    }
    return null;
  }

  // 4 ── brand unknown on one side
  if (brand === 'unknown') {
    if (sim >= 0.9 && qtyRel === 'same_total') {
      reasons.push('Names and sizes agree', `Name similarity ${r2(sim)}`, !a.brandKey && !b.brandKey ? 'Neither product names a brand, so identity rests on the name and size alone' : 'Brand missing on one product, so identity is unconfirmed');
      return {
        ...base,
        matchClass: 'identical',
        confidence: r2(Math.min(0.72, 0.4 + 0.35 * sim)),
        status: 'needs_review',
        method: 'name_similarity',
        reasons,
        components: comps(),
      };
    }
    // the same product sold as a single item and as a multipack: one item is the same size, the pack is not
    const oneItem = (q: PreparedVariant['qty']) => q.unitAmount;
    if (
      sim >= 0.9 && qtyRel === 'different_total' && a.qty.kind === b.qty.kind && oneItem(a.qty) !== null && oneItem(b.qty) !== null &&
      Math.abs(oneItem(a.qty)! - oneItem(b.qty)!) / Math.max(oneItem(a.qty)!, oneItem(b.qty)!) <= 0.01
    ) {
      reasons.push(`Names agree and one item is the same size, but the pack is different (${a.qty.label ?? '?'} vs ${b.qty.label ?? '?'}): compare per unit`, `Name similarity ${r2(sim)}`);
      return { ...base, matchClass: 'different_pack', confidence: r2(Math.min(0.7, 0.4 + 0.35 * sim)), status: 'needs_review', method: 'name_similarity', reasons, components: comps() };
    }
    // the same product in another size ("Almond Breeze Vanilla 32 oz" and "… 64 fl oz"): the original brief's "same product, different pack size", compared per unit
    if (sim >= 0.9 && qtyRel === 'different_total' && a.qty.kind === b.qty.kind && a.qty.kind !== 'unknown' && cat !== 'conflicting') {
      reasons.push(`Names agree but the size differs (${a.qty.label ?? '?'} vs ${b.qty.label ?? '?'}): compare per unit`, `Name similarity ${r2(sim)}`);
      return { ...base, matchClass: 'different_pack', confidence: r2(Math.min(0.65, 0.35 + 0.3 * sim)), status: 'needs_review', method: 'name_similarity', reasons, components: comps() };
    }
    if (sim >= 0.7 && a.qty.kind === b.qty.kind && a.qty.kind !== 'unknown' && cat !== 'conflicting') {
      reasons.push(!a.brandKey && !b.brandKey ? `Similar product, no brand named on either (name similarity ${r2(sim)})` : `Similar product, brand unknown on one side (name similarity ${r2(sim)})`);
      return {
        ...base,
        matchClass: 'comparable',
        confidence: r2(0.3 + 0.35 * sim),
        status: 'needs_review',
        method: 'cross_brand',
        reasons,
        components: comps(),
      };
    }
    return null;
  }

  // 5 ── different brands: only ever "comparable", compared on unit price
  if (sim >= 0.7 && a.qty.kind === b.qty.kind && a.qty.kind !== 'unknown' && cat !== 'conflicting') {
    reasons.push(
      `Different brands ("${a.brand}" vs "${b.brand}") with a similar product (name similarity ${r2(sim)})`,
      'Compare by unit price, not shelf price',
    );
    const conf = clamp(0.3 + 0.4 * sim, 0, 0.7);
    return {
      ...base,
      matchClass: 'comparable',
      confidence: r2(conf),
      status: conf >= 0.6 ? 'auto' : 'needs_review',
      method: 'cross_brand',
      reasons,
      components: comps(),
    };
  }
  return null;
}

// ------------------------------------------------------------------ candidate generation + driver

export interface BuildMatchOptions {
  /** Keep at most this many matches per (source variant, competitor site). */
  perSiteLimit: number;
  maxCandidates: number;
  maxPosting: number;
}

export const DEFAULT_BUILD_OPTIONS: BuildMatchOptions = { perSiteLimit: 3, maxCandidates: 30, maxPosting: 2500 };

const CLASS_PRIORITY: Record<MatchClass, number> = { identical: 0, different_pack: 1, comparable: 2, not_comparable: 3 };

export function buildMatches(
  sources: PreparedVariant[],
  competitors: PreparedVariant[],
  opts: BuildMatchOptions = DEFAULT_BUILD_OPTIONS,
): MatchCandidate[] {
  const gtinIndex = new Map<string, PreparedVariant[]>();
  const tokenIndex = new Map<string, PreparedVariant[]>();
  const brandIndex = new Map<string, PreparedVariant[]>();
  for (const c of competitors) {
    if (c.gtin14) push(gtinIndex, c.gtin14, c);
    if (c.brandKey) push(brandIndex, c.brandKey, c);
    for (const t of new Set(c.core)) push(tokenIndex, t, c);
  }

  const out: MatchCandidate[] = [];
  for (const s of sources) {
    const counts = new Map<PreparedVariant, number>();
    const direct = new Set<PreparedVariant>();
    if (s.gtin14) for (const c of gtinIndex.get(s.gtin14) ?? []) direct.add(c);
    for (const t of new Set(s.core)) {
      const posting = tokenIndex.get(t);
      if (!posting || posting.length > opts.maxPosting) continue;
      for (const c of posting) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const ranked = [...counts.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, opts.maxCandidates)
      .map(([c]) => c);
    const candidates = new Set<PreparedVariant>([...direct, ...ranked]);
    if (s.brandKey) {
      // Add some same-brand items so brand+model matches are not lost when titles differ wildly.
      for (const c of (brandIndex.get(s.brandKey) ?? []).slice(0, 40)) candidates.add(c);
    }

    const bySite = new Map<string, MatchCandidate[]>();
    for (const c of candidates) {
      if (c.siteId === s.siteId) continue;
      const m = scorePair(s, c);
      if (!m) continue;
      const list = bySite.get(c.siteId) ?? [];
      list.push(m);
      bySite.set(c.siteId, list);
    }
    for (const list of bySite.values()) {
      list.sort((x, y) => CLASS_PRIORITY[x.matchClass] - CLASS_PRIORITY[y.matchClass] || y.confidence - x.confidence);
      out.push(...list.slice(0, opts.perSiteLimit));
    }
  }
  return out;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

// ------------------------------------------------------------------ optional AI adjudication

export interface AdjudicationInput {
  a: { title: string; brand: string | null; size: string | null; category: string | null; price?: string | null };
  b: { title: string; brand: string | null; size: string | null; category: string | null; price?: string | null };
  current: Pick<MatchCandidate, 'matchClass' | 'confidence' | 'reasons'>;
}

export interface Adjudication {
  verdict: MatchClass;
  confidence: number;
  rationale: string;
}

export interface MatchAdjudicator {
  readonly id: string;
  adjudicate(input: AdjudicationInput): Promise<Adjudication | null>;
}

/**
 * Applies an AI verdict under hard constraints. The AI may DOWNGRADE freely; it may only UPGRADE a pair when no
 * hard evidence contradicts it, and its verdict is never auto-accepted: the result always needs human review.
 */
export function applyAdjudication(m: MatchCandidate, adj: Adjudication): MatchCandidate {
  let verdict = adj.verdict;
  const rank = (c: MatchClass) => CLASS_PRIORITY[c];
  const notes: string[] = [];
  if (rank(verdict) < rank(m.matchClass)) {
    const c = m.components;
    const hardConflict =
      c.gtin === 'different' ||
      c.brand === 'different' ||
      c.quantity === 'different_total' ||
      c.quantity === 'incompatible';
    if (verdict === 'identical' && hardConflict) {
      verdict = m.matchClass;
      notes.push('AI suggested "identical" but identifiers, brand or size contradict it; verdict ignored');
    }
  }
  return {
    ...m,
    matchClass: verdict,
    confidence: r2(Math.min(0.8, adj.confidence)),
    status: 'needs_review',
    method: 'ai',
    reasons: [...m.reasons, `AI-assisted (${adj.rationale.slice(0, 200)})`, ...notes],
  };
}
