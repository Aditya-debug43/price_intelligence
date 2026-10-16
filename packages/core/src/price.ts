/**
 * Price parsing. Two entry points:
 *  - parseMachinePrice: strict, for JSON-LD / API values where "." is always the decimal separator.
 *  - parsePrice: tolerant, for visible text such as "Afl. 1.299,50" or "US$ 4.99".
 * A missing or unparseable price is `null` — never 0.
 */

export interface ParsedPrice {
  amount: number | null;
  currency: string | null;
  raw: string;
  /** Symbol that does not identify a currency by itself (e.g. "$"). */
  ambiguousSymbol: string | null;
  /** The numeric text could be read two ways (e.g. "1.299") and was therefore rejected. */
  ambiguous: boolean;
}

const KNOWN_CODES = new Set([
  'AWG', 'USD', 'EUR', 'ANG', 'XCG', 'CAD', 'GBP', 'COP', 'MXN', 'BRL', 'ARS', 'CLP', 'PEN', 'DOP', 'JMD',
  'TTD', 'BBD', 'XCD', 'BSD', 'KYD', 'HTG', 'CRC', 'GTQ', 'HNL', 'NIO', 'PAB', 'UYU', 'VES', 'AUD', 'NZD',
  'CHF', 'SEK', 'NOK', 'DKK', 'JPY', 'CNY', 'INR', 'AED', 'ZAR', 'SGD', 'HKD', 'PLN', 'CZK', 'HUF', 'TRY',
]);

const SYMBOLS: { re: RegExp; code: string }[] = [
  { re: /\bUS\s?\$|US\$/i, code: 'USD' },
  { re: /\bCA\s?\$|CAD\s?\$/i, code: 'CAD' },
  { re: /\bAfl\.?|ƒ|ƒ/i, code: 'AWG' },
  { re: /\bNAf\.?|\bNAƒ/i, code: 'ANG' },
  { re: /€/, code: 'EUR' },
  { re: /£/, code: 'GBP' },
];

export function detectCurrency(text: string): { code: string | null; ambiguousSymbol: string | null } {
  const codeMatch = [...text.toUpperCase().matchAll(/\b([A-Z]{3})\b/g)].map((m) => m[1]!).find((c) => KNOWN_CODES.has(c));
  if (codeMatch) return { code: codeMatch, ambiguousSymbol: null };
  for (const s of SYMBOLS) if (s.re.test(text)) return { code: s.code, ambiguousSymbol: null };
  if (text.includes('$')) return { code: null, ambiguousSymbol: '$' };
  if (text.includes('¥')) return { code: null, ambiguousSymbol: '¥' };
  return { code: null, ambiguousSymbol: null };
}

/** Strict parser for machine-formatted values: "12.50", 12.5, "1299". Comma is NOT treated as a decimal mark. */
export function parseMachinePrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(/[\s\u00a0]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parsePrice(input: string | number | null | undefined, hintCurrency?: string | null): ParsedPrice {
  if (input === null || input === undefined) return empty('');
  if (typeof input === 'number') {
    return {
      amount: Number.isFinite(input) && input >= 0 ? input : null,
      currency: hintCurrency ?? null,
      raw: String(input),
      ambiguousSymbol: null,
      ambiguous: false,
    };
  }
  const raw = input.trim();
  if (!raw) return empty(raw);
  const { code, ambiguousSymbol } = detectCurrency(raw);
  const numMatch = raw.match(/\d[\d.,'\u00a0\u202f ]*\d|\d/);
  if (!numMatch) return { ...empty(raw), currency: code ?? hintCurrency ?? null, ambiguousSymbol };
  const numeric = numMatch[0].replace(/['\u00a0\u202f ]/g, '');
  const { value, ambiguous } = normalizeDecimal(numeric);
  return {
    amount: value,
    currency: code ?? (ambiguousSymbol ? (hintCurrency ?? null) : (hintCurrency ?? null)),
    raw,
    ambiguousSymbol,
    ambiguous,
  };
}

function empty(raw: string): ParsedPrice {
  return { amount: null, currency: null, raw, ambiguousSymbol: null, ambiguous: false };
}

function normalizeDecimal(s: string): { value: number | null; ambiguous: boolean } {
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: the later one is the decimal mark.
    const decimalIsComma = lastComma > lastDot;
    normalized = decimalIsComma ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    if (parts.length > 2) {
      normalized = parts.join(''); // repeated separator => thousands grouping
    } else {
      const [intPart = '', frac = ''] = parts;
      if (frac.length === 3 && intPart.length >= 1 && intPart.length <= 3) {
        // "1.299" / "1,299": thousands in many locales, decimals in others. Comma+3 is almost always thousands;
        // dot+3 is genuinely ambiguous so we refuse to guess.
        if (sep === ',') normalized = intPart + frac;
        else return { value: null, ambiguous: true };
      } else {
        normalized = `${intPart}.${frac}`;
      }
    }
  } else {
    normalized = s;
  }
  const n = Number(normalized);
  return { value: Number.isFinite(n) && n >= 0 ? n : null, ambiguous: false };
}

/** Round to 2 decimals using integer cents to avoid float drift in displayed prices. */
export function roundMoney(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** WooCommerce-style minor units ("1250" with minor_unit 2 => 12.50). */
export function fromMinorUnits(value: string | number | null | undefined, minorUnit: number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const mu = minorUnit ?? 2;
  return roundMoney(n / 10 ** mu, mu);
}

export function discountPct(original: number | null, sale: number | null): number | null {
  if (original === null || sale === null || original <= 0 || sale < 0 || sale > original) return null;
  return roundMoney(((original - sale) / original) * 100, 2);
}
