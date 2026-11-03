# Directive 26 — verbatim (2026-11-03)

# Shelfwatch: Fix Excel Export — Respect the Selected Report Type

The Excel exports are still identical regardless of which report type I select from the Reports dropdown.

You previously fixed the PDF and CSV export selection, but explicitly left Excel exporting the entire workbook with all report sheets.

I now want the Excel export to follow the selected report type as well.

## 1. Required behaviour

The Reports dropdown contains:

1. Comparison
2. Offers
3. Stock
4. Marketing
5. Marketing summary
6. Insights
7. Coverage
8. Assortment

When I select a report type and click Excel, the downloaded Excel file must contain only the data relevant to that selected report type.

For example:

- Select Comparison → Excel contains the Comparison report.
- Select Offers → Excel contains the Offers report.
- Select Stock → Excel contains the Stock report.
- Select Marketing → Excel contains the Marketing report.
- Select Marketing summary → Excel contains the Marketing summary.
- Select Insights → Excel contains the Insights report.
- Select Coverage → Excel contains the Coverage report.
- Select Assortment → Excel contains the Assortment report.

Do not download the complete workbook containing all report sections for every selection.

## 2. Investigate and fix the Excel export pipeline

Trace the complete flow:

Dropdown selection → selected report state → Excel button → export request → backend Excel generator → correct report data → downloaded XLSX file.

Investigate why Excel currently ignores the selected report type.

Inspect:
- Excel button and click handler.
- Dropdown state and selected-value mapping.
- API request parameters.
- Excel export endpoint.
- Workbook generation functions.
- Report data transformation.
- Saved snapshot handling.
- Any caching or shared workbook logic.

Reuse the working report-selection logic already implemented for PDF and CSV where appropriate.

The selected report type must reach the actual Excel-generation function. Changing only the filename or sheet title is not a solution.

## 3. Excel file contents

Each generated Excel file must contain the relevant information for the selected report.

Preserve:
- Correct column names and headings.
- Relevant report data and all applicable tables.
- Appropriate cell formatting.
- Dates, prices and numerical values in usable Excel formats.
- Existing useful formulas, where applicable.
- Appropriate worksheet names.
- Proper handling of empty report sections.

If a report contains multiple relevant tables, include all of those tables. However, do not include unrelated report sections.

A selected report can have one or multiple worksheets as needed, but every worksheet must belong to the selected report.

## 4. Preserve saved report snapshots

The Excel export must use the same saved snapshot currently open in the Reports page.

Do not fetch fresh live data or modify historical report snapshots during export.

All report-specific exports from the same saved report must use the same reporting period and source data.

## 5. Test all eight Excel exports

Generate and inspect all eight Excel files individually.

| Selected report | Required verification |
|---|---|
| Comparison | Only comparison-related data |
| Offers | Only offer-related data |
| Stock | Only stock-related data |
| Marketing | Only marketing activity |
| Marketing summary | Only marketing summary |
| Insights | Only insights and findings |
| Coverage | Only coverage information |
| Assortment | Only assortment information |

For each file:

1. Open or programmatically inspect the generated XLSX.
2. Verify its worksheet names and contents.
3. Verify that it contains the correct report data.
4. Verify that unrelated report sections are absent.
5. Compare the file against the selected saved snapshot.
6. Confirm that the export is not merely the full workbook with a different filename.

Do not rely only on file size or hash differences. Verify actual worksheet contents and data.

Also test switching selections repeatedly and exporting immediately to ensure the latest selection is respected.

## 6. Coordinate with the previous PDF fix

The previous PDF and CSV selection fix was committed locally but had not yet been deployed because SSH access was blocked.

Check the current repository and production state first.

If the PDF/CSV fix is still pending, include this Excel correction in the same targeted release so that all three formats work consistently.

Do not accidentally deploy only the frontend while the backend still uses the old export implementation.

## 7. Strict scope restrictions

Only modify the Reports export functionality.

Do not change:
- Product matching.
- Match Review.
- Price Comparison calculations.
- Quantity-matching policies.
- Automotive bundle-matching policies.
- Product or competitor collection.
- Stock collection.
- Authentication.
- Other unrelated Reports functionality.

Preserve the existing PDF and CSV behaviour that has already been implemented.

Do not modify saved snapshots or unrelated database records.

## 8. Final verification and report

Before declaring completion, report:

1. Why Excel files were identical.
2. What exactly was changed.
3. Which files were modified.
4. Whether all eight report types were individually tested.
5. Whether the actual XLSX worksheet contents were verified.
6. Whether saved snapshots were preserved.
7. Whether PDF and CSV still work correctly.
8. Whether the changes were deployed to production.

**Important:** I expect eight report-specific Excel exports, not eight copies of the same complete workbook with different filenames.

The selected report type must control the actual contents of the downloaded Excel file.
