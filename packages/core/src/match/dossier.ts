import type { MatchableVariant, PreparedVariant } from '../matching.ts';
import { normalizeGtin } from '../gtin.ts';
import { stripQuantityText } from '../quantity.ts';
import { normalizeBrand } from '../text.ts';

/**
 * Product dossier (matching engine v2, stage 0): everything a person could use to tell whether two listings are the same, a stand-in or merely
 * related, kept as separate typed facts with the place each one was read from. A fact that is not stated stays unknown — it is never guessed.
 *
 * Extraction is deterministic and knows nothing about any one kind of product: it recognises the SHAPE of things (a code with letters and digits,
 * a year range, a number with a unit) and leaves it to corpus statistics (corpus.ts) to say which of them identify a product on these websites.
 */

/** Where a fact was read: a field the website publishes in a defined place beats the same words found inside a title. */
export type FactSource = 'gtin_field' | 'mpn_field' | 'sku_field' | 'title' | 'variant_title' | 'option' | 'category' | 'tag';

export interface SourcedValue<T> {
  value: T;
  source: FactSource;
}

export type SpecKey = 'power_w' | 'light_lm' | 'colour_temp_k' | 'voltage_v' | 'current_a' | 'length_mm' | 'capacity_mah' | 'storage_gb' | 'frequency_hz' | 'count';

/**
 * hard   — a difference means the products are not interchangeable (a 12 V part does not stand in for a 24 V part)
 * soft   — a difference is a performance tier the person should see, but the products can still stand in for each other
 */
export const SPEC_HARDNESS: Record<SpecKey, 'hard' | 'soft'> = {
  power_w: 'soft', light_lm: 'soft', colour_temp_k: 'soft', voltage_v: 'hard', current_a: 'hard', length_mm: 'hard', capacity_mah: 'soft', storage_gb: 'hard', frequency_hz: 'hard', count: 'soft',
};

export const SPEC_LABEL: Record<SpecKey, string> = {
  power_w: 'power', light_lm: 'light output', colour_temp_k: 'colour temperature', voltage_v: 'voltage', current_a: 'current', length_mm: 'dimension', capacity_mah: 'battery capacity', storage_gb: 'storage', frequency_hz: 'frequency', count: 'count',
};

export interface Spec {
  key: SpecKey;
  /** In the key's base unit (watts, lumens, kelvin, volts, amps, millimetres, mAh, GB, Hz, pieces). */
  value: number;
  /** As written ("12 inch"). */
  raw: string;
  source: FactSource;
}

export interface YearMentions {
  ranges: { from: number; to: number; source: FactSource }[];
  singles: { year: number; source: FactSource }[];
}

export interface Dossier {
  variantId: string;
  productId: string;
  siteId: string;
  /** The sentence-level title (product title plus the variant's own title). */
  title: string;
  legacy: PreparedVariant;
  identifiers: { gtin: SourcedValue<string> | null; mpn: SourcedValue<string> | null; sku: SourcedValue<string> | null };
  brand: { name: string | null; key: string; inferred: boolean };
  /** Code-shaped tokens found in the text, before the corpus says which ones identify a product here. */
  codeTokens: SourcedValue<string>[];
  yearMentions: YearMentions;
  specs: Spec[];
  /** Colours stated for THIS variant: from its own option axis when it has one (precise), else from the title (listed, possibly several). */
  colours: { values: string[]; source: FactSource; fromOptionAxis: boolean };
  /** Items in the offer when it says so ("2 Bulbs", "pack of 4"); null = not stated. */
  packCount: number | null;
  /** Words after "not for" / "does not fit": explicit compatibility exclusions. */
  exclusions: string[];
  bundleMarkers: string[];
  /** The last descriptive words before "for/with/|": what kind of thing the listing is. */
  kind: { tail: string | null; companion: boolean; last3: string[] };
  /** Descriptive words (stemmed, no stop words, no codes, no brand), for type agreement and retrieval. */
  words: string[];
  category: string | null;
  tags: string[];
  /** Option axes of the variant ("Location": "Low beam"). */
  axes: Record<string, string>;
  /** What could not be determined: shown to the reviewer and used to cap the evidence tier. */
  unknown: ('identifier' | 'code' | 'fitment' | 'size' | 'colour')[];
  /** What THIS variant is (which part, which position, which kit): words from its own title and from option axes that name a position or kit. */
  variantTokens: string[];
  /** Words next to each year mention (see `yearContexts`). */
  yearContext: { before: string[]; after: string[] }[];
  // ── resolved against the whole catalogue (corpus.ts); empty until then
  /** Identity codes, aliases folded together, with vehicle/model words taken out. */
  codes: string[];
  /** Words and codes that say WHICH vehicle / appliance / device a listing is for (learned: they accompany year ranges). */
  subject: string[];
  /** Years the listing is for, when it is a fitment listing. */
  fitment: { ranges: { from: number; to: number }[]; years: number[] } | null;
  /** Years that are a vintage or an edition, not a fitment ("Sauvignon Blanc 2013"). */
  vintages: number[];
  /** `variantTokens` that actually tell variants apart in this catalogue (not words found everywhere); empty when the product has no such variants. */
  position: string[];
  /** The words that name what kind of thing this is: the last words of the title's lead part that, across the catalogue, usually come last ("bulb", "mat", "juice"). */
  kindWords: string[];
}

export interface DossierInput extends MatchableVariant {
  options?: Record<string, string> | null;
  tags?: string[] | null;
}

// ─────────────────────────────────────────────────────────────── vocabulary (language-level, not product-level)

const STOP = new Set([
  'the', 'and', 'with', 'for', 'of', 'a', 'an', 'in', 'to', 'by', 'from', 'on', 'at', 'or', 'new', 'fit', 'fits', 'upgrade', 'upgraded', 'series', 'plug', 'play', 'n', 'replacement', 'replace', 'universal',
  'verified', 'tested', 'custom', 'pro', 'plus', 'premium', 'best', 'brightest', 'super', 'bright', 'xtreme', 'extreme', 'ultra', 'high', 'quality', 'free', 'shipping', 'sale', 'only', 'not', 'no', 'all', 'any',
  'your', 'our', 'is', 'are', 'it', 'its', 'this', 'that', 'model', 'models', 'select', 'more', 'available', 'each', 'ea', 'pcs', 'pc', 'pk', 'pack', 'ct', 'count', 'size', 'x', 'w', 'inch', 'in',
]);

/**
 * Nouns that name a thing that goes WITH a product rather than being it. Language-level (an accessory is an accessory in any shop), and the
 * only list in the extractor. It only matters when a listing's kind and the other's disagree on it ("bulb" vs "adapter", "phone" vs "case").
 */
export const COMPANION_NOUNS = new Set([
  'adapter', 'adaptor', 'holder', 'retainer', 'harness', 'decoder', 'resistor', 'canceler', 'canceller', 'relay', 'bracket', 'mount', 'clip', 'connector', 'cable', 'cord', 'wire', 'wiring', 'cover', 'cap',
  'case', 'bezel', 'trim', 'stand', 'charger', 'remote', 'controller', 'fuse', 'gasket', 'seal', 'screw', 'bolt', 'nut', 'washer', 'tool', 'socket', 'base', 'lens', 'refill', 'cartridge', 'strap', 'sleeve', 'dock',
]);

const BUNDLE_RE = /\b(combo|kit|bundle|assortment|multi-?pack|variety pack|value pack|set of \d+)\b/g;

const COLOUR_SEED = ['black', 'white', 'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'brown', 'grey', 'gray', 'silver', 'gold', 'amber', 'clear', 'beige', 'cyan', 'navy', 'teal', 'maroon', 'violet', 'turquoise', 'bronze', 'copper', 'tan', 'ivory'];

export const seedColours = (): Set<string> => new Set(COLOUR_SEED);

const YEAR = '(?:19[5-9]\\d|20[0-3]\\d)';
const YEAR_RANGE = new RegExp(`(?<![\\d])(${YEAR})\\s*(?:-|\\u2013|\\u2014|~|/|to|through|thru|,|\\s)\\s*(${YEAR})(?![\\d])`, 'g');
const YEAR_ONE = new RegExp(`(?<![\\d.,$#-])(${YEAR})(?![\\d])(?![.,]\\d)`, 'g');

/** Unit table: [pattern, key, multiplier into the base unit]. A number with any other unit is not read as a specification. */
const UNITS: [RegExp, SpecKey, number][] = [
  [/^(?:w|watts?)$/, 'power_w', 1], [/^kw$/, 'power_w', 1000],
  [/^(?:lm|lms|lumens?)$/, 'light_lm', 1],
  [/^k$/, 'colour_temp_k', 1],
  [/^(?:v|volts?|vdc)$/, 'voltage_v', 1],
  [/^(?:a|amps?)$/, 'current_a', 1],
  [/^mah$/, 'capacity_mah', 1], [/^ah$/, 'capacity_mah', 1000],
  [/^mm$/, 'length_mm', 1], [/^cm$/, 'length_mm', 10], [/^(?:in|inch|inches)$/, 'length_mm', 25.4], [/^(?:ft|feet|foot)$/, 'length_mm', 304.8],
  [/^gb$/, 'storage_gb', 1], [/^tb$/, 'storage_gb', 1000], [/^mb$/, 'storage_gb', 0.001],
  [/^hz$/, 'frequency_hz', 1], [/^khz$/, 'frequency_hz', 1000], [/^mhz$/, 'frequency_hz', 1e6], [/^ghz$/, 'frequency_hz', 1e9],
  [/^(?:pcs?|pieces?|bulbs?)$/, 'count', 1], [/^pairs?$/, 'count', 2],
];
const SPEC_RE = /(?<![a-z0-9.])(\d+(?:[.,]\d+)?)\s?(w|watts?|kw|lms?|lumens?|k|v|volts?|vdc|a|amps?|mah|ah|mm|cm|inch|inches|in|ft|feet|gb|tb|mb|hz|khz|mhz|ghz|pcs?|pieces?|bulbs?|pairs?)(?![a-z0-9])/g;

const stripDiacritics = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** Lower-case text with the marks that are not part of words normalised; keeps letters, digits and the separators codes use (/ - + .). */
export function plain(text: string | null | undefined): string {
  return stripDiacritics(text ?? '')
    .toLowerCase()
    .replace(/[®™©]/g, ' ')
    .replace(/[“”″"]/g, ' inch ')
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    // "6,000LM" is six thousand, not six: a comma followed by exactly three digits groups thousands
    .replace(/(\d),(\d{3})(?!\d)/g, '$1$2')
    // model names written with a hyphen are one name: "F-150" -> f150, "E-350" -> e350, "CR-V" -> crv, "C-HR" -> chr
    .replace(/\b([a-z]{1,3})-(\d{1,4}[a-z]?)\b/g, '$1$2')
    .replace(/\b(cr|c|hr|rx|gr|crv|z|x)-([a-z]{1,2})\b/g, '$1$2');
}

export function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ch|sh|x|s|z)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

// ─────────────────────────────────────────────────────────────── extractors (pure, individually tested)

export function parseYears(text: string, source: FactSource): YearMentions {
  const t = plain(text);
  const ranges: YearMentions['ranges'] = [];
  const consumed: [number, number][] = [];
  for (const m of t.matchAll(YEAR_RANGE)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const sep = t.slice(m.index! + m[1]!.length, m.index! + m[0].length - m[2]!.length);
    // two years that are only separated by space or a comma are a range when they are close ("2019 2020"); an explicit dash always is
    const explicit = /[-–—~/]|to|through|thru/.test(sep);
    if (b < a || b - a > 40 || (!explicit && b - a > 3)) continue;
    ranges.push({ from: a, to: b, source });
    consumed.push([m.index!, m.index! + m[0].length]);
  }
  const singles: YearMentions['singles'] = [];
  for (const m of t.matchAll(YEAR_ONE)) {
    const at = m.index!;
    if (consumed.some(([s, e]) => at >= s && at < e)) continue;
    // a year that is part of a size ("2000 mg") is not a year
    const after = t.slice(at + 4, at + 9);
    if (/^\s?(mg|mcg|g|kg|ml|l|oz|lb|ct|count|pk|pack|w|v|k|lm|mm|cm|pcs|%)/.test(after)) continue;
    singles.push({ year: Number(m[1]), source });
  }
  return { ranges, singles };
}

/**
 * The words written next to a year or a year range: for a fitment listing these name what it is for ("2018-2021 Chevrolet Traverse LED Bulbs" →
 * after: chevrolet, traverse, led, bulb). The corpus decides how far each list reaches (it stops at the first word that is everywhere).
 */
export function yearContexts(text: string): { before: string[]; after: string[] }[] {
  const t = plain(text);
  const spans: [number, number][] = [];
  for (const m of t.matchAll(YEAR_RANGE)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (b >= a && b - a <= 40) spans.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of t.matchAll(YEAR_ONE)) if (!spans.some(([s, e]) => m.index! >= s && m.index! < e)) spans.push([m.index!, m.index! + m[0].length]);
  // model numbers ("1500", "350") are kept; years and other numbers are not
  const toks = (s: string) =>
    s
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !STOP.has(w) && !(/^\d+$/.test(w) && (w.length < 3 || w.length > 4 || /^(19[5-9]|20[0-3])\d$/.test(w))))
      .map((w) => (/\d/.test(w) ? w : stem(w)));
  return spans.map(([s, e]) => ({ before: toks(t.slice(0, s)).slice(-4).reverse(), after: toks(t.slice(e)).slice(0, 5) }));
}

export function parseSpecs(text: string, source: FactSource): Spec[] {
  const t = plain(text);
  const out: Spec[] = [];
  const seen = new Set<string>();
  for (const m of t.matchAll(SPEC_RE)) {
    const n = Number(m[1]!.replace(',', '.'));
    const unit = m[2]!;
    const row = UNITS.find(([re]) => re.test(unit));
    if (!row || !Number.isFinite(n)) continue;
    let value = n * row[2];
    // "6K" / "8K" are 6000 K / 8000 K when written as thousands
    if (row[1] === 'colour_temp_k' && n < 100) value = n * 1000;
    // a lone "5" in "5 in" is not a dimension when it is followed by more words of a phrase like "5 in 1" (handled by requiring a space/word boundary above)
    if (row[1] === 'length_mm' && /^in$/.test(unit) && /^\s?1(?![0-9])/.test(t.slice(m.index! + m[0].length))) continue;
    const key = `${row[1]}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key: row[1], value: Math.round(value * 1000) / 1000, raw: m[0].trim(), source });
  }
  return out;
}

const CODE_SHAPE = /^[a-z]{0,4}\d{1,5}[a-z]{0,3}(?:-[a-z0-9]{1,4})?$/;
const ORDINAL = /^\d+(?:st|nd|rd|th)$/;

/** Tokens that LOOK like a model, socket or part code. Whether one identifies a product here is the corpus's decision, not this function's. */
export function parseCodeTokens(text: string, _source?: FactSource): string[] {
  let t = plain(text);
  // "100% juice", "2% milk", "0.5% fat" are claims about the contents, never part codes
  t = t.replace(/\d+(?:[.,]\d+)?\s?%/g, ' ');
  t = stripQuantityText(t).replace(YEAR_RANGE, ' ').replace(YEAR_ONE, ' ');
  t = t.replace(SPEC_RE, ' ');
  const out = new Set<string>();
  for (const raw of t.split(/[^a-z0-9/+.-]+/)) {
    const tok = raw.replace(/^[-./+]+|[-./+]+$/g, '');
    if (!tok) continue;
    for (const p of tok.includes('/') || tok.includes('+') ? tok.split(/[/+]/) : [tok]) {
      const c = p.replace(/^[-.]+|[-.]+$/g, '');
      if (!c || !/\d/.test(c) || ORDINAL.test(c)) continue;
      if (/^\d+$/.test(c)) {
        // bare numbers: 3-5 digits can be a part number (9005, 7443, 168); shorter are counts, longer are barcodes or years
        if (c.length < 3 || c.length > 5 || (c.length === 4 && /^(19[5-9]|20[0-3])\d$/.test(c))) continue;
        out.add(c);
        continue;
      }
      if (/^\d+x$/.test(c)) continue;
      if (CODE_SHAPE.test(c)) out.add(c.replace(/-/g, ''));
    }
  }
  return [...out];
}

export function parseExclusions(text: string): string[] {
  const t = plain(text);
  const out = new Set<string>();
  const patterns = [
    /\b(?:not|doesnt|does not|dont|do not|wont|will not)\s+(?:for|fit|fits|compatible with|suitable for|work with|works with)\s+(?:the\s+)?([a-z0-9][a-z0-9 ]{1,30})/g,
    /\bexcluding\s+(?:the\s+)?([a-z0-9][a-z0-9 ]{1,30})/g,
  ];
  for (const re of patterns) {
    for (const m of t.matchAll(re)) {
      for (const w of m[1]!.split(' ').slice(0, 3)) if (w.length >= 3 && !STOP.has(w)) out.add(stem(w));
    }
  }
  return [...out];
}

export function parsePackCount(text: string, fromQuantity: number | null): number | null {
  if (fromQuantity && fromQuantity > 1) return fromQuantity;
  const t = plain(text);
  const m =
    t.match(/\b(?:pack|set|box|case)\s+of\s+(\d{1,3})\b/) ??
    t.match(/\b(\d{1,3})\s*-?\s*(?:pcs?|pieces?|pack|pk|ct|count|bulbs?|pairs?|sets?)\b(?!\s*(?:of\s+)?\d)/) ??
    t.match(/\b(\d{1,2})\s*x\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 500 ? (/pairs?/.test(m[0]) ? n * 2 : n) : null;
}

export function bundleMarkersIn(text: string): string[] {
  return [...new Set([...plain(text).matchAll(BUNDLE_RE)].map((m) => m[1]!.replace(/\s+\d+$/, '')))];
}

/** Where the listing stops saying WHAT it is and starts listing extras, packaging or marketing. */
const EXTRAS_CUT = /\sw\/|\s(?:with|includes?|including|plus)\s|[|,([:;]|\s-\s|\s\/\s/;
const FOR_CUT = /\s(?:for|fits?|fitting|compatible|compatibility|suitable|designed|vs|replaces?)\s/;

/** What kind of thing the listing is: the tail of the words that come before "for / with / |". */
export function kindOf(title: string): { tail: string | null; companion: boolean; last3: string[] } {
  const t = plain(title);
  // the first part that says something ("40W 9003 H4 L1 Plus Series | 4,000LM LED Bulbs" says it in the second part)
  for (const part of t.split(/\s*\|\s*/)) {
    const head = part.split(EXTRAS_CUT)[0] ?? part;
    // "Fit for 2021 Toyota Sienna LED Lights" / "2011-2014 Toyota Sienna LED Bulbs": the kind comes at the end of the text, not before a "for"
    const fitFirst = /^\s*(?:fits?\s+(?:for\s+)?|for\s+)/.test(head) || /^\s*(?:19|20)\d\d/.test(head);
    let seg = fitFirst ? head : (head.split(FOR_CUT)[0] ?? head);
    if (seg.trim().length < 3) seg = head;
    const words = stripQuantityText(seg.replace(YEAR_RANGE, ' ').replace(YEAR_ONE, ' '))
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w))
      .map(stem);
    if (!words.length) continue;
    const last3 = words.slice(-3);
    const comp = [...last3].reverse().find((w) => COMPANION_NOUNS.has(w));
    return comp ? { tail: comp, companion: true, last3 } : { tail: words[words.length - 1]!, companion: false, last3 };
  }
  return { tail: null, companion: false, last3: [] };
}

/** Option axes that say WHICH PART / position / kit a variant is (not which vehicle trim it is for): a language-level reading of the axis name. */
const POSITION_AXIS = /location|position|application|package|set-?up|installation|choose your|which/i;

export function variantTokensOf(variantTitle: string | null, options: Record<string, string> | null | undefined): string[] {
  const texts: string[] = [];
  if (variantTitle) texts.push(variantTitle);
  for (const [k, v] of Object.entries(options ?? {})) if (POSITION_AXIS.test(k) && typeof v === 'string') texts.push(v);
  const out = new Set<string>();
  for (const t of texts) {
    for (const w of plain(t).split(/[^a-z]+/)) if (w.length >= 3 && !STOP.has(w)) out.add(stem(w));
    for (const c of parseCodeTokens(t)) out.add(c);
  }
  return [...out];
}

const COLOUR_AXIS = /colou?r|finish|shade|tint/i;

export function coloursOf(text: string, options: Record<string, string> | null | undefined, vocab: Set<string>): Dossier['colours'] {
  for (const [k, v] of Object.entries(options ?? {})) {
    if (!COLOUR_AXIS.test(k)) continue;
    const found = plain(v).split(/[^a-z]+/).filter((w) => vocab.has(w));
    if (found.length) return { values: [...new Set(found.map(canonColour))], source: 'option', fromOptionAxis: true };
  }
  const found = plain(text).split(/[^a-z]+/).filter((w) => vocab.has(w));
  return { values: [...new Set(found.map(canonColour))], source: 'title', fromOptionAxis: false };
}

/** Same colour, different word. */
function canonColour(w: string): string {
  return w === 'gray' ? 'grey' : w === 'yellow' || w === 'golden' ? (w === 'golden' ? 'gold' : 'amber') : w === 'smoke' || w === 'smoked' ? 'smoke' : w;
}

// ─────────────────────────────────────────────────────────────── building a dossier

export function buildDossier(input: DossierInput, legacy: PreparedVariant, colourVocab: Set<string>): Dossier {
  const variantTitle = input.variantTitle && input.variantTitle.toLowerCase() !== 'default title' ? input.variantTitle : null;
  const options = input.options ?? {};
  const optionText = Object.values(options).join(' ');
  const parts: [string, FactSource][] = [[input.title, 'title']];
  if (variantTitle) parts.push([variantTitle, 'variant_title']);
  if (optionText) parts.push([optionText, 'option']);

  const gtin = normalizeGtin(input.gtin);
  const codeTokens: SourcedValue<string>[] = [];
  const seenCode = new Set<string>();
  const yearMentions: YearMentions = { ranges: [], singles: [] };
  const specs: Spec[] = [];
  for (const [txt, src] of parts) {
    for (const c of parseCodeTokens(txt, src)) if (!seenCode.has(c)) { seenCode.add(c); codeTokens.push({ value: c, source: src }); }
    const y = parseYears(txt, src);
    yearMentions.ranges.push(...y.ranges);
    yearMentions.singles.push(...y.singles);
    for (const s of parseSpecs(txt, src)) if (!specs.some((x) => x.key === s.key && x.value === s.value)) specs.push(s);
  }
  const fullText = parts.map(([t]) => t).join(' ');
  const brandWords = new Set(normalizeBrand(legacy.brand).split(' ').filter(Boolean).map(stem));
  const exclusions = parseExclusions(fullText);
  const words = [
    ...new Set(
      plain(`${stripQuantityText(fullText)} ${input.category ?? ''}`)
        .replace(YEAR_RANGE, ' ')
        .replace(YEAR_ONE, ' ')
        .split(/[^a-z]+/)
        .filter((w) => w.length >= 3 && !STOP.has(w))
        .map(stem),
    ),
  ].filter((w) => !brandWords.has(w) && w !== legacy.brandKey && !exclusions.includes(w));
  const colours = coloursOf(fullText, options, colourVocab);
  const pack = parsePackCount(fullText, legacy.qty.packCount);
  const unknown: Dossier['unknown'] = [];
  if (!gtin && !legacy.mpnKey) unknown.push('identifier');
  if (!codeTokens.length) unknown.push('code');
  if (!yearMentions.ranges.length && !yearMentions.singles.length) unknown.push('fitment');
  if (legacy.qty.kind === 'unknown' && !specs.some((s) => s.key === 'length_mm')) unknown.push('size');
  if (!colours.values.length) unknown.push('colour');

  return {
    variantId: input.variantId,
    productId: input.productId,
    siteId: input.siteId,
    title: legacy.fullTitle,
    legacy,
    identifiers: {
      gtin: gtin ? { value: gtin, source: 'gtin_field' } : null,
      mpn: legacy.mpnKey ? { value: legacy.mpnKey, source: 'mpn_field' } : null,
      sku: legacy.skuKey ? { value: legacy.skuKey, source: 'sku_field' } : null,
    },
    brand: { name: legacy.brand, key: legacy.brandKey, inferred: legacy.brandInferred },
    codeTokens,
    yearMentions,
    specs,
    colours,
    packCount: pack,
    exclusions,
    bundleMarkers: bundleMarkersIn(fullText),
    kind: kindOf(input.title),
    words,
    category: input.category ?? null,
    tags: (input.tags ?? []).filter((t) => typeof t === 'string').slice(0, 30),
    axes: options,
    unknown,
    variantTokens: variantTokensOf(variantTitle, options),
    yearContext: yearContexts(fullText),
    codes: [],
    subject: [],
    fitment: null,
    vintages: [],
    kindWords: [],
    position: [],
  };
}
