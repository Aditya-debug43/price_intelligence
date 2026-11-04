import { INCOMPARABLE_QUANTITY_MISMATCH, type QuantityCheck, type QuantityDimension, type QuantitySide, type QuantityVerdict } from '@ci/shared';
import { parseQuantity, type ParsedQuantity } from './quantity.ts';

/**
 * The quantity-compatibility policy. Two products are compared on price only when they hold the SAME ACTUAL QUANTITY. Products with different quantities are
 * left incomparable for now: their prices are not compared, and not converted into a price per litre, per kilogram or per item to make them comparable.
 *
 * Units are converted here only to decide whether two quantities are equal (1 L = 1000 ml, 1 kg = 1000 g, 2 m = 200 cm). Nothing is converted between
 * different kinds of measure (a kilogram is not a litre) and nothing is inferred: a quantity that a product does not state stays unknown, and an unknown
 * quantity is never taken as a match.
 *
 * Kept apart from the "same product?" decision on purpose: a pair can be the same product and still incomparable (a 10 L and a 20 L bottle of one oil), and
 * the stored reason says which of the two it is.
 */

export const QUANTITY_POLICY_VERSION = 'quantity-1';

/** The base unit of each kind of quantity read: millilitres, grams, pieces, millimetres, square millimetres. */
export const BASE_UNIT: Record<QuantityDimension, 'ml' | 'g' | 'pcs' | 'mm' | 'mm²'> = { volume: 'ml', mass: 'g', count: 'pcs', length: 'mm', area: 'mm²' };

/** Where the quantity was read from. */
export type QuantityReadFrom = NonNullable<QuantitySide['source']>;

/** What one product says it holds. `total` is the whole offer in the base unit of its dimension; the pack configuration is kept apart from it. */
export interface MeasuredQuantity {
  dimension: QuantityDimension | null;
  /** The whole offer in the base unit (ml, g, pieces, mm, mm²): items in the pack × the size of one. Null when not stated. */
  total: number | null;
  /** The size of ONE item in the base unit, when it is stated ("6 × 355 ml" → 355). */
  unitAmount: number | null;
  /** How many items the offer is made of, when it says ("6 × 355 ml" → 6). */
  packCount: number | null;
  /** The quantity as the product states it ("6 × 355 ml", "2 L"). */
  label: string | null;
  source: QuantityReadFrom | null;
  /** Why the number cannot be trusted ('conflict': the text states two pack counts; 'oz': ounces that may be weight or fluid), when it cannot. */
  doubt: 'conflict' | 'oz' | null;
}

export const NO_QUANTITY: MeasuredQuantity = { dimension: null, total: null, unitAmount: null, packCount: null, label: null, source: null, doubt: null };

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const num = (s: string) => Number(s.replace(',', '.'));
const NUM = '((?:\\d+(?:[.,]\\d+)?|[.,]\\d+))';

// ───────────────────────────────────────────────────── length and area (the size parser in quantity.ts reads volume, mass and counts)

const LENGTH_MM: Record<string, number> = {
  mm: 1, millimeter: 1, millimeters: 1, millimetre: 1, millimetres: 1,
  cm: 10, centimeter: 10, centimeters: 10, centimetre: 10, centimetres: 10,
  m: 1000, meter: 1000, meters: 1000, metre: 1000, metres: 1000,
  inch: 25.4, inches: 25.4, '"': 25.4,
  ft: 304.8, foot: 304.8, feet: 304.8,
  yd: 914.4, yard: 914.4, yards: 914.4,
};
const LENGTH_UNIT = 'millimet(?:er|re)s?|centimet(?:er|re)s?|met(?:er|re)s?|mm|cm|inch(?:es)?|feet|foot|ft|yards?|yd|m|"';
const AREA_MM2: Record<string, number> = {
  sqm: 1e6, sqmeter: 1e6, sqmeters: 1e6, sqmetre: 1e6, sqmetres: 1e6, squaremeter: 1e6, squaremeters: 1e6, squaremetre: 1e6, squaremetres: 1e6, m2: 1e6, 'm²': 1e6,
  sqft: 92903.04, sqfeet: 92903.04, sqfoot: 92903.04, squarefeet: 92903.04, squarefoot: 92903.04, ft2: 92903.04, 'ft²': 92903.04,
  sqin: 645.16, sqinch: 645.16, sqinches: 645.16, squareinch: 645.16, squareinches: 645.16,
  sqcm: 100, squarecentimeter: 100, squarecentimeters: 100, squarecentimetre: 100, squarecentimetres: 100, cm2: 100, 'cm²': 100,
  sqmm: 1,
  sqyd: 836127.36, sqyards: 836127.36, squareyard: 836127.36, squareyards: 836127.36,
};
const AREA_UNIT = '(?:sq\\.?\\s*(?:meters?|metres?|feet|foot|ft|yards?|yd|inch(?:es)?|in|cm|mm|m)|square\\s+(?:meters?|metres?|feet|foot|inch(?:es)?|centimet(?:er|re)s?|yards?)|sqft|sqm|m²|m2|ft²|ft2|cm²|cm2)';

function lengthOrArea(text: string): Pick<MeasuredQuantity, 'dimension' | 'total' | 'unitAmount' | 'packCount' | 'label'> | null {
  const s = ` ${text.toLowerCase().replace(/×/g, 'x').replace(/\s+/g, ' ')} `;
  // area first: "25 sq ft" must not be read as 25 ft
  const area = s.match(new RegExp(`(?<![\\d.,a-z])${NUM}\\s*(${AREA_UNIT})(?![a-z0-9²])`, 'i'));
  if (area) {
    const f = AREA_MM2[area[2]!.replace(/[.\s]/g, '')];
    if (f) {
      const each = num(area[1]!) * f;
      return { dimension: 'area', total: round4(each), unitAmount: round4(each), packCount: null, label: `${area[1]} ${area[2]!.replace(/\s+/g, ' ')}`.trim() };
    }
  }
  // "2 x 5 m"
  const multi = s.match(new RegExp(`(?<![\\d.,])(\\d{1,3})\\s*x\\s*${NUM}\\s*(${LENGTH_UNIT})(?![a-z0-9²])`, 'i'));
  if (multi) {
    const f = LENGTH_MM[multi[3]!];
    if (f) {
      const each = num(multi[2]!) * f;
      const n = Number(multi[1]);
      return { dimension: 'length', total: round4(each * n), unitAmount: round4(each), packCount: n, label: `${n} × ${fmt(num(multi[2]!))} ${multi[3]}` };
    }
  }
  const one = s.match(new RegExp(`(?<![\\d.,a-z])${NUM}\\s*(${LENGTH_UNIT})(?![a-z0-9²])`, 'i'));
  if (one) {
    const f = LENGTH_MM[one[2]!];
    if (f) {
      const each = num(one[1]!) * f;
      return { dimension: 'length', total: round4(each), unitAmount: round4(each), packCount: null, label: `${fmt(num(one[1]!))} ${one[2]}` };
    }
  }
  return null;
}

/**
 * Things whose stated length or width is a PHYSICAL DIMENSION (a 42 mm festoon bulb, a 31 mm dome lamp, a 5 mm LED), never how much is sold: a bulb is not sold "by the millimetre".
 * Reading such a length as the quantity made a 42 mm bulb and a 41 mm bulb "hold different quantities" and left the pair out of every price comparison. For these a length is a
 * specification (kept by the dossier as length_mm); the quantity comes from a count ("2 bulbs", "2-pack") or stays unknown. Things really sold by length (cable, tape, hose, ribbon,
 * a roll of film) are not matched here, so their length is still their quantity.
 */
const DIMENSIONAL_ITEM = /\b(?:bulbs?|lamps?|led|leds|festoon|wedge|halogen|hid|xenon|capsule|headlights?|taillights?|tail lights?|fog lights?|brake lights?|turn signals?|dome lights?|interior lights?|license plate|fuses?|relays?|sockets?|connectors?|retainers?|adapters?|decoders?|resistors?|wipers?|blades?|bezels?|lens(?:es)?)\b/i;

/** A few counts the size parser does not know ("60 sheets", "30 tablets"): read only when nothing else states a size. */
const COUNT_NOUNS = 'sheets?|wipes?|tablets?|capsules?|softgels?|caplets?|pods?';
function extraCount(text: string): Pick<MeasuredQuantity, 'dimension' | 'total' | 'unitAmount' | 'packCount' | 'label'> | null {
  const m = ` ${text.toLowerCase()} `.match(new RegExp(`(?<![\\d.,a-z])(\\d{1,4})\\s*-?\\s*(?:${COUNT_NOUNS})(?![a-z])`, 'i'));
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? { dimension: 'count', total: n, unitAmount: null, packCount: n, label: `${n} pcs` } : null;
}

// ───────────────────────────────────────────────────── reading what a product says it holds

export interface QuantityTexts {
  /** The title and the variant's own title, as the matcher reads them. */
  title: string;
  /** The values of the variant's option axes ("Size": "1 L"). */
  options?: Record<string, string> | null;
  /** The other places a size is written: the stored size label, the shop's size attribute or "Size_…" tag. */
  sizeHints?: (string | null | undefined)[];
  /** A labelled net-content statement from the product page's description ("Net weight: 500 g"): only read when nothing else states a quantity. */
  netContent?: string | null;
}

const OZ_WEIGHT_RE = /\boz\b|\bounces?\b/i;
const FLUID_RE = /\bfl\b|fluid/i;

function fromParsed(q: ParsedQuantity, source: QuantityReadFrom): MeasuredQuantity {
  const dimension: QuantityDimension | null = q.kind === 'mass' ? 'mass' : q.kind === 'volume' ? 'volume' : q.kind === 'count' ? 'count' : null;
  if (!dimension || q.total === null) return NO_QUANTITY;
  return {
    dimension, total: q.total, unitAmount: q.unitAmount, packCount: q.packCount, label: q.label, source,
    doubt: q.conflict ? 'conflict' : dimension === 'mass' && OZ_WEIGHT_RE.test(q.source) && !FLUID_RE.test(q.source) ? 'oz' : null,
  };
}

/**
 * What a product holds, read in this order of trust: the size the matcher already parsed from the title and the shop's own size hints (`parsed`, so the
 * policy and the matcher never disagree about a title), then the variant's option values, then a length or area written in the title, then a labelled
 * net-content statement in the description. A number with no unit beside it (a model number, a bulb code, a year) is never a quantity.
 */
export function measureQuantity(parsed: ParsedQuantity, t: QuantityTexts): MeasuredQuantity {
  // a size the matcher read from the title or a size hint
  if (parsed.kind !== 'unknown') {
    const fromHint = (t.sizeHints ?? []).some((h) => !!h && h === parsed.source);
    // a count with no size ("12 pack") may be completed by a size stated in an option ("Size": "355 ml"): the pack and the size of one stay separate facts, so it stays a count
    return fromParsed(parsed, fromHint ? 'size_hint' : 'title');
  }
  const optionValues = Object.values(t.options ?? {}).filter((v): v is string => typeof v === 'string' && /\d/.test(v));
  for (const v of optionValues) {
    const q = parseQuantity(v);
    if (q.kind !== 'unknown') return fromParsed(q, 'option');
  }
  // a length on a bulb, a lamp, a fitting or a mat is a dimension of the thing, not the amount sold (see DIMENSIONAL_ITEM)
  const dimensional = DIMENSIONAL_ITEM.test(t.title);
  const own = dimensional ? null : lengthOrArea(t.title) ?? optionValues.map(lengthOrArea).find(Boolean) ?? null;
  if (own) return { ...own, source: 'title', doubt: null };
  const count = extraCount(t.title);
  if (count) return { ...count, source: 'title', doubt: null };
  if (t.netContent) {
    const q = parseQuantity(t.netContent);
    if (q.kind !== 'unknown') return fromParsed(q, 'description');
    const la = lengthOrArea(t.netContent);
    if (la) return { ...la, source: 'description', doubt: null };
  }
  return NO_QUANTITY;
}

/** What a stored variant row says (the size parsed when it was collected): the fallback for a pair nobody has assessed in full. */
export function measureStored(kind: string | null, total: number | null, label: string | null): MeasuredQuantity {
  const dimension: QuantityDimension | null = kind === 'mass' ? 'mass' : kind === 'volume' ? 'volume' : kind === 'count' ? 'count' : null;
  if (!dimension || total === null || !(total > 0)) return NO_QUANTITY;
  return { dimension, total, unitAmount: null, packCount: null, label, source: 'size_hint', doubt: null };
}

// ───────────────────────────────────────────────────── comparing two products' quantities

export type QuantityAssessment = QuantityCheck;

/** Quantities equal to within a rounding of a label (16.9 fl oz written for 500 ml). */
export const QUANTITY_TOLERANCE = 0.01;

const side = (q: MeasuredQuantity): QuantitySide => ({ dimension: q.dimension, total: q.total, unit: q.dimension ? BASE_UNIT[q.dimension] : null, label: q.label, source: q.source });
const shown = (q: MeasuredQuantity) => q.label ?? (q.total !== null && q.dimension ? `${fmt(q.total)} ${BASE_UNIT[q.dimension]}` : 'not stated');

export function assessQuantities(a: MeasuredQuantity, b: MeasuredQuantity): QuantityAssessment {
  const packaging = { a: a.packCount && a.packCount > 1 ? a.label : null, b: b.packCount && b.packCount > 1 ? b.label : null, differs: (a.packCount ?? 1) !== (b.packCount ?? 1) };
  const out = (verdict: QuantityVerdict, note: string): QuantityAssessment => ({
    policy: QUANTITY_POLICY_VERSION, verdict, exclusion: verdict === 'different' ? INCOMPARABLE_QUANTITY_MISMATCH : null, note, a: side(a), b: side(b), packaging,
  });
  if (!a.dimension || a.total === null || !b.dimension || b.total === null) {
    const missing = !a.dimension || a.total === null ? (!b.dimension || b.total === null ? 'neither product states' : 'your product does not state') : 'the other product does not state';
    return out('unknown', `Quantity unknown: ${missing} a quantity, so it is not taken as a match`);
  }
  if (a.doubt === 'conflict' || b.doubt === 'conflict') return out('unknown', `Quantity unclear: a title gives two different pack counts (${shown(a)} vs ${shown(b)})`);
  if (a.dimension !== b.dimension) {
    // a count with no size (a "6 pack") against a measured quantity: the pack does not say how much one item holds
    if (a.dimension === 'count' || b.dimension === 'count') return out('unknown', `Quantity unknown: one product states only a count (${shown(a)} vs ${shown(b)}), so the totals cannot be compared`);
    // ounces written for a weight may be fluid ounces
    if ((a.doubt === 'oz' && b.dimension === 'volume') || (b.doubt === 'oz' && a.dimension === 'volume')) return out('unknown', `Quantity unclear: ounces may be a weight or a volume (${shown(a)} vs ${shown(b)})`);
    return out('different', `Quantities are measured differently (${a.dimension} ${shown(a)} vs ${b.dimension} ${shown(b)}): equal quantity cannot be established`);
  }
  const rel = Math.abs(a.total - b.total) / Math.max(a.total, b.total);
  if (a.dimension === 'count' ? a.total === b.total : rel <= QUANTITY_TOLERANCE) {
    return out('same', `Same total ${a.dimension === 'count' ? 'count' : a.dimension} (${shown(a)}${shown(a) === shown(b) ? '' : ` = ${shown(b)}`})${packaging.differs ? '; packaged differently' : ''}`);
  }
  return out('different', `Actual ${a.dimension === 'count' ? 'count' : a.dimension} differs (${shown(a)} vs ${shown(b)})`);
}

/** Whether a pair that a PERSON confirmed may be used for price comparison: unless the quantities are shown to differ, the person's own check stands. */
export const personConfirmedEligible = (v: QuantityVerdict): boolean => v !== 'different';
/** Whether an AUTOMATIC confirmation, or a price conclusion on an exact pair, may stand on the quantities: only when they are shown to be equal. */
export const automaticEligible = (v: QuantityVerdict): boolean => v === 'same';
