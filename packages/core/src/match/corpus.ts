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
  /** Subject words that name a MODEL (they keep company with few other vehicle words), as opposed to a make that goes with many. */
  modelWords: Set<string>;
  /** Numbers/codes judged to be scattered over unrelated kinds of product (not part codes). Diagnostic. */
  scatteredCodes: Set<string>;
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
  // (a vehicle's name that happens to end a title is not a kind of product)
  for (const [w, c] of tailCount) if (c >= 3 && c / Math.max(1, df.get(`w:${w}`) ?? c) >= 0.5 && !subjectWords.has(`w:${w}`)) tailVocab.add(w);

  // a make goes with many models (honda: civic, accord, pilot ...); a model goes with few other vehicle words. Only a MODEL tells which vehicle a listing is for.
  const company = new Map<string, Set<string>>();
  for (const d of dossiers) for (const s of d.subject) { const set = company.get(s) ?? new Set<string>(); for (const o of d.subject) if (o !== s) set.add(o); company.set(s, set); }
  const modelWords = new Set<string>();
  for (const [s, set] of company) if (set.size < 6) modelWords.add(s);

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
    // only bare numbers can be "just a number"; a code with letters in it (H7, T10, W5W) is a part code however many kinds of product it is sold for
    if (n < 6 || !/^\d+$/.test(c)) continue;
    const top = Math.max(0, ...(kindsByCode.get(c)?.values() ?? []));
    if (top / n < 0.4) scattered.add(c);
  }

  // words that name WHICH PART a variant is (high, low, beam, fog, dome, tail, brake ...): the vocabulary the websites use to tell the variants of a product apart,
  // read from the variants themselves (frequent in variant titles and position options, and not everywhere, not a kind of product, not a vehicle)
  const variantWordCount = new Map<string, number>();
  for (const d of dossiers) for (const t of d.variantTokens) if (!/\d/.test(t)) variantWordCount.set(t, (variantWordCount.get(t) ?? 0) + 1);
  const applicationWords = new Set<string>();
  for (const [w, c] of variantWordCount) if (c >= Math.max(8, Math.floor(0.0005 * n)) && (df.get('w:' + w) ?? 0) <= 0.1 * n && !tailVocab.has(w) && !subjectWords.has('w:' + w)) applicationWords.add(w);

  // resolve every dossier against the corpus
  const siteCodes = new Map<string, Set<string>>();
  const codeSites = new Map<string, Set<string>>();
  let withCodes = 0;
  let withFitment = 0;
  const codeSet = new Set<string>();
  for (const d of dossiers) for (const c of d.codeTokens) codeSet.add(c.value);
  // what a fitment listing is FOR: the run of uncommon words right next to the year (nearest first), stopping at the first word that is everywhere
  const reach = (tokens: string[], skipLeading = 0): string[] => {
    const out: string[] = [];
    let skipped = 0;
    for (const t of tokens) {
      // a part code (H11, 9005) is a code; a name with a digit in it ("4runner", "f150") is a name, judged like any other word
      const isCode = codeSet.has(t);
      const key = isCode ? `c:${t}` : `w:${t}`;
      if (subjectWords.has(key) || subjectWords.has(`c:${t}`)) {
        out.push(t);
        continue;
      }
      // a word goes with the vehicle unless it is everywhere or names what kind of thing the listing is; a part code only if codes like it accompany year ranges
      const generic = tailVocab.has(t) || (df.get(key) ?? 0) > generalShare * n;
      // "Ford Focus LED Bulbs (2015-2018)": the kind of thing stands between the vehicle and the year; walk over it
      if (generic && !isCode && !out.length && skipped < skipLeading) { skipped++; continue; }
      if (isCode || generic) break;
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
    const named = (w: string) => !brandWords.has(w) && !siteVocabulary(d.siteId, w);
    d.subject = [...new Set(d.yearContext.flatMap((c) => [...reach(c.after), ...reach(c.before, 3)]))].filter(named).sort();
    d.subjectChain = d.yearContext.map((c) => { const after = reach(c.after).filter(named); return after.length ? after : reach(c.before, 3).filter(named).reverse(); }).find((chain) => chain.length) ?? [];
    d.kindWords = d.kind.last3.filter((w) => tailVocab.has(w));
    // which part / position this listing is for: the words of its own variant that name an application, else the application words of its title
    const own = d.variantTokens.filter((t) => applicationWords.has(t));
    d.position = own.length ? [...new Set(own)].sort() : [...new Set(d.words.filter((w) => applicationWords.has(w)))].sort();
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
    modelWords,
    scatteredCodes: scattered,
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
