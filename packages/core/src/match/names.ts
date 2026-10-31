import { variantDifference } from '../matching.ts';
import type { Corpus } from './corpus.ts';
import type { Dossier } from './dossier.ts';

/**
 * Name alignment (matching engine v2.8): whether two titles say the same thing although they are not written the same way, and whether they name
 * the same maker although neither listing has a brand field. Read from the titles and from what the whole catalogue says about its own words:
 *   • a maker is a rare word that starts titles ("Lipton", "Kerrygold"); two titles that start with the same rare word are the same maker's;
 *   • a title may leave the maker out ("Hardwood Smoked Bacon") or add words ("Specialty Herbs and Spices"): the rest of the name is still the same;
 *   • spellings differ between shops ("Hellmann's", "Hellman's"; "Lite", "Light"): one letter apart in a long word, or a known spelling pair, is the same word;
 *   • a word that names a flavour, variety or formulation on one side only ("Diet", "Vanilla", "Salted") makes another product — the caller decides.
 * The only list is a handful of spelling pairs: language-level, not per product.
 */

/**
 * Words, besides the flavour list the earlier matcher keeps, that name a variety when only one of two titles has them: the same seasoning, soup or sauce
 * with another meat or fish is another product. And words that name the FORM a thing is sold in, which decides how it is used ("strained" pear against a fresh pear).
 * Language-level, as short as it can be; stems as `coreNameTokens` writes them.
 */
const EXTRA_VARIETY = new Set(['chicken', 'beef', 'pork', 'turkey', 'steak', 'ham', 'fish', 'salmon', 'tuna', 'shrimp', 'lamb', 'veal', 'sausage']);
const FORM_WORDS = new Set(['strain', 'strained', 'puree', 'pureed', 'dried', 'dry', 'dehydrated', 'frozen', 'canned', 'fresh', 'powder', 'powdered', 'mix', 'concentrate', 'concentrated', 'instant', 'ready', 'baby', 'toddler', 'juice', 'sauce', 'syrup', 'spray', 'flavor', 'flavored', 'scented']);

const SPELLING: Record<string, string> = { lite: 'light', creme: 'cream', yoghurt: 'yogurt', yoghourt: 'yogurt', flavour: 'flavor', colour: 'color', doughnut: 'donut', catsup: 'ketchup', mayo: 'mayonnaise', whiskey: 'whisky', cooky: 'cookie' };
const fold = (t: string) => SPELLING[t] ?? t;

/** One letter apart (a substitution, an insertion or a deletion), both words long enough that this is a typing difference rather than another word. */
function oneApart(x: string, y: string): boolean {
  if (x === y) return true;
  if (x.length < 5 || y.length < 5 || Math.abs(x.length - y.length) > 1) return false;
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  if (x.length === y.length) return x.slice(i + 1) === y.slice(i + 1);
  return x.length > y.length ? x.slice(i + 1) === y.slice(i) : y.slice(i + 1) === x.slice(i);
}

export interface NameAlignment {
  shared: string[];
  onlyA: string[];
  onlyB: string[];
  relation: 'equal' | 'a_in_b' | 'b_in_a' | 'overlap' | 'disjoint';
  /** Leading words the two titles share, and whether the first of them is rare enough to be a maker's name. */
  lead: number;
  leadRare: boolean;
  /** One title is the other with words put in front (a maker named on one listing only). */
  prefixExtra: 'a' | 'b' | null;
  /** The weight of the words only one side has, as a share of the weight of all the words of both. */
  extraShare: number;
  /** Flavour / variety / formulation words that only one side has. */
  variety: string[];
  /** Words naming the form it is sold in ("strained", "frozen", "powder") that only one side has. */
  form: string[];
  /** Only one title names an edition ("Original", "Classic"): possibly the same product, but not one to confirm without a person. */
  editionOneSided: boolean;
  /** The name words of each title after folding spellings and joining near-identical words. */
  tokensA: string[];
  tokensB: string[];
}

/**
 * Edition words ("Original", "Natural", "Classic") are dropped from the name when titles are normalised, so "Applesauce Original" and "Applesauce Natural" would look identical.
 * Two titles that name different editions are different products; a title that names one the other leaves out may still be the same product, but not one to confirm unseen.
 */
const EDITION_WORDS = new Set(['original', 'natural', 'classic', 'regular', 'traditional', 'authentic', 'homestyle', 'plain', 'unsweetened']);
const editionOf = (title: string): string[] => [...new Set(title.toLowerCase().split(/[^a-z]+/).filter((w) => EDITION_WORDS.has(w)))].sort();

export function alignNames(a: Dossier, b: Dossier, corpus: Corpus): NameAlignment {
  const ta = [...new Set(a.legacy.core.map(fold))];
  // B's words are written as A's wherever they are the same word
  const tb = [...new Set(b.legacy.core.map(fold))].map((w) => ta.find((x) => oneApart(x, w)) ?? w);
  const sa = new Set(ta);
  const sb = new Set(tb);
  const shared = ta.filter((w) => sb.has(w));
  const onlyA = ta.filter((w) => !sb.has(w));
  const onlyB = tb.filter((w) => !sa.has(w));
  const relation: NameAlignment['relation'] = !shared.length ? 'disjoint' : !onlyA.length && !onlyB.length ? 'equal' : !onlyA.length ? 'a_in_b' : !onlyB.length ? 'b_in_a' : 'overlap';
  let lead = 0;
  while (lead < ta.length && lead < tb.length && ta[lead] === tb[lead]) lead++;
  const first = ta[0] ?? '';
  const leadRare = lead >= 1 && /^[a-z]{3,}$/.test(first) && (corpus.nameDf.get(first) ?? 0) <= Math.max(3, 0.03 * corpus.nProducts);
  // "bacon" with "oscar mayer naturally" in front of it: the shorter title is the end of the longer one
  const endsWith = (long: string[], short: string[]) => short.length >= 2 && long.length > short.length && short.every((w, i) => long[long.length - short.length + i] === w);
  const prefixExtra: NameAlignment['prefixExtra'] = endsWith(tb, ta) ? 'b' : endsWith(ta, tb) ? 'a' : null;
  const weight = (ws: string[]) => ws.reduce((s, w) => s + corpus.nameIdf(w), 0);
  const all = weight([...new Set([...ta, ...tb])]);
  const extraShare = all > 0 ? weight([...onlyA, ...onlyB]) / all : 1;
  const edA = editionOf(a.title), edB = editionOf(b.title);
  const editionConflict = edA.length > 0 && edB.length > 0 && edA.join() !== edB.join();
  const editionOneSided = (edA.length > 0) !== (edB.length > 0);
  const variety = [...new Set([...variantDifference(ta, tb), ...[...onlyA, ...onlyB].filter((w) => EXTRA_VARIETY.has(w)), ...(editionConflict ? [...edA.filter((w) => !edB.includes(w)), ...edB.filter((w) => !edA.includes(w))] : [])])];
  const form = [...onlyA, ...onlyB].filter((w) => FORM_WORDS.has(w));
  return { shared, onlyA, onlyB, relation, lead, leadRare, prefixExtra, extraShare, variety, form, editionOneSided, tokensA: ta, tokensB: tb };
}

/**
 * The words of a name that say WHAT KIND of product it is, as opposed to who makes it or which line it belongs to: words that start titles under many
 * different makers ("foil", "pinot", "mayonnaise", "water"). Read from the catalogue; a maker's own name never qualifies.
 */
const TYPE_SPREAD_MIN = 3;
/** Words that measure or size a thing rather than name it. */
const SIZE_WORDS = new Set(['square', 'feet', 'foot', 'ft', 'inch', 'yard', 'sheet', 'roll', 'count', 'piece', 'pack', 'pk', 'ounce', 'oz', 'pound', 'lb', 'liter', 'litre', 'gallon', 'large', 'medium', 'small', 'mini', 'jumbo', 'size', 'per', 'each']);

/** The word that names the kind of product: the last kind word of the title (size words left out), and whether it is also the last word of the title. */
export function kindHead(d: Dossier, corpus: Corpus): { head: string; final: boolean } | null {
  const toks = d.legacy.core.map(fold).filter((w) => !SIZE_WORDS.has(w));
  for (let i = toks.length - 1; i >= 0; i--) {
    const w = toks[i]!;
    if (/^[a-z]{3,}$/.test(w) && (corpus.typeSpread.get(w) ?? 0) >= TYPE_SPREAD_MIN) return { head: w, final: i === toks.length - 1 };
  }
  return null;
}

export function typeWords(d: Dossier, corpus: Corpus): string[] {
  return [...new Set(d.legacy.core.filter((w) => /^[a-z]{3,}$/.test(w) && (corpus.typeSpread.get(w) ?? 0) >= TYPE_SPREAD_MIN).map(fold))];
}
