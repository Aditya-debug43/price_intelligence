<!-- Verbatim copy of the user's message, saved for context preservation. Wrapper tags removed; text otherwise unchanged. Sent 2026-10-28. It came with one screenshot: the live report page (Price comparison tab) for "24 Poland Spring 100% Natural Spring Water" showing the "Your shop" card and the quickmartaruba.com and shop.lingandsons.com cards, with the caption "There are few corrections require: 1. can we put link of the products here so customers will be able to verify it from actual websites." -->

Shelfwatch: Add Direct Links to Original Product Pages for Price Verification
My professor reviewed the live Shelfwatch application and suggested an important improvement.
Requirement: Customers should be able to click a product or its price card in Shelfwatch and open that exact product on the original website. This will allow them to independently verify the product, its listed price, and other relevant details.
My live application is:
https://price-intelligence-psi.vercel.app/
I have attached the screenshot with arrows indicating where the links should be available.
1. Understand the requirement
Open and inspect the existing codebase, particularly the Price Comparison report and its product rows.
In the screenshot, each row contains a product from my own store and price cards from the competitors. I want customers to be able to navigate directly to the corresponding source product page.
For example, when a row displays a product from my own store alongside prices from Quickmart or Ling & Sons, customers should be able to open each respective product listing on the corresponding website.
This means:

* My product should link to its actual product page on my store website.
* Each competitor product should link to its actual product page on that competitor's website.
* If multiple competitors have matching products, each competitor's price card should link to that competitor's own product page.
* If a product is unavailable or out of stock, its link should still lead to the correct product page whenever that URL is available.
* Links should make it easy for customers to verify the information without manually searching the source website.

The links must be specific to the actual products represented in Shelfwatch, not merely links to the websites' homepages.
2. Investigate the existing implementation
Before making changes, examine the existing collection pipeline, database schema, product records, API responses, and frontend components.
Determine whether Shelfwatch already captures and stores the original product URL for each collected product, and whether that URL is retained throughout the matching and price-comparison process.
Trace the complete data flow:
Original website → product discovery → product extraction → database storage → product matching → price observations → API response → Price Comparison interface.
Identify exactly where the original product URL is currently stored, where it might be lost, and what changes are necessary to expose it correctly in the frontend.
Inspect the actual stored data rather than assuming every product already has a valid URL.
Do not implement the feature until you understand how the existing system identifies and relates products across different websites.
3. Add direct product links to the Price Comparison page
Implement the feature in the existing Price Comparison interface, following the current design.
The most important locations are the product rows and the price cards highlighted by the arrows in my screenshot.
For each product and competitor entry, customers should have a clear way to open the corresponding original product page.
Use an appropriate, unobtrusive link or clickable product-name treatment that fits the current interface. Keep the pricing information easy to read and retain the existing layout as much as possible.
The implementation should make it clear which website the link belongs to, particularly when several competitors are displayed in the same row.
Do not make an entire card clickable if doing so interferes with existing buttons, selection, hover behavior, or other interactions. Choose an interaction that is intuitive and reliable.
4. Use genuine, verified source URLs
This is one of the most important requirements.
Every product link must point to the actual product represented by that entry in Shelfwatch.

* Reuse the original product URL discovered during collection whenever it is valid.
* Preserve the association between a product, its source website, and its canonical product URL.
* Follow the existing architecture to make the URLs available wherever they are needed.
* If the URL is not currently stored, determine the appropriate way to capture and persist it through the existing collection pipeline.
* Handle redirects and canonical URLs correctly where supported.
* If the source provides product-specific variant URLs, preserve relevant variant information where it is needed to identify the correct item.

Never invent product URLs from product names, guess URL slugs, or link every product to its website homepage just to make the feature appear complete.
If a URL is missing, invalid, or cannot be verified, show an appropriate unavailable state rather than presenting a misleading link.
Do not silently replace one competitor's product URL with another competitor's URL or with a different product from the same website.
5. Ensure links remain correct after product matching
Shelfwatch matches products across different websites. A match does not mean that products on separate websites share the same URL.
For example, if one product from my store is matched with products from two competitors, the row should retain three distinct source URLs where available.
The implementation must preserve:

* The original product URL for my own product.
* The original product URL for each matched competitor product.
* The relationship between each URL and its respective website.
* The correct product identity when several variants, package sizes, flavours, or similar products exist.

Do not use the URL of my product for a competitor's entry just because the products are matched.
Ensure direct links work for existing matched products as well as products collected in future runs.
6. Consider all relevant product views
Inspect the application and identify any other relevant places where customers see products or source-specific prices.
Prioritise the Price Comparison report shown in the screenshot. Where the same source product is displayed elsewhere in the application, evaluate whether the existing design would benefit from the same direct-link capability.
Do not expand the task into an unrelated redesign. Keep the implementation focused on product verification and reuse the same reliable URL-handling approach where appropriate.
7. Make the links safe and user-friendly
Ensure the links:

* Open the correct original product page.
* Use valid HTTP or HTTPS URLs from trusted source records.
* Open in a new tab if appropriate, so customers do not lose their current comparison report.
* Use safe link attributes when opening a new tab.
* Have a clear visual indication that they can be clicked.
* Work with keyboard navigation and provide meaningful accessible names.
* Do not interfere with existing report navigation or product-selection behavior.

Handle missing and malformed URLs safely. Do not allow arbitrary protocols or unsafe URL values to become clickable links.
If a source product page no longer exists, do not pretend it is available. Where possible, explain that the source link is unavailable.
8. Preserve the accuracy of existing data
This task is about adding product verification links, not changing the product-matching or price-calculation algorithms.
Do not unintentionally change:

* Product matching decisions.
* Product identity or variant relationships.
* Price observations or price histories.
* Competitor comparisons or price-gap calculations.
* Product availability information.
* Reports, alerts, or collection history.

If changes to the backend or database are necessary to retain original product URLs, make them consistent with the existing architecture and migration practices.
Preserve all existing production data and avoid destructive database changes.
9. Test the feature thoroughly
Do not consider the task complete merely because links appear in the interface.
Add appropriate tests and verify the entire flow.
At minimum, test the following scenarios:

1. A product from my own store has a link to its actual source product page.
2. A competitor price card links to the corresponding product on that competitor's website.
3. Several competitors in the same comparison row each use their own correct source URL.
4. Products with different package sizes or variants retain the correct URLs.
5. Products with missing URLs do not receive fabricated or misleading links.
6. Previously collected products still have working links wherever their source URLs were stored.
7. New collection runs preserve product URLs correctly.
8. Product matching and price calculations remain unchanged.
9. The links work on the actual Price Comparison page in a browser.
10. No unrelated application features are broken.

Run the relevant automated tests, type checks, linting, and production build. Verify that each displayed link uses the correct stored source URL, not just that it has a valid-looking format.
10. Deploy the completed changes
My frontend is deployed on Vercel, and my backend is deployed on AWS EC2.
Inspect the existing Git and deployment workflow before making deployment changes.
Determine which parts of this feature require frontend changes, backend changes, or database changes.
Preserve uncommitted work and existing production records. Do not reset databases, force-push Git history, or create additional paid AWS resources without my approval.
Verify the changes in a safe environment, then use the existing deployment process where access permits.
If you cannot access the EC2 server or deploy a required backend change, do not claim it is live. Explain exactly what is blocked and what I need to do to complete deployment.
After deployment, verify the feature on the live Vercel website and confirm that links resolve to the correct original product pages.
11. Final report
When finished, explain in simple language:

* How the product URLs were originally stored or why they were missing.
* What you changed in the collection pipeline, backend, database, or frontend.
* Where users can now click to verify products.
* Whether the links were checked against actual source product pages.
* Which tests passed.
* Whether the feature has been deployed and verified on the live website.
* Any products for which a valid source URL remains unavailable.

Do not invent URLs, make assumptions about products you could not verify, or claim deployment success without evidence.
Final objective: Customers using Shelfwatch should be able to click the products and competitor price cards shown in Price Comparison and independently verify the corresponding products on their actual original websites.
