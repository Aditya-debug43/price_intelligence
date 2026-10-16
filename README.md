# Shelfwatch — competitor intelligence for online shops

Shelfwatch watches your online shop and three to five competitor websites, matches their products to yours, and gives you a
daily report: who is cheaper, what is on offer, what is running low in your own shop, and what competitors are promoting.

It is a standalone, multi-tenant web application. Nothing in it is specific to groceries or to one shop platform — you enter
the websites at run time and the app works out how each one can be read.

> **The one rule the whole app is built around:** it never presents something it does not know as if it were known.
> A website that could not be read is shown as *blocked* or *failed*, never as an empty catalogue. Old prices are labelled old.
> A similar-looking product is not called identical. A social post is not called a paid campaign. A missing price is not zero.
> An unknown stock level is not "in stock", and a public website never gets an invented stock quantity.

## What it does

| Area | Behaviour |
| --- | --- |
| **Website profiling** | For each website, finds out what can be collected and says so plainly: *Full / Partial / Limited / Blocked / Failed*, with reasons, platform, currency, catalogue size estimate, robots rules and what is missing. |
| **Collection** | Uses the best available source in order: public platform APIs (Shopify, WooCommerce), sitemaps and feeds, structured data (JSON-LD / microdata), server HTML, optional headless rendering, optional evidence-checked AI extraction, PDF flyers. Respects robots.txt, crawl delays and rate limits; stops on repeated denial; never works around CAPTCHAs, logins or bot protection. |
| **Matching** | Four classes: identical / same product in a different pack / comparable / not comparable. Confidence and reasons are stored, uncertain pairs wait for human review, your decisions are never overwritten. AI adjudication is optional and can never confirm a match on its own. |
| **Prices** | Original price and currency are always kept, with the converted value, the exchange rate used, its source and its time. Unit prices (per 100 g / litre / piece) for pack-size differences. Configurable reporting currency; the Aruban florin uses its fixed 1.79 peg. |
| **Offers & flyers** | Sale prices, banners, promo codes and PDF flyers. A "was" price is only called verified when price history supports it; otherwise it is labelled unverified. Offers expire by a stated policy. |
| **Your own stock** | Low-stock / sold-out / restocked alerts for **your** shop only. Public mode shows availability, never a quantity. Exact quantities come from an inventory connection you authorise (Shopify, read-only). Each transition alerts once. Competitor stock never raises an alert. |
| **Marketing** | Banners and sale pages on the websites, plus posts and videos through the *official* Facebook, Instagram and YouTube APIs when you connect them. Observed content is never labelled a paid campaign. |
| **Daily report** | Ready by a local time you choose (default 09:00 `America/Aruba`). The start time is planned from how long each site actually takes, plus a safety margin. If something runs late, a clearly marked partial report goes out on time. |
| **Exports** | PDF, CSV and Excel are rendered from the same saved snapshot the dashboard shows, so they always agree. |
| **Multi-tenant security** | PostgreSQL row-level security on every tenant table, SSRF-safe fetching, scrypt passwords, HttpOnly sessions, CSRF protection, encrypted integration tokens, secrets redacted from logs. |

## Quick start (local development)

Requirements: **Node.js 22 or newer**. No Docker and no PostgreSQL install are needed — development uses an embedded
PostgreSQL 18.

```bash
npm install
```

Terminal 1 — the database (first run creates it, the roles, the schema and a `.env` with random local secrets):

```bash
npm run dev:db
```

Terminal 2 — a demonstration workspace built entirely from **fictional fixture sites** (clearly labelled "Fixture" everywhere):

```bash
npm run demo:fixtures
```

Terminal 3 — worker, API and web app (`dev:demo` also lets the app reach the local fixture sites and turns on the developer
scheduler; use plain `npm run dev` for real websites):

```bash
npm run dev:demo
```

Open <http://localhost:5173>. The sign-in for the development user is `owner@localhost.test`; its random password is in
`.data/dev-credentials.json` (git-ignored). See [docs/demo-runbook.md](docs/demo-runbook.md) for a guided tour.

To work with your own websites instead, register an account in the app and use **Set up your business**. Adding a website
records *what you are entitled to collect*: collection from a website does not start until you confirm permission for it
([docs/consent-and-compliance.md](docs/consent-and-compliance.md)).

## Using it for real (live mode)

Live and demonstration workspaces are separate by design: a workspace is **live or demo from the day it is created** (a database trigger forbids
changing it), the public sign-up always creates a **live** one, and a live workspace can never contain a fictional fixture website, fixture data
or the stock simulator. A live workspace starts empty and nothing in it is invented.

1. `npm run dev:db` in one terminal, then `npm run dev` in another (no demo flags) and open <http://localhost:5173>.
2. **Create an account**, then name your business — this creates your live workspace. (Without an email service configured the account stays visibly *unverified*; set `SMTP_URL` to enforce verification.)
3. **Set up your business**: enter your own website (the *source*) and **3–5 competitor websites**, your reporting currency and the time you want the daily report (default 09:00 `America/Aruba`).
   URLs are checked when you add them: only public `http`/`https` hosts on the standard ports are accepted; private, loopback, link-local and cloud-metadata addresses, odd ports and embedded credentials are refused with a reason.
4. On **Websites**, each site shows what can be collected and why ("Check this website"). **Confirm permission** for each one — an explicit attestation is recorded, and collection does not start without it — then **Collect**.
5. Follow the checklist on the Dashboard (each step shows whether it is done, what to do next, and what is still to do). Review uncertain matches on **Match review**; read **Price comparison**, **Offers & flyers**, **My stock**, **Marketing activity** and **Reports**; every number links to its evidence and shows when it was seen.
6. **Settings → Integrations** lists exactly what is missing for Shopify (exact stock), YouTube, Instagram and Facebook — see [docs/integrations.md](docs/integrations.md). None of them is needed for price comparison.
7. Invite colleagues under **Settings → People**; they accept with their own account.

`GET /api/v1/ready` (and the status shown in the app) says whether the database, schema, background worker and storage are healthy — start there if nothing is being collected.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Database (if none is running) + worker + API + web with live reload |
| `npm run dev:demo` | Same, with local fixture sites reachable and the developer scheduler on (never for real data) |
| `npm run dev:db` | Embedded PostgreSQL on port 54329; creates roles, runs migrations, writes `.env` |
| `npm run bootstrap:dev` | Creates the local development user (random password → `.data/dev-credentials.json`) |
| `npm run demo:fixtures` | Fictional-fixture demo workspace with two days of history; leaves the fixture sites running |
| `npm run demo:setup` | Creates the intended live-demo workspace with **consent pending** (add `-- --profile` for a light capability check) |
| `npm run live:probe -- <urls>` | Capability probe of real websites (no database; ≈10–25 requests per site; writes `docs/live-probe-<date>-<time>.json`) |
| `npm run fixtures:serve` | Just the fixture websites (ports 4101–4110; control endpoint on 4100) |
| `npm run db:setup` / `db:migrate` / `db:generate` | Create roles, apply migrations, generate a migration after a schema change |
| `npm test` | Unit + integration + end-to-end suites (embedded PostgreSQL, fictional sites, local imitations of the providers; 695 tests) |
| `npm run test:unit` / `test:integration` | One project at a time |
| `npm run lint` · `npm run typecheck` · `npm run format:check` | Static checks |
| `npm run build` | Production builds of web (`apps/web/dist`), API and worker (`apps/*/dist`) |

## Repository layout

```
apps/web         React 19 + Vite interface ("Shelfwatch")
apps/api         Fastify 5 HTTP API: sessions, CSRF, rate limits, tenant-bound transactions
apps/worker      Background jobs: profiling, collection, matching, reports, scheduler, retention, social/inventory sync
packages/core    Pure domain logic with no I/O: URL/IP rules, prices, matching, stock state machine, offers, scheduling, crypto
packages/shared  Types, enums and zod schemas shared by API and web
packages/database  Drizzle schema, migrations, row-level-security setup
packages/connectors  Safe fetcher, profiler, platform connectors, extractors, flyer/social/inventory clients, fixture sites
packages/services  Application services that join the above (scan, match, compare, report, exports, alerts…)
scripts          Dev launcher, database tooling, demos, live probe
tests            Integration and end-to-end suites
docs             Documentation
```

## Documentation

- [Demo runbook](docs/demo-runbook.md) — a guided tour, with and without live websites
- [Architecture](docs/architecture.md) — components, data flow, decisions
- [Data reliability](docs/data-reliability.md) — the 14 rules and the tests that enforce each
- [Consent and compliance](docs/consent-and-compliance.md) — what is collected, from whom, under what conditions
- [Integrations](docs/integrations.md) — Shopify, Facebook/Instagram, YouTube, SMTP, S3, headless browser, AI, exchange rates
- [Deployment](docs/deployment.md) — production configuration, backups and restore, shutdown, readiness, Docker (untested)
- [Limitations](docs/limitations.md) — what is not done, not verified, or needs credentials
- [Production readiness](docs/PRODUCTION_READINESS.md) — verdict, evidence strength, what only you can provide, prioritised remaining work, next step
- [Verification report](docs/verification-report.md) — what was actually run, with results
- [Project context](docs/PROJECT_CONTEXT.md), [work log](docs/WORK_LOG.md) and [requirements matrix](docs/REQUIREMENTS_MATRIX.md) — the master record, the chronological log, and requirement-by-requirement status (start here when resuming work)

## Configuration

Every setting is an environment variable, validated at start-up; an unsafe or invalid value stops the process with a
specific message. [`.env.example`](.env.example) documents all of them. With `NODE_ENV=production` the process refuses to
start if local fixtures, the developer scheduler or demo auto-consent are enabled, or if the token-encryption key or the
worker database role is missing; session cookies default to `Secure`.

## Licence and attribution

Exchange rates, when the optional market-rate provider is enabled, come from open.er-api.com and require attribution
(shown in the app next to converted prices). Fonts (Bricolage Grotesque, IBM Plex Sans, Barlow Condensed) are self-hosted
under the SIL Open Font Licence.
