# Directive 22 — verbatim (2026-11-01)

(The message came with a screenshot of the Reports page: the report dated 28 October 2026 with the report-selection dropdown open beside the PDF, Excel and CSV buttons, "Stock" highlighted, and the tab row Insights (68) / Prices (1006) / Offers (150) / My stock (0) / Marketing (1) / Assortment / Basket / Coverage.)

# Shelfwatch Bug Fix: Report Filters and Section Navigation Are Not Working

I have identified a problem in the Reports section of Shelfwatch.

I have attached a screenshot of the Reports page. The report selection dropdown and report section tabs are not working as expected.

I need you to investigate the entire report navigation/filtering functionality, identify the actual root cause, and fix it properly.

**Important: This is a targeted bug fix. Do not modify unrelated functionality anywhere in Shelfwatch.**

## 1. Understand the affected UI

The affected page is the Reports section.

The screenshot shows the following controls.

### A. Top-right report selection dropdown

The dropdown contains:

- Comparison
- Offers
- Stock
- Marketing
- Marketing summary
- Insights
- Coverage
- Assortment

It appears beside the PDF, Excel and CSV buttons.

Investigate exactly what this dropdown is intended to control.

Depending on its intended design, selecting an option should correctly update the selected report/export scope and ensure that the corresponding PDF, Excel or CSV export contains the correct data.

Do not assume that this dropdown is supposed to change the visible page. Inspect the existing implementation and determine its intended behavior first.

### B. Report section tabs

The report also contains these tabs:

- Insights
- Prices
- Offers
- My stock
- Marketing
- Assortment
- Basket
- Coverage

These are section-navigation controls.

Clicking each tab should display the corresponding section and its relevant report data.

Verify that:
- The correct section becomes active.
- The corresponding content is rendered.
- The selected tab is visually distinguishable.
- The correct data is displayed.
- Switching between tabs does not accidentally retain data from another section.
- Empty sections display an appropriate empty state rather than broken or misleading content.
- The section navigation works consistently when switching repeatedly between tabs.

## 2. Investigate the actual root cause

Do not immediately modify the frontend or replace the existing components.

First inspect the complete flow:

1. Report page components.
2. Dropdown state and event handlers.
3. Tab navigation logic.
4. Report data-fetching functions.
5. API endpoints and their response structures.
6. Report snapshot data handling.
7. Export functionality for PDF, Excel and CSV.
8. Any conditional rendering logic.
9. Relevant routing and state-management logic.

Check for problems such as:

- Click handlers not being attached correctly.
- Incorrect state updates.
- Dropdown values not being passed to the correct functions.
- Incorrect mappings between dropdown options and report sections.
- Tabs updating their appearance without updating the displayed content.
- Data-fetching functions using the wrong report type.
- Stale data being retained after switching sections.
- Incorrect API parameters.
- API responses being interpreted incorrectly.
- Conditional rendering bugs.
- Export functions ignoring the selected report type.
- CSS overlays or invisible elements blocking clicks.
- Errors occurring in the browser console or network requests.

These are possibilities to investigate, not assumptions about the cause.

## 3. Verify every option

Do not test only one dropdown option or one tab.

Verify all eight dropdown choices individually:

| Dropdown option | Expected verification |
|---|---|
| Comparison | Correct comparison report/export scope |
| Offers | Correct offers report/export scope |
| Stock | Correct stock report/export scope |
| Marketing | Correct marketing report/export scope |
| Marketing summary | Correct marketing summary scope |
| Insights | Correct insights report/export scope |
| Coverage | Correct coverage report/export scope |
| Assortment | Correct assortment report/export scope |

Also verify all eight report tabs individually:

| Report tab | Expected verification |
|---|---|
| Insights | Insights content |
| Prices | Price comparison details |
| Offers | Offer details |
| My stock | Own-store stock details |
| Marketing | Marketing activity |
| Assortment | Assortment analysis |
| Basket | Basket comparison |
| Coverage | Catalogue coverage information |

For every option, confirm that the displayed or exported information corresponds to the selected section.

## 4. Check PDF, Excel and CSV exports

Because the dropdown appears beside the export buttons, verify their interaction carefully.

Test the following:

1. Select Comparison and export each supported format.
2. Select Offers and export each supported format.
3. Select Stock and export each supported format.
4. Repeat for the remaining dropdown options.

Verify that:
- The selected report type is respected.
- The correct report data is exported.
- The output is not accidentally identical for every selection.
- Data is not mixed between report categories.
- Empty sections are handled correctly.
- The exported report has correct headings and column names.
- The selected report type is clearly represented where appropriate.

Do not redesign the export system. Fix only what is necessary for correct operation.

## 5. Preserve saved report snapshots

The screenshot shows a saved report dated 28 October 2026.

The page explicitly states:

"Saved snapshot — it will not change."

Preserve this existing behavior.

Do not make an old saved report silently display current live data when switching tabs or changing the dropdown.

All sections of the report must use the correct data belonging to that particular saved snapshot.

Also ensure that navigating between tabs does not create or modify report snapshots.

## 6. Testing requirements

I do not want a fix based only on successful compilation or unit tests.

Perform actual browser-level verification using the existing report page and a representative saved report.

Use automated browser testing where available.

At minimum:

- Open the report page.
- Click every dropdown option.
- Verify the selected value and resulting behavior.
- Click every report tab.
- Verify that the correct content appears.
- Switch repeatedly between different sections.
- Test PDF, Excel and CSV exports.
- Check browser console errors.
- Check failed network requests.
- Test empty sections.
- Confirm that saved snapshot data remains unchanged.

Add or update automated tests for any bug discovered.

If you cannot access the authenticated production page, reproduce the behavior using the existing code and a representative saved report, and clearly state what you could not verify.

## 7. Strict scope restriction

This is extremely important.

**Only fix the Reports page dropdown, report tabs, their associated data handling, and their export-selection behavior where necessary.**

Do NOT:

- Modify the matching engine.
- Change Match Review.
- Change Price Comparison logic.
- Change product matching decisions.
- Modify product collection or scraping.
- Modify stock collection or inventory logic.
- Change competitor data.
- Change offers or marketing collection logic.
- Modify authentication or permissions.
- Redesign the entire Reports page.
- Refactor unrelated components.
- Change database records or schemas unless absolutely necessary and directly justified by the identified bug.
- Change other pages or dashboard functionality.

Preserve the existing UI design, layout and visual styling unless a minimal UI correction is essential to make the controls functional.

## 8. Production deployment and safety

Before deployment:

- Inspect the existing production state.
- Make a targeted code change.
- Run relevant tests and the full test suite if practical.
- Check lint and build.
- Review the final diff to ensure unrelated files were not changed.
- Take a backup if any production data or database operation is required.

Deploy only the necessary changes.

Verify the production page after deployment.

## 9. Final report

Give me a concise but evidence-based report:

1. What exactly was broken?
2. What was the root cause?
3. What did you change?
4. Which files were modified?
5. Are all eight dropdown options working?
6. Are all eight report tabs working?
7. Are PDF, Excel and CSV exports respecting the selected report type?
8. Were saved report snapshots preserved?
9. What actual browser-level tests were performed?
10. Was production deployment successful?
11. Were any unrelated features changed?

Do not report a control as working simply because it renders or changes color when clicked. Verify that the actual intended behavior works.

**Final objective: Make every report dropdown option, report tab and associated export selection work correctly while preserving all existing Shelfwatch functionality. Do not make unrelated changes.**
