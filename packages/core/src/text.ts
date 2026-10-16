import { stripQuantityText } from './quantity.ts';

/** Lowercase, strip diacritics/punctuation, collapse whitespace. */
export function normalizeText(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const STOPWORDS = new Set([
  'the', 'and', 'with', 'of', 'for', 'a', 'an', 'in', 'to', 'by', 'from', 'new', 'fresh', 'original', 'brand',
  'pack', 'size', 'each', 'ea', 'pcs', 'pc', 'pk', 'ct', 'x', 'regular', 'classic', 'natural',
]);

const CORP_SUFFIXES = new Set(['inc', 'ltd', 'llc', 'co', 'corp', 'company', 'brands', 'brand', 'foods', 'food', 'the', 'nv', 'bv', 'sa']);

export function normalizeBrand(brand: string | null | undefined): string {
  const tokens = normalizeText(brand)
    .split(' ')
    .filter((t) => t && !CORP_SUFFIXES.has(t));
  return tokens.join(' ');
}

/** Spaces removed, for tolerant brand comparison ("coca cola" == "cocacola"). */
export const compactBrand = (brand: string | null | undefined): string => normalizeBrand(brand).replace(/ /g, '');

function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.length > 4 && token.endsWith('es') && /(ch|sh|x|s|z)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/**
 * Tokens that describe WHAT the product is: sizes, pack words, brand tokens and noise removed.
 * "Coca-Cola Zero Sugar 12 x 355ml" with brand "Coca-Cola" => ['zero', 'sugar'].
 */
export function coreNameTokens(title: string, brand?: string | null): string[] {
  const noSizes = stripQuantityText(title);
  const brandTokens = new Set(normalizeBrand(brand).split(' ').filter(Boolean));
  const brandCompact = compactBrand(brand);
  const tokens = normalizeText(noSizes)
    .split(' ')
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .map(stem);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (brandTokens.has(t) || brandTokens.has(t.replace(/s$/, ''))) continue;
    // Drop a token that is the compacted brand ("cocacola") or a pair of tokens that together form it.
    if (brandCompact && t === brandCompact) continue;
    out.push(t);
  }
  if (brandCompact) {
    // Remove adjacent token pairs forming the brand (e.g. "coca" + "cola" with brand "cocacola").
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i]! + out[i + 1]! === brandCompact) {
        out.splice(i, 2);
        i--;
      }
    }
  }
  return out;
}

export function diceCoefficient(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return (2 * inter) / (sa.size + sb.size);
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Character-trigram Dice similarity: robust to small spelling differences and word order. */
export function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

/** Combined name similarity: best of token overlap and trigram similarity over the core tokens. */
export function nameSimilarity(tokensA: string[], tokensB: string[]): number {
  const token = diceCoefficient(tokensA, tokensB);
  const tri = trigramSimilarity([...tokensA].sort().join(' '), [...tokensB].sort().join(' '));
  return Math.max(token, tri * 0.95);
}

/** Attempt to find a leading brand in the title using a dictionary of normalised known brands. */
export function inferBrandFromTitle(title: string, knownBrands: Set<string>): string | null {
  const tokens = normalizeText(title).split(' ');
  for (let len = Math.min(4, tokens.length); len >= 1; len--) {
    const candidate = tokens.slice(0, len).join(' ');
    if (knownBrands.has(candidate)) return candidate;
    // Compact form: "coca cola" vs known "cocacola"
    if (knownBrands.has(candidate.replace(/ /g, ''))) return candidate.replace(/ /g, '');
  }
  return null;
}
