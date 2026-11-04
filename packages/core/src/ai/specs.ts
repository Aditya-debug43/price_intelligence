/**
 * Reading a product page's own specification lines ("Wattage: 55W", "Voltage: 12V", "Socket: H11", "Package includes: 2 bulbs") into facts (pure). Only what the page STATES is read: a label
 * with no value yields nothing, a number is kept with the unit it was written with, and nothing is inferred. Each fact is marked as read from the description's specification text, so it never
 * passes for something the title said.
 */

export type PageSpecKey = 'power_w' | 'voltage_v' | 'lumens' | 'colour_temperature_k' | 'part_codes' | 'lamp_position' | 'canbus' | 'dimensions' | 'package_contents' | 'fitment_text' | 'alcohol_percent' | 'ingredients';

export interface PageSpecFact {
  key: PageSpecKey;
  value: string | number | boolean;
  /** The label as the page wrote it. */
  label: string;
}

const LABELS: { re: string; key: PageSpecKey }[] = [
  { re: 'wattage|power|watts?', key: 'power_w' },
  { re: 'voltage|input voltage|working voltage', key: 'voltage_v' },
  { re: 'lumens?|brightness|luminous flux', key: 'lumens' },
  { re: 'colou?r temperature|colou?r temp|kelvin', key: 'colour_temperature_k' },
  { re: 'socket|bulb type|bulb size|bulb model|bulb base|base type|base|fitment code|part number|model number', key: 'part_codes' },
  { re: 'location|position|installation position', key: 'lamp_position' },
  { re: 'can-?bus|error free|decoder', key: 'canbus' },
  { re: 'dimensions?|length|diameter|size|width|height', key: 'dimensions' },
  { re: 'package includes?|package contents?|in the box|included|contents?|kit includes?', key: 'package_contents' },
  { re: 'fitment|fits|compatible with|compatibility|vehicle fitment|applications?', key: 'fitment_text' },
  { re: 'alcohol(?: content| by volume)?|abv', key: 'alcohol_percent' },
  { re: 'ingredients?', key: 'ingredients' },
];
const ANY_LABEL = new RegExp(`(?:${LABELS.map((l) => l.re).join('|')})`, 'i');
// a value runs to the end of its line, a delimiter, or the next label ("Wattage: 55W Voltage: 12V" holds two facts)
const SCAN = new RegExp(`(?:^|[^a-z])(${LABELS.map((l) => l.re).join('|')})\\s*[:：]\\s*([^\\n\\r|;•]{1,160}?)(?=\\s+(?:${LABELS.map((l) => l.re).join('|')})\\s*[:：]|[\\n\\r|;•]|$)`, 'gi');

const num = (s: string) => Number(s.replace(',', '.'));

function parse(key: PageSpecKey, raw: string): string | number | boolean | null {
  const v = raw.replace(/\s+/g, ' ').trim().replace(/[.,;\s]+$/, '');
  if (!v || /^(n\/a|none|no|-|—|unknown|unspecified)$/i.test(v)) return key === 'canbus' && /^no$/i.test(v) ? false : null;
  const number = (unit: string) => v.match(new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${unit}`, 'i'));
  switch (key) {
    case 'power_w': { const m = number('w(?:atts?)?\\b'); return m ? num(m[1]!) : null; }
    case 'voltage_v': { const m = number('v(?:olts?)?\\b'); return m ? num(m[1]!) : null; }
    case 'lumens': { const m = number('(?:lm|lumens?)\\b') ?? v.match(/^(\d{3,6})\b/); return m ? num(m[1]!) : null; }
    case 'colour_temperature_k': { const m = number('k\\b') ?? v.match(/^(\d{4})\b/); return m ? num(m[1]!) : null; }
    case 'canbus': return /\b(yes|built[- ]?in|included|supported|compatible|free)\b/i.test(v) ? true : /\b(no|not|without)\b/i.test(v) ? false : null;
    case 'alcohol_percent': { if (/\b(free|0\.0|zero|non[- ]?alcoholic)\b/i.test(v)) return 0; const m = v.match(/(\d+(?:[.,]\d+)?)\s*%/); return m ? num(m[1]!) : null; }
    case 'dimensions': return /\d/.test(v) ? v.slice(0, 80) : null;
    default: return v.slice(0, key === 'fitment_text' || key === 'package_contents' || key === 'ingredients' ? 160 : 60);
  }
}

/** The facts a page's specification lines state, at most one per kind (the first stated). */
export function extractSpecTable(text: string | null | undefined): PageSpecFact[] {
  if (!text) return [];
  const out = new Map<PageSpecKey, PageSpecFact>();
  for (const m of text.matchAll(SCAN)) {
    const label = m[1]!;
    const key = LABELS.find((l) => new RegExp(`^(?:${l.re})$`, 'i').test(label.trim()))?.key;
    if (!key || out.has(key)) continue;
    // a run-on line ("Wattage: 55W Voltage: 12V") ends where the next label begins
    let value = m[2]!;
    const next = value.search(new RegExp(`\\s(?:${ANY_LABEL.source})\\s*$`, 'i'));
    if (next > 0) value = value.slice(0, next);
    const parsed = parse(key, value);
    if (parsed !== null) out.set(key, { key, value: parsed, label: label.trim() });
  }
  return [...out.values()];
}
