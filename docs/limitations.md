# Limitations and status

Read this with [verification-report.md](verification-report.md) (what was actually run) and [integrations.md](integrations.md) (what each integration needs).

## What works in real conditions

Only what ran against **real local services**: PostgreSQL 18 (migrations, row-level security, triggers, the job queue, roles) and real Chrome (headless rendering of local pages).
Everything else below was verified against fictional websites and **local imitations** of the providers.

## Implemented and verified against fictional sites, local imitations and a real PostgreSQL

Accounts, workspaces, roles and **invitations**; **live vs demo workspaces** enforced in the database; row-level-security isolation; SSRF-safe, robots-aware collection (including every
sub-request and WebSocket of a rendered page); capability profiling; Shopify/WooCommerce/sitemap/structured-data/HTML connectors; **resumable collection with capped recovery**;
normalisation, unit prices, currency conversion; product matching with a full **review workflow** (side-by-side evidence, choose a different product, decisions survive re-matching);
offers with history-based verification and **flyer review** (confirm / correct / dismiss); own-site stock alerts with an **open → acknowledged → resolved lifecycle** and evidence;
marketing observation with **engagement counts, token health, quota/rate-limit backoff and evidence-based summaries**; scheduler with measured start times, cut-off and partial reports;
immutable reports with PDF/CSV/Excel from the same snapshot; **retention** (per workspace, covering everything that grows); **readiness endpoint**; graceful shutdown; the web interface
(structurally audited, contrast-measured and keyboard-tested). One full **live-workspace journey** runs through the real HTTP API against public hostnames served by local imitations.

## The largest gap: no real website has been collected

Permission to collect from the real competitor websites (and from the source business's own site) has **not been confirmed**, so none was collected. Only a read-only capability
probe was run on 2026-10-14. Consequences: behaviour on real catalogues (thousands of products, real rate limits, real failure mixes, real flyers, real prices) is **unmeasured**;
doit.aw (JavaScript-rendered) and Super Food Aruba (Freshop storefront, no public feed) have **not** been collected and cannot be without further work; the claim "the collector
attempts the complete accessible catalogue" is tested on fictional sites only.
A fourth competitor's URL ("Cmart") was never supplied and has not been guessed.

## Implemented but not verified here

| Item | Why unverified |
| --- | --- |
| Headless-browser rendering on **real websites** | Verified with real Chrome against local test pages only. Residual risk: DNS rebinding between the browser's own resolution and our check cannot be closed in application code — run rendering workers behind an egress firewall. |
| S3-compatible storage on a **real** service | Tested through the AWS SDK against an in-process S3-compatible fake. Never run against AWS S3, Cloudflare R2 or MinIO. |
| Email through a **real** provider | The SMTP path is tested against an in-process SMTP server. Without `SMTP_URL`, messages stay in the outbox and are never described as delivered; accounts stay visibly unverified. |
| Production bundles | Built; the API bundle was started and `/api/v1/ready` answered `ready`. Not run under load or for a full schedule cycle. |
| `Dockerfile`, `docker-compose.yml` | Written without Docker available; **never built or run**. |
| Backup **restore drill** | Written in [deployment.md](deployment.md); **not executed** (no `pg_dump`/`pg_restore` on the development machine). |
| Graceful shutdown with a real `SIGTERM` | Covered by unit and end-to-end tests; not exercised with a real signal (Windows development machine). |
| open.er-api.com market rates | Client tested against a local imitation; the live service was not called. The fixed AWG peg is the tested default. |
| Accessibility beyond the automated audit | A screen reader, tablet width, hover/focus-state contrast and non-Chromium browsers were not checked. |

## Needs credentials or approval nobody has granted

| Item | What is missing |
| --- | --- |
| Live competitor collection | Recorded permission per website (and the fourth competitor's URL). |
| Shopify inventory | App credentials (`SHOPIFY_CLIENT_ID/SECRET/REDIRECT_URI`), `TOKEN_ENCRYPTION_KEY`, and the merchant's authorisation. The flow is tested end to end against a local imitation; it has never talked to Shopify. |
| Instagram / Facebook | A Meta app; Instagram needs a token from your own professional account and (for production) App Review + Business Verification; Facebook public Pages need "Page Public Content Access". The token's expiry/permissions are checked, but a user token is renewed by a person (a system-user token does not expire). |
| YouTube | `YOUTUBE_API_KEY` (quota 10,000 units/day). |
| Email delivery | `SMTP_URL` and a sender your provider accepts. |
| AI summaries / adjudication / extraction fallback | `ANTHROPIC_API_KEY`. The product is complete without it; every AI number is checked against stored facts. |
| Non-peg exchange rates | A choice of provider (`FX_PROVIDER=open-er-api` is free and needs no key, with attribution). |

## Not implemented

- Price recommendations and billing (out of scope).
- OCR for image-only flyers (reported as "no text layer", never guessed).
- Engagement **history** (only the latest public counts per post are kept, with their own observation time).
- Match "learning" across workspaces, finer permissions than owner / admin / staff, and dedicated adapters for Magento, PrestaShop and BigCommerce.
- Automatic renewal of a Meta user token (it cannot be stored securely without a credential vault).

## Known behaviours to be aware of

- Name-only product matches are capped below certainty and wait for review; with few barcodes published, many pairs need a person.
- Authorised inventory outranks the public "in stock / sold out" flag; disagreements are flagged on the Stock page, not silently resolved.
- Competitor catalogues are refreshed within a request budget and crawl delay; very large catalogues are only partly fresh at any moment, and coverage is always stated.
- A demonstration workspace is only scheduled on a server that allows fictional websites; its sites carry fixture labels everywhere, and a live workspace can never contain one.
- The development demo workspace may show failed runs from before the scheduler fix; re-seed it with `npm run demo:fixtures`.
- Observed marketing content is never described as a paid campaign; summaries describe a pattern only when enough items support it.
