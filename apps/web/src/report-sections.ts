import { csvDatasetLabel, type CsvDataset } from '@ci/shared';

/** The sections of a saved report, in the order of the tab strip. The address carries the open one (`?tab=stock`). */
export const REPORT_TABS = ['insights', 'prices', 'offers', 'stock', 'marketing', 'assortment', 'basket', 'coverage'] as const;
export type ReportTab = (typeof REPORT_TABS)[number];

/** Anything else in the address (a mistyped or old link) opens the first section instead of leaving the page body empty. */
export function reportTabFrom(raw: string | null): ReportTab {
  return (REPORT_TABS as readonly string[]).includes(raw ?? '') ? (raw as ReportTab) : 'insights';
}

/**
 * The CSV table that holds what a section shows, so "CSV" downloads what is on screen. The basket comparison has no CSV table of its own
 * (it is in neither the Excel workbook nor the PDF either), so on that section CSV starts at the price comparison.
 */
export const CSV_TABLE_OF_TAB: Record<ReportTab, CsvDataset | null> = {
  insights: 'insights',
  prices: 'comparison',
  offers: 'offers',
  stock: 'stock',
  marketing: 'marketing',
  assortment: 'assortment',
  basket: null,
  coverage: 'coverage',
};

/** The CSV table to download: the one the person picked while on this section, else the one that matches the section, else the price comparison. */
export function csvTableFor(tab: ReportTab, picked: { tab: ReportTab; dataset: CsvDataset } | null): CsvDataset {
  if (picked && picked.tab === tab) return picked.dataset;
  return CSV_TABLE_OF_TAB[tab] ?? 'comparison';
}

/**
 * The address of an export of a saved report. The PDF, the Excel file and the CSV all carry the selected report, so the file is that report and nothing else. In the list of reports
 * there is no dropdown: a PDF and an Excel file there are the whole report (no report named) and a CSV is the price comparison.
 */
export function exportUrl(base: string, format: 'pdf' | 'xlsx' | 'csv', dataset: CsvDataset, compact = false): string {
  if (compact && format !== 'csv') return `${base}?format=${format}`;
  return `${base}?format=${format}&dataset=${dataset}`;
}

/** "marketing_summary" → "Marketing summary" (the names the dropdown has always shown; the PDF of the selection carries the same name). */
export const csvTableLabel = csvDatasetLabel;
