# Verification report

Last full run: **2026-10-15, after Phase 7 (commit `803a1c1`)**. Everything below was actually executed unless marked otherwise.
No real third-party service was contacted by any test, and **no real website catalogue has ever been collected** (permission has not been confirmed).

## Automated checks

| Check | Command | Result |
| --- | --- | --- |
| Tests (unit + integration + end-to-end; embedded PostgreSQL 18; local fictional sites; 6 real-Chrome tests) | `npx vitest run` | **695 passed, 0 failed, 40 files** (repeated full runs are stable) |
| Typecheck, all workspaces | `npm run typecheck` | Clean |
| Lint | `npm run lint` | 0 errors, 2 intentional `any` warnings (`connectors/src/extract.ts`, `services/src/jobs.ts`) |
| Production builds (web, API, worker) | `npm run build` | Succeeds |
| API production bundle | `node apps/api/dist/main.js` (against the dev database, other port) | Started; `GET /api/v1/ready` answered `ready` with all 8 migrations recognised |
| Worker | `npm run dev` runs the worker from source | Logged `worker ready`; its scheduler heartbeat is what `/ready` reports. The worker **bundle** was last started in an earlier session and not re-run now |

Per-area test counts: connectors 168 (safe-fetch 66, connectors 26, extract 26, social-health 20, integrations 19, browser 6, providers 5) · core 177 (domain 53, url-ip-robots 55, parsing 21, marketing-summary 13, social-backoff 13, site-status 7, scan-explain 6, limitation-advice 4, sync-health 5) ·
services 12 (lifecycle 9, s3-storage 3) · integration 20 (database/RLS 15, queue 5) · end-to-end 318 (api 39, live-journey 28, social-providers 26, invitations 24, readiness 21, pipeline 20, reports 20, alert-lifecycle 16, scan-recovery 16,
stock-alerts 15, email-verification 14, retention 13, workspace-modes 13, scheduler 12, offer-review 11, shopify-oauth 8, collection-observability 6, honest-controls 6, match-review 6, email-smtp 4).

Known harmless noise: Vitest sometimes prints "close timed out after 10000ms" after all tests pass (exit code 0) — slow shutdown of the embedded PostgreSQL.
Integration test files run sequentially against **one shared database**, and the scheduler and retention are global by design, so tests scope their runs and `harness.close()` switches off the schedules of the workspaces it created.

## Phase 7 — the requested scenarios, and the test that covers each

| Scenario (directive Phase 7) | Where it is verified |
| --- | --- |
| Multiple websites | `live-journey` (1 source + 5 competitors through the real API), `pipeline`, `api` |
| Partial failures | `live-journey` §5/§9 (blocked + unreachable competitor → partial report naming them), `scheduler` (08:50 cut-off partial report), `reports` |
| Unavailable competitors never shown as "no match" | `live-journey` §7 (matrix facets `access_denied` / `failed`; no cell for them), `honest-controls`, `workspace-modes` |
| Duplicate products | `pipeline`/`api` (same product across sites, matched), `live-journey` §7 |
| Incorrect product matches | `match-review` (candidate search, manual choice supersedes, survives re-matching), `api` (reject/reclassify), `live-journey` §7 |
| Changing prices | `live-journey` §8 (+50% change → one new observation, history only grows), `pipeline` |
| Expired promotions | `live-journey` §8 (flyer offers expire when validity passes), `pipeline`, `offer-review` |
| Stock transitions | `live-journey` §8 (out → one alert, repeat → none, restock → auto-resolved, no invented quantity), `stock-alerts`, `alert-lifecycle` |
| Missing credentials | `live-journey` §10 (Shopify/YouTube/Instagram/Facebook "not set up", impossible actions answered 409/501), `social-providers`, `shopify-oauth` |
| Invalid URLs | `live-journey` §2 (11 unsafe/odd URLs), `api`, `safe-fetch` (66 cases incl. alternative IPv4/IPv6 spellings, mapped DNS answers, redirects) |
| Authentication failures | `live-journey` §11, `api`, `email-verification` (14) |
| Cross-tenant access | `live-journey` §11 (404 on 16 paths + zero rows at the database), `api`, `database` (15 RLS tests), `invitations`, `alert-lifecycle`, `offer-review` |
| Demo data cannot leak into a live workspace | `workspace-modes` (13: database triggers, API, services), `live-journey` §2/§6 |
| Restart safety / stuck work | `scan-recovery` (16), `scheduler` (12), `lifecycle` (9) |
| Retention | `retention` (13) |
| Production readiness signals | `readiness` (21) |

### The live-workspace journey (`tests/e2e/live-journey.test.ts`)

Every other end-to-end test runs in a *demo* workspace. This one runs in a **live** workspace through the **real HTTP API**, with websites on ordinary public
hostnames (`mine.test`, `rival-woo.test`, …) that pass the production public-host policy — no loopback exception, no fixture flag. Only the last network hop is
imitated: the fetcher's `transport` hook serves each hostname from a local fictional site; URL validation and the SSRF policy still run. It asserts, among other
things, that every stored page copy, price and stock reading is `public_web` provenance and never a fixture, that evidence URLs are the public hostnames,
and that a report built from it is not labelled fixture data.
**What it does not prove:** that any real website behaves like these imitations (none was contacted), or the connect-time DNS validation (bypassed by the
transport hook; covered separately by `safe-fetch.test.ts`).

## Browser verification (in-app browser, real stack, demo workspace)

Run against the dev stack after refreshing the demo workspace (`npm run demo:fixtures`).

- **Structural audit, 18 views at 1280 px and 18 views at 375 px:** every link/button/control has an accessible name, every field a label, every table header cells, exactly one `h1`, no duplicate ids, a title, no sideways page scroll.
- **Colour contrast, 21 signed-in views + the sign-in, register, forgot-password and invitation pages:** every visible text element measured against its composited background (4.5:1, or 3:1 for large text). 0 failures after the fixes below.
- **Keyboard (the product-picker dialog):** focus lands in the search box, survives typing and list refreshes, Tab/Shift+Tab stay inside, Escape closes, focus returns to the button that opened it. Sign-in and the invitation page were driven by keyboard/real clicks end to end (wrong account → sign out → register → accept).
- **Long names:** a 250-character sentence, a 120-character unbroken string, emoji and right-to-left text on Products, product detail, Prices, Matches and Stock at both widths.
- **Real use:** match review (accept/choose a different product, then confirmed under "Confirmed by you"), alert history and automatic resolution, offer correction dialog, marketing and integrations pages, readiness endpoint on the running stack.

Defects this found and fixed: **the page title never changed** (every page showed the last one set); two tables without header cells; **the dialog stole focus on every parent re-render and could not return focus to its opener** (autofocus overridden, opener recorded too late); coral (4.28:1), green (4.08:1), muted-grey text (2.74:1, 71 places) and a pale legend swatch (2.18:1) below the AA thresholds; **an unbroken long product name widened the whole page** (2424 px).
**Not covered:** a screen reader; tablet width; hover/focus-state contrast; any real device; Safari/Firefox (only the Chromium-based in-app browser was used).

## Integrations exercised against local imitations (no live service, no key, no cost)

| Integration | Test | What it covers |
| --- | --- | --- |
| Shopify | `shopify-oauth` (8) | Authorize URL (read-only scopes, myshopify.com only); callback rejected when unsigned, tampered, from another user, for another shop, or replayed; code exchange; encrypted expiring tokens; first sync; token refresh; a refused refresh moves the connection to `error`; disconnect revokes and wipes tokens; another workspace cannot see it |
| YouTube, Instagram, Facebook | `social-health` (20), `social-providers` (26), `integrations` | Engagement counts (a count not provided is `null`, never 0); quota/rate-limit/revoked/expired/missing-approval/not-found classified; persisted backoff with the exact next attempt; a refused credential is not retried until replaced; a person cannot override a quota or rate limit; Meta token health (valid/expiry/days left/missing permissions); no API response contains a credential |
| SMTP | `email-smtp` (4), `email-verification` (14) | Delivery to every recipient, recorded failure, retry, idempotence, outbox-only mode; verification enforced when mail is configured |
| S3-compatible storage | `s3-storage` (3) | put/get/head/delete through the AWS SDK with signed requests; missing object vs permission error |
| Headless browser | `browser` (6) | **Real Chrome** on local pages: JavaScript content extracted, robots honoured, sub-requests **and WebSockets** to private/metadata addresses blocked, loopback refused |
| Anthropic API, open.er-api.com | `providers` (5) | Request shape, text-only extraction, status-only errors that never echo the key, rate parsing |

These prove our client code and error handling. They do not prove that the real services accept our requests (credentials, quotas, App Review).

## Real defects found by verification, across the work

Collection and security: headless-browser page **WebSockets bypassed request screening** (fixed; a test fails without the fix); a **blocked/unreachable competitor was shown as "no match found"** (now "not available — <why>").
Reliability: scan recovery was **uncapped and an orphaned queued scan blocked its website forever**; **one failed storage delete aborted retention for every workspace** and several tables never expired; the scheduler **started demo workspaces on servers that cannot serve fixtures** (false failure alerts every morning); a stored profile without a strategy crashed the whole scheduler pass; a second shutdown signal after a fatal error hid the failing exit code; the in-flight collections were left to time out on shutdown.
Honesty: **the readiness endpoint would have repeated raw SQL from database errors** to the public; a password reset marked an address verified when the "email" only sat in the development outbox; `GET /evidence/:id` omitted `provenance`; an empty-workspace report said "No significant changes…"; the journey claimed "permission recorded" for unchecked sites.
Earlier passes: a forbidden target made the headless renderer throw; the S3 driver reported permission/network errors as "missing"; a Shopify connection stayed `connected` after a refused refresh; flyer sizes like "1.75L" were read as prices.

## Live websites

Only a read-only capability probe was run on 2026-10-14 (see [demo-runbook.md](demo-runbook.md)): groceriestogoaruba.com and shop.lingandsons.com — Full (Shopify, public products.json);
shop.superfoodaruba.com — Limited (Freshop storefront); doit.aw — Limited (JavaScript-rendered). **No catalogue was collected from any live site and no live prices were compared.**
This is the single largest unverified item: see [limitations.md](limitations.md).

## Not verified

- **Any real website's catalogue** and everything that depends on it (performance on thousands of products, long crawls under real rate limits, real failure mixes, PDF flyers from real sites, headless rendering of a live site).
- **Any real third-party service:** Shopify, Meta (Instagram/Facebook), YouTube, Anthropic, open.er-api.com, an SMTP provider, S3/R2/MinIO.
- **Docker:** the `Dockerfile` and compose file were never built or run.
- **Backups:** the restore drill in [deployment.md](deployment.md) was not executed (`pg_dump`/`pg_restore` are not installed on the development machine).
- **Graceful shutdown with a real `SIGTERM`** (the development machine is Windows); covered by unit and end-to-end tests of the same code paths.
- **Several days of the real 09:00 `America/Aruba` schedule** (tested with an injected clock).
- **Accessibility beyond the automated audit:** a screen reader, tablet width, hover/focus-state contrast, non-Chromium browsers.
