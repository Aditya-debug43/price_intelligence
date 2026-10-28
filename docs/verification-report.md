# Verification report

Last full run: **2026-10-28, after the collection-reliability work (directive 14)**: typecheck, lint (0 errors), build and **1,061 of 1,061 tests in 69 files** passed; see "Collection reliability (2026-10-28)" below. Before that, the lasfit.com collection fix (directive 13): 1,001 in 66; see "Collection failure on lasfit.com (2026-10-28)". Before that, removing the minimum of 3 competitors (directive 12): 988 in 64; see "Competitor count (2026-10-28)". Before that, the product page links (directive 11): 974 in 62; see "Product page links (2026-10-28)". Before that, the product-count investigation (directive 10): 950 in 59; see "Product count reconciliation (2026-10-28)". Before that, the EC2 deployment (directive 9): 944 in 58; the deployed system was tested separately, see "Backend on AWS EC2 (2026-10-26)" below. Before that, the Vercel build fix (directive 8): 943 in 58. Earlier the same day: directive 7 (website removal, 934 in 57) and directive 6 (Ling & Sons, 914 in 55). Directive 6 (Ling & Sons) ran the same day with 914 in 55. Before that: 2026-10-23, the exhaustive audit (directive 5); the 2026-10-19 real-data audit (directive 4) follows it and still stands. The 2026-10-19 competitor collection predates the terms-of-use review described in the first section. Everything below was actually executed unless marked otherwise.
Status words are the project vocabulary defined at the top of [integrations.md](integrations.md). Four kinds of evidence are kept apart on purpose:

| Kind | Meaning | Examples here |
| --- | --- | --- |
| **Real external** | Real websites, real mail server, real provider, real clock | your shop and (on 2026-10-19) three competitors, the Gmail account, open.er-api.com, public scraping sandboxes |
| **Automated test** | Code run by `vitest` against a real PostgreSQL | 950 tests |
| **Fixture** | Fictional `.test` shops served inside tests; never reachable from the product | `tests/support/fixtures` |
| **Mock / library-in-process** | A real library talking to a fake peer (SMTP, S3, OAuth) | `email-smtp`, `shopify-oauth`, `s3-storage` |

**The backend was deployed to AWS EC2 on 2026-10-26** (section "Backend on AWS EC2" below). Every other section was produced on the development machine before that and makes no claim about the hosted environment (see [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md)).

## Exhaustive audit (2026-10-23) — permission first, then a fresh account on the real sites

Source: `docs/original-prompt/05_DIRECTIVE_EXHAUSTIVE_AUDIT_2026-10-23.md`. The five addresses were used exactly as supplied (`www.lingandsons.com`, not `shop.lingandsons.com`, which your original brief named and which I did **not** add this time).
Evidence kinds are kept apart: **[real]** real websites / mail server / clock, **[test]** automated tests, **[fixture]** fictional shops, **[mock]** a real library against a fake peer.

### 1. Is the intended collection permitted? (checked before any new collection)

I read each website's `robots.txt` and its public terms page(s). `robots.txt` does not disallow the product pages of any of the five (Super Food asks for a 10 s delay), but **the terms pages are stricter**:

| Website | What its terms say (quoted, read 2026-10-23) | Verdict |
| --- | --- | --- |
| groceriestogoaruba.com (your shop) | reproduction or commercial use of its materials without the owner's written permission is prohibited — it is your own shop | permitted: the owner's own site |
| quickmartaruba.com | prohibited uses include "to spam, phish, pharm, pretext, **spider, crawl, or scrape**"; and no reproducing or copying "any portion of the Service… without express written permission" | **forbids automated collection** |
| shop.superfoodaruba.com | "not to use… any engine, software, tool, agent or other device or mechanism (including… **spiders, robots**…) to navigate or search this Site" other than browsers | **forbids automated collection** |
| foodstore2go.com | the user "may not access, display, use, download, and/or otherwise copy or distribute Content obtained on the website… without the consent of the Provider" | restricts copying; permission **unclear** |
| www.lingandsons.com | no "commercial uses of our web site or service without our prior written consent"; it is an information site with no catalogue | restricts commercial use; nothing to collect |

**Consequence.** Following your instruction (permission unclear ⇒ report the blocker, do not collect), **I collected nothing from any competitor in this audit.** Only your own shop was collected. Everything about competitors below uses data **already stored** from 2026-10-19 (analysis only — no new request to any competitor), and I say so each time.
**A gap in the product the audit found:** Shelfwatch only ever read `robots.txt` and left the terms to the customer. It now reads the terms itself (footer link, then the usual paths) and — see §6 — quotes the clause, refuses collection when the terms forbid automated access unless the customer records the owner's written permission and where it is kept, and warns when they restrict copying. **My own earlier collection (2026-10-19) of Quickmart, foodstore2go and Ling & Sons ran before this check and is therefore on weaker footing than I reported; that data is still stored, and removing it is your decision (Websites → Remove).**

### 2. The customer journey with a fresh account **[real]** (browser + real Gmail)

| Step | Result |
| --- | --- |
| Registration validation | empty form blocked; 6-character password and a common password each refused with a specific message |
| Email verification | real Gmail accepted the message (`250 2.0.0 OK`, Message-ID stored); signing in before verifying is refused with "verify first" and a resend button; the first resend inside a minute is silently throttled (by design); the second creates a new link and the **old link is rejected**; the new link verifies; a wrong password gives the generic "Email or password is incorrect" |
| Workspace → setup | created; the five URLs entered as supplied (a private `127.0.0.1` address was refused with a clear per-field message while the valid entries were kept; a bare `foodstore2go.com` was normalised) |
| Website validation / profiling | own shop **Full** (Shopify feed, 2,382 estimated); foodstore2go **Full** (restricts-copying warning); Ling & Sons `www` **Limited** (no catalogue); **Quickmart and Super Food: Blocked — "Terms forbid collection"**, stopped after 3 requests (robots.txt, home page, terms page) |
| Collection rules | the dialog for a terms-forbidden competitor quotes the clause and keeps "Confirm" disabled until the written-permission box **and** a note are filled in; cancelled (I have no such permission). Confirmed for your own shop |
| Collection | a 25-product live sample ("partial: not a full catalogue"), then the full run with live progress ("500 / ~2382") |
| Products, search, filters, product page | work; search runs on Enter; an uncollected website's filter now says why instead of "No products found" |
| Price comparison | with no competitor collected it says "No competitor website has been collected… This is not a result about your prices" and lists each website with its reason — never "no match" |
| Report | generated, saved, PDF / Excel / four CSV datasets downloaded (correct type, filename, `%PDF-`, `PK`), two reports compared; the report is now **Partial** when a configured competitor was never collected |
| Settings | retention values validated (30-day minimum), saved, and **still there after reload**; Notifications, People and Integrations tabs read honestly (Shopify "not set up" with the exact variables; YouTube/Instagram/Facebook "not set up" with what is needed); the test email was accepted by Gmail |
| Sign-out / sign-in | signing out ends the session; a protected URL then redirects to sign-in with no data shown; signing in again shows the workspace as left |
| Keyboard | the consent dialog opens from the keyboard, keeps focus inside, closes on Escape and returns focus to the button that opened it |
| Every page, 1280 px and 375 px | 15 routes × 2 widths: no sideways scroll, every control labelled, one `h1` and a `main` landmark; console in a quiet window: **no errors or warnings** |

### 3. Your shop, collected completely and reconciled in full **[real]**

| Measure | Result |
| --- | --- |
| Products reported by the source | feed 2,381 products / 2,385 variants (10 pages of 250); sitemap 2,381 product URLs in 3 files — the first file also lists the home page, so a raw count says 2,382 (the profiler's estimate was off by one for that reason; fixed) |
| Stored | 2,381 products, 2,385 variants, 0 skipped, 0 failed, 0 duplicates, all with their own page URL and observation time |
| Comparison with the feed | **every** variant checked (not a sample) on price, compare-at price, availability, SKU, barcode, variant title, product title, URL and category: **0 differences**. No variant without a price |
| Product pages | 60 randomly chosen product pages read independently (JSON-LD offer for that variant): **60 of 60** agree on price, availability and title |
| Re-collection (4 full runs + 1 sample) | no duplicate products, first-seen times kept, last-seen advanced, price history appended (9,565 observations for 2,385 variants), **no spurious "price changed"** on unchanged prices |
| Work done | 11 requests per full run, 1.5 s apart, resumable |
| Brand / barcode | none (the Shopify `vendor` is "Aruba" on 2,296 products): shown as missing, never guessed; no GTIN in the feed |
| Sizes | **54 % of variants had no size the collector could read.** 1,266 of them state it only in a `Size_9oz` / `Size_1kg` tag, which the collector ignored → now read: **98.1 %** of variants have a size (the remaining 45 are "Size_0"/none: gift cards, produce) |

### 4. Matching and price comparison **[real data held since 2026-10-19; no new competitor request]**

**Calculation.** An independent calculator (not the app's code) recomputed **every confirmed comparison cell — 217 cells in 207 rows** — from the raw stored prices, the AWG peg (1.79), and package sizes: displayed prices, USD conversion, absolute and percentage difference, sign ("positive = the competitor is dearer"), unit prices (107 per L, 99 per 100 g, 11 per item) and that no struck-through "regular" price is ever compared: **0 mismatches**, run before and after the fixes below.
**Identity.** I read **all 235 accepted "identical" pairs one by one** (not a sample). Findings: 1 clearly wrong pair (Jose Cuervo *1800* Silver vs Jose Cuervo Silver), 5 vintage/ edition doubts (a 2013–2015 wine matched to an undated listing; "Dole 100%" vs "Dole"), and **7 pairs whose unit class was wrong** (ground coffee, milk chocolate, tea mix read as fluid ounces, so "per L" instead of "per 100 g"). Every one is now handled (see §6). Replaying the new rules over all 937 stored pairs: 763 keep their class and 174 change — 166 proposals become "same product, different pack", 6 accepted-identical pairs would go back to review (their acceptance stays, because the app never overwrites a person's decision), 2 proposals are dropped.
**Recall.** 1,956 of your 2,385 variants had no proposal; about half of the sample I looked at had no stated size. After reading sizes from tags, a re-run **on the competitor data already held** gives:

| | before | after |
| --- | --- | --- |
| own variants without a size | 1,293 | **45** |
| own variants with any proposed counterpart | 429 | **1,005** |
| own variants with an *identical* proposal | 207 | **605** |
| proposals (identical / same-product-other-size / comparable) | 235 accepted / 41 / 661 | 235 accepted + **432 new identical** / **294** / **1,092**, all awaiting review |

A random sample of 90 of the 432 new identical proposals: **88–89 are clearly the same product at the same size** (the doubtful ones: a Colgate "Minions" edition missing that word on one side; 292 g vs 10.2 oz). Nothing is confirmed without a person: no barcode or brand exists on these shops, so identity rests on name and size and the 0.72 confidence cap stands.
**Not forced.** Products with no stated size are never called identical to a sized one; a competitor that could not be collected is "not available — <reason>", never "no match".

### 5. Other features — what each rests on

| Feature | Verified how | Status |
| --- | --- | --- |
| Authentication, tokens, lockout, sessions, CSRF, origin check, cross-tenant 404s | 30+ end-to-end tests (`auth`, `api`, `invitations`, `live-journey`, `database`) **[test]** + the live journey above **[real]** | ✅ |
| Own-store stock: thresholds, zero, restock, unchanged, untracked, conflicts, duplicates, acknowledge, resolve | `stock-alerts` (15) + `alert-lifecycle` (16) + core tests **[fixture]**. The real feed lists everything as available (2,385 in stock), so **no real low-stock event exists**; exact quantities need the shop's Shopify authorisation | ✅ logic / 🔒 real quantities |
| Offers, regular vs sale, expiry, conditions, flyers, review | `pipeline`, `offer-review` (11), core **[fixture]**; real: your shop's standing 8 % "regular price" is correctly **not** counted as 2,000 sales; a homepage banner "We **offer** a pre-stocking service" was wrongly an offer → fixed | ✅ / flyers 🟡 (no real flyer) |
| Marketing | provider statuses read honestly; observed site banners shown "not proof of paid"; Facebook/Instagram/YouTube need credentials | 🔒 credentials |
| Reports, exports, history, comparison, partial rule | real downloads above; `reports` (21) **[fixture]**; **new** `export-safety` (17): hostile names such as `=HYPERLINK(…)`, `+cmd|…`, `-2+3`, `@SUM`, a leading tab are neutralised in all 8 CSV datasets and stored as text in Excel — **the guard existed but had no test** | ✅ |
| Schedule 09:00 `America/Aruba`, delays, interrupted workers, retries, duplicates, retention boundaries | `scheduler` (11), `scan-recovery` (16), `retention` (13) **[fixture]**; a real day of worker runs on 2026-10-19 **[real]**. Settings shows "next report 09:00, collection planned from 08:30" | ✅ / multi-day on a server 🔒 |
| Social integrations, Shopify OAuth | imitations of the provider APIs **[mock]** | 🔒 credentials |

### 6. Defects found by this audit, and their fixes (each has a regression test)

1. **The terms of use were never read** (see §1). New: `core/terms.ts`, a profiler step, `sites.written_permission` (migration 0011), consent gate, scan re-check, UI quote + permission dialog. Tests: `terms.test` (7), `terms-of-use` e2e (7), `site-status`.
2. Terms-blocked sites were labelled "Access denied" / "collection rules not confirmed", and "Automated access: permitted" contradicted the terms → "Terms forbid collection".
3. Empty states hid the reason: products list, price comparison and product "No matches — no equivalent was found at the other websites" now say which websites were **not looked at** and why.
4. A report with a never-collected competitor was labelled **complete**; it is now partial and says why.
5. The catalogue estimate counted a non-product URL (the home page in a Shopify sitemap).
6. A banner "We offer… service" counted as an offer (`promo-text.test`, 21 cases).
7. **Sizes kept in tags were ignored** (the biggest coverage loss) + data-entry slips in a tag, leading-dot decimals (".87 oz"), a nappy's baby-weight range read as pack weight (`parsing.test`, `size-in-tags` e2e).
8. Ground coffee, milk chocolate, tea mix, tuna in water read as fluid ounces (cocktail mixers and creamers correctly stay liquid).
9. Product-line numbers, vintage years and numbered sizes ("Size 4" vs "Size 5") did not keep a pair out of "identical"; the same product in another size is now "same product, different pack".
10. My own regression: a `<ul>` inside a `<p>` in the new empty states (caught by the console audit, fixed).

### 7. Not verified in this audit

Any competitor catalogue (no permission); Super Food's technical feasibility (a Freshop storefront; not probed because its terms forbid it); real flyers; real low-stock events and exact stock (needs Shopify authorisation); Facebook / Instagram / YouTube; inbox arrival of any email (I can see Gmail's `250 OK`, not your mailbox); a multi-day schedule; any deployment (done later: see "Backend on AWS EC2 (2026-10-26)"); screen readers, tablet width, Safari/Firefox.

## Product count reconciliation (2026-10-28) — "3,116 in the admin, 2,385 in Shelfwatch"

Question from the owner's professor: are products being missed when collecting groceriestogoaruba.com? Evidence kinds: **real external** (the live store's public storefront, fetched 2026-10-28), **local data** (the local copy of the collected data; same code as production), **automated test**.

| Stage | Count | Evidence |
| --- | --- | --- |
| Shopify admin count (owner's screenshot) | **3,116** (the screenshot reads 3116; the owner's text says 3,316) | Screenshot, not reproducible by Shelfwatch: it needs the owner's admin session |
| Public product feed, paged **past** the collector's stop point | pages 1–9: 250 each, page 10: 131, **pages 11 and 12: empty** → **2,381 products**, 2,385 variants | Real: `/products.json?limit=250&page=N` |
| Public product sitemaps (an independent public view) | 1,000 + 1,000 + 381 = **2,381** product URLs | Real: `/sitemap_products_*.xml` |
| Discovered by the collector | **2,381** (10 pages, 11 requests, no errors) | Local: scan run, then repeated twice more |
| Extracted / attempted / saved | **2,381 products, 2,385 variants** (one product, the gift card, has 5 variants) | Local: scan run counters |
| In the database | **2,381 products** (0 delisted, 0 duplicate ids), **2,385 variants** | Local: queries |
| Set comparison, feed vs sitemaps vs database | **0 differences in every direction** (same 2,381 handles and ids) | Real + local |
| Shown by My Stock | "2385 of 2385 **products**" — this is the **variant** count (the page joined variants to products and printed the result as products) | Code: `loadStock`; fixed |

**Conclusion.** No public product was being missed. The store's public catalogue is 2,381 products (2,385 variants); the admin's larger number (735 more by the screenshot, 935 by the typed figure) counts products that are **not public** — no public source Shelfwatch may use lists them. The likely reasons are drafts, archived products and products not sold through the Online Store, but that cannot be proven from outside: the breakdown (Status: Active / Draft / Archived, and availability on the Online Store) is in the owner's own Shopify admin, or through the authorised Shopify inventory connection (Settings → Integrations), which needs the owner's Shopify app credentials (not configured).

**Real defects found and fixed.** (1) My Stock printed variants as "products" (now: "of 2,385 items · 2,381 products"). (2) A feed run was declared complete as soon as the feed returned a short page, without checking the site's own sitemaps; a feed that ended early would have been reported as a whole catalogue (now cross-checked: the products the feed missed are read from their own pages, anything unreadable keeps the run partial with the numbers). (3) Nothing said what the collected number covers (now stated with every run: public products only; a store admin's total can be higher).

**Repeatability (real collections, local copy of the data, backup taken first).** Two collections in a row: both `succeeded`/complete via the Shopify feed, 11 requests, 2,381 discovered and saved, 2,385 variants, 0 errors, sitemap estimate 2,381 (so the cross-check made no extra request). Products and variants unchanged; the product-id fingerprint identical before and after; the 879 match decisions made by a person unchanged (fingerprint identical; 2,053 matches in all); 2 reports and 3 alerts unchanged. Price and stock observations grew by one per variant per run (2,385 each) — the design (a time series), not duplicates.

**Not done at the time: production (updated later the same day, see "Product page links").** The server could not be reached over SSH during this work (the AWS security group drops port 22 from the current address; the API itself, Vercel and the database were healthy). The changes were therefore verified locally and are ready for `sudo shelfwatch-update`; the production figures are the ones in the owner's screenshot (2,385 variants, the same as locally). See the work log.

## Collection reliability (2026-10-28) — "auxito.com stopped at 750 of 1,483"

Evidence kinds: **real external** (the owner's own websites; the production database), **automated test** (fictional websites through the real pipeline; they are fictional, written from the behaviour of real ones, so they measure the software against known situations, not the world).

| Check | Result | Evidence |
| --- | --- | --- |
| auxito.com | Pages 1–3 of 6 saved (750 products, 1,039 variants, 0 duplicates), page 4 answered HTTP 429 three times (2 s and 4 s apart), run `partial`, cursor `{"page":4}`; ten minutes later the same page answered normally (HTTP 200) | Production database (read-only) and one polite request from the server's address |
| Same pattern elsewhere | shop.lingandsons.com, the 12:30 scheduled run: 750 of 1,850, "HTTP 429" | Production database |
| Was "continue where it stopped" true? | No: a new collection started at page 1 (no cursor was carried over) | Code (`startScan`) + a test |
| Reliability measurement | **Before: 14 of 24 eligible scenarios = 58.3%** (previous commit's code, same scenarios and same test). **After: 24 of 24 = 100%.** Non-collectable websites ending in their honest state: before 5 of 8, after 8 of 8 | Automated: `tests/e2e/collection-reliability.test.ts` (results are also written to `.data/live-runs/reliability-fixtures-*.json`) |
| What "success" means in that measurement | last run succeeded, marked complete, exactly the products the website publishes, and a second collection creates no duplicate product or variant; a partial result is a failure | Same test |
| What is NOT in the rate | robots.txt forbids (×2), bot challenge, login, website down, information site, a feed that cannot be paged, a website limiting us for a month: listed separately, measured for the right honest end state (never "succeeded", never an endless retry) | Same test |
| Pause and continue | pause → wait → continue from the saved page as ONE run: 600 products and 600 observations (not 1,100: nothing read twice); waits 2, 4, 8, 16, 32, 60, 60 min then stops trying by itself with what it saved; Retry-After respected; a click continues the same run; a run stored the way auxito.com's is stored is picked up and finished | Automated: `tests/e2e/collection-resilience.test.ts` (13) |
| Fetcher behaviour | "slow down" is waited out only when short; never a denial; refusals stop only their own run; robots.txt 429/5xx is "not now" (not cached, not "forbidden"); classification and schedule | Automated: `tests/unit/fetch-resilience.test.ts` (14) |
| Real owner websites, new code, temporary database | groceriestogoaruba.com: complete, 2,381 products / 2,385 variants, 11 requests, 0 differences from the website's own feed, 8 of 8 real pages agree, second collection adds nothing; lasfit.com: complete, 1,129 / 9,199, 6 requests, 0 differences, 8 of 8 pages agree, no duplicates | Real: `npm run test:live` (9 of 9 checks each) |
| Whole suite | typecheck, lint (0 errors), build; **1,061 of 1,061 tests in 69 files** | Automated |

| Production, after the update | On production, after the update (backup first, `…T170239Z.dump`, 11 MB; the owner had allowed SSH from their new address): within about a minute the scheduler found auxito.com's and shop.lingandsons.com's paused runs (recorded the old way: `http_error`, HTTP 429, cursor page 4) and continued them from page 4 as the same runs. **auxito.com: succeeded, complete, 1,483 products (= the 1,483 the website lists), 3,602 variants, 3,602 price observations (one per variant: pages 1–3 were not read again), 11 requests in total, 0 duplicate products or variants, 0 delisted.** **shop.lingandsons.com: succeeded, complete, 1,850 of 1,850 products, 2,126 variants, 0 duplicates.** The "Aditya" workspace is unchanged (7,660 products / 7,959 variants / 2,056 matches); the workspace "Groceries To Go Aruba" (another person) was not touched; products now total 10,678 = 7,660 + 3,018. A faulty variant tally (0) on those two runs was found in this check, fixed (`03aa072`, with a test) and the two rows corrected from the stored data; the products and variants themselves were right throughout. Smoke test 30 of 30 (its throw-away account removed). The website part is live: the entry bundle is byte-identical to the local build. | Real: production database (read-only checks), the scheduler, the live website bundle |
| Real-world record of full-catalogue runs | before: 13 of 17 complete (76.5%; the 4 others: two 429 stops and two lasfit.com value failures); after: both 429 runs finished by continuation | Production database |

Limits: the measurement is of fictional websites; real websites can behave in ways none of the 24 scenarios shows. A website that limits requests tightly makes a large catalogue take hours (several sittings), not minutes. The real-world figures are a small sample (7 websites, 17 runs) and the "after" runs are the same runs finished by continuation, not new independent collections; the next independent evidence is the daily 12:30 UTC collection, not yet observed.

## Collection failure on lasfit.com (2026-10-28)

Evidence kinds: **real external** (the owner's own website lasfit.com; the production server and its database), **automated test**.

| Check | Result | Evidence |
| --- | --- | --- |
| Why it failed | One variant's compare-at price in the website's own feed is 139982999149929.98 (price 317.94); prices are numeric(14,4) → "numeric field overflow" → the batch's single transaction rolled back → scan crashed, 0 saved. The screen showed the SQL and values because the cause was never read. | Production: two failed runs, 0 rows stored, worker log; the live feed (the variant); a test reproducing the error byte for byte |
| The URL change | Not involved: the audit trail shows the lasfit address was never changed; the failure is in the data and reproduces for any workspace | Production audit events and website rows (read-only) |
| After the fix, real website, temporary database | **1,129 products, 9,199 variants, complete**, 6 requests, 0 differences from an independent re-read of the feed (every product and variant), 10 of 10 real pages agree, all observations traceable, the odd variant stored as 317.94 with no compare-at, 2 gift lines at 0.00 stored as "no price", second collection: no duplicates, observations 9,199 → 18,398, no price changed | Real: `npm run test:live` on lasfit.com (9 of 9 checks pass) |
| After the fix, production | Same website in a throw-away workspace on the real worker and database: succeeded, complete, 1,129 / 9,199, 0 errors, about 70 s, 0 duplicates; throw-away data removed; the real workspaces unchanged (7,660 products / 7,959 variants) | Real: production API and database |
| Failure leaves nothing behind | The failed runs left 0 products, variants and observations; a skipped product keeps exactly what it had before | Production + automated |
| One bad product no longer fails the catalogue | Only that product is skipped; the run is partial (not complete) with `products_skipped`, count and the database's reason; the next collection completes | Automated: `tests/e2e/collection-data-errors.test.ts` |
| Honest reporting | The run's notes name the product and the value; no SQL or values in the error, notes or log | Automated + production run notes |
| Other websites | Every connector's fixture collections (Shopify, WooCommerce, JSON-LD, HTML, listings, JS rendering, blocked, failing) unchanged | Automated: whole suite |
| Whole suite | typecheck, lint (0 errors), build; **1,001 of 1,001 tests in 66 files** | Automated |

Limits: the left-out amount is reported, not repaired: the website's owner should correct the price in their shop. The website's own capability estimate (1,127) differs slightly from the collected count (1,129); the collected count is the one read from the feed.

## Competitor count (2026-10-28) — "one competitor is enough"

Evidence kinds: **automated test** (real collections of fictional shops through the real pipeline), **local app in the in-app browser** (throwaway account, its own empty workspace, example.com/.org/.net only; no worker, so nothing was collected).

| Check | Result | Evidence |
| --- | --- | --- |
| Where the minimum lived | `DEFAULTS.minCompetitors` (sent to the website by the API), the getting-started step, the Setup form (three empty lines, "Add at least 3"); **not** in the database, API validation, collection, matching, comparison or reports | Code search of `apps/`, `packages/`, every migration |
| Exactly 1 competitor | Step done, guide moves on to "check what each website allows"; collected, matched (identical > 10), compared (every row has one card), report complete (not partial), 1 site and 1 basket line in the report | Automated: `tests/e2e/competitor-count.test.ts` |
| 2, 3, 4, 5 competitors, add then remove one at a time | Every count accepted; the guide says "N competitor(s) added"; a sixth is still refused (limit unchanged); removing back to none turns the step to "to do"; re-adding works | Automated |
| A competitor not collected yet | Empty comparison (no error), partial report, "not collected yet" | Automated |
| Existing workspace with 3 competitors | Collected, matched and compared as before (up to 3 cards per row) | Automated |
| Validation kept | `javascript:`, `ftp:`, cloud-metadata and private addresses and non-addresses are still refused | Automated + browser (metadata address refused with its message) |
| Regression guard | Re-adding `minCompetitors` fails the guard; the guard also bans the wording, list padding to 3 and count comparisons | Automated: `tests/unit/competitor-minimum.test.ts` (red/green shown) |
| Setup page, real browser | New workspace: one empty line, "Competitors (up to 5)", one-competitor hint. One URL typed → saved; guide "1 competitor added … up to 5". "Add competitor" ×2 → 3 saved. "Remove" one → 2 saved. | Local app in the in-app browser |
| Production | Backend updated (backup first, 46f2aed → f082b7f); throw-away account, new workspace, ONE competitor: `limits` = `{"maxCompetitors":5}`, guide step "to do" with none and "done" with one (next step "check what each website allows"), unsafe address refused, dashboard and reports 200; account removed again. Vercel serves the new entry bundle (byte-identical to the local build) | Real: the production API and the live website bundle |
| Whole suite | typecheck, lint (0 errors), build; **988 of 988 tests in 64 files** | Automated |

## Product page links (2026-10-28) — "click a price card, open the product on its own website"

Question from the owner's professor: can a customer open each product, yours and each competitor's, on the website it comes from, to check the price? Evidence kinds: **real external** (the shops' live pages), **local data** (the local copy of the owner's collected data; same code as production), **automated test**.

| Check | Result | Evidence |
| --- | --- | --- |
| Addresses stored per product | 7,959 variants: 0 empty, 0 non-http(s), 0 with credentials, 0 on another website; 2,053 matched pairs, each with two different addresses on their own websites; every saved report snapshot already carried them | Local: queries over the owner's data |
| Link on every card, live Price Comparison and the report's Prices tab (the owner's screenshot) | Present on all cards (report: 150 of 150 rows, three websites); "24 Poland Spring…" → `groceriestogoaruba.com/products/24-poland-spring-100-natural-spring-water?variant=40612263559308` and Quickmart's own page; `target="_blank"`, `rel="noopener noreferrer"`, accessible name names website and product | Local data in the in-app browser (temporary read-only staff account, removed afterwards) |
| Keyboard | Tab reaches the link; visible 2 px focus ring | Same browser |
| Stored addresses vs the real pages | 13 matched pairs → 26 pages. **20 reached the right product** (HTTP 200, same website, every title word found, price equal to the stored price, `?variant` id on the page); **6 Quickmart pages unreachable** from this computer (connection reset by the server, even for robots.txt; the browser pane could not open the site either) — **not verified** | Real: bounded, one request per page, 2.5 s apart, robots.txt honoured, only websites the owner has set up as their shop and competitors (for Quickmart, the owner's recorded written permission applies) |
| A real competitor link in a browser | `shop.lingandsons.com/products/0502000040366?variant=33746259148937` opens "Poland Spring Water 6-500 ml" | Real, in the browser pane |
| Safety rule | `javascript:`, `data:`, `file:`, `ftp:`, relative or malformed text, credentials in the address, spaces/control characters, > 2,048 characters, a front page and another website's page all give no link | Automated: `tests/unit/source-link.test.ts`, `tests/e2e/product-links.test.ts` |
| Several competitors in one row | Own product + two competitors → three different addresses, each on its own website and equal to what that shop's own page is; pack-size variants keep their own pages; unavailable products keep theirs | Automated: `tests/e2e/product-links.test.ts` (fictional shops) |
| Matching, prices and everything else unchanged | With 11 kinds of damaged address injected, the comparison is identical except the link fields; after restoring, deep-equal to before; match rows identical | Automated |
| Saved reports and re-collection | A new collection keeps the links while the price moves; a saved report holds the same links as the live comparison; an exported row with no link has an empty cell | Automated |
| What the customer sees | The card's link, "No page link" when none is safe, the exact markup | Automated: `tests/unit/web-source-links.test.ts` (10) |
| Whole suite | typecheck, lint (0 errors), build; **974 of 974 tests in 62 files** | Automated |

Limits: a link shows the address recorded when the product was last collected; Shelfwatch does not re-check the page when someone clicks, so a shop that moved or removed the page shows its own redirect or "not found" page. The own-website rule on the server (`productPageLink`) is in production too: the backend on EC2 was updated on 2026-10-28 (after the owner allowed SSH from their current address): backup first (`/var/backups/shelfwatch/…T134759Z.dump` and the update script's own `…T134806Z.dump`, 6.3 MB each), then `sudo shelfwatch-update` took the server from `ad828d6` to `46f2aed` (so it also carries directive 10's completeness cross-check), no new migration (12 applied), worker restarted first, readiness `ready`, smoke test **30 of 30**; the smoke test's own throw-away account and workspace were removed again and the 3 real accounts and workspaces were not touched. Read-only check of the production data under the new rule: the owner's workspace has 7,959 variants (2,385 / 878 / 2,570 / 2,126 on its four websites), **0** without a page address and **0** on another website, and 2,056 matched pairs, so no card is hidden by the server-side rule. No logged-in check of the production website was possible. Deployment evidence: commit `3c83c80` on `main`; the live Vercel site serves the new `app-shell` chunk, byte-identical to the local production build; `/api/v1/health` through Vercel answers.

## Backend on AWS EC2 (2026-10-26)

Evidence kinds: **real external** (the EC2 instance, Let's Encrypt, the live Vercel site, a real browser), **automated test** (the repository's suite).

| Question | Finding | Evidence |
| --- | --- | --- |
| What is deployed, and from which code? | `main` at `2d14cf2` (later `7e0ff1e`, which only adds deployment files and the Vercel rewrite) on one Amazon Linux 2023 `t3.micro`: API and worker as systemd services, PostgreSQL 18, nginx, certbot. The live Vercel bundle files (`index-DB1g3kQb.js`, `index-D2eFELfK.css`) are the same names a clean build of this code produces, so frontend and backend are compatible. | Real: `shelfwatch-status`, `git log` on the server, the live site's HTML |
| Is the backend healthy? | `/api/v1/ready` is **ready** on every check: database, 12 of 12 migrations, tenant isolation (the API connects with the restricted role), job queue, worker heartbeat, storage, email, encryption key. | Real: on the server and through the public address |
| Is HTTPS genuine? | A publicly trusted Let's Encrypt certificate for `18-212-221-70.sslip.io` (valid to 2027-01-24, renewal timer enabled). From outside: HTTP 200 with the certificate verified; plain HTTP only redirects; the bare IP gets no answer; port 4000 is closed. | Real: `curl`, `openssl s_client` from the development machine |
| Does the live Vercel site reach it? | Yes. `/api/*` on `price-intelligence-psi.vercel.app` was 404 before the rewrite and answers from the backend after it. A real browser on the live site registered an account (`POST /auth/register` 201), verified the email, signed in, created a workspace (201) and loaded the dashboard, websites, settings, members, alerts, reports and journey (all 200); the browser console had no messages and no request failed. | Real: browser pane on the live site; its network log |
| Does authentication behave? | 30 of 30 requests of `deploy/ec2/smoke-test` pass, **also when sent through the Vercel address**: wrong password 401; login before verification 403; session cookie `HttpOnly`, `Secure`, `SameSite=Lax`, host-only; protected routes 401 without a session; another workspace's id 404; missing CSRF header and foreign Origin 403; single-use verification link; logout invalidates the session; error bodies hold no stack trace or connection string. | Real: run on the server against the Vercel address |
| Does the worker work? | A capability check queued from the live site was run by the worker on EC2 and stored (`site profiled … status: full, requests: 11`, 14.4 s). One earlier run took 75 s for 12 requests; the same check measured later on the server takes 14.6 s, as it does locally. The cause of that one slow run was not established (most likely a cold start on a small instance). | Real: worker log, stored profile |
| Does it survive a restart? | The services restart on SIGTERM cleanly. After a full **reboot** of the instance (back in about 33 s) postgres, worker, API, nginx and both timers were active again without anyone starting them, readiness was `ready` on the first check, **every table's row count was identical** to before, and the browser's session was still valid without signing in again. | Real: reboot, counts before and after |
| Are secrets protected? | Production secrets were generated on the server and live only in `/etc/shelfwatch/shelfwatch.env` (`root:shelfwatch`, mode 640). Zero lines in the service logs mention a connection string, password, token or authorization header; no secret in any process command line or in the application directory or Git. The email settings were copied from the owner's local `.env` over SSH. | Real: log and file searches (counts only) |
| Which ports are open? | Internet: 22 (SSH), 80 (redirect and certificate challenge), 443. Closed: 4000 (API, bound to 127.0.0.1) and 5432 (PostgreSQL, 127.0.0.1). The security group was changed by the owner in the AWS Console; no AWS credentials were used. | Real: connection probes from the development machine |
| Do the repository's checks still pass? | typecheck, lint (0 errors) and **944 of 944 tests in 58 files**. The deployment guard now also requires the `/api` rewrite to be https, path-preserving, ahead of the page rule, and the only backend. | Automated |

Not verified: real email delivery to an inbox (the deployment was tested with a reserved `.test` address, which the application refuses to mail; the SMTP settings are configured and `/ready` reports email as configured); any real competitor collection on the server; behaviour under load; the Elastic-IP case (a stop/start of the instance); restoring a backup on the server.

Test data created on the production database (4 throw-away accounts and workspaces) was removed afterwards; the database holds no users.

## Web app on Vercel (2026-10-26) — `tsc: command not found`

| Question | Finding | Evidence |
| --- | --- | --- |
| Why did the build fail? | Vercel installs inside the Root Directory (`apps/web`), which installs only that workspace's own dependencies. The web build runs `tsc`, but `typescript` was declared only at the repository root. | Reproduced in a clean clone: `npm install` from `apps/web` → 125 packages, `vite` present, no `tsc`, build fails; Vercel's docs state the install path is the Root Directory |
| Anything else that would break the next deploy? | `apps/web/src/api.test.ts` imported the root-only `vitest` and would have failed the web `tsc`. Moved to `tests/unit`. | Same clean-clone build after the first fix |
| Does the fix hold on every install path? | `npm ci` from `apps/web` (126 packages), `npm install` from `apps/web`, and a root install + `npm run build -w @ci/web` all build (765 modules, `dist/`); the lockfile content is unchanged by the install. | Real: three clean clones, npm 11.17 / Node 24 on Windows |
| Linux (Vercel's platform)? | The lockfile holds the Linux x64 builds of Rolldown, esbuild and lightningcss with integrity hashes, and `npm ci --os=linux --cpu=x64 --libc=glibc` installs them. Running them needs Linux — not done here. | Real install with the Linux flags; lockfile read |
| The npm warnings? | `cache-dir`: not from the repository (no `.npmrc`, no `cache-dir`); it comes from Vercel's environment. `esbuild` postinstall: npm 11's "not yet approved" notice; esbuild is an optional peer of Vite 8, which builds with Rolldown. Neither affects the build. | Repository search; `npm ls esbuild`; the build passing |
| Is the app ready for a separately hosted backend? | Not by itself: it has no API address setting and calls `/api/v1/…` on its own hostname, so Vercel needs a rewrite of `/api/*` to the backend's https address. None is committed — no backend address exists yet. | Code read (`apps/web/src/api.ts`); `docs/deployment.md` |

## Website removal (2026-10-26) — "Remove website and its data" answered 400

| Question | Finding | Evidence |
| --- | --- | --- |
| Why 400? | The web client's `api.del` declared `content-type: application/json` with no body; Fastify 5 answers 400 `FST_ERR_CTP_EMPTY_JSON_BODY` to that, in the body-parsing step, before authentication or the route. Every bodyless DELETE of the web app was affected (website, invitation, member, integration). | Automated: reproduced on the repo's own Fastify 5.12.7 (no content type → 200; JSON content type, no body → 400; with `{}` → 200); the new API test fails 10 of 13 with the server fix off and passes with it on |
| Why was it not caught? | The API tests sent DELETE with no content type at all. | Code read of `tests/support/api-client.ts` |
| Database / permissions / validation? | Not the cause. Every foreign key to `sites` cascades or sets null; admin role required (staff 403); id must be a UUID (400); unknown 404. | Schema read; `site-removal.test.ts` |
| Does removal clean up and stay inside its limits? | After removal, 0 rows remain in 13 site-linked tables; other websites, the same hostname in another workspace and the saved report are unchanged; the removal is in the audit trail; the website can be added again. | Automated, real API with the browser's exact headers |
| Does the real dialog work? | Confirm → `DELETE … 200 OK`, list refreshed, rows gone, audit event. A forced HTTP 500 shows the message in the dialog (still open, "Removing…" and locked buttons while pending); a real retry then removed the website. | Real browser on the local app, throwaway workspace only; the user's workspace stayed at 2,381 / 2,566 / 863 products |

Not covered by this check: a removal while a collection of the same website is running (its rows go with it; the worker's later writes for that website fail harmlessly and are logged).

## Ling & Sons (2026-10-26) — why `www.lingandsons.com` never collected

Evidence kinds: **real external** (the website, a handful of polite requests; the real profiler; a real browser on the local app), **automated test**, **fixture**.

| Question | Finding | Evidence |
| --- | --- | --- |
| What is `https://www.lingandsons.com/`? | The company's information website. Its sitemap lists 19 pages (home, deals, news, VIP rewards, customer service, about, location, contact, terms, privacy, articles) and none is a product page. | Real: sitemap, home page, specials page fetched 2026-10-26 |
| Where is the shop? | `https://shop.lingandsons.com/` — the home page's menu item "Online Shopping" links to it. A separate Shopify store, public feed, about 1,850 products, AWG. | Real: home page; capability check of the shop in a throwaway workspace (13 requests) |
| Why 0 requests and "no reliable collection method"? | The scan reuses the stored capability report; nothing ranks, so it stops before crawling. Correct behaviour — but it called the site "unsupported" and advised asking for a product feed. | Stored profiles and scan runs in the database (5 profiles, 7 failed runs, all the same) |
| Does the site publish any deal data? | "VIP Deals" builds its list in the browser from `/data/sp.json`, which is an empty file (HTTP 200, 0 bytes, changed 2026-10-26 08:09 GMT). No data exists to read; nothing was invented. | Real: the file's headers |
| May the shop be read? | robots.txt allows normal pages and `/products.json`; the shop's own terms page exists but is empty (the product's terms review: `none_found`). The *website's* terms restrict commercial use without written consent; whether they cover the shop is the owner's call. | Real: robots.txt, terms pages; the product's own terms review |

What changed in behaviour (all measured with the real profiler on the real URL, 17 requests, no database): status stays *limited*; the "about 19 products / ~20 requests" claim is gone; the four irrelevant product-field warnings are gone; the report says the site does not list products and names `https://shop.lingandsons.com/`. In the real browser the website page shows the explanation and **"Add shop.lingandsons.com as a website"**; the click added the shop to a throwaway workspace, opened its page and ran its capability check (full, Shopify feed, about 1,850 products). **No collection was started anywhere in this directive.**

Not changed, on purpose: the other sites. Fixture sites of every kind (JSON-LD, plain HTML, WooCommerce, listing grid, home-page grid, JavaScript-only, terms-restricted) are asserted to get no "not a shop" verdict, no storefront and the same catalogue estimate.

Unrelated defect found by the full run and fixed (tests only): three retention tests had started failing on 2026-10-24 because the test clock was pinned to 2026-10-14 while rows were stamped by the database's real clock. 

## Automated checks

| Check | Command | Result |
| --- | --- | --- |
| Tests (unit + integration + end-to-end; embedded PostgreSQL 18; fictional sites served inside the tests; 6 real-Chrome tests; real SMTP library in process) | `npx vitest run` | **950 passed, 0 failed, 59 files** (final run on 2026-10-28; 944 in 58 before the completeness cross-check; 943 before the Vercel rewrite guard was extended; 934 in 57 after the removal fix, 914 in 55 after the Ling & Sons fix, 885 in 53 on 2026-10-23) |
| Live procedure (real websites and the real FX provider; opt-in, sends real requests) | `npm run test:live` | Ran 2026-10-19 against the four named shops (exhaustive procedure, `LIVE_SOURCE_URL` / `LIVE_COMPETITOR_URLS`); record in `.data/live-runs/` (git-ignored) |
| Typecheck, all workspaces, plus `tests/` and `scripts/` | `npm run typecheck` | Clean (exit 0, 2026-10-23) |
| Lint | `npm run lint` | Exit 0 on 2026-10-23 (2 intentional `any` warnings on 2026-10-19: `connectors/src/extract.ts`, `services/src/jobs.ts`) |
| Production builds (web, API, worker) | `npm run build` | Succeeds (exit 0, 2026-10-23) |
| **Production bundles run** | `node apps/api/dist/main.js` and `node apps/worker/dist/main.js` with `NODE_ENV=production`, https `APP_BASE_URL`, `SERVE_WEB=true`, against the real-data database | **18 of 18 checks passed** (see "Production-bundle smoke test"). Docker was not involved |

Added by the 2026-10-28 count investigation (6 tests, 944 → 950): a feed that ends early is not reported as complete (reads the missed products from their pages; stays partial when some cannot be read; no extra request for a normal store; a stale estimate does not cause a false partial; repeat run changes nothing) and My Stock counts items and products separately (`tests/e2e/catalogue-completeness.test.ts`). Added by the 2026-10-26 Vercel build fix (9 tests, 934 → 943): the web workspace builds from its own dependencies and its Vercel configuration is valid (`tests/unit/web-deploy.test.ts`). Added by the 2026-10-26 website-removal fix (20 tests, 914 → 934): the web client's request shapes (7) and removal through the real API with the browser's headers (13). Added by the 2026-10-26 Ling & Sons fix (29 tests, 885 → 914): storefront detection (16), end-to-end "information website that links to its shop" plus every other fixture kind unchanged (12), site-status addition (1). Added by the 2026-10-23 audit (87 tests, 798 → 885): terms review (7 unit + 7 end-to-end), promotional-text rules (21), CSV/Excel formula-injection export safety (17), size-in-tags (3), partial-report rule, plus parsing/domain/site-status additions. Added by the 2026-10-19 audit (38 tests): real-shop title shapes, bulk match review (10), placeholder-brand detection, standing "regular price" detection, pack notation, vintage years, reserved-address mail guard, sitemap/listing fixes, and static-file caching (3). Per-file counts: `npx vitest run --reporter=verbose`.
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

- **Any deployment** (at the time of this audit). Done on 2026-10-26: see "Backend on AWS EC2 (2026-10-26)".
- **Your inbox:** that the Gmail messages arrived, and the reset-email round trip through Gmail. Rotate the App Password you pasted in chat.
- **Own-store stock alerts on real data**, **flyers / PDFs from real sites**, **retention on real data**, **headless rendering of a live site** (Super Food Plaza needs it, and is a 10 s-crawl-delay site).
- **Shopify authorised inventory, Meta (Instagram/Facebook), YouTube, Anthropic, S3/R2/MinIO** — need your credentials.
- **Match correctness at scale:** 24 of 235 accepted identical matches were checked against the live pages; the other 211 were not individually checked.
- **Docker:** the `Dockerfile` and compose file were never built or run.
- **Backups:** the restore drill in [deployment.md](deployment.md) was not executed (`pg_dump`/`pg_restore` are not installed on the development machine).
- **Graceful shutdown with a real `SIGTERM`** (the development machine is Windows); covered by unit and end-to-end tests of the same code paths.
- **Several days of the real 09:00 `America/Aruba` schedule** and of the 12-hourly exchange-rate refresh (a day of real runs was observed; the rest is tested with an injected clock).
- **Accessibility beyond the automated audit:** a screen reader, tablet width, hover/focus-state contrast, non-Chromium browsers.
