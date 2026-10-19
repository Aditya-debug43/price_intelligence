/**
 * Size / pack normalisation for comparing "the same thing" across shops.
 * Everything is converted to base units: grams (mass), millilitres (volume) or pieces (count).
 */

export type QuantityKind = 'mass' | 'volume' | 'count' | 'unknown';

export interface ParsedQuantity {
  kind: QuantityKind;
  /** Base units in ONE sellable item (g or ml). Null for pure counts or unknown. */
  unitAmount: number | null;
  /** Items bundled in the pack ("6 x 355 ml" => 6). Null when not stated. */
  packCount: number | null;
  /** Total base units in the offer (g, ml, or pieces). Null when not derivable. */
  total: number | null;
  baseUnit: 'g' | 'ml' | 'ea' | null;
  /** Human-friendly label, e.g. "6 × 355 ml". */
  label: string | null;
  source: string;
  /** The text states two different pack counts ("24 Pack, 12×12 oz"), so the size cannot be trusted for matching. */
  conflict?: true;
}

const MASS: Record<string, number> = {
  mg: 0.001, g: 1, gr: 1, gm: 1, gms: 1, gram: 1, grams: 1, gramme: 1, grammes: 1,
  kg: 1000, kgs: 1000, kilo: 1000, kilos: 1000, kilogram: 1000, kilograms: 1000,
  oz: 28.349523125, ounce: 28.349523125, ounces: 28.349523125,
  lb: 453.59237, lbs: 453.59237, pound: 453.59237, pounds: 453.59237,
};
const VOLUME: Record<string, number> = {
  ml: 1, milliliter: 1, milliliters: 1, millilitre: 1, millilitres: 1,
  cl: 10, dl: 100,
  l: 1000, lt: 1000, ltr: 1000, ltrs: 1000, liter: 1000, liters: 1000, litre: 1000, litres: 1000,
  floz: 29.5735295625, 'fl oz': 29.5735295625,
  gal: 3785.411784, gallon: 3785.411784, gallons: 3785.411784,
  pt: 473.176473, qt: 946.352946,
};

const UNIT_RE =
  'kilograms?|kilos?|kgs?|grammes?|grams?|gms?|gr|mg|g|ounces?|oz|pounds?|lbs?|' +
  'milliliters?|millilitres?|ml|cl|dl|liters?|litres?|ltrs?|ltr|lt|l|fl\\.?\\s?oz|gallons?|gal|pt|qt';
const NUM = '(\\d+(?:[.,]\\d+)?)';
/** Pack counts shops really sell in; used to tell "24-12 oz" (24 cans of 12 oz) from a size range. */
const COMMON_PACKS = new Set([2, 3, 4, 6, 8, 10, 12, 15, 16, 18, 20, 24, 30, 32, 36, 40, 48]);
const PACK_WORDS = 'pack|pk|ct|count|pcs|pc|pieces?|stuks|stuk|units?|ea|each|bottles?|cans?|bags?|rolls?|sachets?';

function num(s: string): number {
  return Number(s.replace(',', '.'));
}

function unitFactor(unitRaw: string): { kind: 'mass' | 'volume'; factor: number } | null {
  const u = unitRaw.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  const compact = u.replace(' ', '');
  if (compact === 'floz') return { kind: 'volume', factor: VOLUME.floz! };
  if (u in MASS) return { kind: 'mass', factor: MASS[u]! };
  if (u in VOLUME) return { kind: 'volume', factor: VOLUME[u]! };
  return null;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function label(kind: 'mass' | 'volume', unitAmount: number, packCount: number | null): string {
  const one = kind === 'mass' ? (unitAmount >= 1000 ? `${fmt(unitAmount / 1000)} kg` : `${fmt(unitAmount)} g`) : unitAmount >= 1000 ? `${fmt(unitAmount / 1000)} L` : `${fmt(unitAmount)} ml`;
  return packCount && packCount > 1 ? `${packCount} × ${one}` : one;
}

export function parseQuantity(...texts: (string | null | undefined)[]): ParsedQuantity {
  for (const t of texts) {
    if (!t) continue;
    const q = parseOne(t);
    if (q.kind !== 'unknown') return q;
  }
  // Fall back to a bare pack count in any text.
  for (const t of texts) {
    if (!t) continue;
    const q = parseOne(t);
    if (q.packCount) return q;
  }
  return { kind: 'unknown', unitAmount: null, packCount: null, total: null, baseUnit: null, label: null, source: '' };
}

function parseOne(text: string): ParsedQuantity {
  const s = ` ${text.toLowerCase().replace(/[()]/g, ' ').replace(/×/g, 'x').replace(/\s+/g, ' ')} `;

  let packCount: number | null = null;
  let measure: { kind: 'mass' | 'volume'; amount: number; match: string } | null = null;

  // "6 x 355 ml" / "6x355ml"
  const mult = s.match(new RegExp(`(?<![\\d.,])(\\d{1,3})\\s*x\\s*${NUM}\\s*(${UNIT_RE})(?![a-z])`, 'i'));
  if (mult) {
    const f = unitFactor(mult[3]!);
    if (f) {
      packCount = Number(mult[1]);
      measure = { kind: f.kind, amount: num(mult[2]!) * f.factor, match: mult[0] };
    }
  }
  // "355 ml x 6"
  if (!measure) {
    const rev = s.match(new RegExp(`${NUM}\\s*(${UNIT_RE})\\s*x\\s*(\\d{1,3})(?![\\d.,a-z])`, 'i'));
    if (rev) {
      const f = unitFactor(rev[2]!);
      if (f) {
        packCount = Number(rev[3]);
        measure = { kind: f.kind, amount: num(rev[1]!) * f.factor, match: rev[0] };
      }
    }
  }
  // "12-12 oz", "24-20 oz", "6-330 ml": a pack count, a hyphen, the size of one item (no spaces around the hyphen). Only common pack counts
  // count, so a range like "50-60 g" or "1-2 oz" is not read as a pack.
  if (!measure) {
    const hy = s.match(new RegExp(`(?<![\\d.,-])(\\d{1,2})-${NUM}\\s*(${UNIT_RE})(?![a-z])`, 'i'));
    if (hy && COMMON_PACKS.has(Number(hy[1]))) {
      const f = unitFactor(hy[3]!);
      if (f) {
        packCount = Number(hy[1]);
        measure = { kind: f.kind, amount: num(hy[2]!) * f.factor, match: hy[0] };
      }
    }
  }
  // Plain measure; prefer the first occurrence that looks like a package size.
  if (!measure) {
    const re = new RegExp(`(?<![\\d.,a-z])${NUM}\\s*(${UNIT_RE})(?![a-z])`, 'gi');
    for (const m of s.matchAll(re)) {
      const f = unitFactor(m[2]!);
      if (!f) continue;
      measure = { kind: f.kind, amount: num(m[1]!) * f.factor, match: m[0] };
      break;
    }
  }
  // Explicit pack words: "12 pack", "pack of 6", "6-pack", "dozen"
  let conflict = false;
  if (packCount !== null) {
    // "24 Pack, 12×12 oz" says 24 and 12: the size cannot be trusted
    const stated = s.match(/(?<![\d.,x])(\d{1,3})\s*-?\s*(?:pack|pk)(?![a-z])/i) ?? s.match(/(?:pack|case|box|set) of (\d{1,3})(?![\d])/i);
    if (stated && Number(stated[1]) > 1 && Number(stated[1]) !== packCount) conflict = true;
  }
  if (packCount === null) {
    const a = s.match(new RegExp(`(?<![\\d.,])(\\d{1,3})\\s*-?\\s*(?:${PACK_WORDS})(?![a-z])`, 'i'));
    const b = s.match(/(?:pack|case|box|set) of (\d{1,3})(?![\d])/i);
    const c = /\bdozen\b/i.test(s) ? 12 : null;
    const half = /\bhalf[- ]dozen\b/i.test(s) ? 6 : null;
    const p = half ?? (a ? Number(a[1]) : b ? Number(b[1]) : c);
    if (p && p > 0 && p < 1000) packCount = p;
  }
  // A "6 x 355ml" with the unit parsed from elsewhere is handled above; guard silly values.
  if (packCount !== null && (packCount < 1 || packCount > 999)) packCount = null;

  if (measure && measure.amount > 0) {
    const total = measure.amount * (packCount ?? 1);
    return {
      kind: measure.kind,
      unitAmount: round4(measure.amount),
      packCount,
      total: round4(total),
      baseUnit: measure.kind === 'mass' ? 'g' : 'ml',
      label: label(measure.kind, measure.amount, packCount),
      source: text,
      ...(conflict ? { conflict: true as const } : {}),
    };
  }
  if (packCount !== null) {
    return {
      kind: 'count',
      unitAmount: null,
      packCount,
      total: packCount,
      baseUnit: 'ea',
      label: `${packCount} pcs`,
      source: text,
    };
  }
  return { kind: 'unknown', unitAmount: null, packCount: null, total: null, baseUnit: null, label: null, source: text };
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

const BEVERAGE_RE = /\b(soda|sodas|colas?|juices?|water|beers?|lagers?|wines?|champagne|milk|drinks?|beverages?|lemonades?|tea|coffee|smoothies?|cider|liquors?|spirits?|rum|vodka|whisk(?:e)?y|gin|tonic|energy)\b/i;
const OZ_RE = /(?<![a-z])\d+(?:[.,]\d+)?\s*(?:oz|ounces?)(?![a-z])/i;

/**
 * "12 oz" is ambiguous (weight vs fluid ounces). When the product is clearly a beverage and the text says
 * plain "oz" (not "fl oz"), reinterpret the quantity as a volume so it can be compared with ml/L sizes.
 */
export function reinterpretOzForBeverage(q: ParsedQuantity, title: string): ParsedQuantity {
  if (q.kind !== 'mass' || !BEVERAGE_RE.test(title) || !OZ_RE.test(q.source) || /fl\.?\s?oz/i.test(q.source)) return q;
  const k = VOLUME.floz! / MASS.oz!;
  const unitAmount = q.unitAmount === null ? null : round4(q.unitAmount * k);
  const total = q.total === null ? null : round4(q.total * k);
  return {
    ...q,
    kind: 'volume',
    unitAmount,
    total,
    baseUnit: 'ml',
    label: unitAmount === null ? q.label : label('volume', unitAmount, q.packCount),
  };
}

export type QuantityRelation = 'same_total' | 'different_total' | 'incompatible' | 'unknown';

export function compareQuantities(a: ParsedQuantity, b: ParsedQuantity, tolerance = 0.01): QuantityRelation {
  if (a.kind === 'unknown' || b.kind === 'unknown' || a.total === null || b.total === null) return 'unknown';
  if (a.conflict || b.conflict) return 'unknown'; // a size that states two different pack counts cannot be verified
  if (a.kind !== b.kind) {
    // A pure count ("6 pack") and a measured item are not comparable by total.
    return 'incompatible';
  }
  const rel = Math.abs(a.total - b.total) / Math.max(a.total, b.total);
  return rel <= tolerance ? 'same_total' : 'different_total';
}

export interface UnitPrice {
  value: number;
  unit: 'per 100 g' | 'per L' | 'per item';
}

/** Price per standard reference unit: 100 g, 1 L, or 1 piece. Null when the size is unknown. */
export function unitPrice(price: number | null, q: ParsedQuantity): UnitPrice | null {
  if (price === null || q.total === null || q.total <= 0) return null;
  if (q.kind === 'mass') return { value: round4((price / q.total) * 100), unit: 'per 100 g' };
  if (q.kind === 'volume') return { value: round4((price / q.total) * 1000), unit: 'per L' };
  if (q.kind === 'count') return { value: round4(price / q.total), unit: 'per item' };
  return null;
}

/** Remove size/pack expressions so the remaining words describe only the product. */
export function stripQuantityText(text: string): string {
  return text
    .toLowerCase()
    .replace(new RegExp(`\\d{1,3}\\s*[x×]\\s*${NUM}\\s*(?:${UNIT_RE})(?![a-z])`, 'gi'), ' ')
    .replace(new RegExp(`${NUM}\\s*(?:${UNIT_RE})\\s*[x×]\\s*\\d{1,3}`, 'gi'), ' ')
    .replace(new RegExp(`${NUM}\\s*(?:${UNIT_RE})(?![a-z])`, 'gi'), ' ')
    .replace(new RegExp(`\\d{1,3}\\s*-?\\s*(?:${PACK_WORDS})(?![a-z])`, 'gi'), ' ')
    .replace(/(?:pack|case|box|set) of \d{1,3}/gi, ' ')
    .replace(/\b(?:half[- ])?dozen\b/gi, ' ');
}
