import { modelNumbersIn, VARIANT_WORDS } from '../matching.ts';
import { hashText } from '../match/engine.ts';
import { isBulbCode } from '../match/bundle.ts';
import type { Dossier } from '../match/dossier.ts';

/**
 * The product dossier AI is shown (pure). It is built from what the rule engine already extracted — never invented — and every attribute keeps WHERE it was read
 * ("title", "variant option", "description chart", a field the website publishes). An attribute that is not stated is listed under `unknown`, never filled in.
 *
 * Two forms: the full dossier (stored with its fingerprint, so an unchanged product is never prepared again) and a COMPACT wire form (what is actually sent: short, no URLs,
 * no repeated text). Categories differ in what matters, so the attribute set depends on the product's domain; a new category adds a domain here and a paragraph in the prompt.
 */

export type AiDomain = 'automotive' | 'grocery' | 'general';

export interface Sourced<T> {
  value: T;
  source: string;
}

export interface AiDossier {
  ref: string;
  productId: string;
  siteId: string;
  domain: AiDomain;
  title: string;
  variantTitle: string | null;
  options: Record<string, string>;
  brand: Sourced<string> | null;
  category: string | null;
  productType: string | null;
  identifiers: { gtin?: string; mpn?: string; sku?: string };
  attributes: Record<string, Sourced<string | number | boolean | string[]>>;
  /** A short, cleaned piece of the product page's description (a bulb-size chart, what is in the box). Never a whole page. */
  notes: string | null;
  url: string | null;
  /** Attributes that matter for this domain and are not stated by the listing. */
  unknown: string[];
  fingerprint: string;
  /** Version of this builder: a change invalidates every stored dossier. */
  version: string;
}

export const AI_DOSSIER_VERSION = 'ai-dossier-1';

const AUTOMOTIVE_WORDS = /\b(headlights?|head ?lamps?|bulbs?|led|fog|brake light|tail ?lights?|turn signal|backup|reverse light|dome light|license plate|wipers?|floor mats?|cargo|tailgate|mud flaps?|running boards?|side steps?|seat covers?|decoder|canceler|harness|retainer|adapter)\b/i;
const FORM_WORDS = new Set(['strained', 'puree', 'pureed', 'dried', 'dry', 'dehydrated', 'frozen', 'canned', 'fresh', 'powder', 'powdered', 'mix', 'concentrate', 'instant', 'ready', 'baby', 'toddler', 'juice', 'sauce', 'syrup', 'spray', 'sparkling', 'still']);
const EDITION_WORDS = new Set(['original', 'natural', 'classic', 'regular', 'traditional', 'authentic', 'homestyle', 'plain', 'unsweetened', 'diet', 'zero', 'light', 'lite']);

export function aiDomainOf(d: Dossier): AiDomain {
  if (d.fitment || d.codes.some((c) => isBulbCode(c)) || AUTOMOTIVE_WORDS.test(`${d.title} ${d.category ?? ''}`)) return 'automotive';
  if (d.quantity.total !== null || d.identifiers.gtin || d.legacy.core.length > 0) return 'grocery';
  return 'general';
}

const years = (f: NonNullable<Dossier['fitment']>): string => [...f.ranges.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`)), ...f.years.map(String)].join(', ');
const sourceName = (s: string): string => ({ title: 'title', variant_title: 'variant title', option: 'variant option', description: 'description chart', category: 'category', tag: 'tag', gtin_field: 'barcode field', mpn_field: 'part-number field', sku_field: 'SKU field' } as Record<string, string>)[s] ?? s;

export interface AiDossierExtra {
  /** The catalogue's alias map (H11 → H8): the codes are shown as the listing writes them, with the other names of the same part. */
  alias?: Map<string, string>;
  url?: string | null;
  /** Description text of the product page; only a short cleaned excerpt is kept. */
  description?: string | null;
}

const cleanNotes = (text: string | null | undefined): string | null => {
  const t = (text ?? '').replace(/\s+/g, ' ').replace(/https?:\/\/\S+/g, '').trim();
  return t.length >= 20 ? t.slice(0, 280) : null;
};

export function buildAiDossier(d: Dossier, extra: AiDossierExtra = {}): AiDossier {
  const domain = aiDomainOf(d);
  const attrs: AiDossier['attributes'] = {};
  const unknown: string[] = [];
  const set = (k: string, v: string | number | boolean | string[] | null | undefined, source: string) => {
    if (v === null || v === undefined || (Array.isArray(v) && !v.length) || v === '') return false;
    attrs[k] = { value: v, source: sourceName(source) };
    return true;
  };
  const text = `${d.title} ${Object.values(d.axes).join(' ')}`;
  const firstSource = (values: { value: string; source: string }[], v: string) => values.find((x) => x.value === v)?.source ?? 'title';

  if (domain === 'automotive') {
    // codes as the listing writes them (the engine folds aliases: H11 and H8 are one part), plus the other names of the same part
    const written = d.codeTokens.filter((t) => d.codes.includes(extra.alias?.get(t.value) ?? t.value)).map((t) => t.value);
    const shown = (written.length ? [...new Set(written)] : d.codes).map((c) => c.toUpperCase()).slice(0, 8);
    if (!set('part_codes', shown, firstSource(d.codeTokens, written[0] ?? d.codes[0] ?? ''))) unknown.push('part_codes');
    if (extra.alias) {
      const family = [...new Set([...extra.alias.entries()].filter(([, canon]) => d.codes.includes(canon)).map(([k]) => k.toUpperCase()).concat(d.codes.map((c) => c.toUpperCase())))].filter((c) => !shown.includes(c)).slice(0, 5);
      set('same_part_also_written_as', family, 'catalogue');
    }
    if (d.fitment) set('model_years', years(d.fitment), d.yearMentions.ranges[0]?.source ?? d.yearMentions.singles[0]?.source ?? 'title');
    else unknown.push('model_years');
    if (!set('vehicle', d.subjectChain.length ? d.subjectChain : d.subject.slice(0, 6), 'title')) unknown.push('vehicle');
    if (!set('lamp_position', d.position.length ? d.position : d.variantTokens.filter((t) => !/\d/.test(t)).slice(0, 5), 'option')) unknown.push('lamp_position');
    for (const [key, label] of [['power_w', 'power_w'], ['light_lm', 'lumens'], ['voltage_v', 'voltage_v'], ['colour_temp_k', 'colour_temperature_k'], ['length_mm', 'length_mm']] as const) {
      const s = d.specs.find((x) => x.key === key);
      if (s) set(label, s.value, s.source);
      else if (key !== 'length_mm' && key !== 'voltage_v') unknown.push(label);
    }
    if (d.colours.values.length) set('colour', d.colours.values, d.colours.source);
    // plain-text hints: what the title or option says, nothing inferred
    const beam = [/low[ -]?beam|dipped/i.test(text) && 'low beam', /high[ -]?beam|main beam/i.test(text) && 'high beam', /\bfog\b/i.test(text) && 'fog', /\bflood\b/i.test(text) && 'flood', /\bspot\b/i.test(text) && 'spot'].filter(Boolean) as string[];
    set('beam_or_function', beam, 'title');
    const housing = [/reflector/i.test(text) && 'reflector', /projector/i.test(text) && 'projector'].filter(Boolean) as string[];
    set('housing_mentioned', housing, 'title');
    if (/can[ -]?bus|error[ -]?free|anti[ -]?flicker|decoder[ -]?(free|built)/i.test(text)) set('canbus_mentioned', true, 'title');
    if (d.kind.companion) set('is_accessory_not_bulb', d.kind.tail ?? true, 'title');
    if (d.bundle.bundle || d.bundle.single) {
      set('bundle', { is_bundle: d.bundle.bundle, parts: d.bundle.parts.map((p) => (p.count ? `${p.count}x ${p.label}` : p.label)), without: d.bundle.without, pairs: d.bundle.pairs, contents_named_only_in_part: d.bundle.implicit } as unknown as string, d.bundle.basis === 'variant' ? 'option' : 'title');
    }
    if (d.packCount) set('pack_count', d.packCount, 'title');
  } else {
    if (d.quantity.total !== null && d.quantity.label) set('quantity', `${d.quantity.label}${d.quantity.dimension ? ` (${d.quantity.dimension})` : ''}`, d.quantity.source === 'size_hint' ? 'tag' : d.quantity.source ?? 'title');
    else unknown.push('quantity');
    if (d.packCount) set('pack_count', d.packCount, 'title');
    const words = d.legacy.core;
    set('flavour_or_variety', words.filter((w) => VARIANT_WORDS.has(w)), 'title');
    set('product_form', words.filter((w) => FORM_WORDS.has(w)), 'title');
    set('edition', words.filter((w) => EDITION_WORDS.has(w)), 'title');
    set('percent_claims', [...text.matchAll(/\d+(?:[.,]\d+)?\s?%/g)].map((m) => m[0]!), 'title');
    set('numbers_that_belong_to_the_name', modelNumbersIn(d.title), 'title');
    set('vintage_year', d.vintages.map(String), 'title');
    if (d.exclusions.length) set('not_for', d.exclusions, 'title');
    if (domain === 'grocery' && !d.identifiers.gtin) unknown.push('barcode');
  }
  const brandName = d.brand.name;
  return finish({
    ref: d.variantId,
    productId: d.productId,
    siteId: d.siteId,
    domain,
    title: d.title.replace(/\s+/g, ' ').trim(),
    variantTitle: null,
    options: d.axes,
    brand: brandName ? { value: brandName, source: d.brand.inferred ? 'first words of the title' : 'vendor field' } : null,
    category: d.category,
    productType: d.kindWords[0] ?? d.kind.tail ?? null,
    identifiers: { ...(d.identifiers.gtin ? { gtin: d.identifiers.gtin.value } : {}), ...(d.identifiers.mpn ? { mpn: d.identifiers.mpn.value } : {}), ...(d.identifiers.sku ? { sku: d.identifiers.sku.value } : {}) },
    attributes: attrs,
    notes: cleanNotes(extra.description),
    url: extra.url ?? null,
    unknown: [...unknown, ...(brandName ? [] : ['brand'])],
  });
}

function finish(d: Omit<AiDossier, 'fingerprint' | 'version'>): AiDossier {
  const wire = toWire({ ...d, fingerprint: '', version: AI_DOSSIER_VERSION });
  return { ...d, fingerprint: hashText(JSON.stringify(wire)), version: AI_DOSSIER_VERSION };
}

/** What is sent to the model: compact, no URLs, no empty fields. The SAME function produces the fingerprint, so what changed is exactly what costs a new request. */
export function toWire(d: AiDossier): Record<string, unknown> {
  const w: Record<string, unknown> = { t: d.title };
  if (Object.keys(d.options).length) w['o'] = d.options;
  if (d.brand) w['brand'] = d.brand.value;
  if (d.category) w['cat'] = d.category;
  if (d.productType) w['type'] = d.productType;
  if (Object.keys(d.identifiers).length) w['ids'] = { ...(d.identifiers.gtin ? { gtin: d.identifiers.gtin } : {}), ...(d.identifiers.mpn ? { mpn: d.identifiers.mpn } : {}) };
  const a: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d.attributes)) a[k] = v.value;
  if (Object.keys(a).length) w['a'] = a;
  if (d.unknown.length) w['unknown'] = d.unknown;
  if (d.notes) w['d'] = d.notes;
  return w;
}

/** All the text a value quoted by the model could legitimately come from: used to check that evidence is grounded in the facts that were sent. */
export function groundingText(d: AiDossier): string {
  return JSON.stringify(toWire(d)).toLowerCase();
}
