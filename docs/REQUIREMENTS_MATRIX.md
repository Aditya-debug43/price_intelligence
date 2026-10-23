# Requirements → implementation matrix

**Updated 2026-10-23 for the fifth directive (Part 17: the original brief checked requirement by requirement); 2026-10-19 for the fourth directive (Part 16 at the end; rows D6, D13, D14 of Part 14 were brought current), and earlier that day for the third (Part 14 below, `docs/original-prompt/03_…`).** Parts 2–13 were built in Phase 1 (2026-10-15) from the original prompt and the 2026-10-15 directive (`docs/original-prompt/`), checked against the
repository; rows that the third directive changed are marked *(updated)* — the demonstration mode they mention no longer exists. **Status legend:** ✅ implemented and verified (fixtures/local services) · 🟡 partial · ❌ missing · 🔒 blocked by
credentials/permission · ⚠️ defect found. "Verified" never means "verified on a real customer site" unless stated.
Phase = where in the directive's plan the gap is closed (P2 live/demo + onboarding, P3 collection, P4 price intelligence,
P5 offers/stock/marketing, P6 reports/notifications/hardening, P7 full verification).

Audit evidence (Phase 1): baseline 393/393 tests, lint/typecheck/build clean; live-mode walk-through with a fresh account on a clean
workspace (registration → workspace → setup → dashboard → report); cross-tenant probes (all 404); unsafe-URL probes; code reading.

## Part 2 — core journey

| ID | Requirement | Status | Evidence | Gap / plan |
| --- | --- | --- | --- | --- |
| J1 | Register / sign in | ✅ | `api.test.ts`; live walk-through | verification policy (see AU3) |
| J2 | Create/access the correct organisation | ✅ | onboarding page; `GET/POST /orgs` | — |
| J3 | Enter own site + 3–5 competitors | ✅ | `Setup.tsx`; max 5 enforced; port rule enforced at add time (`workspace-modes.test.ts`); journey step guides the minimum of 3 | — (P2 done) |
| J4 | Validate and profile sites | ✅ | profiler tests; live probe | — |
| J5 | Know what can be collected (capability) | ✅ | capability report page | surface "unsupported by this website" + authorised alternative — P2/P3 |
| J6 | Collect accessible catalogue automatically | ✅ fixtures / ❌ never run on real catalogues | connector + pipeline tests | real-site verification needs per-site consent — P3/P7 |
| J7 | Normalise; match; compare | ✅ fixtures | pipeline tests | real-data accuracy unmeasured — P4/P7 |
| J8 | Offers; own stock; marketing | ✅ fixtures / 🔒 live inventory & social | e2e tests | P5 |
| J9 | Evidence-backed insights; dashboard; downloadable reports | ✅ fixtures | `reports.test.ts` | ⚠️ empty-workspace report says "No significant changes…" (RD1) — P2/P6 |
| J10 | History, schedule, daily reports, alerts | ✅ fixtures | scheduler/stock tests | restart recovery untested (SC2) — P6 |
| J11 | Honest gaps/stale/inaccessible/unsupported | ✅ | `deriveSiteStatus` (11 states) shown on Websites/Dashboard/matrix/honesty bar; 7 unit tests | Reports/Quality pages still to adopt the pill — P2/P6 |
| J12 | Controls perform the advertised action | ✅ | 409 with reasons for refresh/report/match/social (`honest-controls.test.ts`); dashboard buttons disabled with reasons; **every `<button>` in `apps/web/src` audited against its handler (≈70 controls): each calls the one API action its label names; destructive ones confirm; “Acknowledge all” says it leaves resolved alerts alone** | automated UI click-through of every button is not in the test suite (the audit was a code read plus the browser passes) |
| J13 | Guided onboarding to first report | ✅ | `GET /journey` + `JourneyCard` (computed from real data; tested from empty to first report) | live walk-through continuing — P2 |

## Part 3 — remove fiction from the real product

| ID | Requirement | Status | Evidence | Gap / plan |
| --- | --- | --- | --- | --- |
| F1 | Demo vs live separation *(updated)* | ✅ superseded | There is no demo mode any more: one product, `organizations.mode` and its triggers dropped (migration 0008), fixtures test-only — see D1/D2 | — |
| F2 | Live workspace starts empty / shows setup status | ✅ | live walk-through: empty setup, dashboard CTA | — |
| F3 | No fabricated competitors/prices/stock/offers/campaigns in live | ✅ | audit: no hard-coded URLs/random data in production code (only `scripts/demo-setup.ts`) | guard against regression with tests — P2 |
| F4 | Provenance stored (real obs / authorised API / user action / FX service / fixture) | ✅ | `provenance` column on 6 tables, written at every storage point, shown in the UI; backfilled | — |
| F5 | Honest statuses (not configured … collected) | ✅ | unified site status + integration statuses | — |
| F6 | Distinguish "no match found" from "could not be collected" | ✅ | matrix says "not available — <state>" unless the competitor was collected | — |
| F7 | Mocks/fixtures only in dev/test paths *(updated)* | ✅ | `tests/support` only; imported by no application, worker, script or package (`real-product-only.test.ts` §6) | — |

## Part 4 — collection

| ID | Requirement | Status | Evidence | Gap / plan |
| --- | --- | --- | --- | --- |
| C1 | Layered strategy; extensible adapters | ✅ | registry + 6 connectors | add adapters as real sites demand — P3 |
| C2 | Full accessible catalogue: pagination, variants, sitemap indexes, dedupe, resumable, budgets, progress | ✅ fixtures | scan runner, `crawl_queue`, cursor | real-catalogue verification — P3/P7 |
| C3 | Record discovered/collected/failed/skipped, coverage, last success, duration, failures, complete vs partial + reason | ✅ | `scan_runs` counters, coverage service, `explainScanRun` (plain-language outcome + reasons), failed/skipped URL lists | verified on fixtures; real-site verification — P7 |
| C4 | No false 100% claim | ✅ | `is_complete` only when enumerated | — |
| C5 | Timeouts, bounded concurrency, size limits, retries/backoff, per-domain rate limit, caching | ✅ | `safe-fetch.ts` + 45 tests | — |
| C6 | Respect robots/terms; no bypass; no private checkout probing | ✅ | tests; no login/cart code | — |
| C7 | Explain unsupported sites + authorised alternative | ✅ | every limitation the profiler can emit has plain-language advice (`packages/shared/src/limitation-advice.ts`), shown under it as “What you can do”; a test fails if the profiler gains a limitation without advice; blocking limitations only ever suggest a feed, API access, written permission, waiting, or replacing the competitor — never a workaround (`limitation-advice.test.ts`) | — |
| C8 | Re-audit SSRF fetcher + browser rendering; regression tests | ✅ (residual risk documented) | `safe-fetch.test.ts` 66 tests (alternative IPv4/IPv6 spellings, mapped/NAT64 DNS answers, redirect to internal spellings); `browser.test.ts` 6 tests with real Chrome. **Defect found and fixed:** page WebSockets bypassed request screening → now blocked | residual: DNS rebinding between the browser's own resolution and our check — mitigate with an egress firewall on rendering workers (documented in deployment) — P8 |
| C9 | Collection observable on site detail page | ✅ | Websites page: expandable run rows (`ScanDetailPanel`) with explanation, counts, failed URLs + errors, skipped URLs; `collection-observability.test.ts` (6) | — |
| C10 | Don't call a site operational because the homepage loaded | ✅ | capability vs scan success separate | covered by unified status — P2 |
| C11 | Headless rendering for JS sites | ✅ local pages / ❌ live site | `browser.test.ts` | doit.aw needs consent + verification — P3/P7 |

## Part 5 — matching, comparison, currency

| ID | Requirement | Status | Evidence | Gap / plan |
| --- | --- | --- | --- | --- |
| M1 | Normalisation (names, brand, GTIN, model, size, units, multipack, variants, category, currency, prices, availability) | ✅ fixtures | core parsing tests | multi-category/non-grocery coverage unmeasured — P4 |
| M2 | 1 L ≠ 2 L; multipack ≠ single | ✅ | matching tests (size mismatch ⇒ different_pack/needs_review) | — |
| M3 | Strongest identifiers first; confidence + evidence; uncertain not forced into matrix | ✅ | tests | — |
| M4 | Review UI: accept/reject/search alternative/side-by-side evidence/why/correct | ✅ | `Matches.tsx`: reasons, side-by-side table (differences highlighted, observed-at, source links), "Choose a different product…" picker (`GET /matches/candidates`, `POST /matches/manual`), "decided by a person"; `match-review.test.ts` (6); verified in browser | — |
| M5 | Learn from reviewed matches (not globally) | 🟡 | decisions preserved on re-match | optional/undefined; keep as-is unless needed — P4 |
| M6 | Real comparisons: our/competitor price, abs & %, cheapest, position, unit price, availability, confidence, last observed, links | ✅ fixtures | `Prices.tsx`, comparison service | — |
| M7 | Regular vs sale price; no unit/multipack mixing without unit price | ✅ | tests | — |
| M8 | Currency detect + user correction; real attributable FX with provenance | 🟡 | `currency_source`, FX table with source/time | non-peg FX provider decision (open.er-api.com needs no key; attribution) — P4 |
| M9 | Price changes derive from real history | ✅ | append-only observations | — |

## Part 6 — own inventory

| ID | Requirement | Status | Evidence | Gap / plan |
| --- | --- | --- | --- | --- |
| S1 | Public availability; authorised inventory (Shopify) | ✅ imitation / 🔒 real | `shopify-oauth.test.ts` | Shopify app credentials + merchant authorisation — P5/P7 |
| S2 | Exact quantity only from authorised source | ✅ | stock tests | — |
| S3 | Threshold default 5, configurable (global + per product) | ✅ | tests, UI | — |
| S4 | Out-of-stock / restock transitions; no duplicate alerts | ✅ | domain + e2e tests | — |
| S5 | Alert status, evidence, timestamps, acknowledgement, **resolution** | ✅ | open→acknowledged→resolved; automatic resolution with the resolving observation; manual resolution with note; evidence + source links; `alert-lifecycle.test.ts` (16) | — |
| S6 | Conflict when page availability ≠ inventory | ✅ | 2026-10-14 flag + test | — |
| S7 | Stock warnings in reports | ✅ | report stock tab | — |
| S8 | Never ask for competitor inventory | ✅ | no such code | — |

## Part 7 — offers

| ID | Requirement | Status | Evidence | Gap / plan |
| --- | --- | --- | --- | --- |
| O1 | Regular/sale/absolute/% discount, descriptions, dates, conditions, scope, bundles, source/evidence | ✅ fixtures | offers tests | — |
| O2 | New/expired offer tracking | ✅ | expiry policy tests | — |
| O3 | Ordinary low price ≠ sale; `1.75L` ≠ price | ✅ | regression test | — |
| O4 | Displayed offer vs confirmed promotion | ✅ | verification states | — |
| O5 | Flyer PDFs + review when uncertain | ✅ | `needs_review` flag + confirm / correct (original reading kept) / dismiss, source shown, verdict survives re-collection; `offer-review.test.ts` (11); verified in browser | OCR for image-only flyers is not implemented (reported as "no text layer") |

## Part 8 — marketing

| ID | Requirement | Status | Evidence | Gap / plan |
| --- | --- | --- | --- | --- |
| K1 | YouTube / Instagram / Facebook providers with honest status | ✅ imitations / 🔒 live | `integrations.test.ts`, `social-health.test.ts`, `social-providers.test.ts` (local imitations of the provider APIs) | real credentials / Meta App Review / Business Verification — P7 (asked of the user) |
| K2 | Record account, platform, URL, time, caption, **engagement metrics**, product references, provider, limitations | ✅ imitations | engagement (views/likes/comments/shares; null when not provided) stored with its own observation time; brand mentions in the summary; provenance + provider stored; limitations shown per competitor | verified only against imitations of the provider answers |
| K3 | Organic ≠ paid campaign | ✅ | `paidStatus: 'not_determined'` literal | — |
| K4 | Provider status, token expiry/refresh, revocation, quotas, backoff, errors | ✅ imitations (refresh n/a) | Meta `debug_token` health (valid / expiry date / days left / missing permissions / data-access expiry), revoked-grant detection (OAuth sub-codes), YouTube quota reset at midnight Pacific, Retry-After, exponential backoff persisted per account, credential-fingerprint reset, manual sync cannot override quota/rate limit; 20 + 13 + 26 tests | token refresh: Meta user tokens are re-issued by a person (system-user tokens never expire); YouTube API keys do not expire — documented in `docs/limitations.md` |
| K5 | Summaries of themes/timing from evidence | ✅ | `summariseMarketing` (13 unit tests): counts, recurring themes, brand mentions, weekday timing only with ≥5 dated promotions, most liked / most viewed separately, limitations — shown on the Marketing page **and saved in every report snapshot, PDF, Excel sheet and CSV dataset** (`reports.test.ts`) | — |
| K6 | Never display simulated campaigns as real | ✅ | no simulator for social | — |

## Part 9 — reports, schedule, notifications

| ID | Requirement | Status | Evidence | Gap / plan |
| --- | --- | --- | --- | --- |
| R1 | Ready by 09:00 `America/Aruba` | ✅ | scheduler tests (injected clock) | multi-day real run unverified — P6/P7 |
| SC1 | Queue-based, retry/recovery, cutoff, partial reports, freshness, history, duplicate-job prevention | ✅ | scheduler/queue tests | — |
| SC2 | Restart-safe scheduler; stale-run recovery | ✅ | `recoverScans`: stale running runs resume (capped at 3), orphaned queued runs re-queued under their original job key, runs that keep dying are closed as failed with an alert (no website stuck "collecting"), nothing queued twice, scheduled runs are not resurrected after the report cut-off; 14 tests in `scan-recovery.test.ts` | multi-day real run unverified — P7 |
| RD1 | No false "nothing happened" when nothing was collected | ✅ | headline "This report has no findings: …"; `nothing_to_report` 409 | — |
| RD2 | Report contents (comparison, cheapest, changes, availability, stock, offers, marketing, coverage, exceptions, evidence+time) | ✅ fixtures | report tabs | — |
| RD3 | PDF/CSV/Excel from the same snapshot; test file **contents**; CSV injection-safe | ✅ | `reports.test.ts` | PDF visual review on real-size data — P6 |
| RD4 | History + comparison over time | ✅ | compare page | — |
| N1 | Dashboard alerts; email summary; **real** email when configured; outbox never shown as delivered *(updated)* | ✅ real SMTP library in process / 🔒 Gmail | `email-smtp.test.ts`; outbox states with provider Message-ID | Gmail address + App Password from the user (D6) |
| RT1 | Retention ≈1 year / 90-day snapshots, implemented + tested | ✅ | per-workspace windows, exact boundary, marketing/offers/flyers/daily runs/old profiles now expire, newest profile and people's match decisions kept, failing storage never stops the clean-up and is retried, idempotent; 13 tests in `retention.test.ts` | legal hold / export-before-delete not implemented |

## Part 10 — auth and tenancy

| ID | Requirement | Status | Evidence | Gap / plan |
| --- | --- | --- | --- | --- |
| AU1 | Hashing, sessions, expiry, logout, reset, roles, CSRF, rate limits, safe errors | ✅ | `api.test.ts` | — |
| AU2 | RLS + cross-tenant protection (API + DB level) | ✅ | 15 DB tests; 404 matrix; live probe this session | — |
| AU3 | Don't treat unverified accounts as verified *(updated)* | ✅ mocks + local / 🔒 Gmail | an account cannot sign in until its emailed single-use link is used; with no mail server registration answers `503 email_not_configured` (D4/D6); `auth.test.ts` | real Gmail delivery: blocked on the user's App Password |
| AU4 | Member invitation/onboarding | ✅ | invitation flow: single-use 7-day link (hash stored), must be accepted by the invited address, nobody joins without accepting, resend replaces the link, revoke, role limits, 25-pending cap, tenant isolation, race-safe; `invitations.test.ts` (24); verified in the browser (wrong account, register-and-accept) | — |
| AU5 | Dev owner must not be a default identity *(updated)* | ✅ | no default identity exists: `bootstrap:dev` and the demo scripts were deleted; the first account is a person who registers and verifies an email address | — |

## Parts 11–13 — integrations, UI, hardening

| ID | Requirement | Status | Evidence | Gap / plan |
| --- | --- | --- | --- | --- |
| I1 | Integration reference (provider, vars, permissions, essential?, works without?, how to verify) *(updated)* | ✅ | `docs/integrations.md`: status vocabulary + checklist with mock vs real tests, blockers and verification steps per provider (D18) | — |
| I2 | Credential workflow | n/a | — | ask the user when each integration is ready for live verification |
| U1 | Guided setup journey (10 steps) | ✅ | journey card on the dashboard (`/journey`): workspace → own site → competitors → capabilities → permissions → collection → matches → report → alerts, each step done/next/blocked with the reason and a link; verified by the live-journey test and in the browser | — |
| U2 | No misleading green "connected/success" | ✅ | audited every green pill/banner/toast against the fact it claims: simulated data is labelled; coverage “complete” requires a succeeded, complete (or refresh) run with nothing stale or failing; **Shopify “connected” and the stock page’s “Connected inventory mode” now go green only when the last sync succeeded and is under 36 h old — otherwise amber/red with the reason (`connectionSyncHealth`, tested at unit and API level)**; success toasts fire only from a mutation’s success callback | not covered: a future pill added without this check |
| U3 | Verify desktop + mobile, tables, filters, charts, states, long names, accessibility, keyboard | ✅ (automated + in-browser) | structural audit of 18 views at 1280 px and 375 px; **colour contrast measured on 21 views + 4 public pages (0 failures after fixes)**; keyboard test of the dialog (autofocus, Tab trap, Escape, focus return); long-name stress (unbroken string, RTL, emoji) at both widths; defects fixed (page titles, header-less tables, dialog focus, contrast, overflow) | not covered: a screen reader, tablet width, hover/focus-state contrast, non-Chromium browsers |
| H1 | Config validation, safe start/stop, migrations/indexes, pooling, separate API/worker, job recovery, redacted logs | ✅ | config checks, pino redaction, **graceful shutdown audited and fixed**: clean stop on SIGTERM/SIGINT, second signal forces exit, hung stop abandoned with a log line, unhandled errors are fatal (exit 1), in-flight collections handed back for resumption; `lifecycle.test.ts` (9) + scan-recovery hand-back tests | not exercised with a real SIGTERM (Windows dev machine) |
| H2 | Health **and readiness** endpoints | ✅ | `GET /api/v1/ready`: database, schema version, RLS role, queue, worker heartbeat, storage, email/secrets/rendering/AI; 503 only when unsafe to serve, "degraded" when work would not happen; no secrets, no SQL; 21 tests in `readiness.test.ts`; verified on the running dev stack | — |
| H3 | Backups/recovery guidance, deployment instructions | 🟡 | `docs/deployment.md`: what to back up (and what not to rely on), dump with the admin URL, role recreation, secret key loss consequences, step-by-step restore drill, what a restore reproduces | ⚠️ the restore drill has **not been executed** (no `pg_dump`/`pg_restore` on the dev machine) — stated in the doc |
| H4 | Docker verified | ❌ | Dockerfile/compose written; **never built or run** (no Docker) | stated plainly in `docs/deployment.md` with a list of things to confirm; build and run before relying on it |

## Part 14 — Directive 3 (2026-10-18): remove the demo, make Shelfwatch real

Source: `docs/original-prompt/03_DIRECTIVE_REMOVE_DEMO_2026-10-18.md`. Evidence tiers use the vocabulary defined in `docs/integrations.md`
(*mocks* = automated mocks · *fixtures* = isolated test fixtures · *local* = real local service · *external* = real external service ·
*real data* = verified end to end with a website you authorised). Nothing below is claimed beyond its tier.

| ID | Requirement | Status | Evidence | Gap / plan |
| --- | --- | --- | --- | --- |
| D1 | Demo / fixture / simulated functionality removed from the product and runtime; fixtures test-only | ✅ | One product, no modes: migration `0008_remove_demo_mode.sql` (guarded, non-destructive), `post-migrate.ts` drops the legacy triggers, dev routes, demo scripts, `ALLOW_LOCAL_FIXTURES` / `DEMO_AUTO_CONSENT` / `SCHEDULER_MODE` removed from the configuration (`domain.test.ts` proves they are ignored); fictional sites live in `tests/support`; `docs/DEMO_REMOVAL_AUDIT.md` | Re-grep the production bundles for fixture traces after each build |
| D2 | Fictional data cannot enter a workspace by any path | ✅ fixtures | `tests/e2e/real-product-only.test.ts` (18): `.test` hosts, loopback and private addresses refused at add time and at fetch time; every stored observation is `public_web` / authorised; the API has no route that writes catalogue data | — |
| D3 | Existing data handled with the user's approval | ✅ | The development database folder was copied to `.data/postgres-backup-2026-10-18` first (the user's choice, "Back up the folder, then delete"); then only the demonstration workspace was removed with `db:purge-demo -- --yes` (it lists first and needs `--yes`); other workspaces, accounts and `.env` were not touched (`docs/DEMO_REMOVAL_AUDIT.md` §5) | — |
| D4 | Genuine registration: unverified until an emailed, single-use, expiring token is used; no auto-login; no enumeration | ✅ mocks + local / 🔒 Gmail | `tests/e2e/auth.test.ts`: tokens hashed in the DB, 48 h verify / 1 h reset, a new token cancels the old, 1/min throttle, lockout after 8 failures, change-password revokes other sessions, no email configured → `503 email_not_configured` | Real Gmail delivery has not run (blocked on the sender address and App Password) |
| D5 | Password reset, resend, change password | ✅ mocks + local | same suites; invalid / expired / reused / replaced tokens covered | Real inbox: 🔒 |
| D6 | Real email delivery (Gmail SMTP, App Password only in `.env`) | ✅ code, real SMTP library in process, **real Gmail acceptance 2026-10-19** / 🟡 inbox arrival unconfirmed | `core/smtp.ts` rules (STARTTLS required off-loopback, App Password normalisation, plain-language errors), `OutboxMailer` states `queued → sent | retrying | failed | not_configured` with Message-ID and provider answer, `npm run email:check`, Settings → Notifications test message | Gmail accepted the sign-in, a test message and the app's verification email on 2026-10-19 (outbox `sent`, Message-ID stored). Later the running worker's real daily schedule sent 3 daily-summary and 4 collection-failure digest emails through Gmail (all `sent`; 3 earlier daily summaries and 2 verification emails correctly recorded `not_configured` before Gmail was set up). Mail to reserved addresses (`.test`, `example.*`) is now refused locally (`unroutable_recipient`) so it cannot bounce into the sender's inbox. **Open:** the owner confirming arrival in the inbox, the link, and a reset email through Gmail; rotate the App Password (it was pasted in chat) |
| D7 | Accept arbitrary real URLs (1 own + 3–5 competitors) | ✅ | `addSite` / `normalizeSiteUrl`: any public http(s) host on port 80/443; private, loopback, metadata, odd ports, embedded credentials refused with a reason; the page typed is kept as the entry path (`entryPath`, migration `0010`) | — |
| D8 | Honest collection-permission design | ✅ | "Collection rules": the customer's own confirmation (consent text v2, name and time recorded), never presented as the competitor's approval; robots.txt obeyed regardless; revocation stops collection; `docs/consent-and-compliance.md` | — |
| D9 | robots.txt applies to the page the customer typed, and "/shop" ≡ "/shop/" | ✅ fixtures + external | `profiler.ts` entry check, `safe-fetch.ts` trailing-slash rule; `listing-collection.test.ts` (blocked, the path is never requested); live: scrapingcourse.com `/ecommerce/` (robots `Disallow: /ecommerce/*`) → **blocked, 0 pages read** | — |
| D10 | Real catalogue collection for shops with no feed/sitemap: listing pages, pagination, categories; resumable; counts | ✅ fixtures + external | `listing-crawl` connector (`listing.ts`, `page-crawl.ts`), `crawl_queue` kind `listing`, 17 e2e tests in `listing-collection.test.ts`; live: books.toscrape.com collected through its listings (40-product sample, GBP) | A **complete** real-catalogue run (all 1,000 books) was not done; large real catalogues unmeasured |
| D11 | Collection shows discovered / collected / skipped / failed; partial vs complete with the reason | ✅ | `scan_runs` counters, `explainScanRun`, run panel on the website page (`collection-observability.test.ts`, `listing-collection.test.ts`) | — |
| D12 | Stored values equal the page: prices, names, currency, availability, URL, time | ✅ external | `tests/live/real-sites.live.test.ts`: all 40 stored observations (books.toscrape.com) and WooCommerce rows checked against the raw page copy; re-fetch of live pages still shows the price (3 of 3) | Only on public sandboxes; repeat on the user's sites |
| D13 | Verified end to end with real website data of the user's own sites | ✅ real data *(updated 2026-10-19)* | The user named groceriestogoaruba.com (own shop) and four competitors in chat on 2026-10-19. Four were collected completely (two Shopify shops, one more Shopify shop in AWG, one WooCommerce shop: 2,381 + 863 + 2,566 + 1,850 products), two could not be (`shop.superfoodaruba.com`, `www.lingandsons.com` — shown as unavailable, never as "no match"). Prices were checked against the live product pages. See [verification-report.md](verification-report.md) §"Real-data audit" | Super Food Plaza (JavaScript storefront, 10 s crawl-delay) and `www.lingandsons.com` (information site, no catalogue) are not collectable; a Cmart address was never supplied and never guessed |
| D14 | Price comparison on real overlapping products (matching, unit prices, never mix pack sizes) | ✅ real data, with a stated limit *(updated 2026-10-19)* | 24 identical-class pairs across the three overlapping shops were checked against both live product pages: both prices on the pages equalled the stored prices, and the displayed % difference equalled an independent calculation (AWG ÷ 1.79 → USD) in 22 of 24; the other 2 are explained (verification-script variant read; a pair later rejected by the improved rules). The report held the same figures as the comparison page | **No barcodes and no usable brand exist on any of the four shops, so every match rests on name + size and needs a human decision** (235 identical, 661 comparable, 41 different-pack proposed). Hence bulk review and "confirmed only" by default. All 235 identical matches in the test workspace were accepted in **one bulk action** by the test owner after the 24-pair spot check — none individually; the other 702 proposed pairs (661 comparable, 41 different-pack) are still waiting for review and are not in any conclusion |
| D15 | "No equivalent found" is not "nobody sells it" unless the other catalogues were read completely | ✅ | `core/assortment.ts` (`assortmentBasis`, `assortmentNote`), saved in every report snapshot and served by `GET …/assortment`; `assortment.test.ts` (4) and e2e (blocked competitor + sampled source → named gaps; both complete → strong wording) | — |
| D16 | FX with an attributable real source; AWG peg stays a stated constant; never fabricate history | ✅ external | `FX_PROVIDER=open-er-api` fetched live on 2026-10-18: 164 rates, USD→GBP 0.7508, source "open.er-api.com (market rate)", provider update time stored, `provenance = exchange_rate_service`; AWG rows are never written from the provider | The scheduler's 12-hourly refresh was not observed running over days |
| D17 | Stock, offers, marketing, reports contain no mock data | ✅ | provenance on every table; no simulator route; marketing/stock providers are real clients that report *not set up* until credentials exist | Shopify / YouTube / Meta: 🔒 credentials; all tested with mocks only |
| D18 | Truthful integration checklist (provider, feature, core/optional, env, permissions, status, mock vs real tests, blockers, verification) | ✅ | `docs/integrations.md` — checklist table, status vocabulary, "what I need from you" | Keep current as integrations are verified |
| D19 | Testing / security / production readiness | 🟡 | unit + integration + e2e + live procedure; SSRF, RLS, token storage, rate limits re-checked; production config refuses a non-https `APP_BASE_URL`; `docs/PRODUCTION_READINESS.md` | Docker never built; restore drill not run; no load test; no real-device UI pass in this directive |
| D20 | Documentation current (`PROJECT_CONTEXT`, `WORK_LOG`, this matrix, `PRODUCTION_READINESS`, `integrations`, `limitations`) | ✅ | updated 2026-10-18/19 | — |

**What would let me claim "real end to end":** D6 (the owner confirming the Gmail messages arrived), plus a **deployed** system on which the customer journey has been run (Part 16, R18–R20). D13 and D14 are met on the development machine
(see the updated rows above): *verified on four real shops and real Gmail acceptance; not deployed; every match still needs a person's review.*

## Part 16 — Directive 4 (2026-10-19): real-data verification first, then GitHub and AWS

Source: `docs/original-prompt/04_DIRECTIVE_REAL_DATA_THEN_DEPLOY_2026-10-19.md`. Evidence: `docs/verification-report.md` ("Real-data audit", "Production-bundle smoke test"). Same tier vocabulary as Part 14.

| ID | Requirement | Status | Evidence | Gap / plan |
| --- | --- | --- | --- | --- |
| R1 | Audit real-data price comparisons on the four named shops; list which are usable and refreshable | ✅ real data | Four collected completely (2,381 / 1,850 / 863 / 2,566 products), two not collectable and shown as unavailable; robots.txt checked first; 1.5 s pacing; 5–29 requests each | Re-collection is cheap (a few requests per shop); Super Food Plaza needs rendering and its permission |
| R2 | Do not invent permission or collect where access is not permitted | ✅ | Only addresses the user typed; the app records the customer's own confirmation (not the competitor's approval); robots.txt obeyed; no Cmart address guessed; the 10 s crawl-delay site was not collected | — |
| R3 | Full pipeline on real data: collect → persist in the right organisation → normalise → match → review → compare → unit prices → report | ✅ real data | Verification report: 24 pairs checked against both live pages; report ↔ comparison equal; exports | Match review is the human bottleneck (no barcodes/brands) |
| R4 | Missing/unreliable brands; vendor "Aruba" | ⚠️ found → ✅ fixed | Placeholder vendor detection (`core/brands.ts`), `clearBrandLabels`, `vendorLabel`; regression tests | No usable brand exists on these shops; shown as missing, never guessed |
| R5 | Regular price misread as a discount | ⚠️ found → ✅ fixed | `detectUniformCompareAt`; `real-data-shapes` e2e; run note says why | — |
| R6 | Sizes, multipacks and variants not compared as identical | ⚠️ found → ✅ fixed | Pack notation, conflict flag, `different_pack`, flavour/variety words, **vintage years** (added after the audit) — `domain.test.ts` real-title tests | New product vocabularies will need new words |
| R7 | AWG/USD conversion through the reporting currency | ✅ real data | Ling & Sons pairs: AWG ÷ 1.79; displayed difference = independent calculation (all 8 Ling pairs among the 24 checked) | — |
| R8 | Inaccessible/incomplete competitors never shown as "no match"; no forced matches to fill the table | ✅ real data | "not available — not supported by this website"; partial report; the comparison shows confirmed matches only; 702 proposals stay out | — |
| R9 | Auditable set of real examples | ✅ | Verification report tables (10 shown, 24 checked, kept-apart examples) | — |
| R10 | Auth / email verification | ✅ mocks + real Gmail acceptance | See D4–D6 | Inbox arrival unconfirmed |
| R11 | Match review, offers, reports/exports | ✅ real data | Bulk accept on real data; 149 sale prices + 2 banners checked; PDF/Excel/CSV | Flyers from real sites: ❌ none available |
| R12 | Own-store stock alerts | 🟡 fixtures only | The real feed says all 2,385 products are available, so no alert could fire | Needs the authorised Shopify inventory (🔒 credentials) |
| R13 | Daily schedule in America/Aruba | ✅ real clock | Worker ran for hours; summaries sent; next run 2026-10-20 09:00, collection planned from 07:38 | Multi-day server run: not done |
| R14 | Social integrations, retention, missing-credentials states | 🔒 / 🟡 | Mocks and fixtures; credentials absent; states shown as "not set up" | — |
| R15 | Tenant isolation / access control | ✅ real HTTP + RLS tests | Cross-tenant 404, missing CSRF 403, foreign Origin 403, unauthenticated 401 | — |
| R16 | Visual/functional check of populated screens, desktop and mobile; console errors | ✅ with stated limits | In-app Chromium: 11 screens at 1280 px (dashboard, websites, a website, products, a product, match review, comparison, offers, stock, alerts, data quality), 6 at 375 px (dashboard, comparison, match review, reports, a report, settings); no overflow, no console errors | Tablet, screen reader, Safari/Firefox; Products/Offers/Websites/Alerts/Stock/Quality not re-read at 375 px |
| R17 | Production API/worker configuration works; never local-demo commands | ✅ locally | Bundles run with `NODE_ENV=production`: 18/18; unsafe production configuration refuses to start | On a server: not done |
| R18 | GitHub repository holds the verified frontend and backend code, up to date, no secrets, no force-push | ✅ pushed 2026-10-19 (`2574a4a..56e5094`, fast-forward) | Fast-forward of `main` on `Aditya-debug43/price_intelligence`; secret scan of tracked files and pending commits clean | There is no hosting workflow: the frontend is *stored*, not *hosted*, on GitHub |
| R19 | Existing AWS backend inspected and updated; env/secrets/migrations/worker/health verified | 🔒 blocked | No AWS CLI, profile, credentials, SSO, environment variables or deployment files on the development machine | Needs AWS access configured locally by the user and a description of the existing environment |
| R20 | Deployed frontend ↔ backend communication and a disposable-account customer journey on the deployed system | 🔒 blocked (depends on R19) | The single-origin rule is documented; the same journey was run locally on the production bundles | — |

## Part 17 — Directive 5 (2026-10-23): exhaustive audit, checked against the ORIGINAL brief

Source: `docs/original-prompt/05_DIRECTIVE_EXHAUSTIVE_AUDIT_2026-10-23.md`; evidence in [verification-report.md](verification-report.md) ("Exhaustive audit"). Each row is an original requirement (section of `01_ORIGINAL_PROMPT.md`), classified by what this audit **actually ran**:
✅ real = verified on real websites / real Gmail / the real browser · ✅ test = automated tests (fixtures) · 🟡 partial · 🔒 blocked (permission / credentials / hosting) · ⚠️→✅ defect found and fixed in this audit.

| ID | Original requirement | Status | What was run | Gap / blocker |
| --- | --- | --- | --- | --- |
| E1 | Account + workspace; email verification; sessions (§3.6, §13) | ✅ real | Fresh account in the browser: validation, real Gmail (`250 2.0.0 OK`), unverified sign-in refused, resend throttle, old link rejected, new link works, sign-out/in, protected URL redirects | Inbox arrival is not observable from here |
| E2 | One source URL + 3–5 competitor URLs, editable (§3.1, §3.8, §14B) | ✅ real | The five URLs exactly as supplied; private address refused; partial save keeps valid rows | — |
| E3 | Universal profiler / capability report in plain language (§5) | ✅ real | Own shop Full, foodstore2go Full, Ling `www` Limited, Quickmart + Super Food Blocked | Super Food's technical feasibility not probed (terms forbid it) |
| E4 | Respect site terms, robots, rate limits; record consent (§3.9, §18) | ⚠️→✅ | **The product had never read a website's terms.** Added terms review, quote of the clause, refusal unless written permission is recorded (migration 0011); 7 e2e + 7 unit tests; verified on the five real sites | **Four competitors not collected in this audit: Quickmart and Super Food forbid automated access; foodstore2go and Ling restrict copying/commercial use (unclear).** Needs the owners' written permission or your explicit decision |
| E5 | Collect the entire discoverable catalogue, resumable, polite, counts (§6, §2) | ✅ real (own shop) | 2,381 / 2,381 products, 2,385 variants; feed = sitemap = stored; 0 duplicates / 0 skipped; 11 requests at 1.5 s | Competitors: blocked by permission |
| E6 | Stored values equal the pages; provenance, URL, time (§6, §19.11) | ✅ real | Every variant vs the feed (11 fields, 0 differences); 60 of 60 random product pages agree on price, availability and title | — |
| E7 | History kept; no overwrite; no duplicates on re-run (§6) | ✅ real | 4 full runs + 1 sample: same products, first-seen kept, observations appended, no spurious price change | — |
| E8 | Currency detection; original + converted price; configurable FX with attribution (§3.2, §7) | ✅ real data held | 217 confirmed cells recomputed independently (AWG ÷ 1.79 → USD): 0 differences, sign and denominator as labelled | Only the AWG peg and USD seen on real shops |
| E9 | Four match classes; identity ≠ similarity; confidence + reason; human review (§7) | ✅ real data held, ⚠️ fixed | All 235 accepted identical pairs read one by one: 1 wrong + 5 doubtful + 7 wrong unit classes → all fixed (model numbers, vintages, numbered sizes, dry-product units, other-size class) | Names only (no barcode/brand on any shop) ⇒ **everything needs a person**; 432 new identical proposals await review (≈ 98 % right in a 90-pair sample) |
| E10 | Coverage honesty: partial / not collected / stale never shown as success or "no match" (§2, §19.3–5, §19.10) | ⚠️→✅ | Products, comparison and "No matches" empty states now name the uncollected websites and why; a never-collected competitor makes the report **partial** | — |
| E11 | Discounts, offers, flyers, historical verification (§8) | ✅ test, 🟡 real | Real: standing 8 % "regular price" not counted as sales; "We offer a service" banner no longer an offer (fixed). Fixtures: expiry, conditions, review, correction | No real flyer / PDF available |
| E12 | Own-site low stock: public + authorised modes, threshold 5, no invented counts, dedupe (§3.3, §9) | ✅ test | 15 + 16 + core tests incl. untracked, conflicts, restock, duplicates, acknowledge/resolve | The real feed shows everything in stock; Shopify authorisation needed for real quantities 🔒 |
| E13 | Marketing / social with honest status (§3.7, §10) | ✅ real status, 🔒 data | Integrations tab lists exactly what each provider needs; site banners shown "not proof of paid" | Credentials / App Review |
| E14 | Insights traceable to observations (§11) | ✅ test + real report | Insight evidence resolves to stored observations | — |
| E15 | Reports: snapshot, PDF/CSV/Excel, history, compare, daily email (§3.5, §12) | ✅ real | Downloaded every format, compared two reports; **CSV/Excel formula injection now tested (17 tests)** — the guard existed untested | — |
| E16 | Ready by 09:00 `America/Aruba`, partial on delay, retries, retention (§3.4, §3.5) | ✅ test, 🟡 real | Scheduler / recovery / retention suites; Settings shows planned start; a real day of runs on 2026-10-19 | Multi-day server run |
| E17 | Multi-tenant isolation (§3.6, §13, §19.14) | ✅ test + real | Cross-tenant 404 matrix, row-level security tests; live probes earlier | — |
| E18 | Security: SSRF, size/time limits, injection, secrets (§18) | ✅ test + real | 11 unsafe-URL cases, private address refused in the UI, hostile text neutralised in exports | — |
| E19 | Pages A–L, loading / empty / error / partial states, responsive, accessible (§14) | ✅ real | 15 routes × 2 widths, no overflow, all controls labelled, keyboard dialog, quiet console | Tablet, screen reader, Safari/Firefox |
| E20 | 14 data-reliability invariants (§19) | ✅ test | Pre-existing suites; this audit re-checked 3, 4, 5, 10, 11 and 13 on real data | — |
| E21 | Acceptance criteria (§21): real collection, comparison, offers, stock, reports, scheduling, marketing, security, quality | 🟡 | Met for the own shop and the pipeline; **the cross-store comparison on freshly collected competitor data is blocked by permission** | See E4 |

## Acceptance criteria (Part 15) — current state

Core: sign-in ✅ · correct organisation ✅ · enter source + competitors ✅ · new URLs without hard-coded catalogue ✅ · attempt to discover the complete accessible catalogue ✅ fixtures + public sandbox shops (2026-10-18) · persisted/presented completeness ✅ · **one authorised real-world end-to-end run ✅ locally (four named shops, 2026-10-19 — D13/D14; not deployed — Part 16 R19–R20)** · normalise/match/review 🟡 · genuine comparisons ✅ fixtures · evidence+timestamps ✅ · no fabrication ✅ (with F1/F5 gaps) · promotions ✅ · own-stock with real/authorised data 🔒 · daily report/downloads/history ✅ fixtures · **demo data cannot leak into live workspaces ✅ (there is no demo mode; fictional data exists only in tests — D1/D2)** · tenant isolation ✅.
External: genuine connection status ✅ · requirements documented ✅ (`integrations.md`) · tested against real services 🟡 (public websites and the FX provider yes; Gmail, Shopify, Meta, YouTube, S3, Anthropic no) · unavailable integrations identified ✅.
Engineering: existing functionality preserved ✅ · tests/lint/typecheck/build reported accurately ✅ · regression tests ✅ · auth/isolation tests ✅ · URL-security tests ✅ · docs match code ✅ (rewritten in Phase 7) · context + work log current ✅ (this phase).
