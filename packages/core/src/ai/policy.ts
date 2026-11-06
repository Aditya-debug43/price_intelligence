import type { AiDossier } from './dossier.ts';
import { VERIFIED_CODE_ALIASES } from '../match/code-aliases.ts';

export { VERIFIED_CODE_ALIASES };

/**
 * The automatic-approval policy for ONE narrow category: replacement vehicle bulbs (pure). One framework can serve many categories; one similarity threshold cannot establish identity or
 * compatibility across them, so each category states the critical fields it needs and whether each is established, conflicting or unknown. Anything outside the category (kits, assemblies,
 * mats, wipers, groceries) is simply not supported by this policy: bulb-code rules cannot validate them.
 *
 * Evidence rules:
 *  - The bulb code is read as the listing WRITES it, for the selected variant: a code in the variant's option, or in the title when the title names at most two. A title that lists many codes
 *    without a selected option is an AMBIGUOUS variant, not a match.
 *  - Two codes are the same only when they are the same raw code or are listed together in VERIFIED_CODE_ALIASES (standard lamp designations). Codes that merely appear together in the
 *    catalogue (the software's learned families, e.g. H8/H9/H11) can retrieve a candidate but never satisfy this policy.
 *  - The intended light function (headlight, fog, turn signal, brake, tail, reverse, interior, plate) must be stated by both and agree; an unstated function is unknown, and unknown critical
 *    fitment needs enrichment or a person.
 *  - Colour conflicts block; brightness, power and colour temperature are marketing figures and never block by themselves.
 */

export const AUTO_POLICY_VERSION = 'auto-2-bulb';

export type FieldState = 'established' | 'conflicting' | 'unknown';


const norm = (c: string) => c.toUpperCase().replace(/[\s-]+/g, '');
const aliasOf = new Map<string, string>();
VERIFIED_CODE_ALIASES.forEach((row, i) => row.forEach((c) => aliasOf.set(norm(c), `family-${i}`)));
/** The key two codes are compared by: a verified alias row, or the raw code itself. */
export const codeKey = (c: string): string => aliasOf.get(norm(c)) ?? norm(c);

const FUNCTIONS: [string, string][] = [
  ['headlight', 'head ?lights?|head ?lamps?|low beam|high beam|dipped|main beam'],
  ['fog', 'fog'],
  ['turn_signal', 'turn signal|blinker|indicator|signal light'],
  ['brake', 'brake|stop light'],
  ['tail', 'tail ?lights?|tail ?lamps?'],
  ['reverse', 'reverse|back ?up'],
  ['interior', 'dome|interior|map light|courtesy|glove|trunk|cargo'],
  ['plate', 'licen[sc]e|number plate'],
];
const FUNCTION_RES = FUNCTIONS.map(([k, re]) => [k, new RegExp(re, 'i')] as const);
const SIGNAL_FUNCTIONS = new Set(['turn_signal', 'brake', 'tail', 'reverse']);
const NOT_A_BULB = /assembl|housing|projector|\blens\b|\bmats?\b|liners?|wipers?|\bcovers?\b|harness|decoder|resistor|adapter|retainer|socket only|\bkit\b|combo|bundle/i;
const BULB_WORD = /bulbs?|\bled\b|halogen|\bhid\b|xenon|lamps?|lights?/i;

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);

function selectedCodes(a: Pick<AiDossier, 'attributes'>): { codes: string[]; ambiguous: boolean } {
  const p = a.attributes['part_codes'];
  if (p) {
    const codes = list(p.value);
    if (p.source === 'variant option') return { codes, ambiguous: false };
    // the title names the codes: at most two, otherwise no variant is selected and the listing fits several lamps
    return codes.length <= 2 ? { codes, ambiguous: false } : { codes: [], ambiguous: true };
  }
  const spec = a.attributes['spec_part_codes'];
  if (spec) {
    const codes = (list(spec.value)[0] ?? '').split(/[\s/,;]+/).filter((c) => /\d/.test(c)).slice(0, 4);
    return codes.length <= 2 ? { codes, ambiguous: false } : { codes: [], ambiguous: true };
  }
  return { codes: [], ambiguous: false };
}

export function functionsOf(a: Pick<AiDossier, 'title' | 'attributes' | 'productType'>): string[] {
  const text = [a.title, a.productType ?? '', ...list(a.attributes['lamp_position']?.value), ...list(a.attributes['beam_or_function']?.value), ...list(a.attributes['spec_lamp_position']?.value)].join(' ');
  return FUNCTION_RES.filter(([, re]) => re.test(text)).map(([k]) => k);
}

type Facts = Pick<AiDossier, 'domain' | 'title' | 'attributes' | 'productType'>;

function categoryOf(a: Facts): 'replacement_bulb' | 'kit' | 'accessory' | 'unsupported' {
  if (a.domain !== 'automotive') return 'unsupported';
  const bundle = a.attributes['bundle']?.value as { is_bundle?: boolean } | undefined;
  if (bundle?.is_bundle || /\bkit\b|combo|bundle/i.test(a.title)) return 'kit';
  if (a.attributes['is_accessory_not_bulb'] || /harness|decoder|resistor|adapter|retainer/i.test(a.title)) return 'accessory';
  if (NOT_A_BULB.test(a.title) || !BULB_WORD.test(`${a.title} ${a.productType ?? ''}`)) return 'unsupported';
  return 'replacement_bulb';
}

export interface BulbPolicyResult {
  version: string;
  category: 'replacement_bulb' | 'kit' | 'accessory' | 'unsupported';
  fields: { code: FieldState; function: FieldState; colour: FieldState };
  /** The code the two listings share (as one of them writes it), when the code is established. */
  sharedCode: string | null;
  eligible: boolean;
  /** Why it is not eligible (the funnel's reasons). */
  blocker: 'unsupported_category' | 'kit' | 'missing_fitment' | 'conflicting_fitment' | 'ambiguous_variant' | null;
  reasons: string[];
}

export function evaluateBulbPolicy(src: Facts, cand: Facts): BulbPolicyResult {
  const cs = categoryOf(src);
  const cc = categoryOf(cand);
  const out: BulbPolicyResult = { version: AUTO_POLICY_VERSION, category: cs === 'replacement_bulb' ? cc : cs, fields: { code: 'unknown', function: 'unknown', colour: 'unknown' }, sharedCode: null, eligible: false, blocker: null, reasons: [] };
  if (cs !== 'replacement_bulb' || cc !== 'replacement_bulb') {
    const kit = cs === 'kit' || cc === 'kit';
    out.blocker = kit ? 'kit' : 'unsupported_category';
    out.reasons.push(kit ? 'A kit or combo is not a replacement bulb: a compatible bulb alone does not establish a compatible kit (the constituent parts must be verified).' : 'This policy covers replacement bulbs only; bulb-code rules cannot validate other parts.');
    return out;
  }
  // the selected bulb code
  const a = selectedCodes(src);
  const b = selectedCodes(cand);
  if (a.ambiguous || b.ambiguous) {
    out.blocker = 'ambiguous_variant';
    out.reasons.push('A listing names several bulb codes without a selected option, so the variant being compared is not known.');
    return out;
  }
  if (!a.codes.length || !b.codes.length) {
    out.fields.code = 'unknown';
    out.blocker = 'missing_fitment';
    out.reasons.push('The bulb code is not stated for the selected variant of at least one listing.');
  } else {
    const bk = new Map(b.codes.map((c) => [codeKey(c), c]));
    const shared = a.codes.find((c) => bk.has(codeKey(c)));
    if (shared) { out.fields.code = 'established'; out.sharedCode = shared; } else { out.fields.code = 'conflicting'; out.blocker = 'conflicting_fitment'; out.reasons.push(`Different bulb codes (${a.codes.join('/')} against ${b.codes.join('/')}); codes that only appear together in the catalogue are not treated as the same lamp.`); }
  }
  // the intended light function
  const fa = functionsOf(src);
  const fb = functionsOf(cand);
  if (!fa.length || !fb.length) {
    out.fields.function = 'unknown';
    out.blocker ??= 'missing_fitment';
    out.reasons.push('The light function (headlight, fog, signal …) is not stated by both listings.');
  } else if (fa.some((f) => fb.includes(f))) out.fields.function = 'established';
  else {
    out.fields.function = 'conflicting';
    out.blocker = 'conflicting_fitment';
    out.reasons.push(`Different light functions (${fa.join('/')} against ${fb.join('/')}).`);
  }
  // colour: a conflict blocks; for signal lamps an unstated colour is critical too
  const ca = list(src.attributes['colour']?.value).map((c) => c.toLowerCase());
  const cb = list(cand.attributes['colour']?.value).map((c) => c.toLowerCase());
  const signal = [...fa, ...fb].some((f) => SIGNAL_FUNCTIONS.has(f));
  if (ca.length && cb.length) {
    if (ca.some((c) => cb.includes(c))) out.fields.colour = 'established';
    else { out.fields.colour = 'conflicting'; out.blocker = 'conflicting_fitment'; out.reasons.push(`Different colours (${ca.join('/')} against ${cb.join('/')}).`); }
  } else if (signal) { out.fields.colour = 'unknown'; out.blocker ??= 'missing_fitment'; out.reasons.push('The colour of a signal lamp is not stated by both listings.'); }
  else out.fields.colour = 'established'; // not critical for this lamp: marketing colour figures never block
  out.eligible = out.fields.code === 'established' && out.fields.function === 'established' && out.fields.colour !== 'conflicting' && !(signal && out.fields.colour === 'unknown');
  if (out.eligible) { out.blocker = null; out.reasons = [`Same bulb code (${out.sharedCode}), same light function, no conflicting colour.`]; }
  return out;
}
