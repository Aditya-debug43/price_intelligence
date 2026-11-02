import { INCOMPARABLE_BUNDLE_CONTENT_MISMATCH, type BundleCheck, type BundleSide } from '@ci/shared';

/**
 * The bundle-contents policy (automotive). Two bundles are compared on price only when their CONTENTS are the same: a combo with an extra, a missing or a different
 * component, or a combo against a single item, is not a fair price comparison however alike their main product, brand or vehicle fit. Contents are read, never
 * guessed: from the variant's own option or title first ("Low Beam", "Headlight Combo", "Inner Tail Light(4PCS)", "…(W/o Fog Lights)"), then from the product title
 * ("9005+H11 Headlight Turn Signal Brake Lights Combo"), as lamp positions, included accessories, counts and the bulb codes. Three outcomes: equivalent (established
 * and equal), mismatch (shown to differ), unknown (not established: never assumed equal). Brand, vehicle fit and name similarity play no part.
 *
 * Works on text already normalised by `plain()` (lower case, "&" as "and"), so it has no dependency on the dossier module.
 */

export const BUNDLE_POLICY_VERSION = 'bundle-1';

interface PartDef { id: string; label: string; re: RegExp; accessory?: true }
const L = '(?:[ -]?(?:lights?|lamps?))?';
const PARTS: PartDef[] = [
  { id: 'headlight', label: 'headlight', re: /\b(?:head[ -]?(?:lights?|lamps?)|headlights?|headlamps?|low[ -]?beams?|high[ -]?beams?|hi[ -]?lo|dual[ -]?beams?|dipped[ -]?beams?|forward[ -]?lightings?)\b/g },
  { id: 'fog', label: 'fog light', re: new RegExp(`\\bfog${L}\\b|\\bfoglights?\\b`, 'g') },
  { id: 'turn', label: 'turn signal', re: /\b(?:turn[ -]?(?:signals?|lights?|lamps?|indicators?)|signal[ -]?(?:lights?|lamps?)|indicators?|blinkers?)\b/g },
  { id: 'brake', label: 'brake light', re: new RegExp(`\\bbrake${L}\\b|\\bstop[ -]?(?:lights?|lamps?)\\b`, 'g') },
  { id: 'tail', label: 'tail light', re: new RegExp(`\\btail${L}\\b|\\btaillights?\\b`, 'g') },
  { id: 'backup', label: 'backup light', re: new RegExp(`\\b(?:back[ -]?up|reverse|reversing)${L}\\b`, 'g') },
  { id: 'parking', label: 'parking light', re: /\bparking(?:[ -]?(?:lights?|lamps?))?\b|\bpark[ -]?(?:lights?|lamps?)\b/g },
  { id: 'interior', label: 'interior light', re: /\binterior\b|\b(?:dome|map|cargo|trunk|courtesy|vanity|glove[ -]?box|step[ -]?well|footwell|door)[ -]?(?:lights?|lamps?)\b/g },
  { id: 'license', label: 'license plate light', re: new RegExp(`\\b(?:license|licence|number)[ -]?plate${L}\\b`, 'g') },
  { id: 'marker', label: 'side marker light', re: /\b(?:side[ -]?markers?|clearance)(?:[ -]?(?:lights?|lamps?))?\b|\bmarker[ -]?(?:lights?|lamps?)\b/g },
  { id: 'drl', label: 'daytime running light', re: /\b(?:drl|daytime[ -]?running(?:[ -]?lights?)?)\b/g },
  { id: 'lightbar', label: 'light bar', re: /\blight[ -]?bars?\b|\b(?:pod|work|cube)[ -]?lights?\b/g },
  // things that come WITH a light: an accessory is part of the contents only where the listing says it is included
  { id: 'harness', label: 'wiring harness', accessory: true, re: /\b(?:wiring[ -]?)?harness(?:es)?\b|\bwiring\b/g },
  { id: 'adapter', label: 'adapter', accessory: true, re: /\badapt(?:er|or)s?\b|\bretainers?\b|\bholders?\b|\bsocket[ -]?bases?\b/g },
  { id: 'decoder', label: 'canbus decoder', accessory: true, re: /\b(?:can[ -]?bus[ -]?)?(?:decoders?|resistors?|cancell?ers?)\b|\banti[ -]?flicker\b/g },
  { id: 'relay', label: 'relay', accessory: true, re: /\brelays?\b/g },
  { id: 'bracket', label: 'bracket', accessory: true, re: /\bbrackets?\b|\bmounts?\b/g },
  { id: 'switch', label: 'switch or controller', accessory: true, re: /\b(?:switch(?:es)?|controllers?|remote)\b/g },
  { id: 'lens', label: 'lens', accessory: true, re: /\blens(?:es)?\b/g },
];

/** A word that says several items are sold together. */
const MARKER = /\b(?:combo|kit|bundle|package|set|assortment|all[ -]?in[ -]?one)\b/;
const PLUS = /\+|\bplus\b/;
const NEGATION = /(?:\bw\/o|\bwithout|\bno|\bexcluding|\bexcludes?|\bminus)\s*(?:the\s+)?$/;
/** Phrases that list what a vehicle-specific listing can be used for, not what is in the box. */
const APPLICATION = /\b(?:fit|fits|for)\b.*\b(?:19|20)\d\d\b|vehicle[ -]specific|\bfull\s+(?:exterior|interior)|\bexterior\b|\binterior\b.*\bupgrade\b|\bkit\b/;
const BULB_WORD = /\b(?:bulbs?|led|lamps?|headlights?)\b/;

export interface BundlePart { id: string; label: string; count: number | null; accessory: boolean }

export interface BundleContents {
  /** Sold as several items together (a combo, a kit, "A + B"). */
  bundle: boolean;
  basis: 'variant' | 'title' | null;
  parts: BundlePart[];
  /** Components the listing says are NOT included ("W/o fog lights"). */
  without: string[];
  /** "2 Pairs": how many pairs, when it says so. */
  pairs: number | null;
  /** A single known item (not a bundle): the variant names exactly one position, or the title names one lamp and a bulb code. */
  single: boolean;
  /** The listing, variant or title, names a lamp position: the sign that this is a lighting product. */
  lamp: boolean;
  bulbWord: boolean;
  text: string | null;
}

export const NO_BUNDLE: BundleContents = { bundle: false, basis: null, parts: [], without: [], pairs: null, single: false, lamp: false, bulbWord: false, text: null };

interface Scan { parts: BundlePart[]; without: string[]; marker: boolean; plus: boolean; pairs: number | null }

/** The number written right before a component ("2 turn signals", "4pcs inner tail light") or right after it in brackets ("Inner Tail Light(4PCS)"). */
function countNear(text: string, start: number, end: number): number | null {
  // a count is a number of its own: the end of a bulb code ("H11 headlight", "9005 headlight", "T10 tail") is not how many there are, so the digits must not continue a word or a longer number
  const before = text.slice(0, start).match(/(?<![a-z0-9])(\d{1,2})\s*(?:x\s*)?(?:pcs?\.?|pieces?|bulbs?|sets?)?\s*(?:of\s+)?(?:the\s+)?$/);
  if (before) return Number(before[1]);
  const after = text.slice(end, end + 12).match(/^\s*\(\s*(\d{1,2})\s*(?:pcs?|pieces?|bulbs?)\s*\)/);
  return after ? Number(after[1]) : null;
}

function scan(text: string, opts: { accessoriesAnywhere: boolean }): Scan {
  const t = ` ${text} `;
  const found = new Map<string, BundlePart>();
  const without: string[] = [];
  for (const def of PARTS) {
    for (const m of t.matchAll(def.re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      const lead = t.slice(Math.max(0, start - 16), start);
      if (NEGATION.test(lead)) {
        if (!without.includes(def.id)) without.push(def.id);
        continue;
      }
      // an accessory counts as contents where the variant names it, or where the title says it is included ("+ wiring harness", "includes a decoder")
      if (def.accessory && !opts.accessoriesAnywhere && !/(?:\+|\bplus\b|\bincludes?\b|\bincluding\b|\bwith\b)\s*(?:a\s+|an\s+|the\s+)?(?:\w+\s+)?$/.test(lead)) continue;
      // "decoder free", "built-in resistor": a feature of the bulb, not an item in the box
      if (def.accessory && (/\b(?:built[ -]?in|free|no)\s*$/.test(lead) || /^\s*(?:free|included|built[ -]?in|needed|required)\b/.test(t.slice(end, end + 14)))) continue;
      const count = countNear(t, start, end);
      const prev = found.get(def.id);
      if (!prev) found.set(def.id, { id: def.id, label: def.label, count, accessory: !!def.accessory });
      else if (count !== null && prev.count === null) prev.count = count;
    }
  }
  // a part the listing leaves out is not also a part it includes
  const parts = [...found.values()].filter((p) => !without.includes(p.id));
  const pairs = t.match(/\b(\d{1,2})\s*-?\s*pairs?\b/);
  return { parts, without, marker: MARKER.test(t), plus: PLUS.test(t), pairs: pairs ? Number(pairs[1]) : null };
}

/**
 * What a listing includes. `variantText` is the text of the variant's own option values / title (only the option values of that variant, joined with " | "); `title` the
 * product title; `hasCode` whether the listing names a bulb code. Both are already normalised by `plain()`.
 */
export function readBundle(input: { title: string; variantText: string; hasCode: boolean }): BundleContents {
  const v = scan(input.variantText, { accessoriesAnywhere: true });
  const t = scan(input.title, { accessoriesAnywhere: false });
  const lamp = [...v.parts, ...t.parts].some((p) => !p.accessory);
  const bulbWord = BULB_WORD.test(input.title);
  const base = { lamp, bulbWord };
  // the variant says what it is (a position, a named kit): that is the product the shopper gets, whatever the title lists
  if (v.parts.length > 0 || v.marker || v.plus) {
    const bundle = v.marker || v.plus;
    return { ...base, bundle, basis: 'variant', parts: v.parts, without: v.without, pairs: v.pairs, single: !bundle && v.parts.length === 1, text: input.variantText.trim() };
  }
  const titleBundle = t.marker || (t.plus && t.parts.length >= 2);
  if (titleBundle) return { ...base, bundle: true, basis: 'title', parts: t.parts, without: t.without, pairs: t.pairs, single: false, text: input.title.trim() };
  // a title with no marker that names one lamp and a bulb code is a single item, unless it lists what a vehicle-specific product can be used for
  const single = t.parts.filter((p) => !p.accessory).length === 1 && t.parts.length === 1 && input.hasCode && !APPLICATION.test(input.title);
  return { ...base, bundle: false, basis: single ? 'title' : null, parts: single ? t.parts : [], without: [], pairs: null, single, text: single ? input.title.trim() : null };
}

const partLabel = (p: BundlePart) => (p.count !== null && p.count > 0 ? `${p.count} × ${p.label}` : p.label);
const withoutLabel = (id: string) => PARTS.find((p) => p.id === id)?.label ?? id;

function sideOf(c: BundleContents, codes: string[]): BundleSide {
  return { bundle: c.bundle, items: c.parts.map(partLabel), without: c.without.map(withoutLabel), codes: codes.map((x) => x.toUpperCase()), basis: c.basis, text: c.text };
}

/** How many distinct items a listing is established to hold (named components, or the bulb codes it lists, whichever is more). */
const itemCount = (c: BundleContents, codes: string[]) => (c.single ? 1 : Math.max(c.parts.length, codes.length));

const list = (xs: string[]) => (xs.length ? xs.join(' + ') : 'nothing named');

/**
 * Compares the contents of two listings. Null when the policy has nothing to say: neither is a bundle, or there is no sign of a lighting product (so grocery
 * combos, variety packs and every other listing are untouched). `codes` are each listing's identity codes as the catalogue resolves them (aliases folded).
 */
export function assessBundles(a: BundleContents, b: BundleContents, codes: { a: string[]; b: string[]; shared: string[] }): BundleCheck | null {
  const lighting = a.lamp || b.lamp || (a.bulbWord && b.bulbWord && codes.a.length >= 2 && codes.b.length >= 2);
  if (!lighting || (!a.bundle && !b.bundle)) return null;
  const sa = sideOf(a, codes.a);
  const sb = sideOf(b, codes.b);
  const out = (verdict: BundleCheck['verdict'], note: string, onlyA: string[] = [], onlyB: string[] = []): BundleCheck => ({
    policy: BUNDLE_POLICY_VERSION, verdict, exclusion: verdict === 'mismatch' ? INCOMPARABLE_BUNDLE_CONTENT_MISMATCH : null, note, a: sa, b: sb, onlyA, onlyB,
  });
  const nA = itemCount(a, codes.a);
  const nB = itemCount(b, codes.b);

  // a bundle against a single item
  if (a.bundle !== b.bundle) {
    const [bun, std, bunCodes, stdCodes, bunIsA] = a.bundle ? [a, b, codes.a, codes.b, true] as const : [b, a, codes.b, codes.a, false] as const;
    const who = bunIsA ? ['Your bundle', 'the competitor’s single item'] : ['The competitor’s bundle', 'your single item'];
    if (itemCount(bun, bunCodes) < 2) return out('unknown', `${who[0]} is sold as a bundle but its contents are not spelled out, so it cannot be compared with ${who[1]}`);
    if (!std.single) return out('unknown', `${who[0]} holds ${list(bun.parts.map(partLabel).concat(bun.parts.length ? [] : bunCodes.map((x) => x.toUpperCase())))}; what ${who[1]} contains is not stated`);
    const stdIds = new Set(std.parts.map((p) => p.id));
    const extra = bun.parts.filter((p) => !stdIds.has(p.id)).map(partLabel);
    const missing = std.parts.filter((p) => !bun.parts.some((x) => x.id === p.id)).map(partLabel);
    const extraCodes = bun.parts.length ? [] : bunCodes.filter((c) => !stdCodes.includes(c)).map((c) => c.toUpperCase());
    const more = [...extra, ...extraCodes];
    const onlyBundle = more.length ? more : ['additional items'];
    return bunIsA
      ? out('mismatch', `Your bundle holds ${list(bun.parts.map(partLabel))}; the competitor sells ${list(std.parts.map(partLabel))} on its own: your bundle includes ${list(onlyBundle)} that the competitor does not${missing.length ? `, and the competitor’s ${list(missing)} is not in it` : ''}`, onlyBundle, missing)
      : out('mismatch', `The competitor’s bundle holds ${list(bun.parts.map(partLabel))}; you sell ${list(std.parts.map(partLabel))} on its own: the competitor includes ${list(onlyBundle)} that you do not${missing.length ? `, and your ${list(missing)} is not in it` : ''}`, missing, onlyBundle);
  }

  // two bundles
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  let compared = false;
  let uncertain: string | null = null;
  if (a.parts.length > 0 && b.parts.length > 0) {
    compared = true;
    for (const p of a.parts) {
      const q = b.parts.find((x) => x.id === p.id);
      if (!q) onlyA.push(partLabel(p));
      else if (p.count !== null && q.count !== null && p.count !== q.count) { onlyA.push(partLabel(p)); onlyB.push(partLabel(q)); }
      else if ((p.count === null) !== (q.count === null)) uncertain = `the number of ${p.label}s is stated on one side only`;
    }
    for (const q of b.parts) if (!a.parts.some((x) => x.id === q.id)) onlyB.push(partLabel(q));
  }
  // a component one bundle says it leaves out, which the other includes
  for (const id of a.without) if (b.parts.some((p) => p.id === id)) onlyB.push(`${withoutLabel(id)} (yours leaves it out)`);
  for (const id of b.without) if (a.parts.some((p) => p.id === id)) onlyA.push(`${withoutLabel(id)} (theirs leaves it out)`);
  if ((a.without.length > 0) !== (b.without.length > 0) && !onlyA.length && !onlyB.length) uncertain = 'one bundle states what it leaves out and the other does not';
  if (codes.a.length >= 2 && codes.b.length >= 2) {
    compared = true;
    for (const c of codes.a) if (!codes.shared.includes(c)) onlyA.push(`bulb ${c.toUpperCase()}`);
    for (const c of codes.b) if (!codes.shared.includes(c)) onlyB.push(`bulb ${c.toUpperCase()}`);
  }
  if (a.pairs !== null && b.pairs !== null && a.pairs !== b.pairs) { onlyA.push(`${a.pairs} pairs`); onlyB.push(`${b.pairs} pairs`); }
  else if ((a.pairs === null) !== (b.pairs === null)) uncertain ??= 'the number of pairs is stated on one side only';

  if (onlyA.length || onlyB.length) {
    const parts: string[] = [];
    if (onlyA.length) parts.push(`yours includes ${list(onlyA)} that the competitor’s does not`);
    if (onlyB.length) parts.push(`the competitor’s includes ${list(onlyB)} that yours does not`);
    return out('mismatch', `The bundles hold different contents (yours: ${list(sa.items.length ? sa.items : sa.codes)}; the competitor’s: ${list(sb.items.length ? sb.items : sb.codes)}): ${parts.join('; ')}`, onlyA, onlyB);
  }
  if (!compared) return out('unknown', 'Both are bundles but the contents of one or both are not spelled out (no components or bulb codes to compare), so they are not assumed to be the same');
  if (uncertain) return out('unknown', `The bundles name the same contents but ${uncertain}, so they are not assumed to be the same`);
  if (nA < 2 || nB < 2) return out('unknown', 'Both are bundles but fewer than two items are named on one side, so the contents are not established');
  return out('equivalent', `Both bundles hold the same contents (${list(sa.items.length ? sa.items : sa.codes)})`);
}
