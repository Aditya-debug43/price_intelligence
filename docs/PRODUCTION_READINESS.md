# Production-readiness assessment

**As of 2026-10-15, commit `aa30324`.** Written for the person who decides whether to put Shelfwatch in front of real customers.
Companion documents: [verification-report.md](verification-report.md) (exactly what was run), [limitations.md](limitations.md),
[integrations.md](integrations.md) (what each integration needs from you), [deployment.md](deployment.md), [REQUIREMENTS_MATRIX.md](REQUIREMENTS_MATRIX.md).

## Verdict

**Not yet ready for production use with real competitor data. Ready for a supervised pilot as soon as you give two things: written permission to collect from one real website, and a place to run it.**

The software side is in good shape: 695 automated tests pass (40 files), typecheck and lint are clean, the production bundles build, and the full journey — register → live workspace → own site + competitors → permission → collection → matching → comparison → alerts → report → retention — runs through the real HTTP API against a real PostgreSQL. What has **never** happened is the same journey against a real website. Everything about real-world behaviour (catalogue sizes, rate limits, odd markup, flyer formats, real prices) is therefore unmeasured. That is a gap in evidence, not a known defect — but it is the gap that matters most.

## What was verified, and how strongly

| Area | Evidence | Confidence for production |
| --- | --- | --- |
| Data model, migrations, row-level security, append-only/immutability triggers, roles | Real PostgreSQL 18; isolation tests at API and database level; migration count check at startup and in `/api/v1/ready` | **High** |
| Accounts, sessions, CSRF, roles, invitations, email-bound acceptance | End-to-end tests including cross-tenant attempts | **High**, except email delivery (below) |
| Live vs demo separation (immutable, enforced by triggers) | Database trigger tests; live-journey test | **High** |
| Collection safety: SSRF screening (every redirect, every browser sub-request and WebSocket), robots.txt, rate limiting, no CAPTCHA/login bypass | Unit + integration tests, local imitation sites, real Chrome on local pages | **High for the rules; unproven against real sites' behaviour** |
| Adaptive collection (Shopify/Woo/sitemap/structured data/HTML), resumable runs, capped recovery, cancel, scheduling | Fictional sites incl. large, failing, rate-limited and slow ones | **Medium** — real catalogues untested |
| Normalisation, unit prices, currency, matching, review workflow | Tests with fixtures designed from the real sites' *shape* (not their data) | **Medium** — match quality on real catalogues unmeasured |
| Offers/flyers, review (confirm/correct/dismiss) | Fixture flyers (text-layer PDFs, images) | **Medium-low** — real flyer variety is large; image-only flyers are reported as unreadable, never guessed |
| Own-site stock alerts and lifecycle; competitor stock never alerts | Tests incl. simulated authorised inventory | **High for logic; Shopify never contacted** |
| Marketing (website + Meta/YouTube APIs), backoff, token health, evidence-limited summaries | Local imitations of the providers | **Medium** — real API behaviour and App Review untested |
| Reports (snapshot, PDF/CSV/Excel), 09:00 `America/Aruba` readiness, partial-report rules, retention | Time-controlled scheduler tests; reports generated from snapshots | **High for logic; email delivery unproven** |
| Web interface | Structural audit of 18 views at 1280 px and 375 px; colour contrast measured on 21 views + 4 public pages; keyboard test; long-name stress | **Medium-high** — no screen reader, no tablet width, Chromium only |
| Production hardening: readiness endpoint, graceful shutdown, startup config checks, secrets handling | Tests; production bundle started and answered `ready` | **Medium** — not run under load or for a full schedule cycle |

## What is only proven with fixtures or local imitations

- Every connector, every provider (Shopify, Meta, YouTube, FX, S3, SMTP) — against local imitations that follow the providers' documented behaviour, never the providers.
- All "real-world" numbers: none exist yet.
- Fixtures are labelled everywhere and can never appear in a live workspace.

## What is not verified at all

- Docker image and compose file: written, **never built or run**.
- Backup restore drill: written, **never executed** (no `pg_dump`/`pg_restore` on the dev machine).
- A real `SIGTERM` shutdown (Windows dev machine).
- Behaviour under load, long soak runs, a multi-day schedule on a server.
- Browser rendering on real JavaScript-heavy sites (doit.aw, the Freshop storefront).

## What needs something only you can provide

| Need | Why it blocks | Detail |
| --- | --- | --- |
| **Written permission, per website, to collect** | Without it nothing real can be collected, by design | Groceries To Go Aruba, Ling & Sons, Super Food Aruba, Do-It Aruba; and for the source business's own site |
| **Which one site to use for the first live run** | The single authorised end-to-end run | Suggest the simplest (an open Shopify/Woo-style catalogue), not the Freshop or JavaScript-rendered ones |
| **The fourth competitor's URL ("Cmart")** | Never supplied; never guessed | — |
| A place to run it | No production deployment is authorised or exists | A server with PostgreSQL 18, a worker process, optionally Chrome for rendering behind an egress firewall; [deployment.md](deployment.md) |
| `SMTP_URL` and a sender | Real email delivery and email verification | Without it the outbox is kept and accounts stay visibly unverified |
| Shopify app credentials + merchant authorisation | Exact own-shop stock counts | `SHOPIFY_CLIENT_ID/SECRET/REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY` |
| Meta app (App Review for production), `YOUTUBE_API_KEY` | Official marketing data | Without them Facebook/Instagram/YouTube are shown as "not connected" — never guessed |
| FX provider choice | Non-peg currencies | AWG↔USD is a fixed peg and works now; `FX_PROVIDER=open-er-api` needs no key |
| `ANTHROPIC_API_KEY` (optional) | AI summaries/adjudication | Product is complete without it |

No credential has been requested yet, because none of these integrations is ready for live verification until the item above it exists.

## Known risks

1. **Real-site surprises.** Real catalogues will expose parsing and matching cases the fixtures did not. Expect a tuning round after the first live run.
2. **Rendering and DNS rebinding.** Chrome resolves hostnames itself; our screening cannot close that gap alone. Run rendering workers behind an egress firewall.
3. **Match quality.** With few published barcodes, many pairs need a human decision; the review workflow exists for this but its workload on real data is unknown.
4. **Single-node design.** One API process, one worker, one PostgreSQL. Fine for a pilot; no horizontal-scaling test was done.
5. **Meta token renewal** is manual for user tokens (system-user tokens do not expire).
6. **Operational maturity.** No monitoring/alerting wiring beyond `/api/v1/ready` and logs; no backup automation.

## Remaining work, in priority order

1. **One authorised live run** (blocked on your permission). Collect a single real website end to end, read the result with the owner, record what differed from the fixtures. *Everything else depends on what this teaches.*
2. **Build and run the Docker image; execute the backup/restore drill** on a machine that has Docker and PostgreSQL client tools. (Environment-blocked here.)
3. **Pilot deployment** on a real server with SMTP, then watch two or three 09:00 report cycles.
4. **Shopify connection** for the own site (credentials + merchant authorisation) — exact stock counts.
5. **Real FX provider** decision (only if non-AWG/USD competitors appear).
6. **Meta/YouTube** keys and App Review (long lead time — start early if marketing data matters).
7. Browser-rendering adapters for doit.aw and the Freshop storefront — **only with the store's permission or a feed**.
8. Load/soak testing and monitoring once a real catalogue size is known.
9. Nice-to-haves: engagement history, OCR for image-only flyers, finer permissions, Magento/PrestaShop adapters.

## The precise next step

**Decide which one real website to collect first and confirm, in writing, that collection from it is permitted** (and, if the source business's own site is part of the run, that permission too). Then:

1. `npm run dev:db`, then `npm run dev`; open <http://localhost:5173>, create an account and name your business (sign-up always creates a **live** workspace).
2. Enter your own website and 3–5 competitors on the setup page, then on the chosen website's page click **Record permission…**, tick the confirmation and add a note saying who approved it and when. Collection stays disabled until that is recorded.
3. Click **Collect catalogue**, watch the run's details, and compare the result with the site in a browser.

If you also want the fourth competitor included, send the Cmart address; it will not be guessed.
