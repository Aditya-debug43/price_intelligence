# Limitations and status

Read this with [verification-report.md](verification-report.md) (what was actually run), [integrations.md](integrations.md) (the truthful
integration checklist) and [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) (the verdict). Status words are those defined at the top
of `integrations.md`. As of 2026-10-23 (after the exhaustive audit; the 2026-10-19 real-data results below still stand).

**The product is not claimed to be production-ready; it is deployed as a demonstration (backend on one small AWS EC2 instance since 2026-10-26, web app on Vercel).** The whole chain has been verified on four real Aruba grocery shops
(own shop + three competitors) on the development machine, and real Gmail accepts the app's mail; nothing has been hosted, and the review of
matches is still a human job because no shop publishes barcodes or brands.

## What was verified against the real world

| What | How | Result |
| --- | --- | --- |
| **Your shop and three competitors** (groceriestogoaruba.com, shop.lingandsons.com, foodstore2go.com, quickmartaruba.com) | 2026-10-19: complete collection of 2,381 / 1,850 / 863 / 2,566 products through public Shopify `products.json` and the WooCommerce Store API, 5–29 requests each at 1.5 s pacing, robots.txt obeyed; stored prices compared with the live product pages (24 pairs); displayed differences recomputed independently (AWG ÷ 1.79); report and exports compared with the comparison page | Tested against real external services — see the verification report's "Real-data audit" |
| Gmail | STARTTLS sign-in, a test message, the verification email, daily summaries and failure digests accepted and recorded `sent` with Message-ID | Tested against a real external service (acceptance); inbox arrival unconfirmed |
| Public scraping sandboxes | `npm run test:live` on 2026-10-18: a static shop collected by listing pages (GBP), a WooCommerce shop, and a site whose robots.txt forbids the page given (blocked, 0 pages read); 40 of 40 stored observations found in the raw page | Tested against a real external service |
| Exchange-rate provider | Real requests to open.er-api.com | Tested against a real external service |
| PostgreSQL 18 (migrations, row-level security, queue, roles) | Embedded real database in every test and in development; the production bundles against it | Tested against a real local service |
| Production bundles (API + worker + web) | `NODE_ENV=production`, 18-check smoke test, browser sign-in | Tested locally; **not on a server** |
| Real Chrome (headless rendering) | `browser.test.ts` against local pages | Tested against a real local service |
| SMTP delivery logic | A real SMTP server library in the test process (authentication, STARTTLS rules, rejected recipients, dropped connections, retries) | Tested against a real local service |

## What was verified only against fictional sites, stand-ins and mocks

Roles and invitations; row-level-security isolation tests; SSRF-safe, robots-aware collection (including every sub-request and WebSocket of a rendered page);
failure modes of collection; own-site stock alerts with an open → acknowledged → resolved lifecycle (against a stand-in for an authorised inventory);
marketing observation with engagement counts, token health, quota and rate-limit backoff; retention; flyer reading; the structural/contrast/keyboard
audit of the web interface. The fictional websites live only in `tests/support` and cannot be reached by the running product
(see [DEMO_REMOVAL_AUDIT.md](DEMO_REMOVAL_AUDIT.md)).

## The largest remaining gaps

0. **Collecting the competitors needs their permission, and the terms say so.** Their public terms of use *forbid* automated access (Quickmart: "spider, crawl, or scrape"; Super Food Plaza: "spiders, robots") or *restrict* copying and commercial use (foodstore2go, Ling & Sons). robots.txt allows the pages, but robots.txt is not the whole of "permission". Shelfwatch now reads the terms and refuses to collect from a website whose terms forbid automated access unless the owner's written permission is recorded. In the 2026-10-23 audit **no competitor was collected**; the competitor data held was collected on 2026-10-19, before this check existed.
1. **The deployment is a demonstration, not a production setup.** It runs on a single `t3.micro` (913 MB RAM) with PostgreSQL on the same machine; the public IP is not fixed (a stop/start changes it and breaks the hostname, certificate and Vercel rewrite until redone); backups sit on the same disk; there is no monitoring or alerting and no load test. Open sign-up lets anyone register and have this server read websites they add. See [deployment.md](deployment.md).
1a. **A store's admin count can be larger than what Shelfwatch collects.** Shelfwatch reads only what a store publishes (its product feed and sitemaps). Drafts, archived products and products not sold through the website are not public, so no public collection method can see them; for groceriestogoaruba.com the public catalogue is 2,381 products (2,385 variants) against an admin count of 3,116. Every collection result now says what its number covers. Reconciling the difference exactly needs the owner's own Shopify admin breakdown or the authorised Shopify connection.
2. **Matches need a person.** None of the four shops publishes a barcode, and their "vendor" fields are not brands (see below), so every match rests on name + size.
   The app proposes (235 identical, 661 comparable, 41 different-pack) and never confirms by itself; bulk review exists. Of the 235 identical matches accepted in the test workspace
   in one bulk action, 24 were checked against both live pages; 4 carried a vintage year on one side only (now flagged by a rule added after the audit; their acceptance stands because a person's decision is never overwritten).
3. **Two named competitors cannot be collected.** shop.superfoodaruba.com is a JavaScript (Freshop) storefront whose prices use the `ƒ` symbol, whose robots.txt asks for a 10 s crawl delay **and whose terms of use forbid robots and spiders**;
   www.lingandsons.com is an information site with no catalogue (the shop is `shop.lingandsons.com`; since 2026-10-26 Shelfwatch says so itself, names the shop its menu links to, and offers a button to add it — the customer's click, never automatic; its "VIP Deals" file is empty today). Both appear as "not available", never as "no match". A fourth competitor's URL ("Cmart") was never supplied and has not been guessed.
4. **Real-data blind spots:** the own shop's feed reports every product available (2,385 in stock, 0 low or out), so own-stock alerts have only run on fixtures; no real flyers; retention on real data.
5. **Email arrival is unconfirmed.** Gmail accepted every message, but nobody has yet confirmed they reached the inbox, opened the link, or run a password reset through Gmail.
6. foodstore2go.com appears to be a Bahamas-based shop (not verified); its prices may not be a meaningful benchmark for Aruban customers.

## Brands, barcodes and vendor labels

Shopify's `vendor` field is often not a brand: on these shops it was "Aruba" (2,296 of the own shop's 2,381 products), Shopify's own placeholder "Your Brand" (837 of 863 at foodstore2go), or the shop's own name (Ling & Sons).
A vendor shared by many products and rarely present in titles, or a placeholder word, is cleared into `vendorLabel` and not used as a brand. Brand-based confidence is therefore unavailable on these shops, and **a missing brand is shown as missing, not guessed**.
WooCommerce gave no brand or GTIN. A brand can still be inferred from titles *within a shop that has real brands*.

## Implemented but not verified here

| Item | Why unverified |
| --- | --- |
| Gmail delivery to the inbox | Gmail accepted the messages; arrival, the verification link and the reset email need the owner to look. |
| Headless-browser rendering on **real websites** | Verified with real Chrome against local test pages only. Residual risk: DNS rebinding between the browser's own resolution and our check cannot be closed in application code — run rendering workers behind an egress firewall. |
| S3-compatible storage on a **real** service | Tested through the AWS SDK against an in-process S3-compatible fake. Never run against AWS S3, Cloudflare R2 or MinIO. |
| Production bundles on a **server** | Run locally with `NODE_ENV=production` (18/18); not under load or for a full schedule cycle. |
| `Dockerfile`, `docker-compose.yml` | Written without Docker available; **never built or run**. |
| Backup **restore drill** | Written in [deployment.md](deployment.md); **not executed** (no `pg_dump`/`pg_restore` on the development machine). |
| Graceful shutdown with a real `SIGTERM` | Covered by unit and end-to-end tests; not exercised with a real signal (Windows development machine). |
| Accessibility beyond the automated audit | A screen reader, tablet width, hover/focus-state contrast and non-Chromium browsers were not checked. |

## Needs credentials or approval nobody has granted

| Item | What is missing |
| --- | --- |
| Collection from Quickmart, Super Food Plaza, foodstore2go, Ling & Sons | The owners' written permission (or a product feed), recorded under Websites → site → Confirm collection rules; or your informed decision for the two whose terms only restrict copying. |
| Deployment to AWS | AWS CLI/credentials configured locally by you (never pasted in chat), the existing environment's description, and your approval for any new resource, DNS or cost. |
| Email delivery — remaining step | Confirmation that the messages arrived. The App Password was pasted into chat: rotate it. |
| Shopify inventory | App credentials (`SHOPIFY_CLIENT_ID/SECRET/REDIRECT_URI`), `TOKEN_ENCRYPTION_KEY`, and the merchant's authorisation. The flow is tested end to end against a local imitation; it has never talked to Shopify. |
| Instagram / Facebook | A Meta app; Instagram needs a token from your own professional account and (for production) App Review + Business Verification; Facebook public Pages need "Page Public Content Access". A user token is renewed by a person (a system-user token does not expire). |
| YouTube | `YOUTUBE_API_KEY` (quota 10,000 units/day). |
| AI summaries / adjudication / extraction fallback | `ANTHROPIC_API_KEY` and your approval of the cost. The product is complete without it; every AI number is checked against stored facts. |
| Hosting and a managed PostgreSQL | Your choice and your payment; nothing has been purchased or created. |

## Not implemented

- Price recommendations and billing (out of scope).
- OCR for image-only flyers (reported as "no text layer", never guessed).
- Engagement **history** (only the latest public counts per post are kept, with their own observation time).
- Match "learning" across workspaces, finer permissions than owner / admin / staff, and dedicated adapters for Magento, PrestaShop and BigCommerce.
- Automatic renewal of a Meta user token (it cannot be stored securely without a credential vault).
- Brands, barcodes and descriptions from **listing pages**: a shop collected only through its listings yields names, prices and availability, so more of its matches need review (stated on the website's page and in its capability report).
- Collection from a catalogue that exists only behind a login, a CAPTCHA, a robots.txt rule or a crawl delay the product does not honour: reported as *blocked/unavailable*, never worked around.
- A frontend hosted on a **different origin** from the API (see [deployment.md](deployment.md#where-the-web-app-can-live-read-before-choosing-hosting)): the app is single-origin by design.

## Known behaviours to be aware of

- Name-only product matches are capped below certainty (0.72 when no brand is named) and wait for review. A flavour, variety, vintage-year or pack difference keeps a pair out of "identical".
- A size is read from the title, then the variant, an explicit `size` attribute, then a shop's own `Size_9oz`-style tag. A product with none of these stays size-less and is never called identical to a sized one (45 of 2,385 of your variants). A size that is obviously a data-entry slip (over 25 kg / 25 L for one unit) is ignored.
- A model or product-line number (1800), a vintage year, or a numbered size (Size 4, Stage 2) present in only one name sends a pair back to review. The same product in another size is "same product, different pack" and is compared per unit.
- Sizes and units already stored for a competitor were computed by the parser of the day; they refresh on that competitor's next collection (matching itself re-reads titles, so new rules apply immediately).
- A report is **partial** whenever any active competitor was never collected (rules unconfirmed, terms forbid it, blocked, failed) — not only when a confirmed one failed.
- The price comparison page shows **confirmed matches only** by default, with a notice of how many proposed pairs wait for review.
- A standing "regular price" shown on nearly every product is treated as a display, not as sales; the run says so.
- Authorised inventory outranks the public "in stock / sold out" flag; disagreements are flagged on the Stock page, not silently resolved.
- Competitor catalogues are refreshed within a request budget and crawl delay; very large catalogues are only partly fresh at any moment, and coverage is always stated.
- A website is tracked as a whole. If you give a page inside it (`/shop`), robots.txt is checked for that page (a forbidden page blocks the website) and the shop is looked for there first; the rest of the website is not ignored.
- A source product with no counterpart is listed as such; it is not "cheaper" and not "zero". Whether the competitor's catalogue was read completely is stated next to it.
- Mail to reserved addresses (`.test`, `example.*`) is never handed to a real mail server (it would only bounce); it is recorded as failed with the reason.
- Observed marketing content is never described as a paid campaign; summaries describe a pattern only when enough items support it.
