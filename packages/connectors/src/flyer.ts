import { extractText, getDocumentProxy } from 'unpdf';
import { detectCurrency, parsePrice } from '@ci/core';

/**
 * Promotional flyer (PDF) extraction. Handles PDFs with a TEXT LAYER. Scanned/image-only flyers need OCR or
 * vision extraction, which is not performed here: they are reported as `no_text_layer` rather than guessed at.
 * Every item carries a confidence and a review flag; ambiguous lines are never silently accepted.
 */

export interface FlyerItem {
  name: string;
  salePrice: number | null;
  originalPrice: number | null;
  currency: string | null;
  conditions: string[];
  confidence: number;
  needsReview: boolean;
  page: number;
  rawLine: string;
}

export interface FlyerExtraction {
  status: 'extracted' | 'no_text_layer' | 'failed';
  pageCount: number;
  title: string | null;
  validFrom: Date | null;
  validTo: Date | null;
  items: FlyerItem[];
  message: string;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

export function parseValidity(text: string, now: Date): { from: Date | null; to: Date | null } {
  const t = text.replace(/\s+/g, ' ');
  const year = now.getUTCFullYear();
  // "Oct 12 - Oct 18, 2026" / "Oct 12 - 18" / "October 12 to October 18"
  const re = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?\s*(?:-|–|to|through|thru)\s*(?:([A-Za-z]{3,9})\.?\s+)?(\d{1,2})(?:,?\s*(\d{4}))?/g;
  for (const m of t.matchAll(re)) {
    const m1 = MONTHS[m[1]!.toLowerCase()];
    if (m1 === undefined) continue;
    const m2 = m[4] ? MONTHS[m[4].toLowerCase()] : m1;
    if (m2 === undefined) continue;
    const wraps = m2 < m1 ? 1 : 0;
    const explicitStart = m[3] ? Number(m[3]) : null;
    const explicitEnd = m[6] ? Number(m[6]) : null;
    // With no explicit year, pick the reading (start year Y-1, Y or Y+1) whose midpoint is closest to today.
    const candidates = explicitStart !== null ? [explicitStart] : explicitEnd !== null ? [explicitEnd - wraps] : [year - 1, year, year + 1];
    let best: { from: Date; to: Date; dist: number } | null = null;
    for (const y1 of candidates) {
      const from = new Date(Date.UTC(y1, m1, Number(m[2]), 0, 0, 0));
      const to = new Date(Date.UTC(explicitEnd ?? y1 + wraps, m2, Number(m[5]), 23, 59, 59));
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) continue;
      const dist = Math.abs((from.getTime() + to.getTime()) / 2 - now.getTime());
      if (!best || dist < best.dist) best = { from, to, dist };
    }
    if (best) return { from: best.from, to: best.to };
  }
  return { from: null, to: null };
}

// A decimal directly followed by a unit ("1.75L", "2.00 kg", "12.00oz") is a size, never a price.
const PRICE_RE = /(?:(?:AWG|Afl\.?|US\$|USD|\$|ƒ)\s?)?(\d{1,4}[.,]\d{2})(?!\d)(?!\s?(?:[mc]l|l|lt|ltr|litres?|liters?|kg|g|gr|oz|lbs?|ct|pk|pcs?)\b)/gi;

export function parseFlyerLines(pageText: string, page: number, siteCurrency: string | null): FlyerItem[] {
  const lines = pageText.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const items: FlyerItem[] = [];
  let lastName = '';
  for (const line of lines) {
    const prices = [...line.matchAll(PRICE_RE)];
    if (prices.length === 0) {
      if (line.length >= 3 && line.length <= 80 && !/^(valid|page|www\.|http|terms|prices|while supplies)/i.test(line)) lastName = line;
      continue;
    }
    const cur = detectCurrency(line).code ?? siteCurrency;
    const amounts = prices.map((p) => parsePrice(p[1]!).amount).filter((a): a is number => a !== null);
    if (!amounts.length) continue;
    // Remove prices, price words and leader punctuation — but keep hyphens/dots inside words ("Coca-Cola").
    let name = line
      .replace(PRICE_RE, ' ')
      .replace(/\b(was|now|reg\.?|regular|sale|save|only|each|ea\.?|antes|ahora|from)\b/gi, ' ')
      .replace(/\s[-–—·.:|]+(?=\s|$)/g, ' ')
      .replace(/^[\s\-–—·.:|]+|[\s\-–—·.:|$ƒ]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    let fromPrevious = false;
    if (name.length < 3) {
      name = lastName;
      fromPrevious = true;
    }
    if (name.length < 3) continue;
    const hasWasNow = /\b(was|reg\.?|regular|antes)\b/i.test(line) && amounts.length >= 2;
    const [a, b] = amounts;
    const conditions: string[] = [];
    const multi = line.match(/\b(\d+)\s*for\s*\$?\s*(\d+(?:[.,]\d{2})?)\b/i);
    if (multi) conditions.push(`${multi[1]} for ${multi[2]}`);
    if (/\blimit\s+\d+/i.test(line)) conditions.push(line.match(/\blimit\s+\d+[^.]*/i)![0]!);
    let sale: number | null;
    let original: number | null = null;
    if (hasWasNow && a !== undefined && b !== undefined) {
      original = Math.max(a, b);
      sale = Math.min(a, b);
    } else {
      sale = a ?? null;
    }
    let confidence = hasWasNow ? 0.7 : 0.78;
    if (fromPrevious) confidence -= 0.2;
    if (amounts.length > 2) confidence -= 0.25;
    if (name.length < 5) confidence -= 0.1;
    if (!cur) confidence -= 0.05;
    confidence = Math.max(0.2, Math.round(confidence * 100) / 100);
    items.push({
      name: name.slice(0, 120),
      salePrice: sale,
      originalPrice: original,
      currency: cur ?? null,
      conditions,
      confidence,
      needsReview: confidence < 0.7 || amounts.length > 2 || fromPrevious,
      page,
      rawLine: line.slice(0, 200),
    });
    lastName = '';
  }
  return items;
}

export async function extractFlyer(pdf: Buffer, opts: { siteCurrency: string | null; now: Date }): Promise<FlyerExtraction> {
  try {
    const doc = await getDocumentProxy(new Uint8Array(pdf));
    const { totalPages, text } = await extractText(doc, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    const chars = pages.join('').replace(/\s/g, '').length;
    if (chars < 40 * Math.max(totalPages, 1) / 4 || chars < 40) {
      return { status: 'no_text_layer', pageCount: totalPages, title: null, validFrom: null, validTo: null, items: [], message: 'This PDF has no readable text layer (it is probably a scanned image). Reading it needs OCR or vision extraction, which is not enabled — nothing was guessed.' };
    }
    const items = pages.flatMap((t, i) => parseFlyerLines(t, i + 1, opts.siteCurrency));
    const validity = parseValidity(pages.join('\n'), opts.now);
    const title = pages[0]?.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length >= 4) ?? null;
    return {
      status: 'extracted',
      pageCount: totalPages,
      title,
      validFrom: validity.from,
      validTo: validity.to,
      items,
      message: items.length ? `${items.length} item(s) read from the text layer; ${items.filter((i) => i.needsReview).length} need review.` : 'The PDF has text but no priced items could be identified.',
    };
  } catch (e) {
    return { status: 'failed', pageCount: 0, title: null, validFrom: null, validTo: null, items: [], message: `The PDF could not be read: ${(e as Error).message}` };
  }
}
