# Limitations and status

Read this with [verification-report.md](verification-report.md) (what was actually run), [integrations.md](integrations.md) (the truthful
integration checklist) and [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) (the verdict). Status words are those defined at the top
of `integrations.md`. As of 2026-10-18.

**The product is not claimed to be production-ready.** The whole chain has been verified on real public sandbox shops, but not yet on a
website you authorised, and real email delivery has not been run.

## What was verified against the real world

| What | How | Result |
| --- | --- | --- |
| PostgreSQL 18 (migrations, row-level security, queue, roles) | Embedded real database in every test and in development | Tested against a real local service |
| Real Chrome (headless rendering) | `browser.test.ts` against local pages | Tested against a real local service |
| SMTP delivery logic | A real SMTP server library running in the test process (authentication, STARTTLS rules, rejected recipients, dropped connections, retry and failure states) | Tested against a real local service |
| Gmail | 2026-10-19: STARTTLS sign-in accepted; one test message and one registration verification email accepted (`250 2.0.0 OK`), outbox `sent` with Message-ID | Tested against a real external service (acceptance); inbox arrival unconfirmed |
| Public websites | `npm run test:live` on 2026-10-18 against three public scraping sandboxes: a static shop with no feed or sitemap (collected by **listing pages**, GBP), a WooCommerce shop (collected through its Store API), and a site whose robots.txt forbids the page given (**blocked**, no page read) | Tested against a real external service — see the verification report. Every stored price and name was found in the raw page it was read from (40 of 40) |
| Exchange-rate provider | One real request to open.er-api.com | Tested against a real external service |
| Two real Shopify shops | A read-only capability probe on 2026-10-14 (no collection) | Profiled only |

## What was verified only against fictional sites, stand-ins and mocks

Accounts, email verification and password reset (mail captured as data), workspaces, roles and invitations; row-level-security isolation;
SSRF-safe, robots-aware collection (including every sub-request and WebSocket of a rendered page); capability profiling;
Shopify/WooCommerce/sitemap/structured-data/listing/HTML connectors; resumable collection with capped recovery; normalisation, unit prices,
currency conversion; product matching with a full review workflow; offers with history-based verification and flyer review; own-site stock
alerts with an open → acknowledged → resolved lifecycle (against a stand-in for an authorised inventory); marketing observation with
engagement counts, token health, quota and rate-limit backoff; scheduler with measured start times, cut-off and partial reports;
immutable reports with PDF/CSV/Excel from the same snapshot; retention; readiness; graceful shutdown; the web interface (structurally
audited, contrast-measured and keyboard-tested). The fictional websites live only in `tests/support` and cannot be reached by the running
product (there is no switch that allows them; see [DEMO_REMOVAL_AUDIT.md](DEMO_REMOVAL_AUDIT.md)).

## The largest remaining gaps

1. **No website you authorised has been collected.** Behaviour on your real catalogues (thousands of products, real rate limits, real
   failure mixes, real flyers) is unmeasured. The sandboxes sell different things, so **price comparison on real overlapping products has
   not been demonstrated**: against the sandboxes the correct result — no matches, every source product listed as having no counterpart —
   was verified, but that is not the same as comparing two shops that sell the same goods.
2. **Real email delivery is only half-proven.** Gmail accepted the sign-in and two messages on 2026-10-19 (a test message and the app's verification email, `250 OK`, Message-IDs stored), but nobody has yet confirmed they reached the inbox, opened the link, or run a password reset through Gmail.
3. doit.aw (JavaScript-rendered) and Super Food Aruba (Freshop storefront, no public feed) have not been collected and cannot be without
   further work or access arranged with the store. A fourth competitor's URL ("Cmart") was never supplied and has not been guessed.

## Implemented but not verified here

| Item | Why unverified |
| --- | --- |
| Gmail delivery to the inbox | Gmail accepted two messages on 2026-10-19; arrival, the verification link and the reset email need the owner to look. |
| Headless-browser rendering on **real websites** | Verified with real Chrome against local test pages only. Residual risk: DNS rebinding between the browser's own resolution and our check cannot be closed in application code — run rendering workers behind an egress firewall. |
| S3-compatible storage on a **real** service | Tested through the AWS SDK against an in-process S3-compatible fake. Never run against AWS S3, Cloudflare R2 or MinIO. |
| Production bundles | Built; the API bundle was started and `/api/v1/ready` answered `ready`. Not run under load or for a full schedule cycle. |
| `Dockerfile`, `docker-compose.yml` | Written without Docker available; **never built or run**. |
| Backup **restore drill** | Written in [deployment.md](deployment.md); **not executed** (no `pg_dump`/`pg_restore` on the development machine). |
| Graceful shutdown with a real `SIGTERM` | Covered by unit and end-to-end tests; not exercised with a real signal (Windows development machine). |
| Accessibility beyond the automated audit | A screen reader, tablet width, hover/focus-state contrast and non-Chromium browsers were not checked. |
| Listing-page collection on large real catalogues | Verified on a 1,000-book sandbox for a 40-product sample and on fictional multi-category shops for complete collection; a **complete** run of a real catalogue has not been done. |

## Needs credentials or approval nobody has granted

| Item | What is missing |
| --- | --- |
| Live collection from your websites | Your first authorised source and competitor addresses. Your confirmation is recorded per website; the competitor's own permission is neither claimed nor needed beyond robots.txt, which is always obeyed. |
| Email delivery — remaining step | Confirmation that the messages arrived. The App Password was pasted into chat: rotate it. |
| Shopify inventory | App credentials (`SHOPIFY_CLIENT_ID/SECRET/REDIRECT_URI`), `TOKEN_ENCRYPTION_KEY`, and the merchant's authorisation. The flow is tested end to end against a local imitation; it has never talked to Shopify. |
| Instagram / Facebook | A Meta app; Instagram needs a token from your own professional account and (for production) App Review + Business Verification; Facebook public Pages need "Page Public Content Access". The token's expiry and permissions are checked, but a user token is renewed by a person (a system-user token does not expire). |
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
- Collection from a catalogue that exists only behind a login, a CAPTCHA, or a robots.txt rule: reported as *blocked*, never worked around.

## Known behaviours to be aware of

- Name-only product matches are capped below certainty and wait for review; with few barcodes published, many pairs need a person.
- Authorised inventory outranks the public "in stock / sold out" flag; disagreements are flagged on the Stock page, not silently resolved.
- Competitor catalogues are refreshed within a request budget and crawl delay; very large catalogues are only partly fresh at any moment, and coverage is always stated.
- A website is tracked as a whole. If you give a page inside it (`/shop`), robots.txt is checked for that page (a forbidden page blocks the website) and the shop is looked for there first; the rest of the website is not ignored.
- A source product with no counterpart is listed as such; it is not "cheaper" and not "zero". Whether the competitor's catalogue was read completely is stated next to it.
- Observed marketing content is never described as a paid campaign; summaries describe a pattern only when enough items support it.
