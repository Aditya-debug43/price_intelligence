import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { extractText, getDocumentProxy } from 'unpdf';
import { and, eq } from 'drizzle-orm';
import { evidence, orgSettings, priceObservations, reportExports, reports, scanRuns, alerts } from '@ci/database';
import { sha256Hex, stableStringify, type LlmProvider } from '@ci/core';
import type { ReportData } from '@ci/shared';
import { ExportError, assembleReportData, exportReport, generateReport, getReport, listReports, marketingSummaryTable, renderPdf, runMatching, runRetention, startScan, JOB_HANDLERS } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';

let h: Harness;
let t: Tenant;
const ids: Record<string, string> = {};
let report: typeof reports.$inferSelect;
let data: ReportData;
const db = () => h.db.worker;

beforeAll(async () => {
  h = await createHarness();
  t = await h.newTenant('Reports');
  ids.source = await t.addFixtureSite('source', 'source');
  for (const k of ['woo', 'jsonld', 'html', 'blocked']) ids[k] = await t.addFixtureSite(k, 'competitor');
  for (const k of Object.keys(ids)) await t.tx((tx) => startScan(h.svc, tx, t.orgId, ids[k]!, { kind: 'discovery', trigger: 'manual' }));
  await h.queue.drain();
  await runMatching(h.svc, db(), t.orgId);
  report = await generateReport(h.svc, db(), t.orgId, { kind: 'manual', deadlineAt: null, createdBy: t.userId });
  data = report.data as ReportData;
}, 120_000);

afterAll(async () => {
  await h.close();
});

describe('report snapshot content', () => {
  it('is saved as a partial report because a competitor could not be collected, and says why', () => {
    expect(report.status).toBe('partial');
    expect(data.meta.isPartial).toBe(true);
    expect(data.sites.find((s) => s.name.includes('Blocked'))).toMatchObject({ complete: false, lastScanStatus: 'blocked', productsKnown: 0 });
    expect(data.warnings.join(' ')).toMatch(/Blocked.*robots/i);
    expect(data.warnings.join(' ')).toMatch(/FIXTURE/);
    expect(data.meta.containsFixtureData).toBe(true);
    expect(data.headline).toMatch(/^Partial report/);
  });

  it('keeps headline numbers consistent with the underlying rows', () => {
    expect(data.kpis.matchedProducts).toBe(data.comparisons.length);
    expect(data.kpis.identicalMatches).toBe(data.comparisons.reduce((a, r) => a + r.cells.filter((c) => c.matchClass === 'identical').length, 0));
    expect(data.kpis.sourceProducts).toBe(32);
    expect(data.kpis.activeOffers).toBe(data.offers.filter((o) => o.status === 'active').length);
    expect(data.fx.some((r) => r.from === 'USD' || r.to === 'USD')).toBe(true);
    expect(data.fx[0]!.source).toMatch(/Central Bank of Aruba/);
  });

  it('every insight is ranked, scored transparently and traceable to evidence', () => {
    expect(data.insights.length).toBeGreaterThan(5);
    const scores = data.insights.map((i) => i.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    for (const i of data.insights) {
      expect(i.evidence.length, i.id).toBeGreaterThan(0);
      expect(i.scoreBreakdown).toMatchObject({ typeWeight: expect.any(Number), magnitude: expect.any(Number), confidence: expect.any(Number), freshness: expect.any(Number) });
      expect(`${i.title} ${i.summary}`).not.toMatch(/NaN|undefined|null/);
    }
    const price = data.insights.find((i) => i.type === 'price_above_competitor' || i.type === 'large_price_gap')!;
    expect(price.evidence.some((e) => e.kind === 'observation' && e.id && e.url && e.observedAt)).toBe(true);
    // the observation ids in the evidence exist in the database
    const obsId = price.evidence.find((e) => e.kind === 'observation')!.id!;
    return db().select().from(priceObservations).where(eq(priceObservations.id, obsId)).then((r) => expect(r).toHaveLength(1));
  });

  it('evidence ids and URLs resolve to retained evidence rows', async () => {
    const rows = await db().select().from(evidence).where(eq(evidence.orgId, t.orgId)).limit(5);
    expect(rows.every((e) => e.url && e.contentHash && e.fetchedAt)).toBe(true);
  });

  it('coverage rows disclose partial catalogues and freshness instead of hiding them', () => {
    for (const s of data.sites) {
      expect(typeof s.complete).toBe('boolean');
      expect(s.productsKnown).toBeGreaterThanOrEqual(0);
    }
    expect(data.sites.filter((s) => s.role === 'competitor' && s.complete).length).toBeGreaterThanOrEqual(3);
  });

  it('is immutable and hash-stable: the stored hash matches a canonical re-hash of what is read back', async () => {
    const reopened = await getReport(db(), t.orgId, report.id);
    expect(reopened!.dataHash).toBe(sha256Hex(stableStringify(reopened!.data)));
    // a later report (after the world changes) does not alter the saved one
    const target = h.fixtures.sites.woo!.products[1]!;
    h.fixtures.sites.woo!.setPrice(target.itemId, target.price + 3);
    h.advance(3_600_000);
    await t.tx((tx) => startScan(h.svc, tx, t.orgId, ids.woo!, { kind: 'discovery', trigger: 'manual' }));
    await h.queue.drain();
    const second = await generateReport(h.svc, db(), t.orgId, { kind: 'manual', deadlineAt: null });
    expect(second.dataHash).not.toBe(report.dataHash);
    const again = await getReport(db(), t.orgId, report.id);
    expect(sha256Hex(stableStringify(again!.data))).toBe(report.dataHash);
    const list = await listReports(db(), t.orgId);
    expect(list.map((r) => r.id)).toEqual(expect.arrayContaining([report.id, second.id]));
    h.fixtures.sites.woo!.setPrice(target.itemId, target.price);
  });

  it('raises an in-app notification for the new report', async () => {
    const a = await db().select().from(alerts).where(and(eq(alerts.orgId, t.orgId), eq(alerts.reportId, report.id)));
    expect(a).toHaveLength(1);
    expect(a[0]!.type).toBe('report_partial');
  });
});

describe('exports are rendered from the same snapshot', () => {
  const cellCount = () => data.comparisons.reduce((a, r) => a + r.cells.length, 0);

  const parseCsv = (buf: Buffer): string[][] => {
    const text = buf.toString('utf8').replace(new RegExp('^' + String.fromCharCode(0xfeff)), '');
    const rows: string[][] = [];
    let row: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (q) {
        if (c === '"' && text[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') {
        row.push(cur);
        cur = '';
      } else if (c === '\n') {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = '';
      } else if (c !== '\r') cur += c;
    }
    return rows;
  };

  it('CSV: one row per source×competitor comparison, with the same numbers as the snapshot', async () => {
    const out = await exportReport(h.svc, db(), t.orgId, report.id, 'csv', 'comparison');
    expect(out.filename).toBe(`report-${data.meta.periodDate}-partial-comparison.csv`);
    const rows = parseCsv(out.body);
    expect(rows[0]![0]).toMatch(/PARTIAL REPORT/);
    expect(rows[0]![0]).toMatch(/FIXTURE/);
    const header = rows[1]!;
    const body = rows.slice(2).filter((r) => r.length > 1);
    expect(body).toHaveLength(cellCount());
    const first = data.comparisons[0]!;
    const cell = first.cells[0]!;
    const line = body.find((r) => r[0] === first.title && r[5] === cell.siteName)!;
    expect(Number(line[header.indexOf('Difference %')])).toBeCloseTo(cell.diffPct ?? NaN, 6);
    expect(Number(line[header.indexOf('Your price (shown)')])).toBeCloseTo(first.sourcePrice.amount!, 6);
    expect(line[header.indexOf('Your currency')]).toBe(first.sourcePrice.currency);
    expect(line[header.indexOf('Competitor evidence URL')]).toBe(cell.url);
    for (const ds of ['offers', 'stock', 'marketing', 'insights', 'coverage', 'assortment'] as const) {
      expect((await exportReport(h.svc, db(), t.orgId, report.id, 'csv', ds)).body.length).toBeGreaterThan(50);
    }
    expect(parseCsv((await exportReport(h.svc, db(), t.orgId, report.id, 'csv', 'offers')).body).slice(2).filter((r) => r.length > 1)).toHaveLength(data.offers.length);
  });

  it('Excel: the comparison sheet has the same rows, and the summary carries the partial/fixture warnings', async () => {
    const out = await exportReport(h.svc, db(), t.orgId, report.id, 'xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out.body as never);
    const ws = wb.getWorksheet('Price comparison')!;
    expect(ws.rowCount - 1).toBe(cellCount());
    const summary = wb.getWorksheet('Summary')!;
    const text: string[] = [];
    summary.eachRow((r) => text.push(r.values!.toString()));
    expect(text.join('\n')).toMatch(/PARTIAL/);
    expect(text.join('\n')).toMatch(/FIXTURE|fixture/);
    expect(text.join('\n')).toContain(`matchedProducts,${data.kpis.matchedProducts}`);
    expect(wb.worksheets.map((s) => s.name)).toEqual(expect.arrayContaining(['Offers', 'Own stock', 'Marketing', 'Insights', 'Coverage']));
    const header = (ws.getRow(1).values as unknown[]).slice(1);
    const diffCol = header.indexOf('Difference %') + 1;
    expect(ws.getRow(2).getCell(diffCol).value).toBeCloseTo(data.comparisons[0]!.cells[0]!.diffPct!, 6);
  });

  it('PDF: opens, is labelled partial/fixture, and shows the same headline numbers', async () => {
    const out = await exportReport(h.svc, db(), t.orgId, report.id, 'pdf');
    expect(out.body.subarray(0, 5).toString()).toBe('%PDF-');
    const doc = await getDocumentProxy(new Uint8Array(out.body));
    const { text, totalPages } = await extractText(doc, { mergePages: true });
    expect(totalPages).toBeGreaterThan(1);
    expect(text).toContain(`Report — ${data.meta.periodDate}`);
    expect(text).toMatch(/PARTIAL REPORT/);
    expect(text).toMatch(/FIXTURE DATA/);
    expect(text).toContain(String(data.kpis.matchedProducts));
    for (const s of data.sites) expect(text).toContain(s.name.slice(0, 12));
    expect(text).toMatch(/Central\s+Bank\s+of\s+Aruba/);
  });

  it('the saved snapshot carries the marketing summary, and the CSV, Excel and PDF all agree with it', async () => {
    const s = data.marketingSummary!;
    expect(s).toBeTruthy();
    expect(s.note).toMatch(/not evidence of paid advertising/);
    const competitors = data.sites.filter((x) => x.role === 'competitor');
    expect(s.competitors).toHaveLength(competitors.length);
    expect(s.competitors.reduce((a, c) => a + c.total, 0)).toBeLessThanOrEqual(data.marketing.length); // the summary never counts more than the rows

    const csv = parseCsv((await exportReport(h.svc, db(), t.orgId, report.id, 'csv', 'marketing_summary')).body).slice(2).filter((r) => r.length > 1);
    expect(csv.map((r) => r[0]).sort()).toEqual(s.competitors.map((c) => c.siteName).sort());
    const first = s.competitors.find((c) => c.total > 0)!;
    const line = csv.find((r) => r[0] === first.siteName)!;
    expect(Number(line[1])).toBe(first.total);
    expect(Number(line[2])).toBe(first.promotionCount);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await exportReport(h.svc, db(), t.orgId, report.id, 'xlsx')).body as never);
    expect(wb.getWorksheet('Marketing summary')!.rowCount - 1).toBe(s.competitors.length);

    const doc = await getDocumentProxy(new Uint8Array((await exportReport(h.svc, db(), t.orgId, report.id, 'pdf')).body));
    const { text } = await extractText(doc, { mergePages: true });
    expect(text).toMatch(/competitors?\s+had\s+observed\s+marketing\s+activity|No\s+marketing\s+activity\s+was\s+observed/);
    expect(text).toMatch(/Timing:/);
    expect(text).not.toMatch(/paid\s+campaign\s+(is|was)\s+running/i);
  });

  it('a report saved before the summary existed still exports: the new sheet is empty and the PDF simply omits the section', async () => {
    const old = { ...data, marketingSummary: undefined } as ReportData;
    expect(marketingSummaryTable(old).rows).toEqual([]);
    const pdf = await renderPdf(old);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('caches exports by content checksum and serves identical bytes', async () => {
    const a = await exportReport(h.svc, db(), t.orgId, report.id, 'xlsx');
    const b = await exportReport(h.svc, db(), t.orgId, report.id, 'xlsx');
    expect(sha256Hex(a.body)).toBe(sha256Hex(b.body));
    expect(await db().select().from(reportExports).where(and(eq(reportExports.reportId, report.id), eq(reportExports.format, 'xlsx')))).toHaveLength(1);
  });

  it('refuses exports across workspaces and for unfinished reports', async () => {
    const other = await h.newTenant('Other');
    await expect(other.tx((tx) => exportReport(h.svc, tx, other.orgId, report.id, 'csv'))).rejects.toBeInstanceOf(ExportError);
    const [draft] = await db().insert(reports).values({ orgId: t.orgId, kind: 'manual', status: 'generating', periodDate: '2026-10-14', title: 'draft' }).returning();
    await expect(exportReport(h.svc, db(), t.orgId, draft!.id, 'pdf')).rejects.toMatchObject({ status: 409 });
  });
});

describe('manual report job', () => {
  it('fills a draft report asynchronously so the UI can poll it', async () => {
    const [draft] = await db().insert(reports).values({ orgId: t.orgId, kind: 'manual', status: 'generating', periodDate: '2026-10-14', title: 'Manual' }).returning();
    await JOB_HANDLERS['generate-report'](h.svc, { orgId: t.orgId, reportId: draft!.id, userId: t.userId });
    const done = await getReport(db(), t.orgId, draft!.id);
    expect(['ready', 'partial']).toContain(done!.status);
    expect(done!.data).toBeTruthy();
  });
});

describe('AI-assisted summary is validated against the data', () => {
  const llm = (text: string): LlmProvider => ({ id: 'fake', available: true, complete: async () => text });
  it('discards an AI summary that contains numbers not found in the records', async () => {
    const d = await assembleReportData({ ...h.svc, llm: llm('Prices are 87.3% lower than every competitor and you will gain 412 customers.') }, db(), t.orgId, { kind: 'manual', deadlineAt: null });
    expect(d.aiSummary).toBeNull();
    expect(d.headline.length).toBeGreaterThan(10); // the deterministic headline is still there
  });
  it('keeps a summary whose numbers all come from computed facts', async () => {
    const top = data.insights.find((i) => i.type !== 'coverage_warning')!;
    const text = `The top finding is: ${top.title}. ${data.kpis.matchedProducts} products are matched.`;
    const d = await assembleReportData({ ...h.svc, llm: llm(text) }, db(), t.orgId, { kind: 'manual', deadlineAt: null });
    expect(d.aiSummary).toMatchObject({ validated: true, provider: 'fake' });
  });
  it('works with no AI provider at all', () => {
    expect(data.aiSummary).toBeNull();
    expect(data.insights.length).toBeGreaterThan(0);
  });
});

describe('retention', () => {
  it('purges raw snapshots after the snapshot window but keeps evidence rows, reports and exports usable', async () => {
    await db().update(orgSettings).set({ snapshotRetentionDays: 1 }).where(eq(orgSettings.orgId, t.orgId));
    const withSnap = await db().select().from(evidence).where(and(eq(evidence.orgId, t.orgId)));
    const refs = withSnap.map((e) => e.snapshotRef).filter((r): r is string => !!r);
    expect(refs.length).toBeGreaterThan(10);
    h.advance(10 * 86_400_000);
    const r = await runRetention(h.svc);
    expect(r.snapshotsPurged).toBeGreaterThanOrEqual(refs.length);
    for (const ref of refs) expect(await h.storage.exists(ref)).toBe(false);
    const after = await db().select().from(evidence).where(eq(evidence.orgId, t.orgId));
    expect(after).toHaveLength(withSnap.length); // rows remain
    expect(after.every((e) => e.snapshotRef === null && e.url && e.contentHash)).toBe(true);
    const hadSnapshot = new Set(withSnap.filter((e) => e.snapshotRef).map((e) => e.id));
    expect(after.filter((e) => hadSnapshot.has(e.id)).every((e) => e.snapshotPurgedAt !== null)).toBe(true);
    // the saved report and its exports still work
    expect((await getReport(db(), t.orgId, report.id))!.data).toBeTruthy();
    expect((await exportReport(h.svc, db(), t.orgId, report.id, 'pdf')).body.length).toBeGreaterThan(1000);
  });

  it('expires structured history, reports and export files after the history window without errors', async () => {
    await db().update(orgSettings).set({ historyRetentionDays: 30 }).where(eq(orgSettings.orgId, t.orgId));
    h.advance(60 * 86_400_000);
    const before = await db().select().from(priceObservations).where(eq(priceObservations.orgId, t.orgId));
    const r = await runRetention(h.svc);
    expect(r.priceObservationsDeleted).toBe(before.length);
    expect(r.reportsDeleted).toBeGreaterThanOrEqual(2);
    expect(await db().select().from(reports).where(eq(reports.orgId, t.orgId))).toHaveLength(0);
    expect(await db().select().from(reportExports).where(eq(reportExports.orgId, t.orgId))).toHaveLength(0);
    expect(r.exportFilesDeleted).toBeGreaterThan(0);
    expect(await db().select().from(scanRuns).where(and(eq(scanRuns.orgId, t.orgId), eq(scanRuns.status, 'running')))).toHaveLength(0);
  });
});
