import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { eq, and } from 'drizzle-orm';
import { sha256Hex, stableStringify } from '@ci/core';
import { CSV_DATASETS, csvDatasetLabel, formatAge, formatDateTime, formatMoney, formatPct, type CsvDataset, type ReportData, type ReportFormat } from '@ci/shared';
import { reportExports, type DbLike } from '@ci/database';
import type { Services } from './context.ts';
import { getReport } from './report.ts';

/**
 * Every export is rendered from the immutable report snapshot (ReportData) — never from live tables — so the
 * dashboard, PDF, CSV and Excel can never disagree with each other.
 */

// the list lives in @ci/shared so the Reports page offers exactly the tables the API accepts
export { CSV_DATASETS };
export type { CsvDataset };

type Cell = string | number | boolean | null;
export interface Table {
  name: string;
  columns: string[];
  rows: Cell[][];
}

const iso = (s: string | null) => s ?? '';

export function comparisonTable(d: ReportData): Table {
  const rows: Cell[][] = [];
  for (const r of d.comparisons) {
    for (const c of r.cells) {
      rows.push([
        r.title, r.variantTitle ?? '', r.brand ?? '', r.category ?? '', r.sizeLabel ?? '', c.siteName, c.matchClass, c.matchStatus, c.confidence,
        r.sourcePrice.amount, r.sourcePrice.currency ?? '', r.sourcePrice.normalized, c.price.amount, c.price.currency ?? '', c.price.normalized, d.meta.reportingCurrency,
        c.diffAbs, c.diffPct, c.unitDiffPct, c.directlyComparable ? 'yes' : 'no', r.sourceAvailability, c.availability, iso(r.sourcePrice.observedAt), iso(c.price.observedAt), c.price.stale ? 'stale' : 'fresh',
        c.price.fxRate, c.price.fxSource ?? '', c.offerSummary ?? '', c.url ?? '', r.url ?? '', c.caveats.join('; '),
      ]);
    }
  }
  return {
    name: 'Price comparison',
    columns: ['Product', 'Variant', 'Brand', 'Category', 'Size', 'Competitor', 'Match class', 'Match status', 'Match confidence', 'Your price (shown)', 'Your currency', `Your price (${d.meta.reportingCurrency})`, 'Competitor price (shown)', 'Competitor currency', `Competitor price (${d.meta.reportingCurrency})`, 'Reporting currency', 'Difference', 'Difference %', 'Unit-price difference %', 'Directly comparable', 'Your availability', 'Competitor availability', 'Your price observed', 'Competitor price observed', 'Freshness', 'FX rate used', 'FX source', 'Competitor offer', 'Competitor evidence URL', 'Your product URL', 'Caveats'],
    rows,
  };
}

export function offersTable(d: ReportData): Table {
  return {
    name: 'Offers',
    columns: ['Website', 'Role', 'Kind', 'Offer', 'Conditions', 'Code', 'Original price', 'Sale price', 'Currency', 'Claimed discount %', 'Historical discount %', 'Verification', 'Valid from', 'Valid to', 'First seen', 'Last seen', 'Status', 'Needs review', 'Confidence', 'Source URL'],
    rows: d.offers.map((o) => [o.siteName, o.siteRole, o.kind, o.title, o.conditions.join('; '), o.code ?? '', o.originalPrice, o.salePrice, o.currency ?? '', o.claimedDiscountPct, o.historicalDiscountPct, o.verification, iso(o.validFrom), iso(o.validTo), o.firstSeenAt, o.lastSeenAt, o.status, o.needsReview ? 'yes' : 'no', o.confidence, o.sourceUrl ?? '']),
  };
}

export function stockTable(d: ReportData): Table {
  return {
    name: 'Own stock',
    columns: ['Product', 'SKU', 'State', 'Public availability', 'Quantity', 'Quantity source', 'Threshold', 'Observed', 'Freshness', 'Last change', 'Note', 'URL'],
    rows: d.stock.map((s) => [s.title, s.sku ?? '', s.state, s.availability, s.quantity, s.quantitySource ?? '', s.threshold, iso(s.observedAt), s.stale ? 'stale' : 'fresh', iso(s.lastChangeAt), s.note ?? '', s.url]),
  };
}

export function marketingTable(d: ReportData): Table {
  return {
    name: 'Marketing',
    columns: ['Website', 'Platform', 'Kind', 'Title', 'Excerpt', 'Classification', 'Confidence', 'Published', 'First seen', 'Last seen', 'Paid status', 'URL'],
    rows: d.marketing.map((m) => [m.siteName, m.platform, m.kind, m.title ?? '', m.excerpt ?? '', m.classification, m.confidence, iso(m.publishedAt), m.firstSeenAt, m.lastSeenAt, 'not determined (observed content only)', m.url ?? '']),
  };
}

export function marketingSummaryTable(d: ReportData): Table {
  const top = (xs: { title: string; value: number; platform: string }[]) => xs.map((x) => `${x.title} (${x.value} on ${x.platform})`).join(' | ');
  return {
    name: 'Marketing summary',
    columns: ['Competitor', 'Items observed', 'Promotional', 'By platform', 'Recurring themes (items)', 'Brands mentioned in promotions', 'Promotional timing', 'Most liked', 'Most viewed', 'What we cannot see'],
    rows: (d.marketingSummary?.competitors ?? []).map((c) => [
      c.siteName, c.total, c.promotionCount,
      Object.entries(c.byPlatform).map(([k, n]) => `${k} ${n}`).join('; '),
      c.themes.map((t) => `${t.term} (${t.items})`).join('; '),
      c.brandMentions.map((b) => `${b.brand} (${b.items})`).join('; '),
      c.timing ? c.timing.sentence : (c.timingNote ?? ''),
      top(c.mostLiked), top(c.mostViewed), c.limitations.join(' '),
    ]),
  };
}

export function insightsTable(d: ReportData): Table {
  return {
    name: 'Insights',
    columns: ['Rank', 'Type', 'Score', 'Severity', 'Title', 'Summary', 'Facts', 'Evidence'],
    rows: d.insights.map((i, n) => [n + 1, i.type, i.score, i.severity, i.title, i.summary, JSON.stringify(i.facts), i.evidence.map((e) => `${e.label}${e.url ? ` <${e.url}>` : ''}${e.observedAt ? ` @${e.observedAt}` : ''}`).join(' | ')]),
  };
}

export function coverageTable(d: ReportData): Table {
  return {
    name: 'Coverage',
    columns: ['Website', 'Role', 'Capability', 'Connector', 'Last scan', 'Last scan at', 'Products known', 'Fresh', 'Stale', 'Estimated catalogue', 'Coverage %', 'Newest observation', 'Oldest observation', 'Complete', 'Failure', 'Warnings'],
    rows: d.sites.map((s) => [s.name, s.role, s.capability ?? '', s.connector ?? '', s.lastScanStatus ?? '', iso(s.lastScanAt), s.productsKnown, s.productsObservedFresh, s.productsStale, s.estimatedCatalogue, s.coveragePct, iso(s.newestObservation), iso(s.oldestObservation), s.complete ? 'yes' : 'no', s.failureReason ?? '', s.warnings.join('; ')]),
  };
}

export function assortmentTable(d: ReportData): Table {
  const row = (kind: string) => (a: ReportData['assortment']['competitorOnly'][number]): Cell[] => [kind, a.siteName, a.title, a.category ?? '', a.price, a.currency ?? '', a.firstSeenAt, a.url];
  return {
    name: 'Assortment gaps',
    columns: ['Gap type', 'Website', 'Product', 'Category', 'Price', 'Currency', 'First seen', 'URL'],
    rows: [...d.assortment.competitorOnly.map(row('At competitor, no equivalent at your shop')), ...d.assortment.sourceOnly.map(row('At your shop, no equivalent at competitors'))],
  };
}

export function tableFor(d: ReportData, dataset: CsvDataset): Table {
  switch (dataset) {
    case 'comparison': return comparisonTable(d);
    case 'offers': return offersTable(d);
    case 'stock': return stockTable(d);
    case 'marketing': return marketingTable(d);
    case 'marketing_summary': return marketingSummaryTable(d);
    case 'insights': return insightsTable(d);
    case 'coverage': return coverageTable(d);
    case 'assortment': return assortmentTable(d);
  }
}

// ───────────────────────────────────────────────────────────── CSV

/** Neutralises spreadsheet formula injection: values scraped from third-party sites must never execute when opened. */
export function csvSafe(v: Cell): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? String(v) : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function renderCsv(d: ReportData, dataset: CsvDataset): Buffer {
  const t = tableFor(d, dataset);
  const header = [`# ${d.meta.orgName} — ${t.name} — period ${d.meta.periodDate} — generated ${d.meta.generatedAt}${d.meta.isPartial ? ' — PARTIAL REPORT' : ''}`];
  const lines = [...header, t.columns.map(csvSafe).join(','), ...t.rows.map((r) => r.map(csvSafe).join(','))];
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
}

// ───────────────────────────────────────────────────────────── XLSX

/** What a report workbook is made of: its tables (each a worksheet) and what a table says when the snapshot holds nothing for it. */
interface ReportSheet {
  table: Table;
  empty: string;
}

/** The exchange rates the comparison's prices were converted with (the PDF of the comparison points here for them). */
function fxTable(d: ReportData): Table {
  return { name: 'Exchange rates', columns: ['From', 'To', 'Rate', 'Source', 'Fixed peg', 'As of'], rows: d.fx.map((r) => [r.from, r.to, r.rate, r.source, r.isFixed ? 'yes' : 'no', r.fetchedAt]) };
}

/** The notes about how complete the collected data was. */
function dataNotesTable(d: ReportData): Table {
  return { name: 'Data notes', columns: ['Note'], rows: d.warnings.map((w) => [w]) };
}

/** What the assortment gaps can and cannot mean for this workspace (the note, and which catalogues were not read completely). */
function assortmentBasisTable(d: ReportData): Table {
  const rows: Cell[][] = [['Note', d.assortment.note]];
  for (const g of d.assortment.basis?.competitorGaps ?? []) rows.push([`Competitor catalogue not read completely: ${g.name}`, g.reason]);
  if (d.assortment.basis?.sourceGap) rows.push(['Your own catalogue', d.assortment.basis.sourceGap]);
  return { name: 'Assortment basis', columns: ['Item', 'Detail'], rows };
}

/** The worksheets of one report: every table that belongs to it, and none of another report's. */
export function reportSheets(d: ReportData, report: CsvDataset): ReportSheet[] {
  switch (report) {
    case 'comparison': return [{ table: comparisonTable(d), empty: 'No price comparison rows are in this saved report.' }, { table: fxTable(d), empty: 'All prices were in the reporting currency.' }];
    case 'offers': return [{ table: offersTable(d), empty: 'No offers or promotions were observed in this saved report.' }];
    case 'stock': return [{ table: stockTable(d), empty: 'No low-stock, out-of-stock or unknown-availability items were found.' }];
    case 'marketing': return [{ table: marketingTable(d), empty: 'No marketing activity was observed.' }];
    case 'marketing_summary': return [{ table: marketingSummaryTable(d), empty: d.marketingSummary ? 'No competitors are in this saved report.' : 'This saved report has no marketing summary: it was saved before summaries were added.' }];
    case 'insights': return [{ table: insightsTable(d), empty: 'No findings were produced for this saved report.' }];
    case 'coverage': return [{ table: coverageTable(d), empty: 'No websites are in this saved report.' }, { table: dataNotesTable(d), empty: 'There are no data notes for this saved report.' }];
    case 'assortment': return [{ table: assortmentTable(d), empty: 'No assortment gaps were found in this saved report.' }, { table: assortmentBasisTable(d), empty: '' }];
  }
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** The number format of a column, from what it holds: prices and differences with two decimals, percentages, exchange rates, and real dates and times. */
function columnFormat(header: string): string | null {
  if (/%/.test(header)) return '0.00';
  if (/price|^difference$/i.test(header)) return '#,##0.00';
  if (/^rate$|fx rate/i.test(header)) return '0.0000';
  return null;
}

const XLSX_DATE_FORMAT = 'yyyy-mm-dd hh:mm';

/**
 * The workbook of ONE report of a saved snapshot, from the snapshot only. Each worksheet is one of that report's tables: its first row says which snapshot it is (workspace, report,
 * period, when it was prepared, and PARTIAL where it is), the second holds the column names (frozen, filterable), the rest the rows, with real dates and numbers. A table with nothing
 * in it says so under its column names. Nothing of any other report is in the file.
 */
function renderReportXlsx(wb: ExcelJS.Workbook, d: ReportData, report: CsvDataset): Promise<Buffer> {
  const label = csvDatasetLabel(report);
  wb.title = `${label} — ${d.meta.periodDate}`;
  wb.subject = `${label} report of the saved snapshot`;
  wb.description = `${d.meta.orgName}: saved snapshot prepared ${d.meta.generatedAt}${d.meta.isPartial ? ' (PARTIAL REPORT)' : ''}`;
  for (const { table: t, empty } of reportSheets(d, report)) {
    const ws = wb.addWorksheet(t.name.slice(0, 31));
    const context = ws.addRow([`${d.meta.orgName} — ${t.name} — period ${d.meta.periodDate} — generated ${d.meta.generatedAt}${d.meta.isPartial ? ' — PARTIAL REPORT' : ''}`]);
    context.font = { italic: true, color: { argb: 'FF5F7378' } };
    const head = ws.addRow(t.columns);
    head.font = { bold: true };
    head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFE8D8' } }; });
    ws.views = [{ state: 'frozen', ySplit: 2 }];
    const dateColumns = new Set<number>();
    for (const r of t.rows) {
      const row = ws.addRow(r.map((c, i) => {
        if (typeof c === 'string' && ISO_TIMESTAMP.test(c)) {
          dateColumns.add(i);
          return new Date(c);
        }
        return typeof c === 'string' && c.length > 32_000 ? c.slice(0, 32_000) : c;
      }));
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const fmt = dateColumns.has(col - 1) && cell.value instanceof Date ? XLSX_DATE_FORMAT : typeof cell.value === 'number' ? columnFormat(t.columns[col - 1] ?? '') : null;
        if (fmt) cell.numFmt = fmt;
      });
    }
    if (!t.rows.length && empty) ws.addRow([empty]).font = { italic: true };
    if (t.columns.length) ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: t.columns.length } };
    ws.columns.forEach((c, i) => {
      c.width = dateColumns.has(i) ? 18 : Math.min(48, Math.max(10, (t.columns[i]?.length ?? 8) + 2));
    });
    if (t.columns.length === 1 || t.name === 'Assortment basis') ws.getColumn(t.columns.length).width = 90;
  }
  return wb.xlsx.writeBuffer().then((b) => Buffer.from(b as ArrayBuffer));
}

/** The whole workbook (a Summary and one worksheet for each report), or, with `report`, the workbook of that one report alone. */
export async function renderXlsx(d: ReportData, report?: CsvDataset): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Shelfwatch';
  wb.created = new Date(d.meta.generatedAt);
  if (report) return renderReportXlsx(wb, d, report);
  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ width: 34 }, { width: 80 }];
  const put = (k: string, v: Cell) => sum.addRow([k, v === null ? '' : v]);
  sum.addRow(['Competitor intelligence report']).font = { bold: true, size: 14 };
  put('Workspace', d.meta.orgName);
  put('Period', d.meta.periodDate);
  put('Generated at', d.meta.generatedAt);
  put('Timezone', d.meta.timezone);
  put('Reporting currency', d.meta.reportingCurrency);
  put('Status', d.meta.isPartial ? 'PARTIAL — see notes' : 'Complete');
  put('Headline', d.headline);
  if (d.aiSummary) put('AI summary (validated)', d.aiSummary.text);
  sum.addRow([]);
  for (const [k, v] of Object.entries(d.kpis)) put(k, v);
  sum.addRow([]);
  sum.addRow(['Notes']).font = { bold: true };
  for (const w of d.warnings) sum.addRow(['', w]);
  sum.addRow([]);
  sum.addRow(['Exchange rates used']).font = { bold: true };
  for (const r of d.fx) sum.addRow([`${r.from} → ${r.to}`, `${r.rate} (${r.source}${r.isFixed ? ', fixed' : ''}; as of ${r.fetchedAt})`]);

  for (const ds of CSV_DATASETS) {
    const t = tableFor(d, ds);
    const ws = wb.addWorksheet(t.name.slice(0, 31));
    ws.addRow(t.columns).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of t.rows) ws.addRow(r.map((c) => (typeof c === 'string' && c.length > 32_000 ? c.slice(0, 32_000) : c)));
    ws.columns.forEach((c, i) => {
      c.width = Math.min(48, Math.max(10, (t.columns[i]?.length ?? 8) + 2));
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

// ───────────────────────────────────────────────────────────── PDF

/** Standard PDF fonts only cover Latin-1/WinAnsi: map the few other glyphs we use to safe equivalents. */
export function pdfText(s: string): string {
  return s
    .replace(/→/g, '->')
    .replace(/−/g, '-')
    .replace(/×/g, 'x')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/…/g, '...')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7e\u00a0-ÿ–—•€\n]/g, '?');
}

/**
 * The PDF of a saved report snapshot. Without `section` it is the whole report (every section, the first rows of each table). With one of the Reports dropdown's selections it is
 * THAT report alone: its own title, its whole table (up to SECTION_PDF_ROWS rows) and an explicit message when the snapshot holds nothing for it. Both come from the snapshot passed in,
 * never from live data.
 */
export function renderPdf(d: ReportData, section?: CsvDataset): Promise<Buffer> {
  const label = section ? csvDatasetLabel(section) : null;
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: label ? `Competitor report ${d.meta.periodDate} - ${label}` : `Competitor report ${d.meta.periodDate}`, Author: 'Shelfwatch', ...(label ? { Subject: `${label} report of the saved snapshot` } : {}) }, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const W = doc.page.width - 80;
  const INK = '#10252b';
  const MUTE = '#5f7378';
  const ACCENT = '#0e6e73';
  const tz = d.meta.timezone;
  const ensure = (h: number) => {
    if (doc.y + h > doc.page.height - 60) doc.addPage();
  };
  const h2 = (t: string) => {
    ensure(40);
    doc.x = 40;
    doc.moveDown(0.8).font('Helvetica-Bold').fontSize(13).fillColor(ACCENT).text(t, 40, doc.y, { width: W }).moveDown(0.3).fillColor(INK);
  };
  // Always anchor body text at the left margin: pdfkit keeps the cursor at the last table cell otherwise.
  const p = (t: string, o: { size?: number; color?: string; bold?: boolean } = {}) => {
    ensure(18);
    doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size ?? 9.5).fillColor(o.color ?? INK).text(pdfText(t), 40, doc.y, { width: W }).fillColor(INK);
    doc.x = 40;
  };
  const table = (cols: { h: string; w: number; align?: 'left' | 'right' }[], rows: string[][], max = 40) => {
    const total = cols.reduce((a, c) => a + c.w, 0);
    const scale = W / total;
    const widths = cols.map((c) => c.w * scale);
    const drawRow = (cells: string[], bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      const heights = cells.map((c, i) => doc.heightOfString(c || ' ', { width: widths[i]! - 6 }));
      const h = Math.max(...heights) + 6;
      ensure(h);
      let x = 40;
      const y = doc.y;
      if (bold) doc.rect(40, y, W, h).fill('#efe8d8').fillColor(INK);
      cells.forEach((c, i) => {
        doc.fillColor(INK).text(pdfText(c) || ' ', x + 3, y + 3, { width: widths[i]! - 6, align: cols[i]!.align ?? 'left' });
        x += widths[i]!;
      });
      doc.rect(40, y, W, h).strokeColor('#e3dccb').lineWidth(0.5).stroke();
      doc.x = 40;
      doc.y = y + h;
    };
    drawRow(cols.map((c) => c.h), true);
    rows.slice(0, max).forEach((r) => drawRow(r));
    if (rows.length > max) p(`… ${rows.length - max} more row(s) in the CSV/Excel export and the dashboard.`, { size: 8, color: MUTE });
  };

  // the tables the whole report and the section reports have in common
  const now = new Date(d.meta.generatedAt);
  const PRICE_COLS = [{ h: 'Product', w: 5 }, { h: 'Competitor', w: 3 }, { h: 'Your price', w: 2.4, align: 'right' as const }, { h: 'Their price', w: 2.4, align: 'right' as const }, { h: 'Diff', w: 1.6, align: 'right' as const }, { h: 'Match', w: 2.4 }, { h: 'Observed', w: 1.8 }];
  const priceRows = (): string[][] => {
    const out: string[][] = [];
    for (const r of [...d.comparisons].sort((a, b) => Math.abs(b.cells[0]?.diffPct ?? 0) - Math.abs(a.cells[0]?.diffPct ?? 0))) {
      for (const c of r.cells) {
        out.push([r.title + (r.sizeLabel ? ` (${r.sizeLabel})` : ''), c.siteName, formatMoney(r.sourcePrice.amount, r.sourcePrice.currency), formatMoney(c.price.amount, c.price.currency), c.directlyComparable ? formatPct(c.diffPct) : c.unitDiffPct !== null ? `${formatPct(c.unitDiffPct)} per unit` : 'n/a', `${c.matchClass.split('_').join(' ')} ${Math.round(c.confidence * 100)}%`, c.price.stale ? 'stale' : formatAge(c.price.observedAt, now)]);
      }
    }
    return out;
  };
  const PRICE_NOTE = `Differences use prices converted to ${d.meta.reportingCurrency}; original amounts and exchange rates are in the Excel export. "Diff" is (competitor − you) ÷ you for confirmed identical products only.`;
  const OFFER_COLS = [{ h: 'Website', w: 2.4 }, { h: 'Offer', w: 5 }, { h: 'Was / now', w: 2.4 }, { h: 'Claimed', w: 1.4, align: 'right' as const }, { h: 'History check', w: 2.4 }, { h: 'Status', w: 1.6 }];
  const offerRow = (o: ReportData['offers'][number]): string[] => [o.siteName, o.title + (o.conditions.length ? ` — ${o.conditions.join(', ')}` : ''), o.originalPrice !== null ? `${formatMoney(o.originalPrice, o.currency)} → ${formatMoney(o.salePrice, o.currency)}` : o.salePrice !== null ? formatMoney(o.salePrice, o.currency) : '—', o.claimedDiscountPct !== null ? `${o.claimedDiscountPct}%` : '—', o.verification.split('_').join(' '), o.status.split('_').join(' ')];
  const OFFER_NOTE = 'A claimed discount is verified only against the product’s own earlier prices. "Unverified" means there is not enough history to check it.';
  const STOCK_COLS = [{ h: 'Product', w: 6 }, { h: 'State', w: 2 }, { h: 'Quantity', w: 2.2, align: 'right' as const }, { h: 'Basis', w: 3.4 }, { h: 'Observed', w: 2 }];
  const stockRow = (s: ReportData['stock'][number]): string[] => [s.title, s.state.split('_').join(' '), s.quantity === null ? 'unknown' : String(s.quantity), s.quantitySource === 'authorised_inventory' ? 'authorised inventory' : s.quantitySource === 'public_claim' ? 'public claim' : (s.note ?? 'public availability'), s.stale ? 'stale' : formatAge(s.observedAt, now)];
  const NO_STOCK = 'No low-stock, out-of-stock or unknown-availability items were found.';
  const MARKETING_COLS = [{ h: 'Website', w: 2.4 }, { h: 'Where', w: 1.8 }, { h: 'Content', w: 6 }, { h: 'Type', w: 2 }, { h: 'Seen', w: 2 }];
  const marketingRow = (m: ReportData['marketing'][number]): string[] => [m.siteName, m.platform, m.title ?? m.kind, m.classification.split('_').join(' '), formatDateTime(m.firstSeenAt, tz)];
  const MARKETING_NOTE = 'Observed public content only. It does not show whether any item is a paid advertisement.';

  // a section report: only the selected report, from this snapshot
  const SECTION_PDF_ROWS = 1000;
  const finish = (sectionLabel?: string): Promise<Buffer> => {
    const range = doc.bufferedPageRange();
    const snapshot = sha256Hex(stableStringify(d)).slice(0, 12);
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // the footer sits inside the bottom margin: left at that, pdfkit starts a new page for each footer (a page of its own, holding nothing else) instead of writing it on the page it belongs to
      const margin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTE).text(`${sectionLabel ? `${sectionLabel} report · ` : ''}Snapshot ${snapshot} · page ${i + 1} of ${range.count}`, 40, doc.page.height - 36, { width: W, align: 'center', lineBreak: false });
      doc.page.margins.bottom = margin;
    }
    doc.end();
    return done;
  };
  if (section && label) {
    const k = d.kpis;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT).text('COMPETITOR INTELLIGENCE', { characterSpacing: 1.2 });
    doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(`${label} — ${d.meta.periodDate}`);
    p(`${d.meta.orgName} · saved snapshot prepared ${formatDateTime(d.meta.generatedAt, tz)} (${tz}) · reporting currency ${d.meta.reportingCurrency}`, { color: MUTE, size: 9 });
    p(`Report type: ${label}`, { color: MUTE, size: 9 });
    if (d.meta.isPartial) {
      doc.moveDown(0.4);
      p('PARTIAL REPORT — some websites were incomplete or unavailable. See the data coverage report for the reasons. Missing data is never treated as zero.', { bold: true, color: '#8a3b12' });
    }
    doc.moveDown(0.3);
    switch (section) {
      case 'comparison': {
        h2('Price comparison');
        table([{ h: 'Measure', w: 5 }, { h: 'Value', w: 2, align: 'right' }], [
          ['Matched products (with competitors)', String(k.matchedProducts)],
          ['Identical matches', String(k.identicalMatches)],
          ['Your price lower than competitor (confirmed identical)', String(k.productsCheaperAtSource)],
          ['Your price higher than competitor (confirmed identical)', String(k.productsPricierAtSource)],
          ['Average difference vs. competitors', formatPct(k.averageDiffPct)],
        ]);
        doc.moveDown(0.6);
        const rows = priceRows();
        if (!rows.length) p('No price comparison rows are in this saved report: none of your products has a confirmed match with a priced competitor product.');
        else table(PRICE_COLS, rows, SECTION_PDF_ROWS);
        p(PRICE_NOTE, { size: 8, color: MUTE });
        break;
      }
      case 'offers': {
        h2('Offers and promotions');
        p(`${k.activeOffers} active offer(s) observed; ${d.offers.length} in all.`);
        if (!d.offers.length) p('No offers or promotions were observed in this saved report.');
        else {
          table(OFFER_COLS, d.offers.map(offerRow), SECTION_PDF_ROWS);
          p(OFFER_NOTE, { size: 8, color: MUTE });
        }
        break;
      }
      case 'stock': {
        h2('Your stock');
        p(`${k.lowStockCount} low-stock and ${k.outOfStockCount} out-of-stock item(s) of your own shop.`);
        if (!d.stock.length) p(NO_STOCK);
        else table(STOCK_COLS, d.stock.map(stockRow), SECTION_PDF_ROWS);
        break;
      }
      case 'marketing': {
        h2('Marketing activity (observed)');
        if (!d.marketing.length) p('No marketing activity was observed.');
        else {
          p(`${d.marketing.length} item(s) observed.`);
          table(MARKETING_COLS, d.marketing.map(marketingRow), SECTION_PDF_ROWS);
        }
        p(MARKETING_NOTE, { size: 8, color: MUTE });
        break;
      }
      case 'marketing_summary': {
        h2('Marketing summary');
        const ms = d.marketingSummary;
        if (!ms) {
          p('This saved report has no marketing summary: it was saved before summaries were added.');
          break;
        }
        p(ms.headline);
        const seen = ms.competitors.filter((c) => c.total > 0);
        const none = ms.competitors.filter((c) => c.total === 0);
        const top = (xs: { title: string; value: number; platform: string }[]) => xs.map((x) => `${x.title} (${x.value} on ${x.platform})`).join('; ');
        for (const c of seen) {
          doc.moveDown(0.3);
          p(c.siteName, { bold: true, size: 9.5 });
          p(`${c.total} item(s) observed, ${c.promotionCount} promotional${Object.keys(c.byPlatform).length ? ` — by platform: ${Object.entries(c.byPlatform).map(([name, n]) => `${name} ${n}`).join(', ')}` : ''}.`, { size: 8.5 });
          if (c.themes.length) p('Recurring themes: ' + c.themes.map((t) => `${t.term} (${t.items} items)`).join(', '), { size: 8.5 });
          if (c.brandMentions.length) p('Brands mentioned in promotions: ' + c.brandMentions.map((b) => `${b.brand} (${b.items})`).join(', ') + '. A mention is not proof the brand is discounted.', { size: 8.5 });
          p('Timing: ' + (c.timing ? c.timing.sentence : (c.timingNote ?? 'not enough dated promotions to describe a pattern.')), { size: 8.5 });
          if (c.mostLiked.length) p('Most liked: ' + top(c.mostLiked), { size: 8.5 });
          if (c.mostViewed.length) p('Most viewed: ' + top(c.mostViewed), { size: 8.5 });
          if (c.limitations.length) p('Cannot see: ' + c.limitations.join(' '), { size: 8, color: MUTE });
        }
        if (!seen.length) p('No marketing activity was observed for any competitor.');
        if (none.length) {
          doc.moveDown(0.3);
          p(`No marketing activity observed for: ${none.map((c) => c.siteName).join(', ')}.`, { size: 8.5 });
        }
        if (ms.note) p(ms.note, { size: 8, color: MUTE });
        break;
      }
      case 'insights': {
        h2('Insights and findings');
        if (!d.insights.length) p('No findings were produced for this saved report.');
        d.insights.slice(0, 100).forEach((i, n) => {
          ensure(46);
          p(`${n + 1}. ${i.title}  [score ${i.score} · ${i.severity}]`, { bold: true, size: 9.5 });
          p(i.summary, { size: 8.5, color: MUTE });
          if (i.evidence.length) p('Evidence: ' + i.evidence.slice(0, 6).map((e) => e.label + (e.observedAt ? ` (${formatAge(e.observedAt, now)})` : '')).join('; '), { size: 8, color: MUTE });
        });
        if (d.insights.length > 100) p(`… ${d.insights.length - 100} more finding(s) in the CSV/Excel export and the dashboard.`, { size: 8, color: MUTE });
        break;
      }
      case 'coverage': {
        h2('Data coverage and freshness');
        if (!d.sites.length) p('No websites are in this saved report.');
        else {
          table([{ h: 'Website', w: 3 }, { h: 'Role', w: 1.5 }, { h: 'Capability', w: 1.6 }, { h: 'Products', w: 1.3, align: 'right' }, { h: 'Fresh', w: 1.1, align: 'right' }, { h: 'Stale', w: 1.1, align: 'right' }, { h: 'Coverage', w: 1.3, align: 'right' }, { h: 'Complete', w: 1.3 }, { h: 'Last collection', w: 3 }], d.sites.map((x) => [x.name, x.role, x.capability ?? '—', String(x.productsKnown), String(x.productsObservedFresh), String(x.productsStale), x.coveragePct === null ? 'n/a' : `${x.coveragePct}%`, x.complete ? 'yes' : 'no', x.lastScanAt ? `${x.lastScanStatus} · ${formatDateTime(x.lastScanAt, tz)}` : 'never']), SECTION_PDF_ROWS);
          // a reason the data notes below already give is not told twice
          const notes = d.sites.filter((x) => (!x.complete || x.failureReason || x.warnings.length) && !(x.failureReason && d.warnings.some((w) => w.includes(x.failureReason!))));
          if (notes.length) {
            h2('Collection notes');
            notes.forEach((x) => p(`${x.name}: ${[x.failureReason, ...x.warnings].filter(Boolean).join(' ') || 'the catalogue was not read completely.'}`, { size: 8.5 }));
          }
        }
        if (d.warnings.length) {
          h2('Data notes and limitations');
          d.warnings.forEach((w) => p(`• ${w}`, { size: 9 }));
        }
        break;
      }
      case 'assortment': {
        h2('Assortment gaps');
        p(d.assortment.note, { size: 8.5, color: MUTE });
        // what the note above does not already say
        const gaps = (d.assortment.basis?.competitorGaps ?? []).filter((g) => !d.assortment.note.includes(g.name));
        if (gaps.length) p('Competitor catalogues not read completely: ' + gaps.map((g) => `${g.name} (${g.reason})`).join('; '), { size: 8.5 });
        const sourceGap = d.assortment.basis?.sourceGap;
        if (sourceGap && !d.assortment.note.includes(sourceGap)) p('Your own catalogue: ' + sourceGap, { size: 8.5 });
        const gapTable = (title: string, rows: ReportData['assortment']['competitorOnly'], none: string) => {
          h2(`${title} (${rows.length})`);
          if (!rows.length) p(none);
          else table([{ h: 'Website', w: 2.4 }, { h: 'Product', w: 6 }, { h: 'Category', w: 2.4 }, { h: 'Price', w: 1.8, align: 'right' }, { h: 'First seen', w: 2.4 }], rows.map((a) => [a.siteName, a.title, a.category ?? '—', a.price !== null ? formatMoney(a.price, a.currency) : '—', formatDateTime(a.firstSeenAt, tz)]), SECTION_PDF_ROWS);
        };
        gapTable('At competitors, no equivalent at your shop', d.assortment.competitorOnly, 'None found.');
        gapTable('At your shop, no equivalent at competitors', d.assortment.sourceOnly, 'None found.');
        break;
      }
    }
    return finish(label);
  }

  // header
  doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT).text('COMPETITOR INTELLIGENCE', { characterSpacing: 1.2 });
  doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(`Report — ${d.meta.periodDate}`);
  p(`${d.meta.orgName} · generated ${formatDateTime(d.meta.generatedAt, tz)} (${tz}) · reporting currency ${d.meta.reportingCurrency}`, { color: MUTE, size: 9 });
  if (d.meta.isPartial) {
    doc.moveDown(0.4);
    p('PARTIAL REPORT — some websites were incomplete or unavailable. See the data notes below. Missing data is never treated as zero.', { bold: true, color: '#8a3b12' });
  }
  doc.moveDown(0.5);
  p(d.headline, { size: 12, bold: true });
  if (d.aiSummary) p(`Summary (AI-written; every number verified against the data): ${d.aiSummary.text}`, { size: 9, color: MUTE });

  h2('Key figures');
  const k = d.kpis;
  table([{ h: 'Measure', w: 5 }, { h: 'Value', w: 2, align: 'right' }], [
    ['Matched products (with competitors)', String(k.matchedProducts)],
    ['Identical matches', String(k.identicalMatches)],
    ['Your price lower than competitor (confirmed identical)', String(k.productsCheaperAtSource)],
    ['Your price higher than competitor (confirmed identical)', String(k.productsPricierAtSource)],
    ['Average difference vs. competitors', formatPct(k.averageDiffPct)],
    ['Active offers observed', String(k.activeOffers)],
    ['Your low-stock items', String(k.lowStockCount)],
    ['Your out-of-stock items', String(k.outOfStockCount)],
    ['New competitor products (last 7 days)', String(k.newCompetitorProducts)],
    ['Marketing items observed (30 days)', String(k.marketingItems)],
  ]);

  if (d.warnings.length) {
    h2('Data notes and limitations');
    d.warnings.forEach((w) => p(`• ${w}`, { size: 9 }));
  }

  h2('Top findings');
  d.insights.slice(0, 12).forEach((i, n) => {
    ensure(34);
    p(`${n + 1}. ${i.title}  [score ${i.score}]`, { bold: true, size: 9.5 });
    p(i.summary, { size: 8.5, color: MUTE });
  });

  h2('Price comparison');
  table(PRICE_COLS, priceRows(), 45);
  p(PRICE_NOTE, { size: 8, color: MUTE });

  h2('Offers and promotions');
  table(OFFER_COLS, d.offers.slice(0, 40).map(offerRow), 40);
  p(OFFER_NOTE, { size: 8, color: MUTE });

  h2('Your stock');
  if (!d.stock.length) p(NO_STOCK);
  else table(STOCK_COLS, d.stock.slice(0, 40).map(stockRow), 40);

  h2('Marketing activity (observed)');
  if (d.marketingSummary) {
    p(d.marketingSummary.headline);
    for (const c of d.marketingSummary.competitors.filter((x) => x.total > 0)) {
      p(c.siteName, { bold: true, size: 9 });
      if (c.themes.length) p('Recurring themes: ' + c.themes.map((t) => `${t.term} (${t.items} items)`).join(', '), { size: 8.5 });
      if (c.brandMentions.length) p('Brands mentioned in promotions: ' + c.brandMentions.map((b) => `${b.brand} (${b.items})`).join(', ') + '. A mention is not proof the brand is discounted.', { size: 8.5 });
      p('Timing: ' + (c.timing ? c.timing.sentence : (c.timingNote ?? 'not enough dated promotions to describe a pattern.')), { size: 8.5 });
      p('Cannot see: ' + c.limitations.slice(-1)[0], { size: 8, color: MUTE });
    }
  }
  if (!d.marketing.length) p('No marketing activity was observed.');
  else table(MARKETING_COLS, d.marketing.slice(0, 30).map(marketingRow), 30);
  p(MARKETING_NOTE, { size: 8, color: MUTE });

  h2('Data coverage and freshness');
  table([{ h: 'Website', w: 3 }, { h: 'Role', w: 1.6 }, { h: 'Capability', w: 1.6 }, { h: 'Products', w: 1.4, align: 'right' }, { h: 'Stale', w: 1.2, align: 'right' }, { h: 'Coverage', w: 1.4, align: 'right' }, { h: 'Last collection', w: 3 }], d.sites.map((s) => [s.name, s.role, s.capability ?? '—', String(s.productsKnown), String(s.productsStale), s.coveragePct === null ? 'n/a' : `${s.coveragePct}%`, s.lastScanAt ? `${s.lastScanStatus} · ${formatDateTime(s.lastScanAt, tz)}` : 'never']), 20);

  h2('Exchange rates used');
  if (!d.fx.length) p('All prices were in the reporting currency.');
  d.fx.forEach((r) => p(`${r.from} → ${r.to}: ${r.rate} — ${r.source}${r.isFixed ? ' (fixed peg)' : ''}, as of ${formatDateTime(r.fetchedAt, tz)}`, { size: 8.5 }));

  // footer on every page
  return finish();
}

// ───────────────────────────────────────────────────────────── cached export API

export const EXPORT_TYPES: Record<ReportFormat, { ext: string; contentType: string }> = {
  pdf: { ext: 'pdf', contentType: 'application/pdf' },
  csv: { ext: 'csv', contentType: 'text/csv; charset=utf-8' },
  xlsx: { ext: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
};

export class ExportError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/**
 * `dataset` is the report the person selected. CSV: that table (the price comparison when none is named). PDF and Excel: that report alone; without it, the whole report (the whole
 * workbook, one sheet per report). Each is saved and served under its own key, so one selection can never be answered with another's file.
 */
export async function exportReport(svc: Services, db: DbLike, orgId: string, reportId: string, format: ReportFormat, dataset?: CsvDataset): Promise<{ body: Buffer; filename: string; contentType: string }> {
  const report = await getReport(db, orgId, reportId);
  if (!report) throw new ExportError('Report not found', 404);
  if (!report.data || (report.status !== 'ready' && report.status !== 'partial')) throw new ExportError('The report is not finished yet', 409);
  const data = report.data as ReportData;
  const ds: CsvDataset | 'all' = format === 'csv' ? (dataset ?? 'comparison') : dataset ?? 'all';
  const type = EXPORT_TYPES[format];
  const filename = `report-${data.meta.periodDate}${data.meta.isPartial ? '-partial' : ''}${ds === 'all' ? '' : `-${ds}`}.${type.ext}`;
  const key = `exports/${orgId}/${reportId}/${ds}.${type.ext}`;

  const [cached] = await db.select().from(reportExports).where(and(eq(reportExports.reportId, reportId), eq(reportExports.format, format), eq(reportExports.dataset, ds)));
  if (cached) {
    const stored = await svc.storage.get(cached.storageKey);
    if (stored && sha256Hex(stored) === cached.checksum) return { body: stored, filename, contentType: type.contentType };
  }
  const body = format === 'csv' ? renderCsv(data, ds as CsvDataset) : format === 'xlsx' ? await renderXlsx(data, ds === 'all' ? undefined : ds) : await renderPdf(data, ds === 'all' ? undefined : ds);
  await svc.storage.put(key, body, type.contentType);
  const checksum = sha256Hex(body);
  await db
    .insert(reportExports)
    .values({ orgId, reportId, format, dataset: ds, storageKey: key, bytes: body.length, checksum })
    .onConflictDoUpdate({ target: [reportExports.reportId, reportExports.format, reportExports.dataset], set: { storageKey: key, bytes: body.length, checksum, createdAt: svc.clock() } });
  return { body, filename, contentType: type.contentType };
}
