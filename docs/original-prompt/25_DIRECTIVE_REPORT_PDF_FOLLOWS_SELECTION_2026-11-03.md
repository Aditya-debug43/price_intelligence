# Directive 25 — verbatim (2026-11-03)

# Critical Bug: PDF Export Ignores the Selected Report Type — All Dropdown Options Download the Same PDF

I have identified another issue in Shelfwatch's Reports section.

**The report dropdown does not correctly control the generated PDF. Regardless of which report type I select, clicking PDF downloads the same PDF.**

I have attached a screenshot showing the current Reports page.

I need you to investigate the complete export pipeline, identify the actual root cause, and fix it properly.

This is not just a UI issue. The generated PDF itself must contain the correct report data for the selected report type.

## 1. Understand the affected functionality

The Reports page has a dropdown containing these eight options:

1. Comparison
2. Offers
3. Stock
4. Marketing
5. Marketing summary
6. Insights
7. Coverage
8. Assortment

Beside the dropdown are the export controls:

- PDF
- Excel
- CSV table
- CSV

The report currently displays a saved snapshot, with the date and time shown on the page.

When I select a different dropdown option and click PDF, I expect the exported document to correspond to that selected report type.

However, currently, different selections produce the same PDF.

**The main requirement is to make every selection generate the correct report-specific PDF, rather than repeatedly downloading the same report.**

First, inspect the existing implementation to determine exactly what each dropdown option is intended to export. Do not redesign the controls or invent a new interpretation of their behaviour.

## 2. Investigate the complete PDF export pipeline

Trace the entire process from the dropdown selection to the final downloaded PDF.

Inspect:

- Dropdown component and selected-value state.
- Dropdown change handler.
- PDF button click handler.
- PDF-generation function.
- Report data selection and transformation.
- PDF template and rendering components.
- Backend export endpoints, if used.
- API request parameters and response.
- Saved report snapshot loading.
- Download and file-generation logic.
- Export filenames and browser download behaviour.

Determine where the selected report type is being lost or ignored.

Investigate possibilities such as:

- The dropdown updates its visible value but does not update export state.
- The PDF button always calls the same generic export function.
- The selected report type is not passed to the export function.
- The API request always uses the same report type.
- The backend ignores the requested report type.
- The PDF generator always loads the full report instead of the selected section.
- The same PDF template or data object is reused for every selection.
- A cached PDF or previous export response is being reused.
- An asynchronous state update causes the export handler to read an outdated selection.
- Different export types are mapped to the same internal identifier.
- The generated file is correct but the download mechanism repeatedly uses a stale file.

These are investigation possibilities, not assumptions. Find the actual root cause before changing the implementation.

## 3. Implement correct PDF generation for all eight options

Each dropdown selection must produce the corresponding report.

| Selected dropdown option | Expected PDF content |
|---|---|
| Comparison | Product comparison and relevant price-comparison information |
| Offers | Offers and promotional information |
| Stock | Own-store stock and availability information |
| Marketing | Marketing activity and relevant observations |
| Marketing summary | Marketing summary information |
| Insights | Report insights and findings |
| Coverage | Product catalogue coverage and collection completeness |
| Assortment | Assortment comparison and relevant assortment information |

Use the existing report definitions, calculations, data models and UI terminology.

Do not create fake or placeholder data to populate a report.

If a selected report section has no data, generate a correct PDF with a clear empty-state message rather than silently exporting another report.

The generated PDF should have an appropriate title and clearly identify the selected report type and report date.

**Important:** Do not simply change the filename to make different exports appear different. The actual contents of the generated PDF must correspond to the selected report.

## 4. Ensure the selected value reaches the generator correctly

The complete flow should be reliable:

Dropdown selection → selected report state → PDF export handler → correct report data → correct PDF template → generated file.

Verify that the selected value is passed explicitly through every necessary layer.

Do not rely on an outdated React state value immediately after a selection change.

Ensure that:
- The most recently selected report type is used.
- Rapidly changing selections cannot generate an incorrect report.
- Repeated exports work correctly.
- Switching between report types does not retain content from a previous export.
- Different report types cannot accidentally share the wrong data object or cached PDF.
- An export failure displays an appropriate error instead of silently downloading an incorrect document.

## 5. Check Excel and CSV exports too

Although the most visible problem is with PDF exports, inspect Excel and CSV as well.

Determine whether the same dropdown is intended to control their report scope.

Where applicable, ensure that:

- Excel exports the correct selected report.
- CSV exports the correct selected report.
- CSV table export follows its intended existing behaviour.
- Exported column names and headings correspond to the selected report.
- Empty sections are handled correctly.
- Data from different report categories is not mixed accidentally.

Do not change export behaviour that is already correct.

## 6. Preserve saved report snapshots

The screenshot shows:

"Prepared 03 Nov 2026, 11:08 (America/Aruba). Saved snapshot — it will not change."

This behaviour must be preserved.

Every report-specific export must use the data belonging to the currently opened saved snapshot.

For example, switching from Comparison to Coverage must not silently fetch today's live data if the report is a saved snapshot.

Do not:
- Modify the saved snapshot.
- Recalculate or overwrite historical report data.
- Create a new snapshot simply because an export button was clicked.
- Mix current live data with historical snapshot data.
- Change the original report date or reporting period.

All eight report types must be generated from the same selected snapshot when exporting from that report page.

## 7. Test every dropdown option individually

Do not test just Comparison and Coverage.

Perform a complete test across all eight selections.

For each option:

1. Open the saved report.
2. Select the report type.
3. Click PDF.
4. Open the downloaded PDF.
5. Verify its title and actual contents.
6. Confirm that the content belongs to the selected category.
7. Confirm that unrelated report sections have not accidentally replaced the selected content.

Also perform a cross-selection test:

- Select Comparison and export.
- Select Offers and export.
- Select Stock and export.
- Select Marketing and export.
- Select Marketing summary and export.
- Select Insights and export.
- Select Coverage and export.
- Select Assortment and export.

Compare the resulting PDFs.

Do not assume all eight PDFs must have different binary hashes; PDFs can differ in metadata or layout without different report content. Instead, verify that their actual report contents, headings, data and section structure are correct.

Pay particular attention to the possibility that all eight selections are returning the same underlying report data.

## 8. Test download behaviour

Also verify:

- The correct file is downloaded on every click.
- Filenames are meaningful and identify the selected report type.
- A previously generated file is not accidentally reused.
- Two consecutive exports of different report types do not overwrite or mix their contents.
- The export uses the latest dropdown selection.
- Browser console and network logs contain no relevant errors.

## 9. Strict scope restrictions

This is a targeted Reports export bug fix.

Do not modify unrelated Shelfwatch functionality.

Specifically, do NOT:

- Change the product matching engine.
- Change Match Review.
- Change Price Comparison calculations.
- Modify quantity-matching rules.
- Modify automotive bundle-comparison rules.
- Change product collection or scraping.
- Modify stock or inventory collection.
- Change competitor data.
- Change authentication or permissions.
- Redesign the Reports page.
- Modify unrelated database records or schemas.
- Refactor unrelated components.

Preserve the current report layout, controls and visual styling.

Only change the code that is strictly necessary to make report selection and export generation work correctly.

## 10. Deployment and verification

Before deploying:

- Identify and document the root cause.
- Review the targeted code changes.
- Run relevant export tests.
- Run the full test suite where practical.
- Run lint, type-checking and production build.
- Verify that all eight report types generate the correct content.
- Take a backup if a production data or database change is required.

Deploy the necessary changes and verify the live application.

I need actual browser-level verification, not just successful compilation.

If you cannot access the authenticated production page, clearly distinguish local test results from production verification. Do not claim that production is fixed without evidence.

## 11. Final report

After completion, tell me:

1. What was the exact root cause?
2. Why were all eight selections downloading the same PDF?
3. Which files and components did you modify?
4. What changes were made to the PDF-generation process?
5. Did you verify all eight report types individually?
6. Do the generated PDFs contain the correct report-specific data?
7. Were Excel and CSV exports affected, and were they verified?
8. Were saved report snapshots preserved?
9. Did all relevant tests pass?
10. Has the fix been deployed to production?
11. Were any unrelated features changed?

Include a table showing each report type and its actual export verification result.

**Final objective: Selecting Comparison, Offers, Stock, Marketing, Marketing summary, Insights, Coverage or Assortment must generate the correct corresponding PDF. Every selection must be respected by the actual PDF-generation process, not just by the dropdown's visual state. Fix the root cause without changing anything unrelated in Shelfwatch.**
