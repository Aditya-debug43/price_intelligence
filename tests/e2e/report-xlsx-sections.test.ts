import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { eq } from 'drizzle-orm';
import { reportExports, reports } from '@ci/database';
import { sha256Hex, stableStringify } from '@ci/core';
import { CSV_DATASETS, csvDatasetLabel, type CsvDataset, type ReportData } from '@ci/shared';
import { createOrganization, generateReport, renderXlsx, reportSheets, runMatching, startScan } from '@ci/services';
import { buildApp } from '../../apps/api/src/app.ts';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp } from '../support/auth.ts';
import { confirmSuggestions } from '../support/confirm.ts';

/**
 * The Excel file follows the report selected in the Reports dropdown. Each of the eight is asked for through the real endpoint, the workbook is opened, and every worksheet is compared with
 * the saved snapshot: its sheets are that report's tables and no other report's, and the cells are the snapshot's own rows, with real dates and numbers. It is never the whole workbook.
 */
let h: Harness;
let app: FastifyInstance;
let owner: ApiClient;
let org: string;
let reportId: string;
let data: ReportData;
let dataHash: string;
const db = () => h.db.worker;
const base = () => `/api/v1/orgs/${org}`;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const open = async (buf: Buffer | Uint8Array) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  return wb;
};
const url = (ds?: string) => `${base()}/reports/${reportId}/export?format=xlsx${ds ? `&dataset=${ds}` : ''}`;
const fetchXlsx = async (ds?: string) => {
  const res = await owner.get(url(ds));
  expect(res.status, ds ?? 'whole').toBe(200);
  expect(res.headers['content-type']).toBe(XLSX);
  return { res, wb: await open(res.raw) };
};
const names = (wb: ExcelJS.Workbook) => wb.worksheets.map((w) => w.name);
const ownSheets = (ds: CsvDataset) => reportSheets(data, ds).map((s) => s.table.name);
const othersSheets = (ds: CsvDataset) => CSV_DATASETS.filter((x) => x !== ds).flatMap((x) => ownSheets(x)).filter((n) => !ownSheets(ds).includes(n));
const cellText = (v: ExcelJS.CellValue): unknown => (v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);

/** One worksheet, against the table it must hold: first row the snapshot's label, second the columns, then every row. */
function expectSheet(ws: ExcelJS.Worksheet, t: { name: string; columns: string[]; rows: (string | number | boolean | null)[][] }, empty: string, where: string) {
  expect(String(ws.getRow(1).getCell(1).value), `${where}: first row`).toBe(`${data.meta.orgName} — ${t.name} — period ${data.meta.periodDate} — generated ${data.meta.generatedAt}${data.meta.isPartial ? ' — PARTIAL REPORT' : ''}`);
  expect((ws.getRow(2).values as unknown[]).slice(1), `${where}: columns`).toEqual(t.columns);
  if (!t.rows.length) {
    expect(ws.rowCount, `${where}: an empty table says so`).toBe(empty ? 3 : 2);
    if (empty) expect(String(ws.getRow(3).getCell(1).value), where).toBe(empty);
    return;
  }
  expect(ws.rowCount, `${where}: rows`).toBe(t.rows.length + 2);
  t.rows.forEach((row, i) => {
    row.forEach((expected, c) => {
      const actual = ws.getRow(i + 3).getCell(c + 1).value;
      const at = `${where} r${i + 3}c${c + 1} (${t.columns[c]})`;
      if (expected === null || expected === undefined || expected === '') expect(actual === null || actual === '' || actual === undefined, at).toBe(true);
      else if (typeof expected === 'string' && ISO.test(expected)) expect(actual instanceof Date && actual.getTime() === new Date(expected).getTime(), `${at}: ${String(actual)} is not ${expected}`).toBe(true);
      else if (typeof expected === 'number') expect(Number(actual), at).toBeCloseTo(expected, 6);
      else if (typeof expected === 'string' && expected.length > 32_000) expect(String(actual).length, at).toBe(32_000);
      else expect(cellText(actual), at).toBe(expected);
    });
  });
}

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
  await signUp(owner, h, { email: `rx-${Date.now()}@example.test`, password: 'Correct-Horse-9-Battery', displayName: 'Owner' });
  const userId = (await owner.get('/api/v1/auth/me')).body.user.id as string;
  org = (await createOrganization(h.db.app, userId, 'Report workbooks')).id;
  const ids: string[] = [];
  for (const [key, role] of [['source', 'source'], ['woo', 'competitor'], ['jsonld', 'competitor'], ['html', 'competitor'], ['blocked', 'competitor']] as const) {
    const id = (await owner.post(`${base()}/sites`, { url: h.fixtures.origin(key), role, name: h.fixtures.sites[key]!.spec.label })).body.site.id as string;
    await owner.post(`${base()}/sites/${id}/consent`, { status: 'confirmed', attest: true });
    ids.push(id);
  }
  for (const id of ids) await startScan(h.svc, db(), org, id, { kind: 'discovery', trigger: 'manual' });
  await h.queue.drain();
  await runMatching(h.svc, db(), org);
  await confirmSuggestions(db(), org);
  const report = await generateReport(h.svc, db(), org, { kind: 'manual', deadlineAt: null, createdBy: userId });
  reportId = report.id;
  data = report.data as ReportData;
  dataHash = report.dataHash!;
}, 180_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('each selection of the dropdown gives its own Excel file', () => {
  it('every one of the eight: its own worksheets, each equal to the snapshot, and nothing of any other report', async () => {
    for (const ds of CSV_DATASETS) {
      const { res, wb } = await fetchXlsx(ds);
      expect(String(res.headers['content-disposition']), ds).toBe(`attachment; filename="report-${data.meta.periodDate}-partial-${ds}.xlsx"`);
      // its worksheets, in order, and only those
      expect(names(wb), ds).toEqual(ownSheets(ds));
      expect(names(wb), ds).not.toContain('Summary');
      for (const other of othersSheets(ds)) expect(names(wb), `${ds} must not hold the "${other}" sheet`).not.toContain(other);
      // and what is in them is the snapshot
      for (const s of reportSheets(data, ds)) expectSheet(wb.getWorksheet(s.table.name)!, s.table, s.empty, `${ds}/${s.table.name}`);
      // the file says which report it is
      expect(wb.title, ds).toBe(`${csvDatasetLabel(ds)} — ${data.meta.periodDate}`);
    }
  });

  it('the comparison is the price comparison and its exchange rates; coverage has its data notes; assortment its basis', async () => {
    expect(ownSheets('comparison')).toEqual(['Price comparison', 'Exchange rates']);
    expect(ownSheets('coverage')).toEqual(['Coverage', 'Data notes']);
    expect(ownSheets('assortment')).toEqual(['Assortment gaps', 'Assortment basis']);
    for (const ds of ['offers', 'stock', 'marketing', 'marketing_summary', 'insights'] as const) expect(ownSheets(ds), ds).toHaveLength(1);
    const cmp = (await fetchXlsx('comparison')).wb;
    expect(cmp.getWorksheet('Price comparison')!.rowCount - 2).toBe(data.comparisons.reduce((a, r) => a + r.cells.length, 0));
    expect(cmp.getWorksheet('Exchange rates')!.rowCount - 2).toBe(data.fx.length);
    const cov = (await fetchXlsx('coverage')).wb;
    expect(cov.getWorksheet('Coverage')!.rowCount - 2).toBe(data.sites.length);
    expect(cov.getWorksheet('Data notes')!.rowCount - 2).toBe(data.warnings.length);
    const asr = (await fetchXlsx('assortment')).wb;
    expect(asr.getWorksheet('Assortment gaps')!.rowCount - 2).toBe(data.assortment.competitorOnly.length + data.assortment.sourceOnly.length);
  });

  it('a partial snapshot says so on every worksheet of every one of them', async () => {
    expect(data.meta.isPartial).toBe(true);
    for (const ds of CSV_DATASETS) {
      const { wb } = await fetchXlsx(ds);
      for (const ws of wb.worksheets) expect(String(ws.getRow(1).getCell(1).value), `${ds}/${ws.name}`).toContain('PARTIAL REPORT');
    }
  });

  it('the eight are eight different workbooks, none of them the whole workbook with another name', async () => {
    const whole = await fetchXlsx();
    expect(names(whole.wb)).toEqual(expect.arrayContaining(['Summary', ...CSV_DATASETS.flatMap((d) => reportSheets(data, d).map((s) => s.table.name)).filter((n) => ['Price comparison', 'Offers', 'Own stock', 'Marketing', 'Marketing summary', 'Insights', 'Coverage', 'Assortment gaps'].includes(n))]));
    const seen = new Map<string, string>();
    for (const ds of CSV_DATASETS) {
      const { wb } = await fetchXlsx(ds);
      expect(wb.worksheets.length, ds).toBeLessThan(whole.wb.worksheets.length);
      const key = JSON.stringify(wb.worksheets.map((w) => [w.name, w.rowCount, w.actualColumnCount]));
      expect(seen.get(key), `${ds} has the same sheets as ${seen.get(key)}`).toBeUndefined();
      seen.set(key, ds);
    }
    expect(seen.size).toBe(CSV_DATASETS.length);
  });

  it('without a selection the Excel file is still the whole workbook (what the list of reports downloads)', async () => {
    const { res, wb } = await fetchXlsx();
    expect(String(res.headers['content-disposition'])).toBe(`attachment; filename="report-${data.meta.periodDate}-partial.xlsx"`);
    expect(names(wb)[0]).toBe('Summary');
    for (const t of ['Price comparison', 'Offers', 'Own stock', 'Marketing', 'Marketing summary', 'Insights', 'Coverage', 'Assortment gaps']) expect(names(wb), t).toContain(t);
    // its tables keep their columns in the first row, as before
    expect((wb.getWorksheet('Offers')!.getRow(1).values as unknown[]).slice(1)).toEqual(reportSheets(data, 'offers')[0]!.table.columns);
  });
});

describe('the cells are usable in Excel', () => {
  it('dates and times are real dates, prices and percentages are numbers with their format, the header is frozen and filterable', async () => {
    const wb = (await fetchXlsx('comparison')).wb;
    const ws = wb.getWorksheet('Price comparison')!;
    const header = (ws.getRow(2).values as unknown[]).slice(1) as string[];
    const first = ws.getRow(3);
    const observed = first.getCell(header.indexOf('Your price observed') + 1);
    expect(observed.value).toBeInstanceOf(Date);
    expect(observed.numFmt).toBe('yyyy-mm-dd hh:mm');
    const price = first.getCell(header.indexOf('Your price (shown)') + 1);
    expect(typeof price.value).toBe('number');
    expect(price.numFmt).toBe('#,##0.00');
    expect(first.getCell(header.indexOf('Difference %') + 1).numFmt).toBe('0.00');
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 2 });
    expect(ws.autoFilter).toBeTruthy();
    const fx = wb.getWorksheet('Exchange rates')!;
    expect(typeof fx.getRow(3).getCell(3).value).toBe('number');
    expect(fx.getRow(3).getCell(3).numFmt).toBe('0.0000');
    expect(fx.getRow(3).getCell(6).value).toBeInstanceOf(Date);
    // the offers: claimed discounts are numbers, first / last seen are dates
    const offers = (await fetchXlsx('offers')).wb.getWorksheet('Offers')!;
    const oh = (offers.getRow(2).values as unknown[]).slice(1) as string[];
    expect(offers.getRow(3).getCell(oh.indexOf('First seen') + 1).value).toBeInstanceOf(Date);
  });

  it('nothing is stored as a formula, whatever a competitor’s page said', async () => {
    const hostile: ReportData = {
      ...data,
      comparisons: data.comparisons.map((r, i) => (i === 0 ? { ...r, title: '=HYPERLINK("http://x.test","click")' } : r)),
      offers: data.offers.map((o, i) => (i === 0 ? { ...o, title: '+cmd|calc' } : o)),
      insights: data.insights.map((x, i) => (i === 0 ? { ...x, summary: '@SUM(1+1)' } : x)),
    };
    for (const ds of CSV_DATASETS) {
      const wb = await open(await renderXlsx(hostile, ds));
      for (const ws of wb.worksheets) ws.eachRow((row) => row.eachCell((cell) => expect(cell.type, `${ds}/${ws.name}!${cell.address}`).not.toBe(ExcelJS.ValueType.Formula)));
    }
    const c = (await open(await renderXlsx(hostile, 'comparison'))).getWorksheet('Price comparison')!;
    expect(c.getRow(3).getCell(1).value).toBe('=HYPERLINK("http://x.test","click")');
  });
});

describe('the selection is respected every time', () => {
  const order = ['coverage', 'comparison', 'stock', 'marketing_summary', 'offers', 'assortment', 'insights', 'marketing', 'comparison', 'coverage', 'stock'] as const;

  it('exports in any order, one after another, each is the report asked for', async () => {
    for (const ds of order) expect(names((await fetchXlsx(ds)).wb), ds).toEqual(ownSheets(ds));
  });

  it('exports asked for all at once never answer one request with another’s file', async () => {
    const asked = [...CSV_DATASETS, ...[...CSV_DATASETS].reverse(), ...CSV_DATASETS];
    const answers = await Promise.all(asked.map(async (ds) => ({ ds, ...(await fetchXlsx(ds)) })));
    for (const a of answers) {
      expect(names(a.wb), a.ds).toEqual(ownSheets(a.ds));
      expect(a.res.headers['content-disposition'], a.ds).toContain(`-${a.ds}.xlsx`);
    }
  });

  it('each report is saved under its own key, apart from the whole workbook', async () => {
    await fetchXlsx();
    const saved = (await db().select().from(reportExports).where(eq(reportExports.reportId, reportId))).filter((r) => r.format === 'xlsx');
    expect(saved.map((r) => r.dataset).sort()).toEqual([...CSV_DATASETS, 'all'].sort());
    expect(new Set(saved.map((r) => r.storageKey)).size).toBe(CSV_DATASETS.length + 1);
  });
});

describe('the saved snapshot is never touched', () => {
  const content = async (ds: CsvDataset) => JSON.stringify((await fetchXlsx(ds)).wb.worksheets.map((w) => { const rows: unknown[] = []; w.eachRow((r) => rows.push(r.values)); return [w.name, rows]; }));

  it('exporting changes no snapshot, creates none, keeps its date', async () => {
    const before = await db().select().from(reports).where(eq(reports.orgId, org));
    for (const ds of CSV_DATASETS) await fetchXlsx(ds);
    const after = await db().select().from(reports).where(eq(reports.orgId, org));
    expect(after).toHaveLength(before.length);
    const row = after.find((r) => r.id === reportId)!;
    expect(row.dataHash).toBe(dataHash);
    expect(sha256Hex(stableStringify(row.data))).toBe(dataHash);
    expect((row.data as ReportData).meta.generatedAt).toBe(data.meta.generatedAt);
  });

  it('live data that changes afterwards never reaches a workbook: made again from the snapshot they come out the same', async () => {
    const earlier = new Map<CsvDataset, string>();
    for (const ds of CSV_DATASETS) earlier.set(ds, await content(ds));
    const target = h.fixtures.sites.woo!.products[1]!;
    h.fixtures.sites.woo!.setPrice(target.itemId, target.price + 5);
    h.advance(3_600_000);
    const sites = (await owner.get(`${base()}/sites`)).body.sites as { id: string }[];
    for (const s of sites) await startScan(h.svc, db(), org, s.id, { kind: 'discovery', trigger: 'manual' });
    await h.queue.drain();
    await db().delete(reportExports).where(eq(reportExports.reportId, reportId));
    for (const ds of CSV_DATASETS) expect(await content(ds), ds).toBe(earlier.get(ds));
    h.fixtures.sites.woo!.setPrice(target.itemId, target.price);
    expect((await db().select().from(reports).where(eq(reports.id, reportId)))[0]!.dataHash).toBe(dataHash);
  });
});

describe('a report with nothing in it', () => {
  const emptied = (): ReportData => ({ ...data, comparisons: [], fx: [], offers: [], stock: [], marketing: [], marketingSummary: null, insights: [], sites: [], warnings: [], assortment: { ...data.assortment, competitorOnly: [], sourceOnly: [] } });
  const message: Record<CsvDataset, string[]> = {
    comparison: ['No price comparison rows are in this saved report.', 'All prices were in the reporting currency.'],
    offers: ['No offers or promotions were observed in this saved report.'],
    stock: ['No low-stock, out-of-stock or unknown-availability items were found.'],
    marketing: ['No marketing activity was observed.'],
    marketing_summary: ['This saved report has no marketing summary: it was saved before summaries were added.'],
    insights: ['No findings were produced for this saved report.'],
    coverage: ['No websites are in this saved report.', 'There are no data notes for this saved report.'],
    assortment: ['No assortment gaps were found in this saved report.'],
  };

  it('every report keeps its worksheets and column names and says plainly that it is empty, instead of holding another report', async () => {
    const e = emptied();
    for (const ds of CSV_DATASETS) {
      const wb = await open(await renderXlsx(e, ds));
      expect(names(wb), ds).toEqual(reportSheets(e, ds).map((s) => s.table.name));
      reportSheets(e, ds).forEach((s, i) => {
        const ws = wb.worksheets[i]!;
        expect((ws.getRow(2).values as unknown[]).slice(1), `${ds}/${ws.name}`).toEqual(s.table.columns);
        if (s.table.rows.length === 0 && s.empty) expect(String(ws.getRow(3).getCell(1).value), `${ds}/${ws.name}`).toBe(message[ds]![i]);
      });
    }
  });

  it('the assortment basis is present even when there are no gaps', async () => {
    const wb = await open(await renderXlsx(emptied(), 'assortment'));
    expect(String(wb.getWorksheet('Assortment basis')!.getRow(3).getCell(1).value)).toBe('Note');
    expect(String(wb.getWorksheet('Assortment basis')!.getRow(3).getCell(2).value)).toBe(data.assortment.note);
  });

  it('a snapshot saved before marketing summaries existed exports that report with a message', async () => {
    const old = { ...data, marketingSummary: undefined } as ReportData;
    const wb = await open(await renderXlsx(old, 'marketing_summary'));
    expect(String(wb.getWorksheet('Marketing summary')!.getRow(3).getCell(1).value)).toMatch(/no marketing summary/);
  });

  it('a very long report is written whole', async () => {
    const big: ReportData = { ...data, offers: Array.from({ length: 3000 }, (_, i) => ({ ...data.offers[0]!, id: `o${i}`, title: `Offer number ${i}` })) };
    const ws = (await open(await renderXlsx(big, 'offers'))).getWorksheet('Offers')!;
    expect(ws.rowCount).toBe(3002);
    expect(String(ws.getRow(3002).getCell(4).value)).toBe('Offer number 2999');
  });
});

describe('answers that are not a file', () => {
  it('a selection that is not offered is refused, and so is a report that does not exist', async () => {
    const bad = await owner.get(url('everything'));
    expect(bad.status).toBe(400);
    expect(bad.headers['content-type']).not.toBe(XLSX);
    expect((await owner.get(`${base()}/reports/00000000-0000-4000-8000-000000000000/export?format=xlsx&dataset=stock`)).status).toBe(404);
  });
});
