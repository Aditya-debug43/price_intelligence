# Production-readiness assessment

**As of 2026-10-19 (after the third directive, "remove the demo product and finish real Shelfwatch").** Written for the person who decides whether to put
Shelfwatch in front of real customers. Companion documents: [verification-report.md](verification-report.md) (exactly what was run),
[limitations.md](limitations.md), [integrations.md](integrations.md) (the truthful checklist), [deployment.md](deployment.md),
[REQUIREMENTS_MATRIX.md](REQUIREMENTS_MATRIX.md) (Part 14 is this directive). Status words are defined at the top of `integrations.md`.

## Verdict

**Not yet claimed production-ready. Ready for a supervised pilot as soon as you give two things: your confirmation that collecting from the first real website pair is allowed, and a place to run it. (Gmail is configured and accepting mail; confirm the messages arrived.)**

What has changed since the last assessment: the demonstration mode no longer exists (one product, fictional websites only inside tests); accounts are genuinely
verified by emailed links; email goes through real SMTP with every message and its outcome recorded; any public website address is accepted, and shops with
no feed or sitemap are collected from their product listing pages; a website that forbids the page you typed is *blocked*, not collected; "no equivalent found" is
worded from how much of each catalogue was actually read; and for the first time **real websites were collected and the stored values were checked against the
real pages** (public scraping sandboxes — 40 of 40 matched).

What has still **never** happened: collecting a website *you* authorised, and comparing prices on two real shops that sell the same goods. (Real email: Gmail accepted the
sign-in, a test message and the app's verification email on 2026-10-19; only the owner's confirmation that they arrived is missing.) Those are the "verified end to end with real website data" bar, and until they are met this document does not say the product is real end to
end — it says "verified on public sandbox shops and a real SMTP server library".

## What was verified, and how strongly

| Area | Evidence | Confidence for production |
| --- | --- | --- |
| Data model, migrations (0000–0010), row-level security, append-only/immutability triggers, roles | Real PostgreSQL 18; isolation tests at API and database level; migration count check at startup and in `/api/v1/ready` | **High** |
| Accounts: registration with emailed verification, sign-in, reset, resend, lockout, sessions, CSRF, roles, invitations | End-to-end tests with captured mail and a real SMTP library in process; cross-tenant attempts | **High** for the logic; **Gmail delivery not yet run** |
| Email delivery bookkeeping (`email_outbox`: queued/sent/retrying/failed/not_configured, Message-ID, provider answer) | Real SMTP library in the test process: authentication, STARTTLS rules, rejected recipients, dropped connections | **Medium-high** — the first real provider is the missing piece |
| Collection safety: SSRF screening (every redirect, every browser sub-request and WebSocket), robots.txt (including the typed page and `/shop` ≡ `/shop/`), rate limiting, no CAPTCHA/login bypass | Unit + integration tests; real requests to a site whose robots.txt forbids the page (refused, 0 pages read) | **High for the rules; real-site behaviour now partly observed** |
| Collection: Shopify/Woo/sitemap/structured data/**listing pages**/HTML, resumable runs, capped recovery, scheduling | Fictional sites (large, failing, rate-limited, slow, no-feed); **real public sandboxes**: static shop collected through its listings, WooCommerce shop through its Store API | **Medium** — real catalogues of customers untested; no complete real-catalogue run yet |
| Stored values equal the page | `npm run test:live`: 40 of 40 stored observations found in the raw page copy, 0 mismatches; live re-fetch still showed the price (3 of 3) | **Medium-high** on the sandboxes; repeat on your sites |
| Normalisation, unit prices, currency, matching, review workflow | Fixtures designed from the real sites' *shape*; the sandboxes (books vs monsters) correctly produced no matches | **Medium** — match quality on real overlapping catalogues unmeasured |
| "No equivalent found" honesty | `assortmentBasis` unit + e2e tests; saved in every report | **High** |
| FX | Real provider fetched once (164 rates, USD→GBP with source and time); AWG peg stays a stated constant | **Medium-high**; no multi-day observation of the 12-hourly refresh |
| Offers/flyers, review (confirm/correct/dismiss) | Fixture flyers (text-layer PDFs, images) | **Medium-low** — real flyer variety is large; image-only flyers are reported unreadable, never guessed |
| Own-site stock alerts and lifecycle; competitor stock never alerts | Tests with a stand-in for an authorised inventory | **High for logic; Shopify never contacted** |
| Marketing (website + Meta/YouTube APIs), backoff, token health, evidence-limited summaries | Local imitations of the providers | **Medium** — real API behaviour and App Review untested |
| Reports (snapshot, PDF/CSV/Excel), 09:00 `America/Aruba` readiness, partial-report rules, retention | Time-controlled scheduler tests; reports from snapshots | **High for logic; email delivery of reports unproven** |
| Web interface | Structural audit of 18 views at 1280 px and 375 px; contrast; keyboard; long names (earlier pass). Entry-page line and assortment wording changed since | **Medium-high** — no screen reader, no tablet width, Chromium only; the changed screens were not re-audited visually |
| Production hardening: readiness (incl. email), graceful shutdown, config checks (https `APP_BASE_URL`, token key, worker role), secrets handling | Tests; production bundle started and answered `ready` (earlier); bundles rebuilt and grepped for fixture traces (none) | **Medium** — not run under load or for a full schedule cycle |

## What is only proven with fixtures, stand-ins or local imitations

- Every provider other than the public websites and the exchange-rate service: Shopify, Meta, YouTube, S3, Anthropic, Gmail — local imitations of their documented behaviour, never the providers.
- All numbers about *your* catalogues: none exist yet.
- The fictional websites are test code only and cannot be reached by the running product.

## What is not verified at all

- Docker image and compose file: written, **never built or run**.
- Backup restore drill: written, **never executed** (no `pg_dump`/`pg_restore` on the dev machine).
- A real `SIGTERM` shutdown (Windows dev machine).
- Behaviour under load, long soak runs, a multi-day schedule on a server.
- Browser rendering on real JavaScript-heavy sites (doit.aw, the Freshop storefront).
- A **complete** run of a large real catalogue (the sandbox run was a 40-product sample; fictional multi-category shops were collected completely).

## What needs something only you can provide

| Need | Why it blocks | Detail |
| --- | --- | --- |
| ~~Gmail address and App Password~~ — **done 2026-10-19** (in `.env`; the password was pasted in chat, so **rotate it** at https://myaccount.google.com/apppasswords after testing) | Real registration and password-reset emails | Remaining: confirm the test and verification emails arrived (inbox or spam), open the link, and try "Forgot password" |
| **Your go-ahead for the first real website pair** | The single end-to-end real collection and comparison run | The original brief names `https://groceriestogoaruba.com/` as the source and `https://shop.lingandsons.com/` (also superfoodaruba, doit.aw) as candidates, and says permission "has not been confirmed". Reply "yes, collect a small sample from groceriestogoaruba.com and shop.lingandsons.com" (or name others) and I run `LIVE_SOURCE_URL=… LIVE_COMPETITOR_URLS=… npm run test:live`: a 40-product sample at a polite pace, robots.txt obeyed |
| **The fourth competitor's URL ("Cmart")** | Never supplied; never guessed | — |
| A place to run it, and its cost | No production deployment is authorised or exists; nothing has been purchased | A server with PostgreSQL 18, a worker process, TLS, optionally Chrome behind an egress firewall; [deployment.md](deployment.md) |
| Shopify app credentials + merchant authorisation | Exact own-shop stock counts | `SHOPIFY_CLIENT_ID/SECRET/REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY` |
| Meta app (App Review for production), `YOUTUBE_API_KEY` | Official marketing data | Without them Facebook/Instagram/YouTube are shown as "not set up" — never guessed |
| `ANTHROPIC_API_KEY` and your approval of the cost (optional) | AI summaries/adjudication | Product is complete without it |

No credential has been requested beyond the Gmail details, because no other integration is ready for live verification until the item above it exists.

## Known risks

1. **Real-site surprises.** The first real run already found a defect the fixtures could not (every page after the first failed on a shop whose listing starts on its home page). Expect more on your sites; each will be fixed with a regression test.
2. **Rendering and DNS rebinding.** Chrome resolves hostnames itself; our screening cannot close that gap alone. Run rendering workers behind an egress firewall.
3. **Match quality.** With few published barcodes — and none at all from listing pages — many pairs need a human decision; the review workflow exists but its workload on real data is unknown.
4. **Gmail limits.** A normal Gmail account sends about 500 messages a day and Google may block sign-in from a new location; fine for a pilot, not for a customer base (use a transactional provider by changing the SMTP settings).
5. **Single-node design.** One API process, one worker, one PostgreSQL. Fine for a pilot; no horizontal-scaling test was done.
6. **Meta token renewal** is manual for user tokens (system-user tokens do not expire).
7. **Operational maturity.** No monitoring/alerting wiring beyond `/api/v1/ready` and logs; no backup automation.

## Remaining work, in priority order

1. **Gmail check, then one authorised real run** (blocked on your details). Register with a real inbox, verify, reset; collect your source and one competitor completely, compare the stored values with the live pages with the owner, record what differed. *Everything else depends on what this teaches.*
2. **Build and run the Docker image; execute the backup/restore drill** on a machine that has Docker and PostgreSQL client tools. (Environment-blocked here.)
3. **Pilot deployment** on a real server with a transactional email provider, then watch two or three 09:00 report cycles.
4. **Shopify connection** for the own site (credentials + merchant authorisation) — exact stock counts.
5. **Meta/YouTube** keys and App Review (long lead time — start early if marketing data matters).
6. Browser-rendering adapters for doit.aw and the Freshop storefront — **only with the store's permission or a feed**.
7. Load/soak testing and monitoring once a real catalogue size is known; a visual pass over the screens changed in this directive.
8. Nice-to-haves: engagement history, OCR for image-only flyers, finer permissions, Magento/PrestaShop adapters.

## The precise next step

1. Look in your Gmail inbox (and spam) for the test message and the "Verify your email address" message sent on 2026-10-19; tell me whether they arrived. Then revoke the App Password you pasted into chat and, if you keep using Gmail, create a new one and type it into `.env` yourself.
2. Give the go-ahead (or other addresses) for the **first real website pair**.
3. I will then run the live collection and comparison — and report exactly which parts ran.
