# Production-readiness assessment

**As of 2026-10-23 (after directive 5, "exhaustive functional, real-data and requirements audit"; the 2026-10-19 verification below still stands except where this says otherwise).** Written for the person who decides whether to put
Shelfwatch in front of real customers. Companion documents: [verification-report.md](verification-report.md) (exactly what was run),
[limitations.md](limitations.md), [integrations.md](integrations.md) (the truthful checklist), [deployment.md](deployment.md),
[REQUIREMENTS_MATRIX.md](REQUIREMENTS_MATRIX.md) (Parts 14 and 16 are the last two directives). Status words are defined at the top of `integrations.md`.

## Verdict

**Not production-ready, but deployed as a demonstration (2026-10-26).** The backend runs on one AWS EC2 instance (API, worker, PostgreSQL, nginx with a Let's Encrypt certificate) and the web app on Vercel, connected through a Vercel rewrite; registration, email verification, login, protected routes, a worker job and a full reboot were tested on the deployed system (see "The backend on AWS EC2" in [deployment.md](deployment.md) and "Backend on AWS EC2" in [verification-report.md](verification-report.md)). What is still missing for production: a stable address (Elastic IP) and a domain, backups kept off the server, monitoring and alerting, a restricted SSH rule, load testing, and a decision on open sign-up.

**What is now true (verified 2026-10-19, with real external data):**

- Your shop and three competitors were collected **completely** (groceriestogoaruba.com 2,381 products; shop.lingandsons.com 1,850, in florins; foodstore2go.com 863; quickmartaruba.com 2,566). Two named competitors (Super Food Plaza, www.lingandsons.com) cannot be collected and are shown as unavailable, never as "no match".
- Prices stored equal the live product pages (24 pairs checked on both sides), and the price differences the app displays equal an independent calculation, including AWG → USD (peg 1.79). The report holds the same figures.
- Real catalogues exposed defects that fixtures could not (junk vendor "brands", $0 prices, a standing "regular price" counted as sales, pack notation, flavour/vintage conflicts, a comparison page that mixed unreviewed pairs into results). All are fixed with tests.
- The production bundles (API, worker, web) run with `NODE_ENV=production` and pass an 18-check smoke test; a real browser signs in and reads the real data.
- Real Gmail delivery works from the app (verification, daily summary, collection-failure emails recorded `sent`).

**What the 2026-10-23 audit changed:**

- **Permission is now checked, and it blocks.** The product only ever read `robots.txt`; the competitors' public **terms** forbid (Quickmart, Super Food Plaza) or restrict (foodstore2go, Ling & Sons) automated copying. Shelfwatch now reads the terms, quotes the clause, and refuses to collect from a website whose terms forbid automated access unless the owner's written permission is recorded. **No competitor was collected in the audit; the cross-store comparison on freshly collected competitor data therefore needs the owners' permission (or your informed decision) first.** Data collected from them on 2026-10-19 is still stored.
- **Your shop is verified completely:** 2,381 / 2,381 products and all 2,385 variants reconciled against its public feed and sitemap (0 differences on 11 fields), 60 of 60 random product pages agree, four re-collections produced no duplicates or spurious changes.
- **A single missing input was the biggest limit on comparisons:** 54 % of your shop's variants had no readable size (the size lives in `Size_…` tags). Reading it raised the share with a size to 98 %, and on the competitor data already held the products with an *identical* proposal went from 207 to 605 — all still awaiting a person's review.
- The price calculation was re-derived independently for every confirmed cell (217): 0 differences. Matching rules were tightened from a one-by-one read of all 235 accepted pairs.

**What is still not verified:** any deployment; arrival of the Gmail messages in your inbox; own-store stock alerts on real data (the shop's feed shows everything in stock); real flyers; retention on real data; Shopify authorised inventory, Meta, YouTube, Anthropic, S3 (no credentials); Docker; backup restore; behaviour under load.

**What limits the value of real data today:** none of the four shops publishes a barcode or a usable brand, so every match rests on name + size and **needs a person's decision** (235 identical, 661 comparable, 41 different-pack proposed). Bulk review and a "confirmed only" default exist for this reason; the figures a customer sees are only as good as the review.

## What was verified, and how strongly

| Area | Evidence | Confidence for production |
| --- | --- | --- |
| Data model, migrations (0000–0010; 11 applied), row-level security, append-only/immutability triggers, roles | Real PostgreSQL 18; isolation tests at API and database level; migration count check at startup and in `/api/v1/ready` (verified on the production bundle) | **High** |
| Accounts: registration with emailed verification, sign-in, reset, resend, lockout, sessions, CSRF, roles, invitations | End-to-end tests with captured mail and a real SMTP library; real Gmail accepted verification mail; browser sign-in on the production bundle; cross-tenant attempts | **High** for the logic; inbox arrival unconfirmed |
| Email delivery bookkeeping (`email_outbox`), reserved-address guard | Real SMTP library in tests; **real Gmail** (verification, daily summary, failure digests: `sent`, Message-ID stored) | **Medium-high** — Gmail's ~500/day limit; use a transactional provider for customers |
| Collection safety: SSRF screening, robots.txt, rate limiting, no CAPTCHA/login bypass | Unit + integration tests; real requests (a forbidden page refused with 0 pages read; four real shops collected at 1.5 s pacing, 5–29 requests each) | **High** |
| Collection of real shops: Shopify, WooCommerce | **Four real shops complete**; fictional shops for failure modes; sandboxes for listing crawl | **Medium-high** — a 2,500-product shop took ~29 requests; much larger or JavaScript-only shops untested |
| Stored values equal the page | 40 of 40 on the sandboxes; **24 of 24 live-page price pairs on the real shops** (22 exact on difference; 2 explained) | **High** on the shops tested |
| Normalisation, unit prices, currency (AWG), matching, review workflow | Real titles from four shops; independent page checks; regression tests built from the real title shapes | **Medium** — no barcodes/brands means human review is the real gate; 24 of 235 accepted matches were spot-checked |
| "No equivalent found" and "can't see that shop" honesty | `assortmentBasis` tests; real data: two unavailable shops shown as such; report marked partial | **High** |
| FX | Real provider fetched (164 rates); AWG peg stays a stated constant; used on real AWG prices | **Medium-high**; no multi-day observation of the 12-hourly refresh |
| Offers | Real data: 149 sale prices + 2 banners (all "unverified"); a standing display price is not counted as a sale | **Medium-high**; real flyers/PDFs unverified |
| Own-site stock alerts and lifecycle | Fixtures only (the real feed says all products are available) | **High for logic; real data unverified** |
| Marketing (Meta/YouTube) | Local imitations of the providers | **Medium** — real API behaviour and App Review untested |
| Reports (snapshot, PDF/CSV/Excel), 09:00 `America/Aruba` schedule, partial-report rules | Real data; the real worker ran the schedule for hours and sent summaries; next run shown 2026-10-20 09:00 | **High for logic; a multi-day server cycle unverified** |
| Web interface | Real data at 1280 px (all pages) and 375 px (dashboard, comparison, review, reports, settings); no console errors; earlier structural/contrast/keyboard audit | **Medium-high** — no screen reader, tablet, Safari/Firefox |
| Production hardening: readiness, graceful shutdown, config checks, secrets handling, static caching | Production bundles run locally (18/18); unsafe production configuration refuses to start (tests) | **Medium** — not run under load or on a server |

## What is only proven with fixtures, stand-ins or local imitations

- Every provider other than the public websites, the exchange-rate service and Gmail: Shopify, Meta, YouTube, S3, Anthropic — local imitations of their documented behaviour.
- Stock alerts, retention and flyer reading on real data.
- The fictional websites are test code only and cannot be reached by the running product.

## What is not verified at all

- **Production hardening of the deployment**: no load or soak test; backups only on the same disk; no monitoring or alerting; a single small instance (t3.micro); the public IP is not fixed.
- Docker image and compose file: written, **never built or run**.
- Backup restore drill: written, **never executed** (no `pg_dump`/`pg_restore` on the dev machine).
- A real `SIGTERM` shutdown (Windows dev machine).
- Behaviour under load, long soak runs, a multi-day schedule on a server.
- Browser rendering on JavaScript-only shops (Super Food Plaza's Freshop storefront, doit.aw).

## What needs something only you can provide

| Need | Why it blocks | Detail |
| --- | --- | --- |
| **AWS access on the development machine, and a description of the existing environment** | Phases "inspect and update the existing AWS deployment" and "verify the deployed journey" cannot start | AWS CLI installed and signed in through a profile or SSO (configure it yourself; never paste keys in chat), the account/region, which service type runs the backend (App Runner, ECS/Fargate, Elastic Beanstalk, EC2, Lambda…), where PostgreSQL lives (RDS?), the frontend's hosting, the domain. I will not create resources, DNS or anything with a cost without your approval |
| **Permission from the competitors (or your explicit decision)** | The terms of Quickmart and Super Food Plaza forbid automated access; foodstore2go's and Ling & Sons' restrict copying / commercial use. Nothing further is collected from them until you have written permission (recorded in the app with where it is kept) or tell me you accept responsibility for the restricted ones | Ask each owner in writing for permission or a product feed; record it under Websites → site → Confirm collection rules. Say whether the data already collected on 2026-10-19 should be kept or removed. `www.lingandsons.com` has no catalogue — the shop is `shop.lingandsons.com` (your original brief named it): say if you want it added |
| Gmail App Password rotation | The old password was pasted in chat | Revoke it at https://myaccount.google.com/apppasswords; type any new one into `.env` (or AWS secret storage) yourself |
| Confirmation that the Gmail messages arrived | Inbox arrival cannot be seen from here | Check inbox and spam for the verification, daily-summary and failure emails sent on 2026-10-19 |
| **The fourth competitor's URL ("Cmart")** | Never supplied; never guessed | — |
| Authorised own-shop inventory (Shopify app credentials + merchant authorisation) | Real own-stock alerts (the public feed shows everything as available) | `SHOPIFY_CLIENT_ID/SECRET/REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY` |
| Meta app (App Review for production), `YOUTUBE_API_KEY` | Official marketing data | Without them Facebook/Instagram/YouTube are shown as "not set up" — never guessed |
| `ANTHROPIC_API_KEY` and your approval of the cost (optional) | AI summaries/adjudication | Product is complete without it |
| Your decision on foodstore2go.com | It appears to be a Bahamas-based shop | Keep it as a competitor only if its prices are meaningful for your customers |

## Known risks

1. **Review workload.** With no barcodes and no brands, hundreds of pairs need a person. Bulk accept helps but a wrong bulk accept is a wrong price claim (e.g. vintages): the rule set is now stricter, yet identity still rests on names.
2. **Real-site surprises.** Each new shop has so far exposed something. Expect more; each will be fixed with a regression test.
3. **Rendering and DNS rebinding.** Chrome resolves hostnames itself; run rendering workers behind an egress firewall.
4. **Single-origin hosting.** The web app only works when the page and `/api` share one origin (API serving the web build, or a proxy that forwards `/api/*`). Hosting the frontend on a separate hostname (for example GitHub Pages) will not work without a redesign of cookies/CORS/CSRF — see [deployment.md](deployment.md).
5. **Gmail limits.** About 500 messages a day and Google may block sign-in from a new location; fine for a pilot.
6. **Single-node design.** One API process, one worker, one PostgreSQL; no horizontal-scaling test.
7. **Operational maturity.** No monitoring/alerting wiring beyond `/api/v1/ready` and logs; no backup automation.

## Remaining work, in priority order

1. **Give AWS access and describe the existing environment**, then: inspect, back up, migrate (never reset), deploy the verified build, check readiness/worker/HTTPS/cookies/logs, run a disposable-account customer journey on the deployed system.
2. Review the 702 proposed pairs in the real workspace (or accept that comparisons are limited to confirmed matches).
3. Build and run the Docker image; execute the backup/restore drill on a machine that has Docker and PostgreSQL client tools.
4. Shopify connection for the own site — exact stock counts; flyers from real sites.
5. Meta/YouTube keys and App Review (long lead time).
6. Browser-rendering adapters for Super Food Plaza — **only with the store's permission or a feed** (it asks for a 10 s crawl delay).
7. Load/soak testing and monitoring; a screen-reader and tablet pass.
