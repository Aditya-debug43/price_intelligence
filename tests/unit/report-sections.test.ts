import { describe, expect, it } from 'vitest';
import { CSV_DATASETS } from '@ci/shared';
import { CSV_TABLE_OF_TAB, REPORT_TABS, csvTableFor, csvTableLabel, reportTabFrom } from '../../apps/web/src/report-sections.ts';

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
  });
});
