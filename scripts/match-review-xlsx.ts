/**
 * Builds the REVIEW WORKBOOK for the second reviewer (Excel): per pair, both products' names, websites and stored page links, their stored details,
 * and a side-by-side check of which details agree, differ or are missing. Evaluation preparation only — it never touches matching, a database or a server.
 *
 *   npx tsx scripts/match-review-xlsx.ts --records <records.json> [--records <more.json>] --out <file.xlsx>
 *
 * Records come from `scripts/match-review-data.ts` (local database now, the production server later). The first file that has a product wins, so list the
 * production file first. `--carry <earlier.xlsx>` copies the reviewer's answers (your_label, unsure, your_notes) from an earlier version by Ref.
 * The workbook never contains the first labeller's labels, the engine's verdicts or any production row id; the AI columns are left
 * empty on purpose (a suggestion shown before the decision would bias an independent review). The file holds catalogue data: the script refuses to write
 * inside the repository.
 */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { SPEC_LABEL, parseCodeTokens, parsePackCount, parseQuantity, parseSpecs, parseYears } from '@ci/core';
import { productPageLink } from '../packages/services/src/source-url.ts';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (name: string) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]!] : []));
const recordFiles = flag('records');
const outArg = flag('out')[0];
if (!recordFiles.length || !outArg) { console.error('usage: tsx scripts/match-review-xlsx.ts --records <records.json> [--records <more.json>] --out <file.xlsx>'); process.exit(1); }
const outPath = path.resolve(outArg);
const rel = path.relative(root, outPath);
if (!rel.startsWith('..') && !path.isAbsolute(rel)) { console.error(`refusing to write ${outPath}: inside the repository (the workbook holds catalogue data)`); process.exit(1); }

// ── input
interface Variant { title: string | null; sku: string | null; gtin: string | null; options: Record<string, string> | null; qtyLabel: string | null; qtyKind: string | null; qtyTotal: number | null; url: string | null }
interface Rec { productId: string; askedFor: string; site: string; title: string; url: string | null; brand: string | null; manufacturer: string | null; model: string | null; mpn: string | null; category: string | null; description: string | null; attrs: { tags?: string[] } | null; lastSeenAt: string | null; delistedAt?: string | null; variantCount: number; variants: Variant[] }
interface Pair { id: string; domain: 'automotive' | 'grocery'; sourceTitle: string; competitorTitle: string; competitorSite: string }
const evalSet = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/matching/eval-v1/eval-set.json'), 'utf8')) as { pairs: Pair[] };
const mapping = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/matching/eval-v1/second-review/mapping.json'), 'utf8')) as { pairs: { reviewId: string; id: string }[] };
const pairById = new Map(evalSet.pairs.map((p) => [p.id, p]));
const evalFull = evalSet.pairs as unknown as { id: string; sourceProductId: string; competitorProductId: string }[];
const idsOf = new Map(evalFull.map((p) => [p.id, p]));
const SOURCE_SITE = { automotive: 'www.lasfit.com', grocery: 'groceriestogoaruba.com' } as const;

const byAsked = new Map<string, { recs: Rec[]; source: string }>();
for (const f of recordFiles) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { source: string; records: Rec[] };
  const groups = new Map<string, Rec[]>();
  for (const r of j.records) groups.set(r.askedFor, [...(groups.get(r.askedFor) ?? []), r]);
  for (const [k, recs] of groups) if (!byAsked.has(k)) byAsked.set(k, { recs, source: j.source });
}

// ── small helpers
const decode = (s: string) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const clean = (s: string | null | undefined): string | null => { const t = s == null ? '' : decode(String(s)).replace(/\s+/g, ' ').trim(); return t || null; };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const STOP = new Set(['the', 'and', 'of', 'for', 'with', 'in', 'a', 'an', 'to', 'by', 'from', 'pack', 'ct', 'count', 'pcs', 'pc', 'oz', 'fl', 'ml', 'cl', 'l', 'lt', 'g', 'gr', 'kg', 'lb', 'lbs', 'per', 'fit', 'new']);
const titleWords = (t: string) => [...new Set(t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+(\.\d+)?[a-z]{0,3}$/.test(w)).map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)))];
const list = (xs: string[], n = 8) => (xs.length > n ? `${xs.slice(0, n).join(', ')} …` : xs.join(', '));
const uniq = <T,>(xs: T[]) => [...new Set(xs)];

type Result = 'Agree' | 'Differs' | 'Check' | 'Missing' | 'n/a';
interface Attr { name: string; s: string; c: string; result: Result; note?: string }

interface Side { title: string; site: string; rec: Rec | null; status: 'found' | 'ambiguous' | 'none'; link: string | null; source: string | null }
function resolve(productId: string, title: string, site: string): Side {
  const hit = byAsked.get(productId);
  if (!hit) return { title, site, rec: null, status: 'none', link: null, source: null };
  const ids = uniq(hit.recs.map((r) => r.productId));
  if (ids.length > 1) return { title, site, rec: null, status: 'ambiguous', link: null, source: hit.source };
  const rec = hit.recs[0]!;
  const link = productPageLink(rec.url, rec.site) ?? productPageLink(rec.variants.find((v) => v.url)?.url, rec.site);
  return { title, site, rec, status: 'found', link, source: hit.source };
}

const sideVariantText = (s: Side) => (s.rec ? s.rec.variants.flatMap((v) => [v.title, ...Object.values(v.options ?? {})]).map((x) => clean(x)).filter((x): x is string => !!x) : []);

function compareSets(name: string, rawA: string[], rawB: string[], missingNote: string, norming = norm): Attr {
  const a = rawA.map((x) => clean(x)).filter((x): x is string => !!x), b = rawB.map((x) => clean(x)).filter((x): x is string => !!x);
  const A = uniq(a.map((x) => norming(x)).filter(Boolean)), B = uniq(b.map((x) => norming(x)).filter(Boolean));
  const show = (xs: string[]) => (xs.length ? list(xs, 4) : '—');
  if (!A.length || !B.length) return { name, s: show(a), c: show(b), result: 'Missing', note: missingNote };
  return A.some((x) => B.includes(x)) ? { name, s: show(a), c: show(b), result: 'Agree' } : { name, s: show(a), c: show(b), result: 'Differs' };
}

function compare(pair: Pair, S: Side, C: Side): Attr[] {
  const out: Attr[] = [];
  const sr = S.rec, cr = C.rec;
  // stored identity details
  out.push(compareSets('Brand (stored)', sr?.brand ? [sr.brand] : [], cr?.brand ? [cr.brand] : [], !sr || !cr ? 'no stored details for one or both products' : 'brand is not stored for one or both products'));
  out.push(compareSets('Barcode / GTIN (stored)', sr?.variants.map((v) => v.gtin ?? '') ?? [], cr?.variants.map((v) => v.gtin ?? '') ?? [], !sr || !cr ? 'no stored details for one or both products' : 'no barcode is stored for one or both products'));
  const modelOf = (r: Rec | null) => (r ? [r.mpn, r.model].filter((x): x is string => !!x) : []);
  // size / pack
  if (pair.domain === 'grocery') {
    const qs = (r: Rec | null, title: string) => {
      const stored = r ? r.variants.filter((v) => v.qtyKind && v.qtyTotal) : [];
      if (stored.length) return { from: 'stored', items: stored.map((v) => ({ kind: v.qtyKind!, total: v.qtyTotal!, label: v.qtyLabel ?? `${v.qtyTotal}` })) };
      const q = parseQuantity(title);
      return q.kind !== 'unknown' && q.total ? { from: 'title', items: [{ kind: q.kind as string, total: q.total, label: q.label ?? `${q.total}` }] } : { from: 'none', items: [] };
    };
    const a = qs(sr, pair.sourceTitle), b = qs(cr, pair.competitorTitle);
    const lab = (x: { from: string; items: { label: string }[] }) => (x.items.length ? `${list(uniq(x.items.map((i) => i.label)), 3)}${x.from === 'title' ? ' (from the title)' : ''}` : '—');
    if (!a.items.length || !b.items.length) out.push({ name: 'Size / pack', s: lab(a), c: lab(b), result: 'Missing', note: 'a size is not stated for one or both products' });
    else if (a.items.some((x) => b.items.some((y) => x.kind === y.kind && Math.abs(x.total - y.total) / Math.max(x.total, y.total) <= 0.01))) out.push({ name: 'Size / pack', s: lab(a), c: lab(b), result: 'Agree' });
    else if (a.items.some((x) => b.items.some((y) => x.kind === y.kind))) out.push({ name: 'Size / pack', s: lab(a), c: lab(b), result: 'Differs' });
    else out.push({ name: 'Size / pack', s: lab(a), c: lab(b), result: 'Check', note: 'the sizes are in different kinds of unit (weight, volume, count)' });
    out.push(compareSets('Part number / model (stored)', modelOf(sr), modelOf(cr), 'no part number or model is stored for one or both products'));
  } else {
    const pa = parsePackCount(pair.sourceTitle, null), pb = parsePackCount(pair.competitorTitle, null);
    out.push(pa && pb ? { name: 'Pack (from the title)', s: `${pa}`, c: `${pb}`, result: pa === pb ? 'Agree' : 'Differs' } : { name: 'Pack (from the title)', s: pa ? `${pa}` : '—', c: pb ? `${pb}` : '—', result: 'Missing', note: 'the pack count is not in one or both titles' });
    // truck model numbers (Ram 1500, F-250, Silverado 3500, Transit-350) read like part codes but name a vehicle, not a bulb
    const isModelNumber = (c: string) => /^[1-5][05]00$/.test(c) || /^[1-5][05]0$/.test(c);
    const codesOf = (title: string, s: Side) => uniq([...parseCodeTokens(title, 'title'), ...sideVariantText(s).flatMap((t) => parseCodeTokens(t, 'option'))]).filter((c) => !isModelNumber(c)).map((c) => c.toUpperCase());
    const ca = codesOf(pair.sourceTitle, S), cb = codesOf(pair.competitorTitle, C);
    const shared = ca.filter((c) => cb.includes(c));
    out.push(!ca.length || !cb.length ? { name: 'Part codes (from the titles and options)', s: ca.length ? list(ca) : '—', c: cb.length ? list(cb) : '—', result: 'Missing', note: 'one title names no bulb or part code' }
      : shared.length ? { name: 'Part codes (from the titles and options)', s: list(ca), c: list(cb), result: 'Agree', note: `shared: ${list(shared)}` }
      : { name: 'Part codes (from the titles and options)', s: list(ca), c: list(cb), result: 'Differs', note: 'some codes are other names for the same socket (H4 = 9003 = HB2, H8 = H9 = H11): check on the page' });
    const ya = parseYears(pair.sourceTitle, 'title').ranges, yb = parseYears(pair.competitorTitle, 'title').ranges;
    const yText = (y: { from: number; to: number }[]) => (y.length ? y.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}–${r.to}`)).join(', ') : '—');
    out.push(!ya.length && !yb.length ? { name: 'Vehicle years (from the titles)', s: '—', c: '—', result: 'n/a', note: 'neither title is vehicle-specific' }
      : !ya.length || !yb.length ? { name: 'Vehicle years (from the titles)', s: yText(ya), c: yText(yb), result: 'Check', note: 'only one listing is vehicle-specific; the other is generic' }
      : { name: 'Vehicle years (from the titles)', s: yText(ya), c: yText(yb), result: ya.some((r) => yb.some((q) => r.from <= q.to && q.from <= r.to)) ? 'Agree' : 'Differs' });
    const sa = parseSpecs(pair.sourceTitle, 'title'), sb = parseSpecs(pair.competitorTitle, 'title');
    const keys = uniq([...sa, ...sb].map((x) => x.key)).filter((k) => k !== 'count');
    const rows = keys.map((k) => { const x = sa.find((y) => y.key === k), y = sb.find((z) => z.key === k); return { k, x, y }; });
    const both = rows.filter((r) => r.x && r.y);
    const differ = both.filter((r) => Math.abs(r.x!.value - r.y!.value) / Math.max(r.x!.value, r.y!.value) > 0.1);
    const specText = (side: 'x' | 'y') => (rows.length ? rows.map((r) => (r[side] ? `${SPEC_LABEL[r.k]} ${r[side]!.raw}` : null)).filter(Boolean).join('; ') || '—' : '—');
    out.push(!rows.length ? { name: 'Power / brightness / colour (from the titles)', s: '—', c: '—', result: 'Missing', note: 'no such details in the titles' }
      : differ.length ? { name: 'Power / brightness / colour (from the titles)', s: specText('x'), c: specText('y'), result: 'Differs', note: `differs: ${differ.map((r) => SPEC_LABEL[r.k]).join(', ')} (a different performance level; the socket may still be the same)` }
      : both.length ? { name: 'Power / brightness / colour (from the titles)', s: specText('x'), c: specText('y'), result: 'Agree' }
      : { name: 'Power / brightness / colour (from the titles)', s: specText('x'), c: specText('y'), result: 'Check', note: 'the two titles state different details, so none can be compared' });
    out.push(compareSets('Part number / model (stored)', modelOf(sr), modelOf(cr), !sr || !cr ? 'no stored details for one or both products' : 'no part number or model is stored for one or both products'));
  }
  // words of the two titles
  const wa = titleWords(pair.sourceTitle), wb = titleWords(pair.competitorTitle);
  const onlyA = wa.filter((w) => !wb.includes(w)), onlyB = wb.filter((w) => !wa.includes(w)), shared = wa.filter((w) => wb.includes(w));
  out.push({
    name: 'Words in the product names', s: onlyA.length ? `only here: ${list(onlyA)}` : 'nothing extra', c: onlyB.length ? `only here: ${list(onlyB)}` : 'nothing extra',
    result: !onlyA.length && !onlyB.length ? 'Agree' : onlyA.length && onlyB.length ? 'Differs' : 'Check',
    note: `${shared.length} words in common${shared.length ? `: ${list(shared, 10)}` : ''}${onlyA.length && onlyB.length ? '; a different flavour, variety, model or position often hides in the words that differ' : '; one name says more than the other'}`,
  });
  // information only
  const opt = (s: Side) => { const t = uniq(sideVariantText(s)); return t.length ? `${s.rec!.variantCount} variant${s.rec!.variantCount === 1 ? '' : 's'}: ${list(t, 5)}` : s.rec ? `${s.rec.variantCount} variant${s.rec.variantCount === 1 ? '' : 's'}, no options stored` : '—'; };
  out.push({ name: 'Variants / options (stored)', s: opt(S), c: opt(C), result: 'n/a', note: S.rec || C.rec ? 'a product with several variants is reviewed as a whole; open the page to see them' : undefined });
  out.push({ name: 'Category (stored)', s: clean(sr?.category) ?? '—', c: clean(cr?.category) ?? '—', result: 'n/a', note: 'each shop names its categories differently; for information only' });
  if (sr?.attrs?.tags?.length || cr?.attrs?.tags?.length) out.push({ name: 'Tags (stored)', s: sr?.attrs?.tags?.length ? list(sr.attrs.tags.map((t) => clean(t) ?? ''), 8) : '—', c: cr?.attrs?.tags?.length ? list(cr.attrs.tags.map((t) => clean(t) ?? ''), 8) : '—', result: 'n/a' });
  out.push({ name: 'Description (stored, shortened)', s: clean(sr?.description)?.slice(0, 280) ?? '—', c: clean(cr?.description)?.slice(0, 280) ?? '—', result: 'n/a' });
  return out;
}

// ── answers already given in an earlier version of the workbook (--carry): copied across by Ref, never changed
const cellText = (v: ExcelJS.CellValue): string => {
  if (v == null) return '';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return String(v.result ?? '');
    return '';
  }
  return String(v);
};
const carried = new Map<string, { label: string; unsure: string; notes: string }>();
for (const f of flag('carry')) {
  const old = new ExcelJS.Workbook();
  await old.xlsx.readFile(f);
  const sheet = old.getWorksheet('Review');
  if (!sheet) { console.error(`${f}: no "Review" sheet`); process.exit(1); }
  const heads = (sheet.getRow(1).values as ExcelJS.CellValue[]).map((v) => cellText(v).trim().toLowerCase());
  const iRef = heads.indexOf('ref'), iLabel = heads.indexOf('your_label'), iUnsure = heads.indexOf('unsure'), iNotes = heads.indexOf('your_notes');
  if (iRef < 1 || iLabel < 1) { console.error(`${f}: the Review sheet needs the columns Ref and your_label`); process.exit(1); }
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const ref = cellText(row.getCell(iRef).value).trim();
    const label = cellText(row.getCell(iLabel).value).trim();
    const unsure = iUnsure > 0 ? cellText(row.getCell(iUnsure).value).trim() : '';
    const notes = iNotes > 0 ? cellText(row.getCell(iNotes).value).trim() : '';
    if (ref && (label || unsure || notes)) carried.set(ref, { label, unsure, notes });
  }
}

// ── workbook
const LABELS: [string, string, string][] = [
  ['E – Same product', 'Exactly the same item: same brand, same product, same size / pack, same colour or version.', 'Two listings of one jar of the same peanut butter, same size.'],
  ['V – Same product, other size / pack / colour', 'The same product, sold in a different size, pack count or colour.', 'The same cola as a single bottle and as a 6-pack.'],
  ['S – Substitute (a shopper could buy it instead)', 'A different brand or version that does the same job at a comparable size. For car bulbs: the same socket for the same use (same position, same vehicle where the listing names one).', 'Two different brands of 2-litre ginger ale; two brands of a 9005 headlight bulb.'],
  ['R – Related, not a substitute', 'Goes with it, or is a different kind of thing: an accessory, adapter, decoder or harness, a different part or position, a different flavour or variety, another kind of product.', 'A bulb and its adapter; strawberry jam against grape jam; a fog-light bulb against a dome-light bulb.'],
  ['I – Not enough information', 'You cannot tell, even after opening both pages.', 'A vehicle bundle against a single generic bulb when the page does not show which bulb is in the bundle.'],
  ['N – Not a match', 'Different products and nothing makes them interchangeable.', 'Floor mats against a light bulb; a different vehicle model.'],
];

const wb = new ExcelJS.Workbook();
wb.creator = 'Shelfwatch evaluation preparation';
wb.created = new Date();
const COL = { dark: 'FF1F3A4D', input: 'FFB7791F', inputFill: 'FFFFF6DA', grey: 'FFEDEDED', link: 'FF0B5CAD' };
const font = (o: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> => ({ name: 'Calibri', size: 10, ...o });

const start = wb.addWorksheet('Start here', { views: [{ showGridLines: false }] });
const review = wb.addWorksheet('Review', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
const details = wb.addWorksheet('Side by side', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });

// Review header
const HEAD = ['Ref', 'Category', 'Source product', 'Source website', 'Source page', 'Competitor product', 'Competitor website', 'Competitor page', 'Brand', 'Size / pack', 'Barcode', 'Codes / model', 'Vehicle years', 'Power / brightness', 'Words in the names', 'Worth checking on the pages', 'your_label', 'unsure', 'your_notes', 'AI_suggestion', 'AI_explanation', 'Stored details', 'Pair ID'];
const WIDTH = [8, 11, 38, 19, 11, 38, 19, 11, 20, 22, 18, 26, 20, 26, 36, 52, 34, 9, 30, 15, 30, 34, 14];
review.columns = HEAD.map((h, i) => ({ header: h, key: String(i), width: WIDTH[i]! }));
const INPUT = new Set(['your_label', 'unsure', 'your_notes']);
const AI = new Set(['AI_suggestion', 'AI_explanation']);
review.getRow(1).height = 32;
review.getRow(1).eachCell((c, n) => {
  const h = HEAD[n - 1]!;
  c.font = font({ bold: true, color: { argb: 'FFFFFFFF' } });
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INPUT.has(h) ? COL.input : AI.has(h) ? 'FF6B6B6B' : COL.dark } };
  c.alignment = { vertical: 'middle', wrapText: true };
});
review.getCell('Q1').note = 'Choose one of the six labels from the list (full explanation on the "Start here" sheet).\nE = same product\nV = same product, other size / pack / colour\nS = substitute (a shopper could buy it instead)\nR = related, not a substitute\nI = not enough information\nN = not a match\nLeave blank if you have not decided yet.';
review.getCell('R1').note = 'Choose Yes when you are not confident in your label.';
review.getCell('T1').note = 'Left empty on purpose: a suggestion shown before your decision would bias an independent review.';
review.getCell('I1').note = 'Details that Shelfwatch stored when it collected the product. "Missing" means it was not stored; check the page.';

details.columns = [{ header: 'Ref', key: 'a', width: 8 }, { header: 'Detail', key: 'b', width: 34 }, { header: 'Source product', key: 'c', width: 44 }, { header: 'Competitor product', key: 'd', width: 44 }, { header: 'Result', key: 'e', width: 11 }, { header: 'Note', key: 'f', width: 60 }];
details.getRow(1).eachCell((c) => { c.font = font({ bold: true, color: { argb: 'FFFFFFFF' } }); c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COL.dark } }; c.alignment = { vertical: 'middle' }; });

const miniOf = (a: Attr | undefined): string => {
  if (!a) return 'n/a';
  const short = (s: string) => (s.length > 40 ? `${s.slice(0, 38)}…` : s);
  if (a.result === 'Agree') return a.s && a.s !== '—' && a.s === a.c ? `Agree (${short(a.s)})` : 'Agree';
  if (a.result === 'Differs') return `Differs: ${short(a.s)} vs ${short(a.c)}`;
  if (a.result === 'Check') return `Check: ${short(a.s)} vs ${short(a.c)}`;
  if (a.result === 'Missing') return `Missing (${a.s !== '—' ? 'only source' : a.c !== '—' ? 'only competitor' : 'both'})`;
  return 'n/a';
};
const findAttr = (attrs: Attr[], prefix: string) => attrs.find((a) => a.name.startsWith(prefix));

const counts = { both: 0, onlyOne: 0, none: 0, ambiguous: 0, linksBoth: 0, linksOne: 0 };
const links = (side: Side, row: ExcelJS.Row, col: number) => {
  const c = row.getCell(col);
  if (side.link) { c.value = { text: 'Open page', hyperlink: side.link }; c.font = font({ color: { argb: COL.link }, underline: true }); }
  else { c.value = 'No stored link'; c.font = font({ color: { argb: 'FF8A8A8A' }, italic: true }); }
  c.alignment = { vertical: 'top', wrapText: true };
};

let rowNo = 1;
const detailRows: { ref: string; rowNo: number }[] = [];
for (const m of mapping.pairs) {
  const p = pairById.get(m.id)!;
  const ids = idsOf.get(m.id)!;
  const S = resolve(ids.sourceProductId, p.sourceTitle, SOURCE_SITE[p.domain]);
  const C = resolve(ids.competitorProductId, p.competitorTitle, p.competitorSite);
  const attrs = compare(p, S, C);
  const found = (S.status === 'found' ? 1 : 0) + (C.status === 'found' ? 1 : 0);
  if (found === 2) counts.both++; else if (found === 1) counts.onlyOne++; else if (S.status === 'ambiguous' || C.status === 'ambiguous') counts.ambiguous++; else counts.none++;
  const nLinks = (S.link ? 1 : 0) + (C.link ? 1 : 0);
  if (nLinks === 2) counts.linksBoth++; else if (nLinks === 1) counts.linksOne++;

  // what to check
  const todo: string[] = [];
  for (const [side, who] of [[S, 'source'], [C, 'competitor']] as const) {
    if (!side.link) todo.push(`no stored page link for the ${who} product: search its name on ${side.site}`);
    if (side.rec?.delistedAt) todo.push(`the ${who} product was no longer listed on its website when last collected (${side.rec.delistedAt.slice(0, 10)}): its page may be gone`);
  }
  const name = (n: string) => findAttr(attrs, n);
  if (S.status !== 'found' && C.status !== 'found') todo.push(p.domain === 'automotive' ? 'no stored details in this copy: read the brand, bulb code, vehicle years and pack from the two pages' : 'no stored details in this copy: read the brand, size and variety from the two pages');
  else if (name('Brand')?.result === 'Missing' && name('Barcode')?.result === 'Missing') todo.push(p.domain === 'automotive' ? 'brand and barcode are not stored: compare brand, bulb code and vehicle on the two pages' : 'brand and barcode are not stored: compare brand, flavour / variety and size on the two pages');
  else if (name('Brand')?.result === 'Differs') todo.push('the brands differ: a different brand is a substitute (S) at best, never the same product');
  const size = name('Size');
  if (size?.result === 'Differs') todo.push('sizes differ: is it the same product in another size (V) or a different product?');
  else if (size?.result === 'Missing') todo.push('size not stated: read it from the page');
  else if (size?.result === 'Check') todo.push('sizes are in different units: compare on the page');
  const words = name('Words');
  if (words?.result === 'Differs') todo.push(`check whether the words that differ change the product (flavour, variety, model, position): ${list(titleWords(p.sourceTitle).filter((w) => !titleWords(p.competitorTitle).includes(w)), 4)} | ${list(titleWords(p.competitorTitle).filter((w) => !titleWords(p.sourceTitle).includes(w)), 4)}`);
  if (p.domain === 'automotive') {
    const codes = name('Part codes'), years = name('Vehicle years');
    if (codes?.result !== 'Agree') todo.push('check the bulb / socket code on both pages');
    if (years?.result === 'Check') todo.push('one listing is vehicle-specific, the other generic: does the vehicle listing include the bulb for the same position, with the same socket?');
    if (years?.result === 'Differs') todo.push('the vehicle years differ: check the vehicle fit on both pages');
    if (name('Power')?.result === 'Differs') todo.push('power / brightness differ: still a stand-in if the socket and use match');
  }
  const why = (s: Side) => (s.status === 'ambiguous' ? 'two stored products have exactly this title, so none is shown' : 'not in this copy');
  const status = found === 2 ? `Stored details for both products (collected ${[S.rec!.lastSeenAt, C.rec!.lastSeenAt].map((d) => d?.slice(0, 10)).filter(Boolean).sort().pop() ?? 'date unknown'} or earlier)`
    : found === 1 ? `Stored details for the ${S.status === 'found' ? 'source' : 'competitor'} product only (the ${S.status === 'found' ? 'competitor' : 'source'} product: ${why(S.status === 'found' ? C : S)})`
    : S.status === 'ambiguous' || C.status === 'ambiguous' ? 'No stored details: two stored products have exactly this title'
    : 'No stored details in this copy: names and title-based facts only';

  rowNo++;
  const row = review.getRow(rowNo);
  row.getCell(1).value = m.reviewId;
  row.getCell(2).value = p.domain === 'grocery' ? 'Groceries' : 'Car lighting';
  row.getCell(3).value = clean(p.sourceTitle);
  row.getCell(4).value = S.site;
  links(S, row, 5);
  row.getCell(6).value = clean(p.competitorTitle);
  row.getCell(7).value = C.site;
  links(C, row, 8);
  row.getCell(9).value = miniOf(name('Brand'));
  row.getCell(10).value = miniOf(name('Size') ?? name('Pack'));
  row.getCell(11).value = miniOf(name('Barcode'));
  row.getCell(12).value = miniOf(name('Part codes') ?? name('Part number'));
  row.getCell(13).value = p.domain === 'automotive' ? miniOf(name('Vehicle years')) : 'n/a';
  row.getCell(14).value = p.domain === 'automotive' ? miniOf(name('Power')) : 'n/a';
  row.getCell(15).value = miniOf(name('Words'));
  row.getCell(16).value = todo.length ? todo.map((t) => `• ${t}`).join('\n') : '• compare the two pages';
  row.getCell(22).value = status;
  row.getCell(23).value = m.id;
  const mine = carried.get(m.reviewId);
  if (mine) { row.getCell(17).value = mine.label || null; row.getCell(18).value = mine.unsure || null; row.getCell(19).value = mine.notes || null; }
  for (let c = 1; c <= HEAD.length; c++) {
    const cell = row.getCell(c);
    if (c !== 5 && c !== 8) cell.font = font(c === 23 ? { color: { argb: 'FF8A8A8A' }, size: 9 } : c === 1 ? { bold: true } : {});
    cell.alignment = { vertical: 'top', wrapText: true };
    const h = HEAD[c - 1]!;
    if (INPUT.has(h)) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COL.inputFill } };
    if (AI.has(h)) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COL.grey } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } } };
  }
  // side-by-side block
  detailRows.push({ ref: m.reviewId, rowNo });
  for (const a of [{ name: 'Product name', s: clean(p.sourceTitle) ?? '', c: clean(p.competitorTitle) ?? '', result: 'n/a' as Result }, { name: 'Website', s: S.site, c: C.site, result: 'n/a' as Result }, { name: 'Page link (stored)', s: S.link ?? 'none stored', c: C.link ?? 'none stored', result: 'n/a' as Result }, ...attrs]) {
    const r = details.addRow([m.reviewId, a.name, a.s, a.c, a.result === 'n/a' ? '' : a.result, a.note ?? '']);
    r.eachCell((c) => { c.font = font(); c.alignment = { vertical: 'top', wrapText: true }; });
    r.getCell(1).font = font({ bold: true });
    if (a.name === 'Product name') r.eachCell((c) => { c.border = { top: { style: 'thin', color: { argb: 'FF8A8A8A' } } }; });
  }
}
const last = rowNo;

// dropdowns
const labelRange = `'Start here'!$B$16:$B$21`;
for (let r = 2; r <= last; r++) {
  review.getCell(`Q${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [labelRange], showErrorMessage: true, errorStyle: 'stop', errorTitle: 'Choose a label', error: 'Pick one of the six labels from the list (see the "Start here" sheet).', showInputMessage: true, promptTitle: 'your_label', prompt: 'Pick one of the six labels.' };
  review.getCell(`R${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"Yes"'], showErrorMessage: true, error: 'Choose Yes, or leave blank.' };
}
review.autoFilter = { from: { row: 1, column: 1 }, to: { row: last, column: HEAD.length } };
details.autoFilter = { from: { row: 1, column: 1 }, to: { row: details.rowCount, column: 6 } };
const RESULT_FILLS: [string, number, string][] = [['Agree', 5, 'FFDFF3E3'], ['Differs', 7, 'FFFBE0DC'], ['Check', 5, 'FFFFF1CC'], ['Missing', 7, 'FFECECEC']];
const colour = (ws: ExcelJS.Worksheet, ref: string, topLeft: string) => {
  RESULT_FILLS.forEach(([word, n, argb], i) => ws.addConditionalFormatting({ ref, rules: [{ type: 'expression', formulae: [`LEFT(${topLeft},${n})="${word}"`], priority: i + 1, style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb } } } }] }));
};
colour(review, `I2:O${last}`, 'I2');
colour(details, `E2:E${details.rowCount}`, 'E2');

// Start here
start.columns = [{ width: 3 }, { width: 44 }, { width: 70 }, { width: 62 }];
const put = (r: number, text: string, o: { bold?: boolean; size?: number; color?: string; fill?: string; cols?: number; wrap?: boolean } = {}) => {
  const c = start.getCell(r, 2);
  c.value = text;
  c.font = font({ bold: o.bold, size: o.size ?? 11, color: o.color ? { argb: o.color } : undefined });
  c.alignment = { vertical: 'top', wrapText: o.wrap ?? true };
  if (o.fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
  if (o.cols) {
    start.mergeCells(r, 2, r, 1 + o.cols);
    // merged cells do not auto-size their row in Excel: about 150 characters fit on a line across the three columns
    start.getRow(r).height = Math.max(o.size && o.size > 12 ? 24 : 16, Math.ceil(text.length / 150) * ((o.size ?? 11) + 5));
  }
  return c;
};
put(1, 'Shelfwatch — product pair review', { bold: true, size: 18, color: COL.dark, cols: 3 });
put(2, `${mapping.pairs.length} pairs of products. For each pair: are these the same product, a stand-in, or something else? Your answer is the independent second opinion used to check the labelling. About 1–2 minutes per pair.`, { cols: 3, size: 11 });
put(4, 'How to do it', { bold: true, size: 13, color: COL.dark });
['1. Open the "Review" sheet. Each row is one pair (Ref rv-001, rv-002 …).', '2. Click "Open page" next to each product to see the real product page. The columns in between are a quick side-by-side check: green = agrees, red = differs, yellow = check, grey = not stored.', '3. Pick your decision in the your_label column (a drop-down with the six labels below). Tick Yes in "unsure" if you are not confident. Notes are optional.', '4. Filter or sort freely (the arrows on the header row). Please do not delete or re-order rows, rename columns, or edit the Ref column or the Pair ID column.', '5. Save (Ctrl+S) and send the same .xlsx file back. The "Side by side" sheet lists every detail for every pair in full, if you want more.'].forEach((t, i) => put(5 + i, t, { cols: 3 }));
put(11, 'The six labels (the same six used in the evaluation)', { bold: true, size: 13, color: COL.dark });
put(12, 'Decide on the product itself: look at what it is, its size and its variety. The stored details can be incomplete or wrong, and the name is not proof of identity.', { cols: 3, color: 'FF555555' });
['Label (the dropdown text)', 'What it means', 'Example'].forEach((t, i) => { start.getCell(15, 2 + i).value = t; });
LABELS.forEach((l, i) => l.forEach((t, j) => { const c = start.getCell(16 + i, 2 + j); c.value = t; c.font = font({ bold: j === 0, size: 10 }); c.alignment = { vertical: 'top', wrapText: true }; c.border = { bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } } }; }));
start.getRow(15).eachCell((c) => { c.font = font({ bold: true, color: { argb: 'FFFFFFFF' } }); c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COL.dark } }; });
put(23, 'Reading the comparison columns', { bold: true, size: 13, color: COL.dark });
['Agree: the stored or title-based detail is the same on both products.', 'Differs: both products state it, and it is not the same (for example 8 oz against 16 oz).', 'Check: it cannot be compared directly (different units, or only one listing is vehicle-specific).', 'Missing: Shelfwatch did not store it for one or both products. It is NOT assumed to be equal: look at the page.', 'Some facts are read from the product name (bulb codes, years, power, pack count) and are marked "from the title". A bulb code can have other names for the same socket (H4 = 9003 = HB2).'].forEach((t, i) => put(24 + i, t, { cols: 3 }));
put(30, 'What is deliberately not in this workbook', { bold: true, size: 13, color: COL.dark });
['The first labeller\'s answers and the matching engine\'s verdicts are not shown, so your decision stays independent.', 'AI_suggestion and AI_explanation are empty. If you want AI hints, ask after you have finished and sent the sheet back: hints shown first would bias the check.', 'Production row ids are not in the sheet; the Ref and Pair ID columns are enough to match your answers to the evaluation records later.'].forEach((t, i) => put(31 + i, t, { cols: 3 }));
put(35, 'About the stored details', { bold: true, size: 13, color: COL.dark });
const srcNotes = uniq([...byAsked.values()].map((v) => v.source));
[`Pairs with stored details for both products: ${counts.both} of ${mapping.pairs.length}; for one product only: ${counts.onlyOne}; for neither: ${counts.none + counts.ambiguous}.`, `Pairs where both products have a stored page link: ${counts.linksBoth}; one link: ${counts.linksOne}. A link is only shown when it is the address Shelfwatch stored for that product, on that product's own website. Where there is no stored link, the cell says so; search the product name on the website.`, `Source of the stored details: ${srcNotes.length ? srcNotes.join('; ') : 'none'}. Prices are left out on purpose (they change and are not needed to decide what a product is).`, 'The workbook contains catalogue data from the owner\'s Shelfwatch: please keep it private.'].forEach((t, i) => put(36 + i, t, { cols: 3 }));
const widths = [44, 70, 62];
LABELS.forEach((l, i) => { start.getRow(16 + i).height = Math.max(18, Math.max(...l.map((t, j) => Math.ceil(t.length / (widths[j]! * 0.95)))) * 14); });
start.getRow(15).height = 20;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
await wb.xlsx.writeFile(outPath);
if (carried.size) console.log(`  carried over ${carried.size} existing answers by Ref`);
console.log(`wrote ${outPath}\n  ${mapping.pairs.length} pairs; stored details for both products: ${counts.both}, one only: ${counts.onlyOne}, neither: ${counts.none}, ambiguous title: ${counts.ambiguous}; stored page links for both: ${counts.linksBoth}, one: ${counts.linksOne}`);
