# Verification report

Last full run: **2026-10-19, after the real-data audit (directive 4)**. Everything below was actually executed unless marked otherwise.
Status words are the project vocabulary defined at the top of [integrations.md](integrations.md). Four kinds of evidence are kept apart on purpose:

| Kind | Meaning | Examples here |
| --- | --- | --- |
| **Real external** | Real websites, real mail server, real provider, real clock | the four shops you named, the Gmail account, open.er-api.com, public scraping sandboxes |
| **Automated test** | Code run by `vitest` against a real PostgreSQL | 798 tests |
| **Fixture** | Fictional `.test` shops served inside tests; never reachable from the product | `tests/support/fixtures` |
| **Mock / library-in-process** | A real library talking to a fake peer (SMTP, S3, OAuth) | `email-smtp`, `shopify-oauth`, `s3-storage` |

**Nothing has been deployed.** No AWS access exists on the development machine, so no claim below is about a hosted environment (see [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md)).

## Automated checks

| Check | Command | Result |
| --- | --- | --- |
| Tests (unit + integration + end-to-end; embedded PostgreSQL 18; fictional sites served inside the tests; 6 real-Chrome tests; real SMTP library in process) | `npx vitest run` | **798 passed, 0 failed, 48 files** (final run on 2026-10-19 on the exact code that was pushed; it was 760 in 44 files before this audit) |
| Live procedure (real websites and the real FX provider; opt-in, sends real requests) | `npm run test:live` | Ran 2026-10-19 against the four named shops (exhaustive procedure, `LIVE_SOURCE_URL` / `LIVE_COMPETITOR_URLS`); record in `.data/live-runs/` (git-ignored) |
| Typecheck, all workspaces, plus `tests/` and `scripts/` | `npm run typecheck` | Clean |
| Lint | `npm run lint` | 0 errors, 2 intentional `any` warnings (`connectors/src/extract.ts`, `services/src/jobs.ts`) |
| Production builds (web, API, worker) | `npm run build` | Succeeds |
| **Production bundles run** | `node apps/api/dist/main.js` and `node apps/worker/dist/main.js` with `NODE_ENV=production`, https `APP_BASE_URL`, `SERVE_WEB=true`, against the real-data database | **18 of 18 checks passed** (see "Production-bundle smoke test"). Docker was not involved |

Added by this audit (38 tests): real-shop title shapes, bulk match review (10), placeholder-brand detection, standing "regular price" detection, pack notation, vintage years, reserved-address mail guard, sitemap/listing fixes, and static-file caching (3). Per-file counts: `npx vitest run --reporter=verbose`.
Known harmless noise: Vitest sometimes prints "close timed out after 10000ms" after all tests pass (exit code 0) — slow shutdown of the embedded PostgreSQL.
Integration test files run sequentially against **one shared database**, and the scheduler and retention are global by design, so tests scope their runs and `harness.close()` switches off the schedules of the workspaces it created.

## Real-data audit (2026-10-19) — your shops, real prices

### What was collected, and on what basis

You named these websites in chat on 2026-10-19: **groceriestogoaruba.com** (your shop) and the competitors **shop.lingandsons.com / www.lingandsons.com, foodstore2go.com, shop.superfoodaruba.com, quickmartaruba.com**.
Nothing was invented: each address was typed by you; on your instruction I recorded the collection-rules confirmation for each through the throwaway test account (the app stores name and time — it is the customer's own statement that they may read public pages, **not** the competitor's approval); and the collector checked `robots.txt` before requesting anything. A "Cmart" address was never given, so none was guessed or collected.
Only public product endpoints were read, at the product's polite default of 1.5 s between requests per host. The latest complete run of each shop used 5, 9, 11 and 29 requests.

| Website | Platform / method | Currency | Result | Products / variants |
| --- | --- | --- | --- | --- |
| groceriestogoaruba.com (own shop) | Shopify `products.json` | USD | complete | 2,381 / 2,385 |
| shop.lingandsons.com | Shopify `products.json` | **AWG** (Aruban florin) | complete | 1,850 / 2,126 |
| foodstore2go.com | Shopify `products.json` | USD | complete | 863 / 878 |
| quickmartaruba.com | WooCommerce Store API | USD | complete | 2,566 / 2,570 |
| shop.superfoodaruba.com | JavaScript storefront (Freshop), prices with the `ƒ` symbol, `robots.txt` asks for a 10 s crawl delay | — | **not collectable** — shown as "unavailable", never as "no match" | 0 |
| www.lingandsons.com | information site, no product catalogue | — | **not collectable** — same | 0 |

Variants with no usable price (stored as empty, excluded from comparisons rather than shown as $0): 15 at foodstore2go, 9 at Quickmart, 1 at Ling & Sons.
foodstore2go.com appears to be a Bahamas-based shop (not verified). If it does not serve Aruba, its prices are not a useful benchmark — that is your call; the app compares what it is told to.

### Pipeline checks, one by one

| Step | Result on real data |
| --- | --- |
| Names, prices, variants, sizes, URLs, observation time collected and stored in the right workspace | ✅ every stored product has its own page URL, a time and an evidence row; the data sits only in the workspace that collected it (cross-tenant probes from another account: 404) |
| Normalisation of names, sizes, packs, currencies | ✅ after the fixes below. AWG shown with its original price and the converted USD value |
| **Brands** | ⚠️ **No usable brand exists on any of the four shops.** The Shopify "vendor" values were not brands: "Aruba" on 2,296 of your 2,381 products (plus "GroceriesToGo Aruba", "groceriestogoaruba"), **"Your Brand"** (a Shopify placeholder) on 837 of foodstore2go's 863, the shop's own name on all 1,850 Ling & Sons products but one ("Acme"). WooCommerce gave none. They are no longer treated as brands (kept as `vendorLabel`), so matching says plainly "neither product names a brand" |
| **Barcodes** | ⚠️ none on any shop (0). Matching therefore rests on name + size only |
| Match suggestions | 235 identical, 661 comparable, 41 different-pack — **every one needs a person**; nothing is auto-confirmed without a barcode or brand |
| Review of uncertain matches | ✅ the review page and a **bulk accept** (by class and minimum confidence, with a dry run and an audit event) were used on real data: the 235 identical matches in the test workspace were accepted in **one bulk action** after the 24-pair spot check below, not one by one. The other 702 stay unreviewed and are in no conclusion |
| Price differences and unit prices | ✅ checked independently, below |
| AWG → USD | ✅ Ling & Sons prices (AWG) divided by the fixed peg 1.79; the app's difference equals the independent calculation for every Ling pair checked |
| "No match" vs "can't see that shop" | ✅ Super Food Plaza and www.lingandsons.com read "not available — not supported by this website" in the table, the dashboard shows 4 of 6 websites complete, and the report is marked **partial** with a named warning |
| Report ↔ comparison | ✅ the generated report (PDF, Excel and CSV exports included) held the same observations and figures as the comparison page; it is a saved snapshot |

### Independent check against the live product pages (24 pairs)

For 24 pairs of the "identical" class (random picks from each competitor plus named products), I fetched **both live product pages** (polite pace) and read the price from each page's own structured data, independently of the collector, then recomputed the difference after converting AWG at 1.79 and compared it with what the comparison page/API displayed.
**22 of 24 agree on both prices and on the difference to the cent.** The two that did not were not defects of the comparison: one was my script reading the default 375 ml variant of a page whose stored variant is the 1 L (the 1 L variant page shows the stored price); the other pair was removed by the improved matching rules after the check.

A selection (all are "identical" pairs; the competitor's size is taken from its own title or "Size" option):

| # | Your shop (USD) | Competitor | Same product? | Conversion | Difference (calc) | App showed | Both pages |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Absolut Vodka 1L — 60.75 | Quickmart: Absolut Vodka, 1L — 56.40 | yes (brand name, 1 L) | none | −7.16 % | −7.16 % | ✅ ✅ |
| 2 | Hunt's Tomato Ketchup 24oz — 4.62 | Quickmart: Hunt's Tomato Ketchup, 24 oz — 3.90 | yes | none | −15.58 % | −15.58 % | ✅ ✅ |
| 3 | Welch's Fruit Juice Cocktail Concord Grape 59oz — 4.95 | Quickmart: same name, 59 oz — 7.20 | yes | none | +45.45 % | +45.45 % | ✅ ✅ |
| 4 | Turkey Breast 500g — 11.09 | Quickmart: Turkey Breast, 500g — 11.10 | yes | none | +0.09 % | +0.09 % | ✅ ✅ |
| 5 | Corona Extra Can 12oz, 12ct — 64.10 | Quickmart: Corona Extra Can, 12-12 oz — 39.99 | yes (12 × 12 oz both sides) | none | −37.61 % | −37.61 % | ✅ ✅ |
| 6 | Pepsi 20oz — 3.24 | Ling & Sons: Pepsi 20 oz — Afl 1.99 | yes | 1.99 ÷ 1.79 = $1.11 | −65.69 % | −65.69 % | ✅ ✅ |
| 7 | Lemon Bag 2lb — 7.41 | Ling & Sons: Lemon Bag 2LB — Afl 10.99 | yes | = $6.14 | −17.14 % | −17.14 % | ✅ ✅ |
| 8 | Mott's Original 100% Apple Juice 64oz — 7.71 | Ling & Sons: Motts Apple Juice 100% 64 oz — Afl 11.10 | yes | = $6.20 | −19.57 % | −19.57 % | ✅ ✅ |
| 9 | Onions Red Bag 2lbs — 5.38 | Ling & Sons: Red Onions Bag 2lb — Afl 6.49 | yes | = $3.63 | −32.61 % | −32.61 % | ✅ ✅ |
| 10 | Patron Silver Tequila 750ml — 95.04 | foodstore2go: Patron Silver Tequila (Size: 750 ML) — 87.99 | yes | none | −7.42 % | −7.42 % | ✅ ✅ |

"Both pages ✅" means the price on the live product page equals the stored price. The "Same product?" column is **my reading of both product pages**, not something the app can prove without a barcode: every one of these pairs still carries "Neither product names a brand, so identity rests on the name and size alone" in the app.

Products the matching rules correctly kept **apart** (each now has a regression test):

| Pair | What the app does |
| --- | --- |
| Corona Extra Can 12oz (single) vs Corona Extra Can, 12-12 oz | different pack — compared per unit, not as identical |
| Poland Spring 3 L vs 6 × 500 ml | different pack (same total) |
| Silk Almond Original vs Silk Almond Unsweetened; Almond Breeze Vanilla vs Original; Land O'Lakes vs Light butter spread; Pepperidge Farm Whole Wheat vs 15 Grain | comparable, waiting for review (flavour/variety differs) |
| Kim Crawford Sauvignon Blanc **2013** vs an undated listing | comparable, waiting for review (**new rule, added after the audit found it**: a vintage year in only one name) |

**A real gap the audit found and I closed late:** 4 of the 235 identical matches carried a vintage year on one side only (Yellow Tail Pinot Grigio 2015 at Ling & Sons and Quickmart, Kim Crawford Sauvignon Blanc 2013 at foodstore2go, Kendall-Jackson Chardonnay 2014 at Quickmart). The new rule would have sent them to review; in the test workspace they had already been accepted in the bulk action, and the app never overwrites a person's decision, so they stay accepted there. They are **not** counted among the verified examples above.

### Problems the real data exposed (all fixed, each with a test)

1. **Junk "brands".** Shopify vendor values such as the shop's own name or "Aruba" were used as brands, so unrelated products looked same-brand. A vendor shared by ≥ 20 products and rarely present in titles, or a placeholder word, is now cleared into `vendorLabel`; matching and the product page then say "no brand".
2. **$0 prices** stored as real prices → now empty, never compared.
3. **A standing "regular price" shown as a discount.** One shop displays a regular price about the same percentage above its selling price on nearly every product; each was being counted as a sale offer. Detected (≥ 90 % of products, uniform mark-up, ≥ 20 products) → no per-product sale offers, and the run says why.
4. **Pack notation** "12-12 oz" (12 × 12 oz) read as a size of 12 oz; a stated pack that disagrees with the parsed one is flagged and never "verified".
5. **Fluid vs weight ounces** (59 oz of juice): the shop's own category tags now decide.
6. **Flavour / variety / vintage conflicts** and **single vs multipack** no longer reach "identical".
7. **Everything needed a person**, so a review burden of hundreds → bulk accept with dry run and audit; the price comparison now **defaults to confirmed matches only** with a visible "N proposed pairs wait for review" notice.
8. **Reserved-domain recipients** (`.test`, `example.*`) were sent through Gmail and bounced into the sender's inbox → refused locally with the recorded reason `unroutable_recipient`.
9. Smaller: WooCommerce `product_cat-sitemap.xml` was treated as products; the `ƒ` florin symbol was not recognised in listing prices; page counters now come from the crawl queue.
10. **Found by the production smoke test:** content-hashed build files were served with `max-age=0`; now `immutable, max-age=31536000`, and the app shell is `no-cache`.

### Other features, and how each was verified

| Feature | Verified how | Result |
| --- | --- | --- |
| Registration, email verification, sign-in, sign-out | real Gmail SMTP + real HTTP API + browser | ✅ verification email accepted by Gmail (Message-ID recorded). **Arrival in your inbox is not something I can see** — please confirm |
| Daily schedule in `America/Aruba` (report ready by 09:00, collection planned from the measured run times) | the real worker running for hours with the real clock | ✅ real daily runs happened and sent 3 summary and 4 collection-failure digest emails through Gmail (all recorded `sent`); next run shown as 2026-10-20 09:00, collection planned from 07:38 |
| Offers | real data: 149 sale prices + 2 banners found, all "unverified" (observed, not proven), values checked against pages | ✅ — flyers / PDFs from a real site: ❌ not available |
| Own-store stock alerts | the shop's public feed says every product is available (2,385 in stock, 0 low, 0 out), so no alert could fire | 🟡 logic verified by fixtures only; real low-stock data needs your authorised inventory connection |
| Report generation and exports | real data: PDF, Excel, CSV, history list, partial-report labelling | ✅ |
| Tenant isolation / access control | cross-tenant requests, missing CSRF header, foreign Origin, unauthenticated reads against the real API | ✅ 404 / 403 / 401 as designed; row-level security tests |
| Retention | fixtures only | 🟡 |
| Social integrations (YouTube, Instagram, Facebook), Shopify authorised inventory, Anthropic, S3 | mocks only; no credentials | 🔒 not verified against the real services |
| Missing credentials | shown as "not set up" with what is needed | ✅ |

### Screens (in-app Chromium browser, real data, signed in as the throwaway test account)

Opened and read at 1280 px: dashboard, websites list, a website's page (Ling & Sons), products list, a product page (Absolut Vodka 1L with its matches), match review (including the bulk-accept dialog with "Accept 235 identical matches?"), price comparison, offers, my stock, alerts, data quality.
At **375 px**: dashboard, price comparison, match review, reports list, a report, settings — no sideways page scroll; the comparison table scrolls inside its own container. Reports and Settings were read at 375 px only (not at desktop width).
What I looked for and found: values equal to the stored observations; green only where a website was really collected (4 green "Collected", the two others "unavailable"); the empty/partial state is stated (partial report, "4 of 6 websites complete"), never presented as success; original currency shown next to converted; observation times on every row; source links work. Console: no errors on the production bundle; the development stack logged one transient 502 while I restarted its API (not reproduced).
**Not covered:** tablet width; a screen reader; Safari/Firefox; a real phone; Products, Offers, Websites, Alerts, My stock and Data quality at 375 px after the changes (the 2026-10-15 audit covered the structure of 18 views at 375 px on a fixture workspace).

### Production-bundle smoke test (local; not a deployment)

`NODE_ENV=production`, `APP_BASE_URL` an https address, `SERVE_WEB=true`, email deliberately unset, run from `dist/` against the real-data database: **18 / 18** — `/health` 200; `/ready` 200 with database, **all 11 migrations applied**, row-level-security role, queue, **worker heartbeat 0 min ago**, storage, secrets key; the only "degraded" item was the email I had switched off, with plain advice; no connection strings or keys in `/ready`; the web app, deep links and hashed assets served; unknown `/api` paths are JSON 404; security headers (nosniff, frame-deny, HSTS); sign-in without the CSRF header refused, from a foreign Origin refused (403), wrong password 401; the session cookie is `HttpOnly; Secure; SameSite=Lax`; an authenticated comparison read worked. A real browser then signed in on the production bundle and opened the dashboard and price comparison with no console errors.
**Important design fact:** the web app calls the API with relative paths (`/api/v1/…`) and a same-origin cookie. It has no setting for a different API address, and it is **not** meant to be hosted on a separate origin (for example GitHub Pages) without a reverse proxy that forwards `/api/*` to the API. See [deployment.md](deployment.md).

## Real-network verification before the audit (`npm run test:live`, 2026-10-18/19)

Real DNS, TLS, robots.txt and pages; the production fetch policy and pacing (1.5 s per host); the real clock; a real PostgreSQL. Public sandboxes made for scraping practice:

| Website | What the collector did | Result |
| --- | --- | --- |
| `https://books.toscrape.com/` (static shop, no feed, no sitemap, no structured data) | strategy `listing-crawl`; sample of 40 products, GBP detected | 40 products stored with name, price, currency, availability, own page URL and the listing page as evidence; stopped by design (sample), never marked complete |
| `https://scrapeme.live/shop/` (WooCommerce) | strategy `woocommerce-store-api` | 40 products stored |
| `https://www.scrapingcourse.com/ecommerce/` (robots.txt: `Disallow: /ecommerce/*`) | the page typed is checked against robots.txt first | Profile **blocked**, **0 pages read**, 0 products stored |

For every stored observation (40 of 40) the stored price and name start were found in the raw page copy — 0 mismatches; 3 of 3 re-fetched pages still showed the stored price. One call to open.er-api.com returned 164 rates; the AWG peg (1.79) stays a stated constant.
What these runs found that fixtures could not (all fixed): a shop whose listing starts on its home page failed on every later page; the page typed was dropped so a forbidden shop looked "limited"; a rule for `/shop/` did not stop `/shop`; a catalogue forbidden by robots.txt was reported "limited" rather than blocked; page counters under-reported.

## The requested scenarios, and the test that covers each

| Scenario | Where it is verified |
| --- | --- |
| Registration, verification, reset, resend, expired / reused / replaced links, lockout, enumeration resistance, sessions, change password | `auth` (32), `email-smtp`, `smtp` |
| Email delivery states, retries, failures, no configuration, reserved addresses | `email-smtp`, `auth` (delivery failures/retries, the Settings panel) |
| No demo, simulator or fixture can reach a workspace | `real-product-only` (18), `domain` (removed settings are ignored), source scan for removed identifiers |
| Any real URL; unsafe URLs refused with a reason; entry page kept | `api`, `live-journey` §2 (11 unsafe/odd URLs), `safe-fetch` (67), `url-ip-robots`, `listing-collection` |
| Collection rules (the customer's confirmation) gate collection; revocation stops it | `api`, `honest-controls`, `live-journey` |
| Shops without feed or sitemap collected from listings; resumable; partial vs complete with reasons; counters | `listing`, `listing-collection` |
| robots.txt forbidding product pages or the typed page → blocked, never requested | `listing-collection`, `safe-fetch`, live run (scrapingcourse.com) |
| Multiple websites, partial failures, unavailable competitors never shown as "no match" | `live-journey`, `scheduler`, `reports`, `honest-controls`, real data (Super Food Plaza) |
| "No equivalent found" worded from catalogue coverage | `assortment`, `listing-collection`, `api` |
| Real shop title shapes: placeholder vendors, $0 prices, standing "regular price", flavour/variety/vintage/pack conflicts | `real-data-shapes` (5), `brands`, `offers-uniform`, `domain` (real grocery titles), `parsing` |
| Duplicate products, incorrect matches, bulk review, changing prices, expired promotions, stock transitions | `pipeline`, `match-review` (incl. bulk accept), `live-journey` §7–§8, `offer-review`, `stock-alerts`, `alert-lifecycle` |
| Missing credentials | `live-journey` §10, `social-providers`, `shopify-oauth` |
| Cross-tenant access | `live-journey` §11 (404 on 16 paths + zero rows at the database), `api`, `database` (15 RLS tests), `invitations`, `alert-lifecycle`, `offer-review` |
| Restart safety / stuck work, retention, readiness (incl. email) | `scan-recovery`, `scheduler`, `lifecycle`, `retention`, `readiness` |
| Production configuration refuses an unsafe setup (token key, worker role, non-https `APP_BASE_URL`) | `domain` |
| Serving the web app from the API: app shell never cached, hashed assets cached for a year, JSON 404 under `/api` | `web-serving` (3) |

### The live-workspace journey (`tests/e2e/live-journey.test.ts`)

Runs through the **real HTTP API** with websites on ordinary public hostnames (`mine.test`, `rival-woo.test`, …) that pass the production public-host policy — no loopback exception, no fixture flag. Only the last network hop is imitated (the fetcher's `transport` hook serves each hostname from a local fictional site); URL validation and the SSRF policy still run. It asserts, among other things, that every stored page copy, price and stock reading is `public_web` provenance. **What it does not prove:** that any real website behaves like these imitations (the real-data audit above is the evidence for that), or the connect-time DNS validation (bypassed by the transport hook; covered by `safe-fetch.test.ts`).

## Browser verification of structure, contrast and keyboard (2026-10-15, fixture workspace)

- **Structural audit, 18 views at 1280 px and 18 views at 375 px:** every link/button/control has an accessible name, every field a label, every table header cells, exactly one `h1`, no duplicate ids, a title, no sideways page scroll.
- **Colour contrast, 21 signed-in views + the sign-in, register, forgot-password and invitation pages:** 0 failures after fixes.
- **Keyboard (the product-picker dialog):** focus, Tab trap, Escape, focus return.
- **Long names:** 250-character sentence, 120-character unbroken string, emoji and right-to-left text at both widths.

Defects this found and fixed: the page title never changed; two tables without header cells; the dialog stole focus on every re-render; contrast failures; an unbroken long name widened the whole page.
**Not covered:** a screen reader; tablet width; hover/focus-state contrast; any real device; Safari/Firefox. Screens added or changed since then (registration/verification/reset, Settings email panel, bulk-accept dialog, the comparison's "confirmed only" notice) were read on real data in the audit above, but the contrast audit was not repeated on them.

## Integrations exercised without a live service (no key, no cost)

| Integration | Test | What it covers |
| --- | --- | --- |
| Gmail / SMTP | `smtp`, `email-smtp`, `auth` — **and real Gmail on 2026-10-19** | A real SMTP library against a test server: authentication, STARTTLS rules, rejected recipients, dropped connections, retries, recorded Message-ID and answer; Gmail-specific rules and error advice. **Real Gmail accepted** the sign-in, a test message, the verification email, daily summaries and failure digests; inbox arrival is for the owner to confirm |
| Shopify | `shopify-oauth` (8) | Authorize URL (read-only scopes, myshopify.com only); callback rejected when unsigned, tampered, from another user, for another shop, or replayed; encrypted expiring tokens; sync; refresh; disconnect revokes and wipes tokens |
| YouTube, Instagram, Facebook | `social-health`, `social-providers`, `integrations` | Engagement counts (not provided = `null`, never 0); quota/rate-limit/revoked/expired/missing-approval classified; persisted backoff; Meta token health |
| S3-compatible storage | `s3-storage` (3) | put/get/head/delete through the AWS SDK against an in-process S3-compatible fake |
| Headless browser | `browser` (6) | **Real Chrome** on local pages: JavaScript content extracted, robots honoured, sub-requests **and WebSockets** to private/metadata addresses blocked |
| Anthropic API | `providers` (5) | Request shape, text-only extraction, status-only errors that never echo the key |
| open.er-api.com | `providers` (5) **and real calls** | Client behaviour; the real answer was fetched and stored with its source and time |

These prove our client code and error handling. They do not prove that the real services accept our requests (credentials, quotas, App Review).

## Real defects found by verification, across the work

Collection and security: headless-browser page **WebSockets bypassed request screening** (fixed); a **blocked/unreachable competitor was shown as "no match found"** (now "not available — <why>"); a robots rule for `/shop/` did not stop `/shop`; the page a customer typed was dropped; a shop whose listing starts on its home page failed on every later page.
Reliability: scan recovery was **uncapped and an orphaned queued scan blocked its website forever**; **one failed storage delete aborted retention for every workspace**; a stored profile without a strategy crashed the whole scheduler pass; a second shutdown signal after a fatal error hid the failing exit code; page counters under-reported a stopped run.
Honesty: the readiness endpoint would have repeated raw SQL from database errors to the public; a password reset marked an address verified when the "email" only sat in a development outbox; **registration signed people in without verifying their address**; **"You sell, no competitor does" was claimed whether or not the competitors' catalogues had been read**; an empty-workspace report said "No significant changes…"; **a fabricated "7.4 % cheaper" example price sat on the sign-in page**; editing a website's address left the old website's data attached to the new name.
**From real shops (this audit):** junk vendor labels used as brands; $0 prices; a standing "regular price" counted as thousands of sales; "12-12 oz" read as one 12 oz; vintage and flavour differences ignored; the comparison page showed unreviewed pairs as if they were results; mail to reserved domains bounced into the sender's inbox; build files not cached.

## Not verified

- **Any deployment.** No AWS access, resources or deployment files exist on the development machine; nothing is hosted. No hosted frontend ↔ backend check, HTTPS/TLS, hosted logs or deployed worker could be examined.
- **Your inbox:** that the Gmail messages arrived, and the reset-email round trip through Gmail. Rotate the App Password you pasted in chat.
- **Own-store stock alerts on real data**, **flyers / PDFs from real sites**, **retention on real data**, **headless rendering of a live site** (Super Food Plaza needs it, and is a 10 s-crawl-delay site).
- **Shopify authorised inventory, Meta (Instagram/Facebook), YouTube, Anthropic, S3/R2/MinIO** — need your credentials.
- **Match correctness at scale:** 24 of 235 accepted identical matches were checked against the live pages; the other 211 were not individually checked.
- **Docker:** the `Dockerfile` and compose file were never built or run.
- **Backups:** the restore drill in [deployment.md](deployment.md) was not executed (`pg_dump`/`pg_restore` are not installed on the development machine).
- **Graceful shutdown with a real `SIGTERM`** (the development machine is Windows); covered by unit and end-to-end tests of the same code paths.
- **Several days of the real 09:00 `America/Aruba` schedule** and of the 12-hourly exchange-rate refresh (a day of real runs was observed; the rest is tested with an injected clock).
- **Accessibility beyond the automated audit:** a screen reader, tablet width, hover/focus-state contrast, non-Chromium browsers.
