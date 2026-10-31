import type { EvidenceItem, EvidenceTier, MatchEvidence, MatchRelationship } from '@ci/shared';
import { compareQuantities } from '../quantity.ts';
import { labelledNumbersIn, modelNumbersIn, scorePair, variantDifference, type MatchCandidate } from '../matching.ts';
import { fitmentYears, type Corpus } from './corpus.ts';
import { alignNames, kindHead, typeWords } from './names.ts';
import { SPEC_HARDNESS, SPEC_LABEL, plain, stem, type Dossier, type Spec, type SpecKey } from './dossier.ts';

/**
 * The evidence model (matching engine v2, stage 2). For a pair of dossiers it collects typed facts — each one agreeing, conflicting, differing
 * or missing — and then decides a RELATIONSHIP and an EVIDENCE TIER from them. Nothing is summed into one similarity number:
 *
 *   • a decisive incompatibility (different part codes, fitment for another vehicle or a non-overlapping period, a different voltage or size,
 *     an explicit "not for") ends the question — no name similarity can outvote it;
 *   • exact and variant need the same product from the same maker: an identifier, or the same known brand with the same codes/name and size;
 *   • a substitute needs a different make that agrees on what it IS (identity codes, fitment, specifications) and does not conflict;
 *   • "strong" needs at least two independent agreeing signals, at least one of them specific (an identifier, shared codes, fitment, a hard
 *     specification), no unresolved fitment and no difference that changes the product (colour, bundle, pack);
 *   • the older name-and-size rules stay in as ONE source of evidence for grocery-type products, never as the verdict on their own.
 */

export interface PairEvaluation {
  relationship: MatchRelationship;
  tier: EvidenceTier;
  evidence: MatchEvidence;
  /** How the pair was found/decided: used for reporting and review ordering. */
  method: 'gtin' | 'brand_model' | 'identity_code' | 'fitment' | 'name_similarity' | 'attributes' | 'cross_brand' | 'none';
  /** For ordering suggestions of one product (higher first). NOT a probability and never displayed as one. */
  rank: number;
  /** Decisive incompatibilities, in plain words (empty unless the relationship is non_match/related because of them). */
  conflicts: string[];
  /**
   * Whether this is a pair the AUTO-CONFIRMATION POLICY allows to be confirmed without a person (only ever exact / other pack): an identifier, or the same maker named in both
   * titles with the same name and the sizes both stated and consistent. The policy was written before it was measured (docs/matching-validation-2026-10-31.md); whether a workspace uses it is its own setting.
   */
  auto: boolean;
  legacy: MatchCandidate | null;
}

type Dir = 'agree' | 'conflict' | 'unknown';

const up = (s: string) => s.toUpperCase();
const years = (f: NonNullable<Dossier['fitment']>): string => {
  const parts = [...f.ranges.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}–${r.to}`)), ...f.years.map(String)];
  return parts.join(', ');
};
const codesText = (d: Dossier, only?: string[]) => {
  const canon = new Set(only ?? d.codes);
  return d.codeTokens.map((c) => c.value).filter((c) => !only || canon.has(c) || d.codes.some((x) => x === c)).map(up).slice(0, 8).join(' ');
};
const pct = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9);
const TOLERANCE: Partial<Record<SpecKey, number>> = { length_mm: 0.06, colour_temp_k: 0.25, voltage_v: 0.02, current_a: 0.05, frequency_hz: 0.05, storage_gb: 0, capacity_mah: 0.1, power_w: 0.1, light_lm: 0.1, count: 0 };

/**
 * Whether two names say the same thing in different order or with a size or pack left out: both must start with the same word, their core names must
 * be the same set of words, and the words of the full titles may differ only by a little weight. One word in a name and not the other is often what
 * makes a different flavour or variety ("Original" against "Strawberry", "Cucumber" Ranch), and the core name drops some such words, so the full
 * titles are compared as well.
 */
const NAME_TITLE_DIFF_MAX = 0.2;
/** The most of the weight of two names that may be words only one title has, for the titles to be called the same product. Read from the labelled development data (the labelled same products sit at or below 0.17). */
const NAME_EXTRA_MAX = 0.25;
function nameContainment(a: Dossier, b: Dossier, corpus: Corpus): { shared: string[]; extras: string[] } | null {
  const ca = [...new Set(a.legacy.core)];
  const cb = [...new Set(b.legacy.core)];
  if (ca.length < 3 || ca[0] !== cb[0] || ca.length !== cb.length) return null;
  const inB = new Set(cb);
  if (ca.some((w) => !inB.has(w))) return null;
  const weight = (words: Iterable<string>) => [...words].reduce((sum, w) => sum + corpus.idf(`w:${w}`), 0);
  const wa = new Set(a.words.filter((w) => !/\d/.test(w)));
  const wb = new Set(b.words.filter((w) => !/\d/.test(w)));
  const diff = [...wa].filter((w) => !wb.has(w)).concat([...wb].filter((w) => !wa.has(w)));
  if (weight(diff) / Math.max(1e-9, weight(new Set([...wa, ...wb]))) > NAME_TITLE_DIFF_MAX) return null;
  return { shared: ca, extras: [] };
}

const KIND_MODIFIERS = new Set(['led', 'series', 'kit', 'set', 'pair', 'upgrade', 'exterior', 'interior', 'front', 'rear', 'universal', 'custom', 'replacement']);

function wordCosine(a: Dossier, b: Dossier, corpus: Corpus, skip?: Set<string>): number {
  const wa = new Map(a.words.filter((w) => !skip?.has(w)).map((w) => [w, corpus.idf(`w:${w}`)]));
  const wb = new Map(b.words.filter((w) => !skip?.has(w)).map((w) => [w, corpus.idf(`w:${w}`)]));
  let dot = 0;
  for (const [w, x] of wa) { const y = wb.get(w); if (y) dot += x * y; }
  const n = (m: Map<string, number>) => Math.sqrt([...m.values()].reduce((s, v) => s + v * v, 0)) || 1;
  return dot / (n(wa) * n(wb));
}

/** Codes of each listing that mean something to the other website, and which of them are shared. */
function compareCodes(a: Dossier, b: Dossier, corpus: Corpus) {
  // a code seen on one website only is that website's own series name (X5, S2S, M6): it says nothing about a product elsewhere
  const general = (c: string) => (corpus.codeSites.get(c)?.size ?? 0) >= 2;
  const A = a.codes.filter((c) => b.codes.includes(c) || general(c));
  const B = b.codes.filter((c) => a.codes.includes(c) || general(c));
  const shared = A.filter((c) => B.includes(c));
  const state: Dir = !A.length || !B.length ? 'unknown' : shared.length ? 'agree' : 'conflict';
  const containment = shared.length / Math.max(1, Math.min(A.length, B.length));
  return { A, B, shared, state, containment, equal: A.length === B.length && shared.length === A.length };
}

function compareFitment(a: Dossier, b: Dossier, corpus: Corpus) {
  const fa = a.fitment;
  const fb = b.fitment;
  if (!fa && !fb) return { state: 'none' as const };
  if (!fa || !fb) return { state: 'unverified' as const, onlyA: !!fa };
  const ya = fitmentYears(fa);
  const yb = fitmentYears(fb);
  const overlap = [...ya].filter((y) => yb.has(y)).length / Math.max(1, Math.min(ya.size, yb.size));
  // "F-250" and "250" name the same model
  const norm = (t: string) => t.replace(/^[a-z]{1,2}(?=\d{3,4}$)/, '');
  const subA = [...new Set(a.subject.map(norm))];
  const subB = [...new Set(b.subject.map(norm))];
  const sa = new Set(subA);
  const sharedSubject = subB.filter((s) => sa.has(s));
  // one listing may name less ("Sienna" against "Toyota Sienna") but neither may name something the other does not ("Traverse" against "Colorado")
  const onlyA = subA.filter((s) => !subB.includes(s));
  const onlyB = subB.filter((s) => !sa.has(s));
  const modelsA = a.subject.filter((s) => corpus.modelWords.has(s)).map(norm);
  const modelsB = b.subject.filter((s) => corpus.modelWords.has(s)).map(norm);
  const sharedModel = modelsA.filter((m) => modelsB.includes(m));
  // "F350" agreeing with "350" is only a number; with "Transit" named on the other side it says nothing about the vehicle
  // the head model of each listing: the first word of its vehicle name after the make ("Transit" in "Ford Transit-250", "F250" in "Ford F-250 Super Duty").
  // Two listings that share a number but have different heads ("Transit-250", "F-250"; "ProMaster 1500", "Ram 1500") are not shown to be for the same vehicle.
  // (only learned vehicle words count: a chain taken from a variant's text can be part codes)
  const isVehicleWord = (t: string) => corpus.subjectWords.has(`w:${t}`) || corpus.subjectWords.has(`c:${t}`);
  const headOf = (chain: string[]) => { const t = chain.find((w) => !corpus.makeWords.has(w) && isVehicleWord(w)); return t === undefined ? undefined : norm(t); };
  const headA = headOf(a.titleChain.length ? a.titleChain : a.subjectChain), headB = headOf(b.titleChain.length ? b.titleChain : b.subjectChain);
  const numberOnly = !!headA && !!headB && headA !== headB && sharedSubject.length > 0;
  const subjectOverlap: number | null = subA.length && subB.length ? (onlyA.length && onlyB.length ? 0 : sharedSubject.length ? 1 : 0) : null;
  // naming a model on only one side ("Honda" against "Honda Accord") does not show it is the same vehicle
  const headAsymmetric = (headA === undefined) !== (headB === undefined);
  const modelUnverified = subjectOverlap === 1 && (((modelsA.length > 0 || modelsB.length > 0) && sharedModel.length === 0) || numberOnly || headAsymmetric);
  if (subjectOverlap === 0) return { state: 'conflict' as const, why: 'different_subject' as const, overlap, subjectOverlap, sharedSubject };
  // "Jeep Cherokee" against "Jeep Grand Cherokee": a word the title puts in front of the model, and the other title does not, names another model
  const chainA = a.subjectChain.map(norm);
  const chainB = b.subjectChain.map(norm);
  const qualifier = (x: string[], y: string[]) => x.some((m, i) => {
    const j = y.indexOf(m);
    if (!/^[a-z]+$/.test(m) || i < 1 || j < 1) return false;
    const px = x[i - 1]!;
    const py = y[j - 1]!;
    // x writes "<make> <model>", y writes "<make> <qualifier> <model>"
    return px !== py && j >= 2 && i === 1 && /^[a-z]+$/.test(py) && !x.includes(py);
  });
  if (sharedSubject.length && (qualifier(chainA, chainB) || qualifier(chainB, chainA))) return { state: 'conflict' as const, why: 'different_model' as const, overlap, subjectOverlap, sharedSubject };
  if (overlap === 0) {
    const gap = Math.min(...[...yb].map((y) => Math.min(...[...ya].map((x) => Math.abs(x - y)))));
    return gap <= 2 ? { state: 'adjacent' as const, gap, overlap, subjectOverlap, sharedSubject } : { state: 'conflict' as const, why: 'years' as const, gap, overlap, subjectOverlap, sharedSubject };
  }
  // years that only touch (2021 against 2015–2021) say little: possibly a different generation
  if (modelUnverified) return { state: 'agree_years' as const, overlap, subjectOverlap, sharedSubject, modelUnverified };
  if (overlap < 0.5) return { state: 'partial' as const, overlap, subjectOverlap, sharedSubject };
  return { state: subjectOverlap === null ? ('agree_years' as const) : ('agree' as const), overlap, subjectOverlap, sharedSubject };
}

function compareSpecs(a: Spec[], b: Spec[]) {
  const supports: { key: SpecKey; a: string; b: string }[] = [];
  /** Performance figures (power, light output …) that agree within tolerance: they do not prove anything, but the closer alternative is the better one to show first. */
  const near: { key: SpecKey; a: string; b: string }[] = [];
  const conflicts: { key: SpecKey; a: string; b: string }[] = [];
  const soft: { key: SpecKey; a: string; b: string }[] = [];
  for (const key of new Set(a.map((s) => s.key))) {
    const xs = a.filter((s) => s.key === key);
    const ys = b.filter((s) => s.key === key);
    if (!ys.length || key === 'count') continue;
    const tol = TOLERANCE[key] ?? 0.05;
    const match = xs.some((x) => ys.some((y) => pct(x.value, y.value) <= tol));
    const row = { key, a: xs.map((s) => s.raw).join(' / '), b: ys.map((s) => s.raw).join(' / ') };
    if (match) { if (SPEC_HARDNESS[key] === 'hard') supports.push(row); else near.push(row); }
    else if (SPEC_HARDNESS[key] === 'hard') conflicts.push(row);
    else soft.push(row);
  }
  return { supports, conflicts, soft, near };
}

const relation = (a: string[], b: string[]): 'equal' | 'disjoint' | 'subset' | 'overlap' | 'unknown' => {
  if (!a.length || !b.length) return 'unknown';
  const sb = new Set(b);
  const shared = a.filter((x) => sb.has(x)).length;
  if (!shared) return 'disjoint';
  if (shared === a.length && shared === b.length) return 'equal';
  return shared === Math.min(a.length, b.length) ? 'subset' : 'overlap';
};

export function evaluatePair(a: Dossier, b: Dossier, corpus: Corpus): PairEvaluation {
  const items: EvidenceItem[] = [];
  const conflicts: string[] = [];
  const legacy = scorePair(a.legacy, b.legacy);
  const al = alignNames(a, b, corpus);
  const brand: 'same' | 'different' | 'unknown' = a.brand.key && b.brand.key ? (a.brand.key === b.brand.key ? 'same' : 'different') : 'unknown';
  // "24 oz" of oil is read as a weight by the size parser although it is a volume: when one size is a weight written in ounces and the other a volume, they cannot be compared
  const ozAsWeight = (q: Dossier['legacy']['qty']) => q.kind === 'mass' && /\boz\b|\bounces?\b/i.test(q.source) && !/\bfl\b|fluid/i.test(q.source);
  let qty = compareQuantities(a.legacy.qty, b.legacy.qty);
  if (qty === 'incompatible' && ((ozAsWeight(a.legacy.qty) && b.legacy.qty.kind === 'volume') || (ozAsWeight(b.legacy.qty) && a.legacy.qty.kind === 'volume'))) qty = 'unknown';
  const add = (i: EvidenceItem) => items.push(i);

  // ── identifiers
  const gtinEqual = !!a.identifiers.gtin && !!b.identifiers.gtin && a.identifiers.gtin.value === b.identifiers.gtin.value;
  const gtinDiffer = !!a.identifiers.gtin && !!b.identifiers.gtin && !gtinEqual;
  const mpnEqual = brand === 'same' && !!a.identifiers.mpn && a.identifiers.mpn.value === b.identifiers.mpn?.value && a.identifiers.mpn.value.length >= 4;
  if (gtinEqual) add({ kind: 'identifier', effect: 'supports', strength: 'strong', text: 'Same barcode (GTIN)', a: a.identifiers.gtin!.value, b: b.identifiers.gtin!.value });
  else if (gtinDiffer) add({ kind: 'identifier', effect: 'differs', strength: 'strong', text: 'Both have a valid barcode and the barcodes are different', a: a.identifiers.gtin!.value, b: b.identifiers.gtin!.value });
  if (mpnEqual) add({ kind: 'identifier', effect: 'supports', strength: 'strong', text: 'Same brand and manufacturer part number', a: a.identifiers.mpn!.value, b: b.identifiers.mpn!.value });
  if (!gtinEqual && !mpnEqual && a.unknown.includes('identifier') && b.unknown.includes('identifier')) add({ kind: 'identifier', effect: 'missing', strength: 'weak', text: 'Neither listing publishes a barcode or part number' });

  // ── brand
  if (brand === 'same') add({ kind: 'brand', effect: 'supports', strength: 'moderate', text: `Same brand (${a.brand.name})`, a: a.brand.name, b: b.brand.name });
  else if (brand === 'different') add({ kind: 'brand', effect: 'differs', strength: 'moderate', text: 'Different brands: a stand-in, not the same maker’s product', a: a.brand.name, b: b.brand.name });
  else add({ kind: 'brand', effect: 'missing', strength: 'weak', text: 'A brand is not stated on one or both listings' });

  // ── identity codes
  const codes = compareCodes(a, b, corpus);
  if (codes.state === 'agree') {
    const shown = codes.shared.map(up).join(' / ');
    add({
      kind: 'identity_code', effect: 'supports', strength: codes.shared.length >= 2 ? 'strong' : 'moderate',
      text: codes.shared.length >= 2 ? `Both name the same part codes: ${shown}` : `Both name the part code ${shown}`,
      a: codesText(a), b: codesText(b),
    });
    if (!codes.equal && codes.containment >= 1) add({ kind: 'identity_code', effect: 'differs', strength: 'weak', text: 'One listing names more codes than the other (often alternative names for the same part)' });
    else if (codes.containment < 1) add({ kind: 'identity_code', effect: 'differs', strength: 'moderate', text: 'The listings only partly agree on part codes', a: codesText(a), b: codesText(b) });
  } else if (codes.state === 'conflict') {
    conflicts.push(`Different part codes (${codes.A.map(up).join(' ')} vs ${codes.B.map(up).join(' ')})`);
    add({ kind: 'identity_code', effect: 'conflicts', strength: 'strong', text: 'The part codes are different, so they are not interchangeable', a: codesText(a), b: codesText(b) });
  } else {
    add({ kind: 'identity_code', effect: 'missing', strength: 'weak', text: a.codes.length || b.codes.length ? 'Only one listing names a part code that the other website uses' : 'No part or model codes found in either listing' });
  }

  // ── fitment
  const fit = compareFitment(a, b, corpus);
  if (fit.state === 'agree' || fit.state === 'agree_years') {
    add({ kind: 'fitment', effect: 'supports', strength: fit.state === 'agree' ? 'strong' : 'moderate', text: fit.state === 'agree' ? `Made for the same thing (${fit.sharedSubject!.join(' ')}) and the years overlap` : 'The years they are made for overlap', a: years(a.fitment!), b: years(b.fitment!) });
  } else if (fit.state === 'partial') {
    add({ kind: 'fitment', effect: 'differs', strength: 'strong', text: 'The years they are made for only partly overlap — possibly a different generation', a: years(a.fitment!), b: years(b.fitment!) });
  } else if (fit.state === 'adjacent') {
    add({ kind: 'fitment', effect: 'differs', strength: 'strong', text: `The years they are made for do not overlap but are only ${fit.gap} year${fit.gap === 1 ? '' : 's'} apart — possibly a different generation`, a: years(a.fitment!), b: years(b.fitment!) });
  } else if (fit.state === 'conflict') {
    const why = fit.why === 'different_model' ? `They are made for different models (${a.subjectChain.join(' ')} vs ${b.subjectChain.join(' ')})` : fit.why === 'different_subject' ? `They are made for different things (${a.subject.join(' ')} vs ${b.subject.join(' ')})` : `They are made for different periods (${years(a.fitment!)} vs ${years(b.fitment!)})`;
    conflicts.push(why);
    add({ kind: 'fitment', effect: 'conflicts', strength: 'strong', text: why, a: years(a.fitment!), b: years(b.fitment!) });
  } else if (fit.state === 'unverified') {
    add({ kind: 'fitment', effect: 'missing', strength: 'moderate', text: `Only ${fit.onlyA ? 'your' : 'the other'} listing says what it is made to fit; whether the other fits the same thing is not stated`, a: a.fitment ? years(a.fitment) : null, b: b.fitment ? years(b.fitment) : null });
  }

  // ── which part / position / kit each variant is (a fog-light bulb is not a dome-light bulb, even for the same vehicle)
  let position: 'agree' | 'conflict' | 'one_sided' | 'none' = 'none';
  if (a.position.length && b.position.length) {
    const shared = a.position.filter((t) => b.position.includes(t));
    position = shared.length ? 'agree' : 'conflict';
    if (shared.length) add({ kind: 'variant', effect: 'supports', strength: 'moderate', text: `Same part or position (${shared.slice(0, 3).join(', ')})`, a: a.position.join(' '), b: b.position.join(' ') });
    else {
      const why = `Different part or position (${a.position.slice(0, 3).join(' ')} vs ${b.position.slice(0, 3).join(' ')})`;
      conflicts.push(why);
      add({ kind: 'variant', effect: 'conflicts', strength: 'strong', text: why, a: a.position.join(' '), b: b.position.join(' ') });
    }
  } else if (a.position.length || b.position.length) {
    position = 'one_sided';
    add({ kind: 'variant', effect: 'missing', strength: 'weak', text: `Only ${a.position.length ? 'your' : 'the other'} listing says which part or position it is` });
  }

  // ── exclusions ("not for classic")
  const bSubject = new Set([...b.words, ...b.subject]);
  const aSubject = new Set([...a.words, ...a.subject]);
  const excluded = [...a.exclusions.filter((w) => bSubject.has(w)), ...b.exclusions.filter((w) => aSubject.has(w))];
  if (excluded.length) {
    const why = `One listing says it is not for “${[...new Set(excluded)].join(', ')}”, which the other is`;
    conflicts.push(why);
    add({ kind: 'exclusion', effect: 'conflicts', strength: 'strong', text: why });
  }

  // ── specifications. A hard difference rules out a stand-in; between two listings of the SAME maker's product it is a variant attribute instead.
  const specs = compareSpecs(a.specs, b.specs);
  const specConflicts = specs.conflicts.map((s) => ({ ...s, why: `Different ${SPEC_LABEL[s.key]} (${s.a} vs ${s.b})` }));
  // light colour (temperature) differing a lot makes a different product for the shopper, but not an unfitting one: it is "related", never a stand-in
  const tempClash = specs.soft.some((s) => s.key === 'colour_temp_k');
  for (const s of specs.supports) add({ kind: 'spec', effect: 'supports', strength: 'moderate', text: `Same ${SPEC_LABEL[s.key]}`, a: s.a, b: s.b });
  for (const s of specs.soft) add({ kind: 'spec', effect: 'differs', strength: 'weak', text: `${SPEC_LABEL[s.key][0]!.toUpperCase()}${SPEC_LABEL[s.key].slice(1)} differs (${s.a} vs ${s.b}): a different performance level`, a: s.a, b: s.b });

  // ── colour
  const ca = a.colours.values;
  const cb = b.colours.values;
  const colourRel = relation(ca, cb);
  if (colourRel === 'equal') add({ kind: 'colour', effect: 'supports', strength: 'weak', text: `Same colour (${ca.join(', ')})` });
  else if (colourRel === 'disjoint') add({ kind: 'colour', effect: 'differs', strength: 'strong', text: `Different colour (${ca.join(', ')} vs ${cb.join(', ')})`, a: ca.join(', '), b: cb.join(', ') });
  else if (colourRel === 'subset' || colourRel === 'overlap') add({ kind: 'colour', effect: 'differs', strength: 'moderate', text: 'The listings name different sets of colours; check the colour', a: ca.join(', '), b: cb.join(', ') });

  // ── pack / size
  const packA = a.packCount;
  const packB = b.packCount;
  const packDiffers = (packA && packB && packA !== packB) || qty === 'different_total';
  if (qty === 'same_total') add({ kind: 'size', effect: 'supports', strength: 'moderate', text: `Same total size (${a.legacy.qty.label})`, a: a.legacy.qty.label, b: b.legacy.qty.label });
  else if (qty === 'different_total') add({ kind: 'size', effect: 'differs', strength: 'strong', text: `Different size or pack (${a.legacy.qty.label ?? '?'} vs ${b.legacy.qty.label ?? '?'}): compare per unit`, a: a.legacy.qty.label, b: b.legacy.qty.label });
  else if (packA && packB && packA !== packB) add({ kind: 'pack', effect: 'differs', strength: 'strong', text: `Different pack (${packA} vs ${packB} items): compare per item`, a: String(packA), b: String(packB) });
  else if (packA && packB) add({ kind: 'pack', effect: 'supports', strength: 'weak', text: `Same pack (${packA} items)` });

  // ── bundle markers on one side only
  const bundleA = a.bundleMarkers.length > 0;
  const bundleB = b.bundleMarkers.length > 0;
  if (bundleA !== bundleB) add({ kind: 'bundle', effect: 'differs', strength: 'strong', text: `One listing is a ${(bundleA ? a : b).bundleMarkers[0]} (several items), the other is not`, a: a.bundleMarkers.join(', ') || null, b: b.bundleMarkers.join(', ') || null });

  // ── kind of thing
  const wc = wordCosine(a, b, corpus);
  // the vehicle's name says nothing about what kind of part a listing is: judge the kind on the other words
  // (a name that starts with a digit, "4Runner", is split into "runner" in the title words, so that form is left out too)
  const vehicleWords = new Set([...a.subject, ...b.subject].flatMap((s) => (/^\d+[a-z]/.test(s) ? [s, s.replace(/^\d+/, '')] : [s])));
  const wcKind = vehicleWords.size ? wordCosine(a, b, corpus, vehicleWords) : wc;
  const lastDisjoint = a.kind.last3.length > 0 && b.kind.last3.length > 0 && !a.kind.last3.some((w) => b.kind.last3.includes(w));
  let kindState: 'agree' | 'companion' | 'differs' | 'unknown' = 'unknown';
  /** The kind is confirmed by a shared kind WORD (not merely by the titles using similar words, which a shared vehicle name inflates). */
  let kindStrict = false;
  // "LED" in both says the light source, not the kind of thing
  const sharedKind = a.kindWords.filter((w) => b.kindWords.includes(w) && !KIND_MODIFIERS.has(w));
  // a modifier ("LED", "kit") says how a thing is built or sold, not what it is: a listing that names only a modifier names no kind
  const kindA = a.kindWords.filter((w) => !KIND_MODIFIERS.has(w));
  const kindB = b.kindWords.filter((w) => !KIND_MODIFIERS.has(w));
  // what a listing is, from the kind words anywhere in its title (a title that starts with the vehicle and has brackets names its kind late)
  const kindsAnywhere = (d: Dossier) => [...new Set(d.words.filter((w) => corpus.kindVocab.has(w) && !KIND_MODIFIERS.has(w) && !d.subject.includes(w) && !corpus.subjectWords.has(`w:${w}`) && !corpus.subjectWords.has(`c:${w}`)))];
  const sharedAnywhere = kindsAnywhere(a).filter((w) => kindsAnywhere(b).includes(w));
  const exclusiveKinds: [string, string] | null = (() => {
    if (sharedKind.length) return null;
    const ka = kindsAnywhere(a), kb = kindsAnywhere(b);
    if (!ka.length || !kb.length || ka.some((x) => kb.includes(x))) return null;
    for (const x of ka) for (const y of kb) {
      const together = corpus.kindTogether.get([x, y].sort().join('|')) ?? 0;
      if (together === 0 && (corpus.df.get(`w:${x}`) ?? 0) >= 30 && (corpus.df.get(`w:${y}`) ?? 0) >= 30) return [x, y];
    }
    return null;
  })();
  if (a.kind.companion !== b.kind.companion || (a.kind.companion && b.kind.companion && a.kind.tail !== b.kind.tail)) {
    kindState = 'companion';
    add({
      kind: 'product_type', effect: 'conflicts', strength: 'strong',
      text: `They are different kinds of product (“${a.kind.tail ?? '?'}” vs “${b.kind.tail ?? '?'}”) — one goes with the other rather than replacing it`,
      a: a.kind.tail, b: b.kind.tail,
    });
  } else if (sharedKind.length || (a.kind.tail && a.kind.tail === b.kind.tail)) {
    kindState = 'agree';
    kindStrict = true;
    add({ kind: 'product_type', effect: 'supports', strength: 'moderate', text: `Both are “${sharedKind[0] ?? a.kind.tail}” listings` });
  } else if (sharedAnywhere.length && !(kindA.length && kindB.length && !kindA.some((w) => kindB.includes(w)) && wcKind < 0.2)) {
    kindState = 'agree';
    kindStrict = true;
    add({ kind: 'product_type', effect: 'supports', strength: 'moderate', text: `Both are “${sharedAnywhere[0]}” listings` });
  } else if ((kindA.length && kindB.length && wcKind < 0.5) || (lastDisjoint && wcKind < 0.15 && kindA.length > 0 && kindB.length > 0)) {
    kindState = 'differs';
    add({ kind: 'product_type', effect: 'differs', strength: 'moderate', text: `The kind of product may differ (“${kindA.join(' ')}” vs “${kindB.join(' ')}”)`, a: kindA.join(' '), b: kindB.join(' ') });
  } else if (exclusiveKinds) {
    kindState = 'differs';
    add({ kind: 'product_type', effect: 'differs', strength: 'moderate', text: `They are different kinds of product (“${exclusiveKinds[0]}” and “${exclusiveKinds[1]}” are never seen together on one listing)`, a: exclusiveKinds[0], b: exclusiveKinds[1] });
  } else if (wcKind >= 0.35) {
    kindState = 'agree';
    add({ kind: 'product_type', effect: 'supports', strength: 'weak', text: 'The descriptions use largely the same words' });
  } else add({ kind: 'product_type', effect: 'missing', strength: 'weak', text: 'The titles share few descriptive words, so the kind of product is not confirmed' });

  // ── name (the earlier rules; one voice among several)
  if (legacy) add({ kind: 'name', effect: legacy.matchClass === 'comparable' ? 'differs' : 'supports', strength: legacy.matchClass === 'comparable' ? 'weak' : 'moderate', text: `Name and size check: ${legacy.reasons.slice(0, 2).join('; ')}` });

  // the earlier rules send a pair back to "comparable" when one name has a year or a lone model number the other lacks (a vintage? a product line?). That is a stated
  // difference on a probable match, not evidence of another product; a different VARIETY, FLAVOUR or NUMBERED SIZE is (those stay out of this).
  const softReasons = legacy && legacy.matchClass === 'comparable' && !legacy.reasons.some((r) => /variety or flavour|numbered size/.test(r)) ? legacy.reasons.filter((r) => /gives a year|has the number/.test(r)) : [];
  const probableSame = softReasons.length > 0 && brand !== 'different';
  for (const r of softReasons) add({ kind: 'name', effect: 'differs', strength: 'moderate', text: r });
  const sameMaker = gtinEqual || mpnEqual || probableSame || (!!legacy && legacy.method !== 'cross_brand' && (legacy.matchClass === 'identical' || legacy.matchClass === 'different_pack') && brand !== 'different');
  for (const s of specConflicts) {
    if (sameMaker) add({ kind: 'spec', effect: 'differs', strength: 'strong', text: `${s.why}: a variant of the same product`, a: s.a, b: s.b });
    else {
      conflicts.push(s.why);
      add({ kind: 'spec', effect: 'conflicts', strength: 'strong', text: `${s.why}, so they are not interchangeable`, a: s.a, b: s.b });
    }
  }
  const hasConflict = conflicts.length > 0;
  const finish = (relationship: MatchRelationship, tier: EvidenceTier, method: PairEvaluation['method'], rank: number, auto = false): PairEvaluation => {
    const supports = items.filter((i) => i.effect === 'supports');
    const specific = supports.filter((i) => i.kind === 'identifier' || i.kind === 'identity_code' || i.kind === 'fitment' || i.kind === 'spec').length;
    return { relationship, tier, method, rank: Math.round(rank * 1000) / 1000, conflicts, legacy, auto, evidence: { items, signals: supports.length, summary: summarise(relationship, tier, items, conflicts, specific) } };
  };

  // ── decisive incompatibilities end the question — unless the same barcode says it IS the same product
  if (hasConflict && !gtinEqual) {
    return finish('non_match', 'strong', 'none', 0);
  }

  // ── the same product from the same maker
  if (sameMaker) {
    const variant = packDiffers || legacy?.matchClass === 'different_pack' || colourRel === 'disjoint' || specConflicts.length > 0;
    const identifier = gtinEqual || mpnEqual;
    if (kindState === 'companion' && !identifier) return finish('related', 'medium', 'attributes', 0.4);
    const clean = !packDiffers && colourRel !== 'disjoint' && legacy?.matchClass !== 'different_pack' && specConflicts.length === 0;
    const strong = identifier ? clean || gtinEqual : legacy?.status === 'auto' && !variant && fit.state !== 'unverified';
    // auto-confirmation policy: the same barcode (or maker + part number) on a clean pair; or, without an identifier, the earlier rules' "identical" / "other pack" on a very similar name
    // with BOTH sizes stated (equal for the same product, different for another pack) and nothing about the kind, the vehicle or the colour that differs
    const sizedBoth = a.legacy.qty.kind !== 'unknown' && a.legacy.qty.kind === b.legacy.qty.kind && !!a.legacy.qty.total && !!b.legacy.qty.total;
    const nameSim = legacy?.components?.['nameSimilarity'] ?? 0;
    const quiet = kindState !== 'companion' && kindState !== 'differs' && fit.state !== 'unverified' && fit.state !== 'adjacent' && fit.state !== 'partial' && colourRel !== 'disjoint' && specConflicts.length === 0;
    const auto = quiet && (identifier || (al.relation === 'equal' && !al.editionOneSided && !al.variety.length)) && (identifier ? clean && !variant : !!legacy && brand !== 'different' && nameSim >= 0.9 && sizedBoth && (variant ? legacy.matchClass === 'different_pack' && qty === 'different_total' : legacy.matchClass === 'identical' && qty === 'same_total'));
    return finish(variant ? 'variant' : 'exact', strong ? 'strong' : 'medium', gtinEqual ? 'gtin' : mpnEqual ? 'brand_model' : 'attributes', identifier ? 0.95 : 0.7 + (legacy?.confidence ?? 0) * 0.2, auto);
  }

  // ── the titles start with the same brand name though one listing publishes no brand field: the same maker's range, so a different variety is
  //    a related product of it, not a stand-in from another maker
  const leadWord = (d: Dossier) => plain(d.title).split(/[^a-z0-9]+/).filter(Boolean)[0] ?? '';
  const lead = leadWord(a);
  const sameMakerByTitle = brand !== 'different' && /^[a-z]{3,}$/.test(lead) && lead === leadWord(b) && (corpus.df.get('w:' + stem(lead)) ?? 0) <= 0.03 * corpus.n;
  if (sameMakerByTitle && legacy && legacy.matchClass === 'comparable' && legacy.method === 'cross_brand' && codes.state !== 'agree') {
    const variety = variantDifference(a.legacy.core, b.legacy.core);
    // "only the size differs" needs the names to say the same thing: the earlier variety check knows a short list of words, so "Original Roast" against
    // "Hazelnut" or "Spinach Dip" against "Ranch Dip" passed it
    // (the same unit size sold as a different number of units is the exception: one descriptor word more or less, "Artesian", does not change which product it is)
    const unitSize = (d: Dossier) => d.legacy.qty.unitAmount ?? d.legacy.qty.total;
    const sameUnit = !!unitSize(a) && !!unitSize(b) && Math.abs(unitSize(a)! - unitSize(b)!) / Math.max(unitSize(a)!, unitSize(b)!) <= 0.01 && a.legacy.qty.packCount !== b.legacy.qty.packCount;
    const oneWordApart = (() => { const ca = new Set(a.legacy.core), cb = new Set(b.legacy.core); const [s, l] = ca.size <= cb.size ? [ca, cb] : [cb, ca]; return s.size >= 2 && [...s].every((w) => l.has(w)) && l.size - s.size <= 1; })();
    const onlySize = !variety.length && qty === 'different_total' && a.legacy.qty.kind === b.legacy.qty.kind && a.legacy.qty.kind !== 'unknown' && (!!nameContainment(a, b, corpus) || (sameUnit && oneWordApart));
    if (onlySize) {
      add({ kind: 'brand', effect: 'supports', strength: 'weak', text: 'Both titles start with the same brand name, so probably the same maker', a: a.title, b: b.title });
      return finish('variant', 'medium', 'name_similarity', 0.6);
    }
    add({ kind: 'variant', effect: 'differs', strength: 'moderate', text: variety.length ? 'Both titles start with the same brand name, but they name different varieties (' + variety.join(', ') + '): a related product of the same range' : 'Both titles start with the same brand name, but the products differ: a related product of the same range', a: a.title, b: b.title });
    return finish('related', 'medium', 'name_similarity', 0.38);
  }

  // ── names that say the same thing although no brand field says who makes it: a rare word that starts both titles (spelled the way each shop spells it), or a
  //    maker named on one listing only. Only for products with no part codes or fitment — those are decided by the evidence above.
  const sparseNames = !a.codes.length && !b.codes.length && !a.fitment && !b.fitment;
  const makerBy: 'brand' | 'lead' | 'one_side' | null = brand === 'different' ? null : brand === 'same' ? 'brand' : al.lead >= 1 && al.leadRare ? 'lead' : al.prefixExtra && al.shared.length >= 2 ? 'one_side' : null;
  const sameNumbers = (() => {
    const na = [...modelNumbersIn(a.title), ...labelledNumbersIn(a.title)].sort().join(',');
    const nb = [...modelNumbersIn(b.title), ...labelledNumbersIn(b.title)].sort().join(',');
    return na === nb;
  })();
  if (makerBy && sparseNames && kindState !== 'companion' && kindState !== 'differs' && codes.state !== 'conflict' && al.shared.length >= 1 && al.relation !== 'disjoint') {
    // the same product needs a name that CONTAINS the other (or equals it) with little added: where each title has words the other lacks, that is two products of one range
    const contained = al.relation === 'equal' || al.relation === 'a_in_b' || al.relation === 'b_in_a';
    if (!al.variety.length && sameNumbers && contained && al.extraShare <= NAME_EXTRA_MAX && (makerBy === 'one_side' ? al.shared.length >= 2 : true)) {
      // both sizes stated but not equal (or not comparable: a weight against a volume) is another pack, whatever the units: only a listing that leaves its size out can be called the same product
      const sizedBoth = a.legacy.qty.kind !== 'unknown' && b.legacy.qty.kind !== 'unknown';
      const sizeDiffers = qty === 'different_total' || (!!packA && !!packB && packA !== packB) || (sizedBoth && qty !== 'same_total');
      const extras = [...al.onlyA, ...al.onlyB];
      add({ kind: 'name', effect: 'supports', strength: 'moderate', text: `The names say the same thing (${al.shared.slice(0, 6).join(' ')})`, a: a.title, b: b.title });
      if (extras.length) add({ kind: 'variant', effect: 'differs', strength: 'weak', text: `One listing adds: ${extras.join(' ')}`, a: null, b: null });
      if (qty !== 'same_total' && qty !== 'different_total') add({ kind: 'size', effect: 'missing', strength: 'moderate', text: 'The sizes cannot be compared (one listing leaves the size out or states it in another kind of unit)' });
      if (makerBy === 'one_side') {
        // a listing that names no maker may be the same product or another maker's equivalent: never claimed as the same product
        add({ kind: 'brand', effect: 'differs', strength: 'moderate', text: 'Only one listing names its maker, so this may be the same product or another maker’s equivalent', a: a.title, b: b.title });
        return finish('substitute', 'medium', 'name_similarity', 0.42);
      }
      add({ kind: 'brand', effect: 'supports', strength: 'weak', text: 'Both titles start with the same maker name', a: a.title, b: b.title });
      if (sizeDiffers && qty !== 'different_total' && !(packA && packB)) add({ kind: 'size', effect: 'differs', strength: 'moderate', text: `The sizes differ (${a.legacy.qty.label ?? '?'} vs ${b.legacy.qty.label ?? '?'}) and are stated in different kinds of unit: compare per unit where possible`, a: a.legacy.qty.label, b: b.legacy.qty.label });
      // auto-confirmation policy: the same maker named in both titles, a name that contains the other with almost nothing added, and both sizes stated and consistent
      const sameKindSized = sizedBoth && a.legacy.qty.kind === b.legacy.qty.kind;
      const auto = makerBy !== null && al.relation === 'equal' && !al.editionOneSided && (sizeDiffers ? sameKindSized && qty === 'different_total' && !(packA && packB && packA === packB) : qty === 'same_total') && al.extraShare <= 0.15;
      return finish(sizeDiffers ? 'variant' : 'exact', 'medium', 'name_similarity', 0.55 - 0.15 * al.extraShare, auto);
    }
    if (al.variety.length && makerBy !== 'one_side' && al.shared.length >= 2) {
      add({ kind: 'variant', effect: 'differs', strength: 'moderate', text: `Both titles start with the same maker name, but they name different varieties (${al.variety.join(', ')}): a related product of the same range`, a: a.title, b: b.title });
      return finish('related', 'medium', 'name_similarity', 0.38);
    }
  }

  // ── a different maker's product: substitute / related
  const agreeing = {
    codes: codes.state === 'agree' && codes.containment >= 1,
    fitment: fit.state === 'agree' && (position === 'agree' || position === 'none'),
    spec: specs.supports.length > 0,
    type: kindState === 'agree',
    name: !!legacy && legacy.matchClass === 'comparable' && (legacy.components.nameSimilarity ?? 0) >= 0.7,
  };
  const specific = agreeing.codes || agreeing.fitment || agreeing.spec;
  // two or more shared part codes are far less likely to collide by chance than one, so they count as two signals
  const signals = Object.values(agreeing).filter(Boolean).length + (agreeing.codes && codes.shared.length >= 2 ? 1 : 0);
  // a difference that changes the product (colour, bundle, size/pack, hard attributes); a different brand is what makes it a stand-in, not a weakness
  const differs = items.some((i) => i.effect === 'differs' && i.strength !== 'weak' && i.kind !== 'brand' && i.kind !== 'identity_code');

  if (kindState === 'companion' && (codes.state === 'agree' || fit.state === 'agree' || !!legacy)) {
    return finish('related', 'medium', 'identity_code', 0.45);
  }
  if (tempClash && (codes.state === 'agree' || !!legacy)) {
    add({ kind: 'colour', effect: 'differs', strength: 'strong', text: 'Different colour temperature, so a different light colour' });
    return finish('related', 'medium', 'identity_code', 0.42);
  }
  // a colour MODE ("switchback", "dual colour") that only one of the two has is the product's point: a single-colour bulb of the same socket is related, not a stand-in
  const modeOf = (d: Dossier) => /\b(switchback|dual[\s-]?colou?r|tri[\s-]?colou?r|color[\s-]?changing|colour[\s-]?changing)\b/i.test(plain(d.title));
  if (modeOf(a) !== modeOf(b) && (codes.state === 'agree' || !!legacy)) {
    add({ kind: 'variant', effect: 'differs', strength: 'strong', text: `Only ${modeOf(a) ? 'your' : 'the other'} listing is a switchback / dual-colour bulb: a different feature, not a stand-in`, a: null, b: null });
    return finish('related', 'medium', 'identity_code', 0.41);
  }
  if (colourRel === 'disjoint' && (codes.state === 'agree' || !!legacy)) {
    return finish('related', 'medium', 'identity_code', 0.42);
  }
  if (bundleA !== bundleB && codes.state === 'agree') {
    return finish('related', 'medium', 'identity_code', 0.4);
  }
  // the same code or vehicle but a different KIND of thing (a bed mat against a bulb): the kinds are the point, not a stand-in
  if (kindState === 'differs' && (codes.state === 'agree' || fit.state === 'agree' || (legacy && legacy.matchClass === 'comparable'))) return finish('related', 'medium', 'identity_code', 0.36);
  // the same bulb size, but two listings for different generations of the vehicle (the years do not overlap): each is the right kit for its own vehicle, so they go together, they do not replace each other
  if (codes.state === 'agree' && fit.state === 'adjacent') {
    return finish('related', 'medium', 'identity_code', 0.4);
  }
  // a code in common is the ONLY link (the kind of product is not confirmed and the titles share almost no descriptive words): a BMW X5 floor mat and an "X5" headlight bulb
  if (codes.state === 'agree' && kindState === 'unknown' && wcKind < 0.15 && specs.supports.length === 0 && fit.state !== 'agree') {
    add({ kind: 'product_type', effect: 'missing', strength: 'moderate', text: 'The listings share a code but nothing else shows they are the same kind of product' });
    return finish('insufficient', 'insufficient', 'identity_code', 0.2);
  }
  // two vehicle-specific kits are each the right kit for their own vehicle: unless both name the same model they go together, they do not replace each other
  if (codes.state === 'agree' && !!a.fitment && !!b.fitment && fit.state === 'agree_years') {
    return finish('related', 'medium', 'identity_code', 0.4);
  }
  if (codes.state === 'agree' || (fit.state === 'agree' && kindStrict) || (legacy && legacy.matchClass === 'comparable' && legacy.method === 'cross_brand')) {
    // vehicle-specific vs generic, adjacent generation, or no type confirmation: never "strong"
    const unresolved = fit.state === 'unverified' || fit.state === 'adjacent' || fit.state === 'partial' || fit.state === 'agree_years' || (fit.state === 'agree' && position === 'one_sided' && codes.state !== 'agree');
    // two combos that do not hold the same sockets ("H11 combo" against "9005 + H11 combo") are not the same contents: never strong
    const sameContents = !(bundleA && bundleB && codes.state === 'agree' && !codes.equal);
    const strong = signals >= 2 && specific && !unresolved && !differs && kindState === 'agree' && brand !== 'same' && sameContents && (codes.state === 'agree' || specs.supports.length > 0);
    const sameBrandCodes = brand === 'same' && codes.state === 'agree' && codes.equal;
    if (sameBrandCodes && !hasConflict) return finish(packDiffers ? 'variant' : 'exact', 'medium', 'identity_code', 0.65);
    // among equally valid stand-ins the CLOSEST one comes first: the same position, similar power and light output, the same pack and colour, and similar wording
    const closeness = 0.08 * wcKind + (position === 'agree' ? 0.03 : 0) + 0.015 * specs.near.length - 0.01 * specs.soft.length + (packA && packB && packA === packB ? 0.02 : 0) + (colourRel === 'equal' ? 0.02 : 0);
    return finish('substitute', strong ? 'strong' : 'medium', codes.state === 'agree' ? 'identity_code' : fit.state === 'agree' ? 'fitment' : 'cross_brand', 0.3 + 0.12 * signals + (specific ? 0.1 : 0) - (unresolved ? 0.05 : 0) + closeness);
  }
  // ── a different maker's product that is the same KIND of thing (products with no part codes or fitment): "Aluminum Foil" and "Aluminum Foil", "Sauvignon Blanc" and
  //    "Sauvignon Blanc". The words that name the kind are the ones many makers' titles use; the words that name a flavour, variety or formulation must agree.
  //    Never "strong": the same words are not proof that the products do the same job.
  if (!makerBy && brand !== 'same' && sparseNames && kindState !== 'companion' && codes.state !== 'conflict') {
    const ta = typeWords(a, corpus);
    const tb = typeWords(b, corpus);
    const sharedType = ta.filter((w) => tb.includes(w));
    const onlyType = [...ta.filter((w) => !tb.includes(w)), ...tb.filter((w) => !ta.includes(w))];
    const wt = (ws: string[]) => ws.reduce((s, w) => s + corpus.nameIdf(w), 0);
    const kindsKnown = a.legacy.qty.kind !== 'unknown' && a.legacy.qty.kind === b.legacy.qty.kind && !!a.legacy.qty.total && !!b.legacy.qty.total;
    const ratio = kindsKnown ? Math.max(a.legacy.qty.total!, b.legacy.qty.total!) / Math.min(a.legacy.qty.total!, b.legacy.qty.total!) : 1;
    const nameDiffers = al.variety.length > 0 || al.form.length > 0 || !sameNumbers;
    // the word that names the kind is the same on both titles, and ends at least one of them ("... Aluminum Foil", "... Sauvignon Blanc"); the words that name the kind carry at least half of the weight of all the kind-like words
    const hA = kindHead(a, corpus), hB = kindHead(b, corpus);
    const headOk = !!hA && !!hB && hA.head === hB.head && (hA.final || hB.final);
    if (headOk && sharedType.some((w) => corpus.nameIdf(w) >= 3) && wt(sharedType) >= 3.5 && wt(sharedType) >= 0.5 * (wt(sharedType) + wt(onlyType)) && !nameDiffers && ratio <= 5 && colourRel !== 'disjoint') {
      add({ kind: 'product_type', effect: 'supports', strength: 'moderate', text: `Both are “${sharedType.slice(0, 4).join(' ')}” products from different makers`, a: ta.join(' '), b: tb.join(' ') });
      if (qty === 'different_total') add({ kind: 'size', effect: 'differs', strength: 'moderate', text: `Different size or pack (${a.legacy.qty.label ?? '?'} vs ${b.legacy.qty.label ?? '?'}): compare per unit`, a: a.legacy.qty.label, b: b.legacy.qty.label });
      else if (qty !== 'same_total') add({ kind: 'size', effect: 'missing', strength: 'weak', text: 'The sizes cannot be compared (one listing leaves the size out or states it in another kind of unit)' });
      return finish('substitute', 'medium', 'cross_brand', 0.3 + 0.05 * Math.min(4, wt(sharedType) / 3.5));
    }
  }
  if (fit.state === 'adjacent' || fit.state === 'partial') return finish('insufficient', 'insufficient', 'fitment', 0.2);
  // the same product named the same way, whose size cannot be compared (one listing leaves it out, or the two state it in different kinds of unit):
  // the rules above need a size to agree on, but a person can settle this at a glance
  const named = nameContainment(a, b, corpus);
  if (named && brand !== 'different' && qty !== 'different_total' && kindState !== 'differs' && kindState !== 'companion' && codes.state !== 'conflict' && !packDiffers) {
    add({ kind: 'name', effect: 'supports', strength: 'moderate', text: `The names say the same thing (${named.shared.join(' ')})`, a: a.title, b: b.title });
    if (named.extras.length) add({ kind: 'variant', effect: 'differs', strength: 'weak', text: `One listing adds: ${named.extras.join(' ')}`, a: null, b: null });
    if (qty !== 'same_total') add({ kind: 'size', effect: 'missing', strength: 'moderate', text: 'The sizes cannot be compared (one listing leaves the size out or states it in another kind of unit)' });
    return finish('exact', 'medium', 'name_similarity', 0.5 - 0.05 * named.extras.length);
  }
  if (legacy && legacy.matchClass === 'comparable') return finish('related', 'medium', 'name_similarity', 0.35);
  // "not enough information" is only worth a person's time when something is actually MISSING on a side (no code and no fitment), not when both
  // sides say plenty and simply do not agree
  const sparse = (d: Dossier) => !d.codes.length && !d.fitment;
  if (wc >= 0.5 && kindState === 'agree' && (sparse(a) || sparse(b))) {
    return finish('insufficient', 'insufficient', 'name_similarity', 0.15 + 0.1 * wc);
  }
  return finish('non_match', 'strong', 'none', 0);
}

/** One plain sentence: why this was suggested and what weakens it. */
function summarise(rel: MatchRelationship, tier: EvidenceTier, items: EvidenceItem[], conflicts: string[], specific: number): string {
  const sup = items.filter((i) => i.effect === 'supports' && i.kind !== 'name').map((i) => i.text.replace(/^Both /, 'both ').replace(/^Same /, 'same ').replace(/^The /, 'the '));
  const weak = items.filter((i) => (i.effect === 'differs' || i.effect === 'missing') && i.strength !== 'weak').map((i) => i.text.charAt(0).toLowerCase() + i.text.slice(1));
  const head: Record<MatchRelationship, string> = {
    exact: 'Looks like the same product',
    variant: 'Looks like the same product in a different pack, size or colour',
    substitute: 'Could stand in for your product',
    related: 'Goes with your product but is not interchangeable',
    non_match: 'Not the same product',
    insufficient: 'Not enough information to say',
  };
  if (rel === 'non_match') return `${head[rel]}: ${conflicts.join('; ') || 'no shared identifying evidence'}.`;
  const because = sup.length ? ` because ${sup.slice(0, 3).join(', ')}` : '';
  const caveat = weak.length ? `. Weakens it: ${weak.slice(0, 2).join('; ')}` : '';
  void tier;
  void specific;
  return `${head[rel]}${because}${caveat}.`;
}
