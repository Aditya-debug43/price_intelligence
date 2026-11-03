import { describe, expect, it } from 'vitest';
import { CSV_DATASETS, csvDatasetLabel } from '@ci/shared';
import { CSV_TABLE_OF_TAB, REPORT_TABS, csvTableFor, csvTableLabel, exportUrl, reportTabFrom } from '../../apps/web/src/report-sections.ts';

describe('the sections of a saved report', () => {
  it('opens the section named in the address, and the first one for anything else', () => {
    for (const t of REPORT_TABS) expect(reportTabFrom(t)).toBe(t);
    for (const bad of [null, '', 'stocks', 'STOCK', 'comparison', '../x', 'insights ']) expect(reportTabFrom(bad)).toBe('insights');
  });

  it('has the eight sections the report shows, in the order of its tab strip', () => {
    expect([...REPORT_TABS]).toEqual(['insights', 'prices', 'offers', 'stock', 'marketing', 'assortment', 'basket', 'coverage']);
  });
});

describe('which CSV table a section downloads', () => {
  it('maps every section to a table the API really has (or to none: the basket has no table)', () => {
    for (const t of REPORT_TABS) {
      const d = CSV_TABLE_OF_TAB[t];
      if (d !== null) expect(CSV_DATASETS as readonly string[]).toContain(d);
    }
    expect(CSV_TABLE_OF_TAB.basket).toBeNull();
  });

  it('gives each of those sections a different table, so no two sections download the same file', () => {
    const tables = REPORT_TABS.map((t) => CSV_TABLE_OF_TAB[t]).filter((d) => d !== null);
    expect(new Set(tables).size).toBe(tables.length);
  });

  it('offers every table the API accepts, and each one is the natural table of a section or is reached from the dropdown', () => {
    const natural = new Set(Object.values(CSV_TABLE_OF_TAB));
    // the marketing summary is the only table without a section of its own: it sits under the Marketing section and is picked in the dropdown
    expect(CSV_DATASETS.filter((d) => !natural.has(d))).toEqual(['marketing_summary']);
  });

  it('follows the section on screen unless the person picked another table for that section', () => {
    expect(csvTableFor('stock', null)).toBe('stock');
    expect(csvTableFor('prices', null)).toBe('comparison');
    expect(csvTableFor('offers', { tab: 'offers', dataset: 'marketing' })).toBe('marketing');
    // a pick made on one section does not follow the person to the next one
    expect(csvTableFor('stock', { tab: 'offers', dataset: 'marketing' })).toBe('stock');
    expect(csvTableFor('marketing', { tab: 'marketing', dataset: 'marketing_summary' })).toBe('marketing_summary');
  });

  it('on the basket (no table of its own) starts at the price comparison, and a table picked there is used', () => {
    expect(csvTableFor('basket', null)).toBe('comparison');
    expect(csvTableFor('basket', { tab: 'offers', dataset: 'offers' })).toBe('comparison');
    expect(csvTableFor('basket', { tab: 'basket', dataset: 'coverage' })).toBe('coverage');
  });

  it('names the tables the way the dropdown always has', () => {
    expect(CSV_DATASETS.map(csvTableLabel)).toEqual(['Comparison', 'Offers', 'Stock', 'Marketing', 'Marketing summary', 'Insights', 'Coverage', 'Assortment']);
    // and the PDF of a selection carries the very same name in its title
    expect(CSV_DATASETS.map(csvDatasetLabel)).toEqual(CSV_DATASETS.map(csvTableLabel));
  });
});

describe('the address each export button asks for', () => {
  const base = '/api/v1/orgs/o1/reports/r1/export';

  it('the PDF asks for the report selected in the dropdown, for each of the eight selections', () => {
    for (const d of CSV_DATASETS) expect(exportUrl(base, 'pdf', d)).toBe(`${base}?format=pdf&dataset=${d}`);
    expect(new Set(CSV_DATASETS.map((d) => exportUrl(base, 'pdf', d))).size).toBe(CSV_DATASETS.length);
  });

  it('the CSV asks for the same selection, and Excel always asks for the whole workbook', () => {
    for (const d of CSV_DATASETS) {
      expect(exportUrl(base, 'csv', d)).toBe(`${base}?format=csv&dataset=${d}`);
      expect(exportUrl(base, 'xlsx', d)).toBe(`${base}?format=xlsx`);
    }
  });

  it('in the list of reports (no dropdown) the PDF is the whole report and the CSV is the price comparison', () => {
    expect(exportUrl(base, 'pdf', 'comparison', true)).toBe(`${base}?format=pdf`);
    expect(exportUrl(base, 'csv', 'comparison', true)).toBe(`${base}?format=csv&dataset=comparison`);
  });

  it('follows the dropdown: the report on screen unless another was picked for that section', () => {
    expect(exportUrl(base, 'pdf', csvTableFor('stock', null))).toContain('dataset=stock');
    expect(exportUrl(base, 'pdf', csvTableFor('stock', { tab: 'stock', dataset: 'coverage' }))).toContain('dataset=coverage');
    // changing the selection changes the very next address: nothing is kept from the previous one
    const first = exportUrl(base, 'pdf', csvTableFor('prices', { tab: 'prices', dataset: 'offers' }));
    const second = exportUrl(base, 'pdf', csvTableFor('prices', { tab: 'prices', dataset: 'insights' }));
    expect([first, second]).toEqual([`${base}?format=pdf&dataset=offers`, `${base}?format=pdf&dataset=insights`]);
  });
});
