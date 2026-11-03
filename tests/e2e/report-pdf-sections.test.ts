import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { extractText, getDocumentProxy } from 'unpdf';
import { reportExports, reports } from '@ci/database';
import { sha256Hex, stableStringify } from '@ci/core';
import { CSV_DATASETS, csvDatasetLabel, type CsvDataset, type ReportData } from '@ci/shared';
import { createOrganization, generateReport, pdfText, renderPdf, runMatching, startScan, tableFor } from '@ci/services';
import { buildApp } from '../../apps/api/src/app.ts';
import { createHarness, type Harness } from '../support/harness.ts';
import { ApiClient } from '../support/api-client.ts';
import { signUp } from '../support/auth.ts';
import { confirmSuggestions } from '../support/confirm.ts';

/**
 * The PDF follows the report selected in the Reports dropdown. Each of the eight selections is asked for through the real endpoint and its PDF is read back: its title, its data, and the
 * proof that none of the other seven reports (nor the whole report) took its place. Everything is rendered from the saved snapshot, whatever happens to the live data afterwards.
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

/** The heading each report starts with in its PDF, and the words of the others that must NOT be there. */
const HEADING: Record<CsvDataset, string> = {
  comparison: 'Price comparison',
  offers: 'Offers and promotions',
  stock: 'Your stock',
  marketing: 'Marketing activity (observed)',
  marketing_summary: 'Marketing summary',
  insights: 'Insights and findings',
  coverage: 'Data coverage and freshness',
  assortment: 'Assortment gaps',
};
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const textOf = async (pdf: Buffer | Uint8Array) => norm((await extractText(await getDocumentProxy(new Uint8Array(pdf)), { mergePages: true })).text);
const pdfUrl = (ds?: string) => `${base()}/reports/${reportId}/export?format=pdf${ds ? `&dataset=${ds}` : ''}`;
const fetchPdf = async (ds?: string) => {
  const res = await owner.get(pdfUrl(ds));
  expect(res.status, ds ?? 'whole').toBe(200);
  expect(res.headers['content-type']).toBe('application/pdf');
  return { res, text: await textOf(res.raw) };
};
const unique = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x).map((x) => norm(pdfText(x)).slice(0, 18)))];

/** What the snapshot says the selected report holds: its own rows, as the PDF must show them. */
function expectedInPdf(ds: CsvDataset): string[] {
  switch (ds) {
    case 'comparison': return [String(data.kpis.matchedProducts), ...unique(data.comparisons.map((r) => r.title))];
    case 'offers': return unique(data.offers.map((o) => o.title));
    case 'stock': return unique(data.stock.map((s) => s.title));
    case 'marketing': return unique(data.marketing.map((m) => m.title));
    case 'marketing_summary': return [...unique(data.marketingSummary!.competitors.filter((c) => c.total > 0).map((c) => c.siteName)), 'Timing:'];
    case 'insights': return unique(data.insights.map((i) => i.title));
    case 'coverage': return unique(data.sites.map((s) => s.name));
    case 'assortment': return [`At competitors, no equivalent at your shop (${data.assortment.competitorOnly.length})`, `At your shop, no equivalent at competitors (${data.assortment.sourceOnly.length})`, ...unique([...data.assortment.competitorOnly, ...data.assortment.sourceOnly].map((a) => a.title))];
  }
}

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ svc: { ...h.svc, db: h.db.app }, rootDb: h.db.app, logger: false, authRateLimitMax: 1000 });
  owner = new ApiClient(app);
  await signUp(owner, h, { email: `rp-${Date.now()}@example.test`, password: 'Correct-Horse-9-Battery', displayName: 'Owner' });
  const userId = (await owner.get('/api/v1/auth/me')).body.user.id as string;
  org = (await createOrganization(h.db.app, userId, 'Report PDFs')).id;
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

describe('the snapshot the PDFs are made from', () => {
  it('holds something in every one of the eight reports, so each PDF can be checked against real rows', () => {
    expect(data.comparisons.length).toBeGreaterThan(0);
    expect(data.offers.length).toBeGreaterThan(0);
    expect(data.stock.length).toBeGreaterThan(0);
    expect(data.marketing.length).toBeGreaterThan(0);
    expect(data.marketingSummary!.competitors.some((c) => c.total > 0)).toBe(true);
    expect(data.insights.length).toBeGreaterThan(0);
    expect(data.sites.length).toBeGreaterThan(0);
    expect(data.assortment.competitorOnly.length + data.assortment.sourceOnly.length).toBeGreaterThan(0);
  });
});

describe('each selection of the dropdown gives its own PDF', () => {
  it('every one of the eight: its title, its heading, its own data, and none of the other seven reports', async () => {
    for (const ds of CSV_DATASETS) {
      const { res, text } = await fetchPdf(ds);
      const label = csvDatasetLabel(ds);
      // it says what it is: the name of the selection and the date of the saved snapshot
      expect(text, ds).toContain(`${label} — ${data.meta.periodDate}`);
      expect(text, ds).toContain(`Report type: ${label}`);
      expect(text, ds).toContain(`saved snapshot prepared`);
      expect(String(res.headers['content-disposition']), ds).toBe(`attachment; filename="report-${data.meta.periodDate}-partial-${ds}.pdf"`);
      // it holds its own report
      expect(text, ds).toContain(HEADING[ds]);
      for (const needle of expectedInPdf(ds)) expect(text, `${ds}: ${needle}`).toContain(needle);
      // and not the others
      for (const other of CSV_DATASETS.filter((x) => x !== ds)) expect(text, `${ds} must not hold the ${other} report`).not.toContain(HEADING[other]);
      expect(text, ds).not.toContain('Key figures');
      expect(text, ds).not.toContain('Exchange rates used');
    }
  });

  it('every page is a page of the report: its footer is on it, and no page holds only a footer', async () => {
    for (const ds of [undefined, ...CSV_DATASETS]) {
      const res = await owner.get(pdfUrl(ds));
      const pages = (await extractText(await getDocumentProxy(new Uint8Array(res.raw)), { mergePages: false })).text.map(norm);
      pages.forEach((page, i) => {
        expect(page, `${ds ?? 'whole'} page ${i + 1}`).toContain(`page ${i + 1} of ${pages.length}`);
        expect(page.replace(/(\w+ report · )?Snapshot [0-9a-f]{12} · page \d+ of \d+/, '').length, `${ds ?? 'whole'} page ${i + 1} holds more than its footer`).toBeGreaterThan(60);
      });
    }
  });

  it('a partial snapshot says so in every one of them', async () => {
    expect(data.meta.isPartial).toBe(true);
    for (const ds of CSV_DATASETS) expect((await fetchPdf(ds)).text, ds).toContain('PARTIAL REPORT');
  });

  it('the eight PDFs are eight different documents, and none of them is the whole report', async () => {
    const texts = new Map<string, CsvDataset | 'whole'>();
    const whole = await fetchPdf();
    texts.set(sha256Hex(whole.text), 'whole');
    for (const ds of CSV_DATASETS) {
      const { text } = await fetchPdf(ds);
      const key = sha256Hex(text.replace(/Snapshot [0-9a-f]{12}/, ''));
      expect(texts.get(key), `${ds} has the same content as ${texts.get(key)}`).toBeUndefined();
      texts.set(key, ds);
    }
    expect(texts.size).toBe(CSV_DATASETS.length + 1);
  });

  it('without a selection the PDF is still the whole report: every section, one document', async () => {
    const { res, text } = await fetchPdf();
    expect(String(res.headers['content-disposition'])).toBe(`attachment; filename="report-${data.meta.periodDate}-partial.pdf"`);
    expect(text).toContain(`Report — ${data.meta.periodDate}`);
    for (const heading of ['Key figures', 'Top findings', 'Price comparison', 'Offers and promotions', 'Your stock', 'Marketing activity (observed)', 'Data coverage and freshness', 'Exchange rates used']) expect(text, heading).toContain(heading);
    expect(text).not.toContain('Report type:');
  });
});

describe('the selection is respected every time', () => {
  const order = ['coverage', 'comparison', 'stock', 'marketing_summary', 'offers', 'assortment', 'insights', 'marketing', 'comparison', 'coverage', 'stock'] as const;

  it('exports in any order, one after another, each is the report asked for (nothing kept from the one before)', async () => {
    for (const ds of order) {
      const { text } = await fetchPdf(ds);
      expect(text, ds).toContain(`Report type: ${csvDatasetLabel(ds)}`);
      expect(text, ds).toContain(HEADING[ds]);
      for (const other of CSV_DATASETS.filter((x) => x !== ds)) expect(text, `${ds} after another one: ${other}`).not.toContain(HEADING[other]);
    }
  });

  it('exports asked for all at once (a person changing the selection and clicking quickly) never answer one request with another’s file', async () => {
    const asked = [...CSV_DATASETS, ...[...CSV_DATASETS].reverse(), ...CSV_DATASETS];
    const answers = await Promise.all(asked.map(async (ds) => ({ ds, ...(await fetchPdf(ds)) })));
    for (const a of answers) {
      expect(a.text, a.ds).toContain(`Report type: ${csvDatasetLabel(a.ds)}`);
      expect(a.text, a.ds).toContain(HEADING[a.ds]);
      expect(a.res.headers['content-disposition'], a.ds).toContain(`-${a.ds}.pdf`);
    }
    // the same selection always gives the same file
    for (const ds of CSV_DATASETS) {
      const mine = answers.filter((a) => a.ds === ds);
      expect(new Set(mine.map((a) => sha256Hex(a.res.raw))).size, ds).toBe(1);
    }
  });

  it('each report is saved under its own key: asking again is served from its own saved copy', async () => {
    const saved = await db().select().from(reportExports).where(eq(reportExports.reportId, reportId));
    const pdfs = saved.filter((r) => r.format === 'pdf').map((r) => r.dataset).sort();
    expect(pdfs).toEqual([...CSV_DATASETS, 'all'].sort());
    expect(new Set(saved.filter((r) => r.format === 'pdf').map((r) => r.storageKey)).size).toBe(CSV_DATASETS.length + 1);
  });
});

describe('the saved snapshot is never touched', () => {
  it('exporting changes no snapshot, creates no new one and keeps its date', async () => {
    const before = await db().select().from(reports).where(eq(reports.orgId, org));
    for (const ds of CSV_DATASETS) await fetchPdf(ds);
    const after = await db().select().from(reports).where(eq(reports.orgId, org));
    expect(after).toHaveLength(before.length);
    const row = after.find((r) => r.id === reportId)!;
    expect(row.dataHash).toBe(dataHash);
    expect(sha256Hex(stableStringify(row.data))).toBe(dataHash);
    expect((row.data as ReportData).meta.generatedAt).toBe(data.meta.generatedAt);
    expect((row.data as ReportData).meta.periodDate).toBe(data.meta.periodDate);
  });

  it('live data that changes afterwards never reaches a PDF: they are rendered again from the snapshot and come out the same', async () => {
    const earlier = new Map<CsvDataset, string>();
    for (const ds of CSV_DATASETS) earlier.set(ds, (await fetchPdf(ds)).text);
    // the world moves on: a price changes and the site is collected again, and the saved copies of the PDFs are thrown away so each is made again
    const target = h.fixtures.sites.woo!.products[1]!;
    h.fixtures.sites.woo!.setPrice(target.itemId, target.price + 5);
    h.advance(3_600_000);
    const sites = (await owner.get(`${base()}/sites`)).body.sites as { id: string; role: string }[];
    for (const s of sites) await startScan(h.svc, db(), org, s.id, { kind: 'discovery', trigger: 'manual' });
    await h.queue.drain();
    await db().delete(reportExports).where(eq(reportExports.reportId, reportId));
    for (const ds of CSV_DATASETS) {
      const now = (await fetchPdf(ds)).text;
      expect(now, ds).toBe(earlier.get(ds));
    }
    h.fixtures.sites.woo!.setPrice(target.itemId, target.price);
    expect((await db().select().from(reports).where(eq(reports.id, reportId)))[0]!.dataHash).toBe(dataHash);
  });
});

describe('Excel and CSV', () => {
  it('Excel is the whole workbook whatever is selected (every report is a sheet in it)', async () => {
    const a = await owner.get(`${base()}/reports/${reportId}/export?format=xlsx`);
    const b = await owner.get(`${base()}/reports/${reportId}/export?format=xlsx&dataset=stock`);
    const c = await owner.get(`${base()}/reports/${reportId}/export?format=xlsx&dataset=coverage`);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(sha256Hex(a.raw)).toBe(sha256Hex(b.raw));
    expect(sha256Hex(a.raw)).toBe(sha256Hex(c.raw));
    expect(String(a.headers['content-disposition'])).toBe(`attachment; filename="report-${data.meta.periodDate}-partial.xlsx"`);
  });

  it('CSV is the selected table: its own heading line, columns and rows, never another table’s', async () => {
    for (const ds of CSV_DATASETS) {
      const res = await owner.get(`${base()}/reports/${reportId}/export?format=csv&dataset=${ds}`);
      expect(res.status, ds).toBe(200);
      const t = tableFor(data, ds);
      const text = res.raw.toString('utf8');
      expect(text, ds).toContain(` — ${t.name} — period ${data.meta.periodDate}`);
      expect(text.split(/\r?\n/)[1], ds).toBe(t.columns.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','));
      expect(String(res.headers['content-disposition']), ds).toContain(`-${ds}.csv`);
    }
    // no table named: the price comparison, as before
    const none = await owner.get(`${base()}/reports/${reportId}/export?format=csv`);
    expect(none.raw.toString('utf8')).toContain(' — Price comparison — ');
  });
});

describe('a report with nothing in it, and answers that are not a file', () => {
  const emptied = (): ReportData => ({ ...data, comparisons: [], offers: [], stock: [], marketing: [], marketingSummary: null, insights: [], sites: [], assortment: { ...data.assortment, competitorOnly: [], sourceOnly: [] } });
  const message: Record<CsvDataset, string> = {
    comparison: 'No price comparison rows are in this saved report',
    offers: 'No offers or promotions were observed in this saved report.',
    stock: 'No low-stock, out-of-stock or unknown-availability items were found.',
    marketing: 'No marketing activity was observed.',
    marketing_summary: 'This saved report has no marketing summary',
    insights: 'No findings were produced for this saved report.',
    coverage: 'No websites are in this saved report.',
    assortment: 'None found.',
  };

  it('every report says so plainly instead of showing another one', async () => {
    for (const ds of CSV_DATASETS) {
      const text = await textOf(await renderPdf(emptied(), ds));
      expect(text, ds).toContain(`${csvDatasetLabel(ds)} — ${data.meta.periodDate}`);
      expect(text, ds).toContain(HEADING[ds]);
      expect(text, ds).toContain(message[ds]);
      for (const other of CSV_DATASETS.filter((x) => x !== ds)) expect(text, `${ds} (empty): ${other}`).not.toContain(HEADING[other]);
    }
  });

  it('a marketing summary with no activity at all says that, not that there is no summary', async () => {
    const quiet: ReportData = { ...data, marketingSummary: { ...data.marketingSummary!, competitors: data.marketingSummary!.competitors.map((c) => ({ ...c, total: 0, promotionCount: 0 })) } };
    expect(await textOf(await renderPdf(quiet, 'marketing_summary'))).toContain('No marketing activity was observed for any competitor.');
  });

  it('a very long report is held whole up to a limit, then says how many rows are left', async () => {
    const big: ReportData = { ...data, offers: Array.from({ length: 1100 }, (_, i) => ({ ...data.offers[0]!, id: `o${i}`, title: `Offer number ${i}` })) };
    const started = Date.now();
    const text = await textOf(await renderPdf(big, 'offers'));
    expect(text).toContain('Offer number 999');
    expect(text).not.toContain('Offer number 1000 ');
    expect(text).toMatch(/100 more row\(s\) in the CSV\/Excel export/);
    expect(Date.now() - started).toBeLessThan(60_000);
  });

  it('refuses a report that does not exist, one that is not offered, and says why', async () => {
    expect((await owner.get(`${base()}/reports/00000000-0000-4000-8000-000000000000/export?format=pdf&dataset=stock`)).status).toBe(404);
    const bad = await owner.get(pdfUrl('everything'));
    expect(bad.status).toBe(400);
    expect(bad.headers['content-type']).not.toBe('application/pdf');
    expect((await owner.get(`${base()}/reports/${reportId}/export?format=docx`)).status).toBe(400);
  });
});
