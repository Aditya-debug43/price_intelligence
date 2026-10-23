<!-- Verbatim copy of the user's message, saved for context preservation. Wrapper tags removed; text otherwise unchanged. Sent 2026-10-23. -->

# SHELFWATCH — EXHAUSTIVE FUNCTIONAL, REAL-DATA, AND REQUIREMENTS AUDIT

Act as a senior software engineer, QA engineer, data engineer, security engineer, and product auditor.

I am going to provide the actual source website and competitor website URLs that I want Shelfwatch to analyse. Before I consider this project complete or present it to my professor, I want you to perform an exhaustive audit of the entire application.

**Your objective is to prove that Shelfwatch fulfils its original business purpose, that every important functionality works correctly, and that real products are collected comprehensively and compared accurately.**

Do not simply inspect the code and tell me everything looks good. Run the application, execute tests, examine actual database records, interact with the UI, perform real-data checks on the supplied websites where permitted, discover bugs, fix them, and rerun the relevant tests.

Do not claim a feature works just because the code exists or an automated test passes.

## 1. First, reread the complete project requirements

Before testing, thoroughly reread:

- My original complete project prompt.
- `docs/PROJECT_CONTEXT.md`
- `docs/WORK_LOG.md`
- `docs/REQUIREMENTS_MATRIX.md`
- `docs/PRODUCTION_READINESS.md`
- `docs/limitations.md`
- `docs/integrations.md`
- The latest verification reports.
- The actual repository, relevant source code, database schema, migrations, and Git history.

My original intention was to build a real competitor intelligence platform where a customer enters their own website and 3–5 competitor websites, and the application analyses their products, prices, discounts, offers, stock information, and permitted marketing activity.

Compare every original requirement against the current implementation. Do not replace my original requirements with your own interpretation or assume a feature is complete because a previous report marked it complete.

Create a checklist of requirements and their actual verification status. Do this as part of the audit, and update the existing project records rather than creating a large amount of unnecessary documentation.

## 2. Test with these real websites

Use the following URLs as the intended live test inputs:

**My source website:**\


[https://groceriestogoaruba.com/](https://groceriestogoaruba.com/)

Competitors websites:
[https://www.lingandsons.com/](https://www.lingandsons.com/)
[https://foodstore2go.com/](https://foodstore2go.com/)
[https://shop.superfoodaruba.com/](https://shop.superfoodaruba.com/)
[https://quickmartaruba.com/](https://quickmartaruba.com/)

Use the exact URLs provided. Do not silently substitute different websites or add competitors without asking me.

Before collection, inspect each site's public accessibility, applicable robots directives, terms, and relevant access restrictions. Confirm that the intended collection is permitted. Do not treat the mere presence of a URL as proof of permission from its owner, and do not bypass CAPTCHAs, authentication, paywalls, or anti-bot protections.

If a site cannot be accessed or permission is unclear, report the precise blocker. Continue auditing independent functionality wherever possible.

## 3. Test the entire customer journey

Start with a fresh, isolated test account and follow the actual customer workflow.

Test every step:

1. Registration and input validation.
2. Email verification through the configured real email service.
3. Login, logout, and session handling.
4. Workspace creation.
5. Entering the source website and 3–5 competitors.
6. Website validation and capability profiling.
7. Recording the appropriate collection permissions.
8. Starting catalogue collection.
9. Monitoring collection progress.
10. Viewing collected products.
11. Reviewing and correcting product matches.
12. Opening the price-comparison page.
13. Reviewing offers and promotions.
14. Viewing own-site stock information and alerts.
15. Viewing marketing intelligence where available.
16. Generating, viewing, comparing, and exporting reports.
17. Configuring schedules, notifications, users, and integrations.

Verify that every button, form, filter, tab, dialog, download, link, and state-changing action performs its advertised function.

Test the result after refreshing the page or signing out and signing in again to confirm that important changes were persisted.

Do not use an old seeded workspace or fictional data as proof that a real customer journey works.

## 4. Exhaustively audit product collection

This is one of the most important parts of the entire project.

For every supplied website, determine whether Shelfwatch can discover and collect its accessible product catalogue.

Inspect the existing connectors and verify the applicable collection strategies, including:

- Public product feeds and supported storefront interfaces.
- Sitemaps and sitemap indexes.
- Product listing and category pages.
- Pagination.
- Product detail pages.
- JSON-LD and other structured data.
- Platform-specific connectors.
- HTML extraction.
- Browser rendering where needed and permitted.
- Public promotional flyers where supported.

Do not assume every website uses the same platform or exposes the same fields.

### Verify catalogue completeness

For each site, record:

- How products were discovered.
- The number of products reported by the source, if it exposes a reliable count.
- The number of unique products discovered.
- The number successfully stored.
- The number skipped, duplicated, or unsuccessfully processed.
- The number of pages found, read, and failed.
- Whether pagination and sitemap indexes were traversed.
- Whether product variants were captured.
- Whether prices and currencies were extracted.
- Whether the collection is complete, partial, blocked, or unsupported.
- The time of the observations.

Investigate missing pages, incomplete pagination, duplicate products, invalid next-page URLs, failed requests, unusual product layouts, and products that have no price.

Do not report an entire catalogue as complete simply because the homepage or first page was collected.

Where a website has thousands of products, make the collection resumable and efficient. Use sensible request limits, timeouts, caching, retries, and polite pacing.

If complete collection is technically impossible, explain exactly what could be collected, what is missing, and why.

## 5. Verify the collected data against the actual websites

Do not trust your own database merely because it contains thousands of products.

For every site, independently re-read the source data using an appropriate permitted method and verify the stored records.

Check:

- Product name.
- Brand.
- SKU and GTIN/EAN/UPC where available.
- Product size and quantity.
- Product variant.
- Regular price.
- Selling price.
- Currency.
- Availability.
- Product URL.
- Observation timestamp.
- Promotion data where present.

Compare the source values against the records stored by Shelfwatch.

Use exhaustive checks where the catalogue or source feed makes them practical. For larger catalogues, combine full-feed reconciliation, duplicate detection, and documented samples of individual product pages. Clearly state what was checked in full and what was sampled.

Investigate every unexplained discrepancy. Do not hide mismatches by normalising away meaningful differences.

Verify that running collection again updates observations correctly without creating duplicate products or losing useful historical information.

## 6. Audit product matching and price comparisons in depth

A product being found on two websites does not mean it is the same product.

Test matching for:

- Same product with slightly different names.
- Missing or unreliable brand information.
- Different brands with similar names.
- Different flavours.
- Different sizes and volumes.
- Different pack counts and multipacks.
- Different product variants.
- Different models or vintages.
- Missing identifiers.
- Similar but genuinely unrelated products.
- Products found in only one catalogue.
- Repeated or discontinued products.

Pay particular attention to pack notation such as `24-12 oz`, conflicting quantity information, beverage sizes, product vintage/year differences, and incorrect vendor labels previously identified during the live-data work.

### Price calculation tests

For every important comparison path, verify:

- Original price on the source website.
- Original price on the competitor website.
- Correct currency for each price.
- Appropriate currency conversion.
- Correct unit-price normalisation.
- Absolute price difference.
- Percentage difference.
- Correct handling of sale versus regular prices.
- Match confidence and review status.
- Source URLs and timestamps.

Use an independently calculated expected result to check the application's result.

A positive price difference must consistently mean what the UI says it means. Check rounding and percentage denominators.

Never compare incompatible pack sizes as identical without a valid unit-price calculation.

Never turn missing information into a default price. Never label an inaccessible competitor as having no matching products. Never force a low-confidence match to make the comparison table look complete.

### Actual comparison evidence

For valid matches across my supplied websites, generate a set of real comparison examples showing:

| Field              | What to verify                                 |
| ------------------ | ---------------------------------------------- |
| Source product     | Actual product name and URL                    |
| Competitor product | Actual product name and URL                    |
| Equivalence        | Why the two products are or are not the same   |
| Prices             | Exact observed prices and currencies           |
| Unit conversion    | Calculation where necessary                    |
| Price difference   | Independently checked result                   |
| Confidence         | Whether the match is confirmed or needs review |
| Evidence           | Where and when each price was observed         |

Investigate all significant mismatches and run the corrected comparison workflow again.

**The central acceptance criterion is that Shelfwatch must produce a correct, evidence-backed comparison from real products collected from the actual supplied websites.**

## 7. Test every other feature and its edge cases

Build a functionality checklist covering the entire application. Every important feature must have a test or a clearly recorded blocker.

### Authentication and security

Test invalid inputs, duplicate accounts, expired verification links, reused reset tokens, failed logins, session expiry, access permissions, CSRF protection, and cross-organisation access.

### Stock and alerts

Test low-stock thresholds, stock reaching zero, restocking, repeated unchanged observations, missing exact quantities, stale inventory syncs, conflicting public availability, duplicate alerts, acknowledgements, and resolutions.

Never invent exact stock quantities when no authorised source provides them.

### Offers and flyers

Test regular versus sale prices, invalid discounts, promotional conditions, expiry, multipacks, product sizes resembling prices, unreadable documents, ambiguous extraction, and manual correction. Do not report unsupported claims as confirmed offers.

### Marketing intelligence

Check Facebook, Instagram, and YouTube provider status, missing credentials, expired permissions, unavailable public information, rate limits, and failed API calls. Keep observed public content separate from confirmed paid campaigns.

### Reports and exports

Verify report contents against persisted observations. Test PDF, CSV, and Excel exports, historical snapshots, comparison between two reports, partial reports, missing sites, stale observations, and CSV formula-injection safety.

### Scheduling and retention

Test the 9:00 AM `America/Aruba` requirement, delayed jobs, failed collection, interrupted workers, retries, duplicate jobs, retention boundaries, and organisation isolation.

### UI and accessibility

Open every page in the browser. Check desktop and mobile layouts, console errors, form validation, empty states, loading states, error states, keyboard navigation, accessible labels, long product names, filters, and downloads.

Do not mark a feature as browser-tested if you only tested its backend or rendered a screenshot without interacting with it.

## 8. Test failure cases, not only successful cases

For every major functionality, exercise normal inputs, invalid inputs, missing data, external failures, and boundary conditions.

At a minimum, cover:

- Invalid URLs and inaccessible websites.
- Robots-restricted pages.
- Unsupported storefronts.
- Partial catalogues.
- Zero products collected.
- Products with no price.
- Invalid currencies and missing size information.
- Duplicate products and conflicting identifiers.
- Empty comparison results.
- Low-confidence matches.
- Missing API keys.
- External API timeouts and rate limits.
- Database or worker failures.
- Expired sessions and unauthorised requests.
- Cross-tenant access attempts.
- Failed emails and invalid recipients.
- Report generation with incomplete data.

Use safe, isolated test fixtures for scenarios that cannot be reliably triggered on real websites. Clearly distinguish those tests from live verification.

Do not damage real user data or deliberately overload external sites to test failure cases.

## 9. Revisit every defect you previously found

Review the latest work log for known issues and previously unverified fixes, especially:

- Incorrect pack-size interpretation.
- Conflicting pack counts.
- False brand/vendor information.
- Flavour and variety mismatches.
- Vintage/year mismatches.
- False promotion detection.
- Currency conversion and unit-price calculations.
- Incomplete pagination.
- The distinction between an inaccessible competitor and a successfully collected catalogue with no equivalent product.
- Any comparison fixes that passed automated tests but have not been rerun on real data.

Ensure each bug has a regression test. Then verify the affected behaviour against real data whenever feasible.

## 10. Check whether the original product intention is actually satisfied

Return to my original requirements and ask this question for every major feature:

**Does the application genuinely deliver the business value that I originally requested, or does it merely contain a screen or a code path for it?**

Specifically verify whether a customer can:

- Register and sign in through a real authentication workflow.
- Enter their own business website and 3–5 competitors.
- Collect accessible products without hardcoded website assumptions.
- Obtain a sufficiently comprehensive and accurate catalogue.
- Compare equivalent products and their real prices.
- Discover evidence-backed discounts and promotions.
- See useful stock warnings for their own store.
- View available competitor marketing observations.
- Receive accurate reports and alerts.
- Understand when data is incomplete, stale, unavailable, or uncertain.

Do not silently drop an original requirement. If something cannot work for a particular website or needs an API key, authorised integration, or additional connector, explain the limitation and what is required.

## 11. Fix issues and verify the corrections

This is an implementation-and-audit task, not just a review.

When you find a bug:

1. Record the failing behaviour.
2. Identify the actual cause.
3. Fix it without unnecessarily rewriting unrelated components.
4. Add or update the regression test.
5. Rerun the targeted test.
6. Verify the corrected behaviour against live data where appropriate.
7. Rerun the complete suite after the audit changes are finished.

Run the available tests, lint, typecheck, and production builds. Inspect the actual application in the browser.

Preserve existing user data, credentials, and uncommitted changes. Do not drop databases, overwrite GitHub changes, deploy unverified code, or create billable cloud resources as part of this audit without my approval.

If external credentials or authorisation are missing, complete all independent tests and identify the exact blocker.

## 12. Final report to me

Keep the final report understandable and focused. I do not want hundreds of pages of documentation.

Provide:

**A. Overall verdict:** Is the original project intention satisfied, partially satisfied, or not satisfied?

**B. Website-by-website collection results:** Products discovered, products stored, coverage evidence, extraction accuracy, prices verified, and any collection limitations.

**C. Price-comparison accuracy:** Real examples, matching correctness, calculation checks, mismatches found, fixes applied, and remaining uncertainty.

**D. Feature audit:** Every major functionality classified as passed, failed, partially verified, or blocked, with evidence.

**E. Test results:** Exact test counts and outcomes, lint, typecheck, build, browser testing, and real external tests.

**F. Remaining blockers:** Missing credentials, required permissions, unsupported websites, incomplete functionality, and what I must do next.

Do not report only a pass percentage. Explain the important failures and their impact.

Keep the context file, work log, requirements matrix, and verification report accurate. Do not make unnecessary documentation files.

## Execution instructions

Start by reading the original requirements and inspecting the current repository and verification history.

Then run the audit against the supplied websites, trace the entire workflow, test every major functionality and important edge case, fix the issues discovered, and rerun verification.

Do not stop after preparing a checklist. Do not claim complete catalogue collection or correct price comparison without evidence.

**My priority is to know, before I present this project to my professor, whether Shelfwatch genuinely works on real websites, collects their products comprehensively, compares equivalent products correctly, and fulfils every important requirement I originally specified.**
