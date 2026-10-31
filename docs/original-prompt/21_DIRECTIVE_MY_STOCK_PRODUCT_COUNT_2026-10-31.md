# Directive 21 — verbatim (2026-10-31)

(The message came with a screenshot of the My Stock page; the figures in it are quoted in section 1.)

# Critical Bug: My Stock Shows an Incorrect Product Count — Fix Only This Issue

I need you to investigate and permanently fix one specific issue in Shelfwatch. A previous attempt did not solve it.

## 1. The actual problem

The total number of products on my source website is **3,316 products**.

However, Shelfwatch → My Stock currently displays:

- In Stock: 2,385
- Out of Stock: 0
- Low Stock: 0
- Availability Unknown: 0
- Total: 2,385 items and 2,381 products

I have attached a screenshot of the current My Stock page.

There is an apparent difference of **935 products** between the source website's stated total and Shelfwatch's product count.

This is not a request to simply change the number shown in the UI. I need you to identify why Shelfwatch is not collecting or counting the complete catalogue and fix the underlying cause.

## 2. Your primary objective

Make Shelfwatch accurately collect, store, and display the complete product catalogue from my own source website.

The source website reports 3,316 products. Verify what that number represents and compare it with the exact same product scope in Shelfwatch.

Do not assume that the missing products are drafts, archived products, unpublished products, duplicates, or inaccessible products. Investigate and establish the actual reason using evidence.

## 3. Investigate the complete collection pipeline

Audit the entire process, from discovering products on the source website to displaying them in My Stock.

### A. Verify the source website's actual catalogue

Determine how the source website exposes its products.

Inspect all relevant discovery methods available for this website, such as:

- Public product feeds or APIs.
- XML sitemaps.
- Product and collection pages.
- Pagination and cursor-based pagination.
- Other legitimate public catalogue endpoints.
- An existing authorised store integration, if configured.

Determine whether the 3,316 figure represents all products, publicly published products, products available through the online storefront, or another category.

Do not compare counts with different definitions.

### B. Investigate product discovery and pagination

Check whether Shelfwatch is missing products because of:

- Pagination stopping before the final page.
- Incorrect page limits.
- Cursor or offset handling errors.
- Products missing from collection pages.
- Incomplete feed or sitemap reconciliation.
- Failed requests.
- Rate limiting and incomplete retries.
- Interrupted collection runs.
- Incorrect resume behaviour.
- Products being skipped after an error.
- Incorrect filters on product status or availability.
- Other collection-specific restrictions.

Verify that every relevant page and product identifier is accounted for.

A successful collection status does not prove that the entire catalogue was collected.

### C. Audit the database

Compare the source website's product identifiers with the products stored in Shelfwatch.

Identify:

1. Total unique products reported by the source.
2. Total unique products discovered by Shelfwatch.
3. Total products successfully fetched.
4. Total products successfully saved.
5. Total unique parent products currently stored in Shelfwatch.
6. Total variants/items associated with those products.
7. Products that are missing and the reason each group is missing.

Use stable source product identifiers wherever possible. Do not rely only on product titles or URLs to identify duplicates.

Look for accidental filtering, incorrect deduplication, stale records, incomplete imports, and products that were discovered but never persisted.

### D. Check product and variant counting

Shelfwatch must distinguish between:

- **Products:** Unique parent products.
- **Items/variants:** Individual product variants or inventory items.

Do not count variants as separate products.

Also verify that products with multiple variants are not accidentally omitted, merged into unrelated products, or counted inconsistently.

## 4. Fix the actual root cause

After identifying the cause, implement the smallest reliable correction.

The solution must ensure that:

- All products within the intended catalogue scope are discovered.
- All discovered products are fetched successfully or have an explicit recorded failure.
- Pagination continues until the actual end of the catalogue.
- Interrupted collections can resume without silently skipping products.
- Rate limits are handled safely without marking incomplete collections as successful.
- Products are saved without creating duplicates.
- Repeated collection runs remain idempotent.
- The final product count reflects actual unique products stored in the database.
- The UI displays accurate product and item/variant totals.

If the source website exposes fewer than 3,316 products publicly because some products require an authorised inventory or admin integration, identify that limitation explicitly. Do not try to bypass access restrictions or pretend those products were collected.

If an existing authorised connection can access the complete catalogue, investigate whether Shelfwatch is correctly using it.

**Important:** Never hardcode 3,316 as the product count. Never insert artificial records or manipulate the count just to make it match the source.

## 5. Check the My Stock page

The screenshot also shows:

"Public availability mode. Your website only publishes available / unavailable. Exact unit counts are shown only when you connect your store inventory."

Preserve the distinction between product availability and exact inventory quantities.

Do not invent stock quantities or change inventory values to solve the product-count problem.

Make sure the My Stock page displays the correct number of unique products and variants after the collection is complete.

If the existing collection data is incomplete or stale, fix the underlying data and refresh the relevant counts rather than merely changing the frontend.

## 6. Strict scope restrictions — extremely important

**Do not change anything outside this specific issue.**

This is a targeted bug fix, not an opportunity to improve or refactor the rest of Shelfwatch.

Do NOT:

- Modify the product matching engine or matching rules.
- Change Match Review or Price Comparison functionality.
- Change matching decisions or accepted matches.
- Modify competitor website collections.
- Change price tracking or price comparison logic.
- Modify product relationships such as exact matches, substitutes, or related products.
- Change authentication, permissions, or user accounts.
- Redesign the dashboard or other pages.
- Refactor unrelated backend or frontend code.
- Modify unrelated database tables or records.
- Delete existing products or reset the database.
- Trigger unnecessary full collections of all competitor websites.
- Change existing features simply because you notice an unrelated improvement opportunity.

Only modify the components, collection logic, database operations, or My Stock display that are strictly necessary to solve this particular product-count problem.

Before making changes, inspect the existing implementation and identify the smallest safe fix. Any database migration must be justified by the root cause and must not destroy existing data.

## 7. Testing and verification requirements

Do not consider this issue fixed just because the code compiles or an API returns success.

Perform evidence-based verification.

At minimum:

1. Establish the exact source catalogue count and its definition.
2. Establish the current number of unique products stored in Shelfwatch.
3. Identify and account for the missing products.
4. Run the corrected collection process for my own website.
5. Verify that the final database contains the complete set of products within the verified collection scope.
6. Confirm that product identifiers are unique and there are no accidental duplicates.
7. Confirm that variants are counted separately from parent products.
8. Refresh or query the My Stock page and verify its displayed counts.
9. Run the collection again, or an equivalent idempotency test, to ensure that it does not create duplicate records or lose products.
10. Check that existing product availability and inventory information has not been corrupted.

If the source exposes all 3,316 products within the intended scope, the final My Stock product count should reconcile to 3,316.

If it does not, provide the exact numerical reconciliation and explain the evidence-backed reason. Do not claim success based on an approximate count.

## 8. Production safety

Before changing production:

- Inspect the current production implementation and database state.
- Take an appropriate database backup.
- Make only the necessary changes.
- Preserve existing product, price, variant, and matching-decision data.
- Deploy only the targeted fix if deployment is required.
- Verify the production API and My Stock page after deployment.

Avoid running unnecessary heavy jobs simultaneously on the EC2 instance.

## 9. Final report

When finished, provide a clear report containing:

| Metric | Before | After |
|---|---:|---:|
| Source website products | 3,316 (reported; verify) | Verified source count |
| Unique products in Shelfwatch | 2,381 | Actual final count |
| Items/variants in Shelfwatch | 2,385 | Actual final count |
| Missing products | To be investigated | Actual remaining count |
| Duplicate products | To be investigated | Actual count |

Also explain:

1. What was the exact root cause?
2. Why did the previous fix fail?
3. How were the missing products identified?
4. What exactly did you change?
5. Which files and database components were modified?
6. What tests did you perform, and what were their actual results?
7. Is the production My Stock page now showing the verified, complete catalogue?
8. Were any unrelated features changed? The expected answer should be **no**.

Do not hide incomplete results or report an unverified success.

**Priority: Fix the actual product collection/count discrepancy, preserve all existing Shelfwatch functionality, and make no unrelated changes.**
