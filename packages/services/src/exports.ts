import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { eq, and } from 'drizzle-orm';
import { sha256Hex, stableStringify } from '@ci/core';
import { formatAge, formatDateTime, formatMoney, formatPct, type ReportData, type ReportFormat } from '@ci/shared';
import { reportExports, type DbLike } from '@ci/database';
import type { Services } from './context.ts';
import { getReport } from './report.ts';

/**
 * Every export is rendered from the immutable report snapshot (ReportData) — never from live tables — so the
 * dashboard, PDF, CSV and Excel can never disagree with each other.
 */

export const CSV_DATASETS = ['comparison', 'offers', 'stock', 'marketing', 'marketing_summary', 'insights', 'coverage', 'assortment'] as const;
export type CsvDataset = (typeof CSV_DATASETS)[number];

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
        c.price.fxRate, c.price.fxSource ?? '', c.offerSummary ?? '', c.url, r.url, c.caveats.join('; '),
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
    columns: ['Website', 'Role', 'Fixture', 'Capability', 'Connector', 'Last scan', 'Last scan at', 'Products known', 'Fresh', 'Stale', 'Estimated catalogue', 'Coverage %', 'Newest observation', 'Oldest observation', 'Complete', 'Failure', 'Warnings'],
    rows: d.sites.map((s) => [s.name, s.role, s.isFixture ? 'yes' : 'no', s.capability ?? '', s.connector ?? '', s.lastScanStatus ?? '', iso(s.lastScanAt), s.productsKnown, s.productsObservedFresh, s.productsStale, s.estimatedCatalogue, s.coveragePct, iso(s.newestObservation), iso(s.oldestObservation), s.complete ? 'yes' : 'no', s.failureReason ?? '', s.warnings.join('; ')]),
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
  const header = [`# ${d.meta.orgName} — ${t.name} — period ${d.meta.periodDate} — generated ${d.meta.generatedAt}${d.meta.isPartial ? ' — PARTIAL REPORT' : ''}${d.meta.containsFixtureData ? ' — CONTAINS FIXTURE DATA' : ''}`];
  const lines = [...header, t.columns.map(csvSafe).join(','), ...t.rows.map((r) => r.map(csvSafe).join(','))];
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
}

// ───────────────────────────────────────────────────────────── XLSX

export async function renderXlsx(d: ReportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Shelfwatch';
  wb.created = new Date(d.meta.generatedAt);
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
  put('Contains fixture data', d.meta.containsFixtureData ? 'YES — demonstration data, not live' : 'no');
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

export function renderPdf(d: ReportData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Competitor report ${d.meta.periodDate}`, Author: 'Shelfwatch' }, bufferPages: true });
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

  // header
  doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT).text('COMPETITOR INTELLIGENCE', { characterSpacing: 1.2 });
  doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(`Report — ${d.meta.periodDate}`);
  p(`${d.meta.orgName} · generated ${formatDateTime(d.meta.generatedAt, tz)} (${tz}) · reporting currency ${d.meta.reportingCurrency}`, { color: MUTE, size: 9 });
  if (d.meta.isPartial) {
    doc.moveDown(0.4);
    p('PARTIAL REPORT — some websites were incomplete or unavailable. See the data notes below. Missing data is never treated as zero.', { bold: true, color: '#8a3b12' });
  }
  if (d.meta.containsFixtureData) p('CONTAINS FIXTURE DATA — demonstration data from local test sites; not live market data.', { bold: true, color: '#8a3b12' });
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
  const rows: string[][] = [];
  for (const r of [...d.comparisons].sort((a, b) => Math.abs(b.cells[0]?.diffPct ?? 0) - Math.abs(a.cells[0]?.diffPct ?? 0))) {
    for (const c of r.cells) {
      rows.push([r.title + (r.sizeLabel ? ` (${r.sizeLabel})` : ''), c.siteName, formatMoney(r.sourcePrice.amount, r.sourcePrice.currency), formatMoney(c.price.amount, c.price.currency), c.directlyComparable ? formatPct(c.diffPct) : c.unitDiffPct !== null ? `${formatPct(c.unitDiffPct)} per unit` : 'n/a', `${c.matchClass.split('_').join(' ')} ${Math.round(c.confidence * 100)}%`, c.price.stale ? 'stale' : formatAge(c.price.observedAt, new Date(d.meta.generatedAt))]);
    }
  }
  table([{ h: 'Product', w: 5 }, { h: 'Competitor', w: 3 }, { h: 'Your price', w: 2.4, align: 'right' }, { h: 'Their price', w: 2.4, align: 'right' }, { h: 'Diff', w: 1.6, align: 'right' }, { h: 'Match', w: 2.4 }, { h: 'Observed', w: 1.8 }], rows, 45);
  p(`Differences use prices converted to ${d.meta.reportingCurrency}; original amounts and exchange rates are in the Excel export. "Diff" is (competitor − you) ÷ you for confirmed identical products only.`, { size: 8, color: MUTE });

  h2('Offers and promotions');
  table([{ h: 'Website', w: 2.4 }, { h: 'Offer', w: 5 }, { h: 'Was / now', w: 2.4 }, { h: 'Claimed', w: 1.4, align: 'right' }, { h: 'History check', w: 2.4 }, { h: 'Status', w: 1.6 }], d.offers.slice(0, 40).map((o) => [o.siteName, o.title + (o.conditions.length ? ` — ${o.conditions.join(', ')}` : ''), o.originalPrice !== null ? `${formatMoney(o.originalPrice, o.currency)} → ${formatMoney(o.salePrice, o.currency)}` : o.salePrice !== null ? formatMoney(o.salePrice, o.currency) : '—', o.claimedDiscountPct !== null ? `${o.claimedDiscountPct}%` : '—', o.verification.split('_').join(' '), o.status.split('_').join(' ')]), 40);
  p('A claimed discount is verified only against the product’s own earlier prices. "Unverified" means there is not enough history to check it.', { size: 8, color: MUTE });

  h2('Your stock');
  if (!d.stock.length) p('No low-stock, out-of-stock or unknown-availability items were found.');
  else table([{ h: 'Product', w: 6 }, { h: 'State', w: 2 }, { h: 'Quantity', w: 2.2, align: 'right' }, { h: 'Basis', w: 3.4 }, { h: 'Observed', w: 2 }], d.stock.slice(0, 40).map((s) => [s.title, s.state.split('_').join(' '), s.quantity === null ? 'unknown' : String(s.quantity), s.quantitySource === 'authorised_inventory' ? 'authorised inventory' : s.quantitySource === 'simulated' ? 'SIMULATED' : s.quantitySource === 'public_claim' ? 'public claim' : (s.note ?? 'public availability'), s.stale ? 'stale' : formatAge(s.observedAt, new Date(d.meta.generatedAt))]), 40);

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
  else table([{ h: 'Website', w: 2.4 }, { h: 'Where', w: 1.8 }, { h: 'Content', w: 6 }, { h: 'Type', w: 2 }, { h: 'Seen', w: 2 }], d.marketing.slice(0, 30).map((m) => [m.siteName, m.platform, m.title ?? m.kind, m.classification.split('_').join(' '), formatDateTime(m.firstSeenAt, tz)]), 30);
  p('Observed public content only. It does not show whether any item is a paid advertisement.', { size: 8, color: MUTE });

  h2('Data coverage and freshness');
  table([{ h: 'Website', w: 3 }, { h: 'Role', w: 1.6 }, { h: 'Capability', w: 1.6 }, { h: 'Products', w: 1.4, align: 'right' }, { h: 'Stale', w: 1.2, align: 'right' }, { h: 'Coverage', w: 1.4, align: 'right' }, { h: 'Last collection', w: 3 }], d.sites.map((s) => [s.name + (s.isFixture ? ' (fixture)' : ''), s.role, s.capability ?? '—', String(s.productsKnown), String(s.productsStale), s.coveragePct === null ? 'n/a' : `${s.coveragePct}%`, s.lastScanAt ? `${s.lastScanStatus} · ${formatDateTime(s.lastScanAt, tz)}` : 'never']), 20);

  h2('Exchange rates used');
  if (!d.fx.length) p('All prices were in the reporting currency.');
  d.fx.forEach((r) => p(`${r.from} → ${r.to}: ${r.rate} — ${r.source}${r.isFixed ? ' (fixed peg)' : ''}, as of ${formatDateTime(r.fetchedAt, tz)}`, { size: 8.5 }));

  // footer on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTE).text(`Snapshot ${sha256Hex(stableStringify(d)).slice(0, 12)} · page ${i + 1} of ${range.count}`, 40, doc.page.height - 36, { width: W, align: 'center' });
  }
  doc.end();
  return done;
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

export async function exportReport(svc: Services, db: DbLike, orgId: string, reportId: string, format: ReportFormat, dataset: CsvDataset = 'comparison'): Promise<{ body: Buffer; filename: string; contentType: string }> {
  const report = await getReport(db, orgId, reportId);
  if (!report) throw new ExportError('Report not found', 404);
  if (!report.data || (report.status !== 'ready' && report.status !== 'partial')) throw new ExportError('The report is not finished yet', 409);
  const data = report.data as ReportData;
  const ds = format === 'csv' ? dataset : 'all';
  const type = EXPORT_TYPES[format];
  const filename = `report-${data.meta.periodDate}${data.meta.isPartial ? '-partial' : ''}${format === 'csv' ? `-${ds}` : ''}.${type.ext}`;
  const key = `exports/${orgId}/${reportId}/${ds}.${type.ext}`;

  const [cached] = await db.select().from(reportExports).where(and(eq(reportExports.reportId, reportId), eq(reportExports.format, format), eq(reportExports.dataset, ds)));
  if (cached) {
    const stored = await svc.storage.get(cached.storageKey);
    if (stored && sha256Hex(stored) === cached.checksum) return { body: stored, filename, contentType: type.contentType };
  }
  const body = format === 'csv' ? renderCsv(data, ds as CsvDataset) : format === 'xlsx' ? await renderXlsx(data) : await renderPdf(data);
  await svc.storage.put(key, body, type.contentType);
  const checksum = sha256Hex(body);
  await db
    .insert(reportExports)
    .values({ orgId, reportId, format, dataset: ds, storageKey: key, bytes: body.length, checksum })
    .onConflictDoUpdate({ target: [reportExports.reportId, reportExports.format, reportExports.dataset], set: { storageKey: key, bytes: body.length, checksum, createdAt: svc.clock() } });
  return { body, filename, contentType: type.contentType };
}
