import { collectKnownBrands, prepareVariant } from '../matching.ts';
import { buildDossier, plain, seedColours, type Dossier, type DossierInput } from './dossier.ts';

/**
 * Corpus analysis (matching engine v2): what the whole catalogue says about its own tokens. Nothing here is written by hand for a product kind —
 * which codes are aliases of each other, which words say WHICH vehicle or device a listing is for, which colour words the websites use, and how
 * rare each token is are all read from the data, so a new website or a new kind of product needs no new rules.
 */

export interface Corpus {
  dossiers: Dossier[];
  byVariant: Map<string, Dossier>;
  n: number;
  /** Document frequency of 'w:<word>' and 'c:<code>' keys. */
  df: Map<string, number>;
  idf(key: string): number;
  /** Codes written differently for the same thing (H4 = 9003 = HB2), folded to one representative. */
  alias: Map<string, string>;
  /** Words and codes that accompany year ranges and are rare: the make/model/device a listing is for. */
  subjectWords: Set<string>;
  /** The codes each website uses at all. */
  siteCodes: Map<string, Set<string>>;
  /** The websites each code appears on: a code found on one website only is that website's own series or model name, not a part code anyone else would use. */
  codeSites: Map<string, Set<string>>;
  colourVocab: Set<string>;
  stats: CorpusStats;
}

export interface CorpusStats {
  dossiers: number;
  withCodes: number;
  withFitment: number;
  aliasGroups: number;
  subjectWords: number;
  colourWords: number;
}

/** A title that lists several products ("9005 and H11 combo") says nothing about which codes are the same thing. */
const BUNDLE_OR_LIST = /\b(combo|kit|bundle|and)\b|\+/;

function union(parent: Map<string, string>, a: string, b: string) {
  const find = (x: string): string => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const ra = find(a);
  const rb = find(b);
  if (ra === rb) return;
  // the representative is the shorter / lexically smaller code: stable between runs
  const [keep, drop] = ra.length < rb.length || (ra.length === rb.length && ra < rb) ? [ra, rb] : [rb, ra];
  parent.set(drop, keep);
  if (!parent.has(keep)) parent.set(keep, keep);
}

function resolveAlias(parent: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const k of parent.keys()) {
    const r = find(k);
    if (r !== k) out.set(k, r);
  }
  return out;
}

/** Colour words the websites themselves use on a colour axis ("Color": "Xenon White" → white), added to a small language-level seed. */
export function mineColourVocab(inputs: DossierInput[]): Set<string> {
  const vocab = seedColours();
  const onAxis = new Map<string, number>();
  const anywhere = new Map<string, number>();
  for (const i of inputs) {
    for (const [k, v] of Object.entries(i.options ?? {})) {
      const last = plain(v).split(/[^a-z]+/).filter((w) => w.length >= 3).at(-1);
      if (!last) continue;
      anywhere.set(last, (anywhere.get(last) ?? 0) + 1);
      if (/colou?r|finish|shade|tint/i.test(k)) onAxis.set(last, (onAxis.get(last) ?? 0) + 1);
    }
  }
  for (const [w, n] of onAxis) if (n >= 5 && n / (anywhere.get(w) ?? n) >= 0.4 && !['pack', 'combo', 'light', 'lights', 'bulb', 'bulbs', 'set', 'kit'].includes(w)) vocab.add(w);
  return vocab;
}

export function analyseCatalogue(inputs: DossierInput[]): Corpus {
  const brands = collectKnownBrands(inputs);
  const colourVocab = mineColourVocab(inputs);
  const dossiers = inputs.map((i) => buildDossier(i, prepareVariant(i, brands), colourVocab));
  const n = dossiers.length;

  // document frequencies
  const df = new Map<string, number>();
  const bump = (k: string) => df.set(k, (df.get(k) ?? 0) + 1);
  for (const d of dossiers) {
    for (const w of d.words) bump(`w:${w}`);
    for (const c of new Set(d.codeTokens.map((x) => x.value))) bump(`c:${c}`);
  }
  const idf = (key: string) => Math.log(1 + n / (1 + (df.get(key) ?? 0)));

  // which tokens say what a listing is FOR: they accompany year ranges and are not everywhere
  const withRange = dossiers.filter((d) => d.yearMentions.ranges.length > 0);
  const fit = new Map<string, number>();
  for (const d of withRange) for (const k of new Set([...d.words.map((w) => `w:${w}`), ...d.codeTokens.map((c) => `c:${c.value}`)])) fit.set(k, (fit.get(k) ?? 0) + 1);
  /** A word in more than this share of all listings is general vocabulary, not the name of a vehicle or device. */
  const generalShare = 0.25;
  const maxDf = Math.max(3, Math.floor(generalShare * n));
  const subjectWords = new Set<string>();
  if (withRange.length >= 5) {
    for (const [k, c] of fit) {
      const f = df.get(k) ?? 0;
      if (c >= 2 && c / f >= 0.5 && f <= maxDf) subjectWords.add(k);
    }
  }

  // codes that always appear together on the same listings, on more than one website, are the same thing named twice (H4 / 9003 / HB2)
  const pairs = new Map<string, { n: number; sites: Set<string> }>();
  for (const d of dossiers) {
    const cs = [...new Set(d.codeTokens.map((c) => c.value))].filter((c) => !subjectWords.has(`c:${c}`));
    if (cs.length < 2 || cs.length > 4 || BUNDLE_OR_LIST.test(plain(d.legacy.title))) continue;
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      const key = [cs[i], cs[j]].sort().join('|');
      const e = pairs.get(key) ?? { n: 0, sites: new Set<string>() };
      e.n++;
      e.sites.add(d.siteId);
      pairs.set(key, e);
    }
  }
  const parent = new Map<string, string>();
  for (const [key, e] of pairs) {
    if (e.n < 3 || e.sites.size < 2) continue;
    const [a, b] = key.split('|') as [string, string];
    const together = e.n / Math.min(df.get(`c:${a}`) ?? 1, df.get(`c:${b}`) ?? 1);
    if (together >= 0.4) union(parent, a, b);
  }
  const alias = resolveAlias(parent);
  const canon = (c: string) => alias.get(c) ?? c;

  // words that name what a thing IS usually come last in a title ("... LED Bulbs", "... Floor Mats", "... Orange Juice"): learn which ones do
  const tailCount = new Map<string, number>();
  for (const d of dossiers) for (const w of new Set(d.kind.last3)) tailCount.set(w, (tailCount.get(w) ?? 0) + 1);
  const tailVocab = new Set<string>();
  for (const [w, c] of tailCount) if (c >= 3 && c / Math.max(1, df.get(`w:${w}`) ?? c) >= 0.5) tailVocab.add(w);

  // a number that turns up on unrelated kinds of product is a number, not a part code: a real code (H7, 9005, 578) keeps the company of one kind of
  // thing, while "3", "100", "24" are scattered over juice, bread, soap and eggs. Judged from how coherent the kinds of the listings carrying it are.
  const kindsByCode = new Map<string, Map<string, number>>();
  const carrying = new Map<string, number>();
  for (const d of dossiers) {
    for (const c of new Set(d.codeTokens.map((x) => x.value))) {
      carrying.set(c, (carrying.get(c) ?? 0) + 1);
      const m = kindsByCode.get(c) ?? new Map<string, number>();
      for (const k of new Set(d.kind.last3.filter((w) => tailVocab.has(w)))) m.set(k, (m.get(k) ?? 0) + 1);
      kindsByCode.set(c, m);
    }
  }
  const scattered = new Set<string>();
  for (const [c, n] of carrying) {
    if (n < 6) continue;
    const top = Math.max(0, ...(kindsByCode.get(c)?.values() ?? []));
    if (top / n < 0.4) scattered.add(c);
  }

  // resolve every dossier against the corpus
  const siteCodes = new Map<string, Set<string>>();
  const codeSites = new Map<string, Set<string>>();
  let withCodes = 0;
  let withFitment = 0;
  // what a fitment listing is FOR: the run of uncommon words right next to the year (nearest first), stopping at the first word that is everywhere
  const reach = (tokens: string[]): string[] => {
    const out: string[] = [];
    for (const t of tokens) {
      const isCode = /\d/.test(t);
      const key = isCode ? `c:${t}` : `w:${t}`;
      // a code goes with the vehicle only if codes like it accompany year ranges; a word does unless it is everywhere or names what kind of thing the listing is
      const generic = tailVocab.has(t) || (df.get(key) ?? 0) > generalShare * n;
      if (isCode ? !subjectWords.has(key) : generic) break;
      out.push(t);
    }
    return out;
  };
  // words a website puts in most of its own titles (its name, its slogans) are site vocabulary, never the name of what a listing is for
  const siteTitles = new Map<string, number>();
  const siteWord = new Map<string, number>();
  for (const d of dossiers) {
    siteTitles.set(d.siteId, (siteTitles.get(d.siteId) ?? 0) + 1);
    for (const w of new Set([...d.words, ...d.codeTokens.map((c) => c.value)])) siteWord.set(`${d.siteId}|${w}`, (siteWord.get(`${d.siteId}|${w}`) ?? 0) + 1);
  }
  const siteVocabulary = (siteId: string, w: string) => (siteTitles.get(siteId) ?? 0) >= 10 && (siteWord.get(`${siteId}|${w}`) ?? 0) / siteTitles.get(siteId)! > 0.3;
  for (const d of dossiers) {
    const brandWords = new Set(d.brand.key ? [d.brand.key, ...(d.brand.name ?? '').toLowerCase().split(/[^a-z0-9]+/)] : []);
    d.subject = [...new Set(d.yearContext.flatMap((c) => [...reach(c.after), ...reach(c.before)]))].filter((w) => !brandWords.has(w) && !siteVocabulary(d.siteId, w)).sort();
    d.kindWords = d.kind.last3.filter((w) => tailVocab.has(w));
    const subjectSet = new Set(d.subject);
    const learned = d.subject.some((s) => subjectWords.has(`w:${s}`) || subjectWords.has(`c:${s}`));
    d.codes = [...new Set(d.codeTokens.map((c) => c.value).filter((c) => !subjectSet.has(c) && !scattered.has(c)).map(canon))].sort();
    if (d.codes.length) withCodes++;
    const ranges = d.yearMentions.ranges.map(({ from, to }) => ({ from, to }));
    const singles = d.yearMentions.singles.map((s) => s.year);
    if (ranges.length || (singles.length && learned)) {
      d.fitment = { ranges, years: singles };
      withFitment++;
    } else d.vintages = [...new Set(singles)].sort();
    const set = siteCodes.get(d.siteId) ?? new Set<string>();
    for (const c of d.codes) {
      set.add(c);
      const sites = codeSites.get(c) ?? new Set<string>();
      sites.add(d.siteId);
      codeSites.set(c, sites);
    }
    siteCodes.set(d.siteId, set);
  }

  return {
    dossiers,
    byVariant: new Map(dossiers.map((d) => [d.variantId, d])),
    n,
    df,
    idf,
    alias,
    subjectWords,
    siteCodes,
    codeSites,
    colourVocab,
    stats: { dossiers: n, withCodes, withFitment, aliasGroups: new Set(alias.values()).size, subjectWords: subjectWords.size, colourWords: colourVocab.size },
  };
}

/** Every year a fitment covers, for overlap tests. */
export function fitmentYears(f: NonNullable<Dossier['fitment']>): Set<number> {
  const out = new Set<number>(f.years);
  for (const r of f.ranges) for (let y = r.from; y <= r.to; y++) out.add(y);
  return out;
}
