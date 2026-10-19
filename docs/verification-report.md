# Verification report

Last full run: **2026-10-19, after directive 3 (commit `2a1ad8e` + the documentation commit)**. Everything below was actually executed unless marked otherwise.
Status words are the project vocabulary defined at the top of [integrations.md](integrations.md). Two kinds of real-world evidence exist so far:
**public scraping-sandbox websites** (collected on 2026-10-18/19) and **one exchange-rate provider call**. **No website you authorised has been collected, and no
email has been sent through Gmail.**

## Automated checks

| Check | Command | Result |
| --- | --- | --- |
| Tests (unit + integration + end-to-end; embedded PostgreSQL 18; fictional sites served inside the tests; 6 real-Chrome tests; real SMTP library in process) | `npx vitest run` | **760 passed, 0 failed, 44 files** (full run 2026-10-19) |
| Live procedure (real websites and the real FX provider; opt-in, sends real requests) | `npm run test:live` | **9 passed, 0 failed** (2026-10-19 run; record in `.data/live-runs/`, git-ignored) |
| Typecheck, all workspaces, plus `tests/` and `scripts/` | `npm run typecheck` | Clean |
| Lint | `npm run lint` | 0 errors, 2 intentional `any` warnings (`connectors/src/extract.ts`, `services/src/jobs.ts`) |
| Production builds (web, API, worker) | `npm run build` | Succeeds; the bundles contain none of the fictional hostnames, `startFixtureServer`, `dev-inventory`, `ALLOW_LOCAL_FIXTURES`, `DEMO_AUTO_CONSENT` or `SIMULATED` (`grep -F` on 2026-10-19) |
| API production bundle | `node apps/api/dist/main.js` (against the dev database, other port) | Started and answered `ready` in an earlier session (all migrations then recognised); **not re-run after migrations 0008–0010** |

Per-area test counts (760): core 197 (domain 55, url-ip-robots 56, parsing 21, marketing-summary 13, smtp 13, social-backoff 13, site-status 7, scan-explain 6, sync-health 5, assortment 4, limitation-advice 4) ·
connectors 144 (safe-fetch 67, extract 26, social-health 20, integrations 18, listing 8, providers 5) · services 12 (lifecycle 9, s3-storage 3) · connector and browser tests that need the fictional sites 32 (connectors 26, browser 6, real Chrome) ·
database/queue 20 (RLS 15, queue 5) · end-to-end 355 (api 38, auth 32, live-journey 26, social-providers 26, invitations 24, readiness 22, pipeline 20, reports 20, real-product-only 18, listing-collection 17, alert-lifecycle 16, scan-recovery 16,
stock-alerts 15, retention 13, offer-review 11, scheduler 11, shopify-oauth 8, collection-observability 6, honest-controls 6, match-review 6, email-smtp 4).

Known harmless noise: Vitest sometimes prints "close timed out after 10000ms" after all tests pass (exit code 0) — slow shutdown of the embedded PostgreSQL.
Integration test files run sequentially against **one shared database**, and the scheduler and retention are global by design, so tests scope their runs and `harness.close()` switches off the schedules of the workspaces it created.

## Real-network verification (`npm run test:live`, 2026-10-18/19)

Real DNS, TLS, robots.txt and pages; the production fetch policy and pacing (1.5 s per host); the real clock; a real PostgreSQL. No fictional website, no transport stand-in.
Targets are public sandboxes made for scraping practice — **not your websites**:

| Website | What the collector did | Result |
| --- | --- | --- |
| `https://books.toscrape.com/` (static shop, no feed, no sitemap, no structured data) | Profile **partial**; strategy `listing-crawl`; sample of 40 products read from its listing pages, GBP detected from the prices | 40 products stored with name, price, currency, availability, own page URL and the listing page as evidence; stopped by design (sample), never marked complete |
| `https://scrapeme.live/shop/` (WooCommerce) | Profile **full**; strategy `woocommerce-store-api` | 40 products stored |
| `https://www.scrapingcourse.com/ecommerce/` (robots.txt: `Disallow: /ecommerce/*`) | The page typed is checked against robots.txt before anything is requested | Profile **blocked**, run **blocked**, **0 pages read**, 0 products stored; the message names the path and says nothing was collected |

Checks on what was stored:

* Every stored product and price carries its real source page, an observation time within the run, an evidence row with a SHA-256 of the page, and `public_web` provenance; none points at a local or `.test` address.
* **Parser vs source of truth:** for every stored observation (40 of 40) the stored price and the start of the stored name were searched in the raw page copy the collector kept — **0 mismatches**.
* **Re-fetch:** 3 of 3 sampled pages, fetched again after the run, still showed the stored price.
* **Comparison honesty:** books and monsters share no product; matching found no match (correct), all 40 source products were listed as having no counterpart, none as "cheaper" or "zero", and the assortment basis said the competitor catalogues were not read completely.
* **Exchange rates:** one request to open.er-api.com returned 164 rates; USD→GBP 0.7508 was stored with source "open.er-api.com (market rate)", the provider's own update time and provenance `exchange_rate_service`; the AWG peg (1.79) stayed a stated constant and no market AWG rate was written.

What the real runs found that fixtures could not (all fixed, each with a regression test): a shop whose listing starts on its home page failed on every later page (`Invalid URL`); the page typed (`/ecommerce/`) was dropped so a forbidden shop looked "limited"; a rule for `/shop/` did not stop `/shop`; a catalogue forbidden by robots.txt was reported "limited" rather than blocked; page counters showed 1 page read for a 2-page sample.

**What this does not prove:** collection from a website you authorised; **price comparison between two shops that sell the same goods**; a complete (not sampled) run of a large real catalogue; anything about Gmail.

## The requested scenarios, and the test that covers each

| Scenario | Where it is verified |
| --- | --- |
| Registration, verification, reset, resend, expired / reused / replaced links, lockout, enumeration resistance, sessions, change password | `auth` (32), `email-smtp`, `smtp` (13) |
| Email delivery states, retries, failures, no configuration | `email-smtp`, `auth` (delivery failures/retries, the Settings panel) |
| No demo, simulator or fixture can reach a workspace | `real-product-only` (18), `domain` (removed settings are ignored), source scan for removed identifiers |
| Any real URL; unsafe URLs refused with a reason; entry page kept | `api`, `live-journey` §2 (11 unsafe/odd URLs), `safe-fetch` (67), `url-ip-robots`, `listing-collection` |
| Collection rules (the customer's confirmation) gate collection; revocation stops it | `api`, `honest-controls`, `live-journey` |
| Shops without feed or sitemap collected from listings; resumable; partial vs complete with reasons; counters | `listing` (8), `listing-collection` (17) |
| robots.txt forbidding product pages or the typed page → blocked, never requested | `listing-collection`, `safe-fetch`, live run (scrapingcourse.com) |
| Multiple websites, partial failures, unavailable competitors never shown as "no match" | `live-journey`, `scheduler`, `reports`, `honest-controls` |
| "No equivalent found" worded from catalogue coverage | `assortment` (4), `listing-collection` (2), `api` |
| Duplicate products, incorrect matches, changing prices, expired promotions, stock transitions | `pipeline`, `match-review`, `live-journey` §7–§8, `offer-review`, `stock-alerts`, `alert-lifecycle` |
| Missing credentials | `live-journey` §10, `social-providers`, `shopify-oauth` |
| Cross-tenant access | `live-journey` §11 (404 on 16 paths + zero rows at the database), `api`, `database` (15 RLS tests), `invitations`, `alert-lifecycle`, `offer-review` |
| Restart safety / stuck work, retention, readiness (incl. email) | `scan-recovery` (16), `scheduler` (11), `lifecycle` (9), `retention` (13), `readiness` (22) |
| Production configuration refuses an unsafe setup (token key, worker role, non-https `APP_BASE_URL`) | `domain` |

### The live-workspace journey (`tests/e2e/live-journey.test.ts`)

Runs through the **real HTTP API** with websites on ordinary public hostnames (`mine.test`, `rival-woo.test`, …) that pass the production public-host policy — no
loopback exception, no fixture flag. Only the last network hop is imitated (the fetcher's `transport` hook serves each hostname from a local fictional site); URL validation
and the SSRF policy still run. It asserts, among other things, that every stored page copy, price and stock reading is `public_web` provenance. **What it does not prove:**
that any real website behaves like these imitations (the live run above is the evidence for that), or the connect-time DNS validation (bypassed by the transport hook; covered
separately by `safe-fetch.test.ts`).

## Browser verification (in-app browser, real stack)

Performed on 2026-10-15 against the dev stack, **before** the demonstration mode was removed (the workspace used then was a fixture workspace; the screens audited are the product's screens):

- **Structural audit, 18 views at 1280 px and 18 views at 375 px:** every link/button/control has an accessible name, every field a label, every table header cells, exactly one `h1`, no duplicate ids, a title, no sideways page scroll.
- **Colour contrast, 21 signed-in views + the sign-in, register, forgot-password and invitation pages:** 0 failures after fixes.
- **Keyboard (the product-picker dialog):** focus, Tab trap, Escape, focus return. Sign-in and the invitation page driven by keyboard/real clicks end to end.
- **Long names:** 250-character sentence, 120-character unbroken string, emoji and right-to-left text at both widths.

Defects this found and fixed: the page title never changed; two tables without header cells; the dialog stole focus on every re-render; contrast failures; an unbroken long name widened the whole page.
**Not covered:** a screen reader; tablet width; hover/focus-state contrast; any real device; Safari/Firefox.
**Since then the registration/verification/reset screens, the Settings email panel, the Websites "shop starts at this page" line and the report's assortment wording changed; they were verified by tests and typecheck but have not had a fresh visual pass.**

## Integrations exercised without a live service (no key, no cost)

| Integration | Test | What it covers |
| --- | --- | --- |
| Gmail / SMTP | `smtp` (13), `email-smtp`, `auth` | A real SMTP server library in the test process: authentication, STARTTLS rules, rejected recipients, dropped connections, retries, recorded Message-ID and answer; Gmail-specific rules and error advice. **Not Gmail itself.** |
| Shopify | `shopify-oauth` (8) | Authorize URL (read-only scopes, myshopify.com only); callback rejected when unsigned, tampered, from another user, for another shop, or replayed; encrypted expiring tokens; sync; refresh; disconnect revokes and wipes tokens |
| YouTube, Instagram, Facebook | `social-health` (20), `social-providers` (26), `integrations` | Engagement counts (not provided = `null`, never 0); quota/rate-limit/revoked/expired/missing-approval classified; persisted backoff; Meta token health |
| S3-compatible storage | `s3-storage` (3) | put/get/head/delete through the AWS SDK against an in-process S3-compatible fake |
| Headless browser | `browser` (6) | **Real Chrome** on local pages: JavaScript content extracted, robots honoured, sub-requests **and WebSockets** to private/metadata addresses blocked |
| Anthropic API | `providers` (5) | Request shape, text-only extraction, status-only errors that never echo the key |
| open.er-api.com | `providers` (5) **and one real call** (live run) | Client behaviour; the real answer was fetched and stored with its source and time |

These prove our client code and error handling. They do not prove that the real services accept our requests (credentials, quotas, App Review).

## Real defects found by verification, across the work

Collection and security: headless-browser page **WebSockets bypassed request screening** (fixed); a **blocked/unreachable competitor was shown as "no match found"** (now "not available — <why>"); a robots rule for `/shop/` did not stop `/shop`; the page a customer typed was dropped, so a forbidden shop looked merely "limited"; a shop whose listing starts on its home page failed on every later page.
Reliability: scan recovery was **uncapped and an orphaned queued scan blocked its website forever**; **one failed storage delete aborted retention for every workspace**; a stored profile without a strategy crashed the whole scheduler pass; a second shutdown signal after a fatal error hid the failing exit code; page counters under-reported a stopped run.
Honesty: the readiness endpoint would have repeated raw SQL from database errors to the public; a password reset marked an address verified when the "email" only sat in a development outbox; **registration signed people in without verifying their address**; **"You sell, no competitor does" was claimed whether or not the competitors' catalogues had been read**; an empty-workspace report said "No significant changes…"; **a fabricated "7.4 % cheaper" example price sat on the sign-in page**; editing a website's address left the old website's data attached to the new name.

## Live websites you authorised

**None yet.** The earlier read-only capability probe (2026-10-14) of groceriestogoaruba.com and shop.lingandsons.com (Full: Shopify, public `products.json`), shop.superfoodaruba.com (Limited: Freshop storefront) and doit.aw (Limited: JavaScript-rendered) collected no catalogue.
This remains the single largest unverified item: see [limitations.md](limitations.md).

## Not verified

- **A website you authorised**, and everything that depends on it: price comparison on overlapping real products, performance on thousands of products, long crawls under real rate limits, real failure mixes, PDF flyers from real sites, headless rendering of a live site.
- **Gmail** (needs your address and an App Password typed into `.env`), **Shopify, Meta (Instagram/Facebook), YouTube, Anthropic, S3/R2/MinIO**.
- **Docker:** the `Dockerfile` and compose file were never built or run.
- **Backups:** the restore drill in [deployment.md](deployment.md) was not executed (`pg_dump`/`pg_restore` are not installed on the development machine).
- **Graceful shutdown with a real `SIGTERM`** (the development machine is Windows); covered by unit and end-to-end tests of the same code paths.
- **Several days of the real 09:00 `America/Aruba` schedule** and of the 12-hourly exchange-rate refresh (tested with an injected clock).
- **Accessibility beyond the automated audit:** a screen reader, tablet width, hover/focus-state contrast, non-Chromium browsers.
