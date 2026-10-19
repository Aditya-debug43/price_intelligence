# Shelfwatch — competitor intelligence for online shops

Shelfwatch watches your online shop and three to five competitor websites, matches their products to yours, and gives you a
daily report: who is cheaper, what is on offer, what is running low in your own shop, and what competitors are promoting.

It is a standalone, multi-tenant web application. Nothing in it is specific to groceries or to one shop platform — you enter
the websites at run time and the app works out how each one can be read.

> **The one rule the whole app is built around:** it never presents something it does not know as if it were known.
> A website that could not be read is shown as *blocked* or *failed*, never as an empty catalogue. Old prices are labelled old.
> A similar-looking product is not called identical. A social post is not called a paid campaign. A missing price is not zero.
> An unknown stock level is not "in stock", and a public website never gets an invented stock quantity.

There is **one product**. There is no demonstration mode, no sample data and no simulator in the running application: everything it
shows was collected from a real website, typed by a person, or read from a real provider, and says which
([docs/DEMO_REMOVAL_AUDIT.md](docs/DEMO_REMOVAL_AUDIT.md)). Fictional websites exist only inside the automated tests.

## What it does

| Area | Behaviour |
| --- | --- |
| **Website profiling** | For each website, finds out what can be collected and says so plainly: *Full / Partial / Limited / Blocked / Failed*, with reasons, platform, currency, catalogue size estimate, robots rules and what is missing. Any public address works; if you give a page inside a site (`/shop`), that page is what robots.txt is checked against and where the shop is looked for first. |
| **Collection** | Uses the best available source in order: public platform APIs (Shopify, WooCommerce), sitemaps and feeds, structured data (JSON-LD / microdata), product **listing pages** (grids with pagination and category links, for shops that publish no feed or sitemap), server HTML, optional headless rendering, optional evidence-checked AI extraction, PDF flyers. Runs are resumable and say how many pages were found, collected, skipped and failed, and whether the whole catalogue was read. Respects robots.txt, crawl delays and rate limits; stops on repeated denial; never works around CAPTCHAs, logins or bot protection. |
| **Matching** | Four classes: identical / same product in a different pack / comparable / not comparable. Confidence and reasons are stored, uncertain pairs wait for human review, your decisions are never overwritten. AI adjudication is optional and can never confirm a match on its own. |
| **Prices** | Original price and currency are always kept, with the converted value, the exchange rate used, its source and its time. Unit prices (per 100 g / litre / piece) for pack-size differences. Configurable reporting currency; the Aruban florin uses its fixed 1.79 peg. |
| **Offers & flyers** | Sale prices, banners, promo codes and PDF flyers. A "was" price is only called verified when price history supports it; otherwise it is labelled unverified. Offers expire by a stated policy. |
| **Your own stock** | Low-stock / sold-out / restocked alerts for **your** shop only. Public mode shows availability, never a quantity. Exact quantities come from an inventory connection you authorise (Shopify, read-only). Each transition alerts once. Competitor stock never raises an alert. |
| **Marketing** | Banners and sale pages on the websites, plus posts and videos through the *official* Facebook, Instagram and YouTube APIs when you connect them. Observed content is never labelled a paid campaign. |
| **Daily report** | Ready by a local time you choose (default 09:00 `America/Aruba`). The start time is planned from how long each site actually takes, plus a safety margin. If something runs late, a clearly marked partial report goes out on time. |
| **Exports** | PDF, CSV and Excel are rendered from the same saved snapshot the dashboard shows, so they always agree. |
| **Accounts** | Registration needs an email address you can read: the account works only after its emailed, single-use, expiring link is opened. Password reset works the same way. Sign-in is rate-limited and locks after repeated failures. |
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

Terminal 2 — worker, API and web app:

```bash
npm run dev
```

Open <http://localhost:5173>.

**Email comes first.** Nobody can register or reset a password until the server can send mail: a new account is usable only after
its verification link is opened. Set up Gmail (about five minutes; you type the App Password into your local `.env` yourself) by
following [Email in docs/integrations.md](docs/integrations.md#email), then check it:

```bash
npm run email:check -- you@example.com
```

Without it the app still starts and says so on the registration page and in Settings → Notifications; it never pretends a message
was sent.

## Using it

1. **Create an account** with an address you can read, open the link in the email, then sign in and name your business.
2. **Set up your business**: enter your own website (the *source*) and **3–5 competitor websites** — any real public `http`/`https`
   address, for example `https://shop.example.com` or `https://example.com/shop` — your reporting currency and the time you want the
   daily report. Addresses are checked when you add them: only public hosts on the standard ports are accepted; private, loopback,
   link-local and cloud-metadata addresses, odd ports and embedded credentials are refused with a reason.
3. On **Websites**, each site shows what can be collected and why ("Check this website"). **Confirm your collection rules** for each
   one — that is *your* statement that you are entitled to collect from it, recorded with your name and the time; it is never
   presented as the competitor's approval, and robots.txt is obeyed regardless — then **Collect**.
4. Follow the checklist on the Dashboard. Review uncertain matches on **Match review**; read **Price comparison**,
   **Offers & flyers**, **My stock**, **Marketing activity** and **Reports**; every number links to its evidence and shows when it
   was seen.
5. **Settings → Integrations** lists exactly what is missing for Shopify (exact stock), YouTube, Instagram and Facebook — see
   [docs/integrations.md](docs/integrations.md). None of them is needed for price comparison.
6. Invite colleagues under **Settings → People**; they accept with their own account.

`GET /api/v1/ready` (and the status shown in the app) says whether the database, schema, background worker, storage and email are
healthy — start there if nothing is being collected.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Database (if none is running) + worker + API + web with live reload |
| `npm run dev:db` | Embedded PostgreSQL on port 54329; creates roles, runs migrations, writes `.env` |
| `npm run email:check [-- address]` | Signs in to the configured mail server (and sends one real message to `address`); prints the plain-language reason on failure; never prints the password |
| `npm run live:probe -- <urls>` | Capability probe of real websites (no database; ≈10–25 requests per site; writes `docs/live-probe-<date>-<time>.json`) |
| `npm run test:live` | The live procedure: add → check → confirm → collect → verify against the real pages, for real websites (default: public scraping sandboxes; or `LIVE_SOURCE_URL` and `LIVE_COMPETITOR_URLS`). Sends real requests, so it never runs as part of `npm test` |
| `npm run db:setup` / `db:migrate` / `db:generate` | Create roles, apply migrations, generate a migration after a schema change |
| `npm run db:purge-demo` | One-off upgrade tool for databases created before the demonstration mode was removed: lists (and with `-- --yes` deletes) workspaces that still hold fictional data |
| `npm test` | Unit + integration + end-to-end suites (embedded PostgreSQL, fictional sites served inside the tests, local imitations of the providers) |
| `npm run test:unit` / `test:integration` | One project at a time |
| `npm run lint` · `npm run typecheck` · `npm run format:check` | Static checks |
| `npm run build` | Production builds of web (`apps/web/dist`), API and worker (`apps/*/dist`) |

## Repository layout

```
apps/web         React 19 + Vite interface ("Shelfwatch")
apps/api         Fastify 5 HTTP API: sessions, CSRF, rate limits, tenant-bound transactions
apps/worker      Background jobs: profiling, collection, matching, reports, scheduler, retention, social/inventory sync, email delivery
packages/core    Pure domain logic with no I/O: URL/IP rules, prices, matching, stock state machine, offers, scheduling, crypto, SMTP rules
packages/shared  Types, enums and zod schemas shared by API and web
packages/database  Drizzle schema, migrations, row-level-security setup
packages/connectors  Safe fetcher, profiler, platform connectors (feeds, sitemaps, structured data, listing pages), extractors, flyer/social/inventory clients
packages/services  Application services that join the above (auth, mail, scan, match, compare, report, exports, alerts…)
scripts          Dev launcher, database tooling, email check, live probe, live test runner
tests            Integration, end-to-end and live suites; tests/support holds the fictional websites and provider stand-ins (test code only)
docs             Documentation
```

## Documentation

- [Architecture](docs/architecture.md) — components, data flow, decisions
- [Data reliability](docs/data-reliability.md) — the rules and the tests that enforce each
- [Consent and compliance](docs/consent-and-compliance.md) — what is collected, from whom, under what conditions
- [Integrations](docs/integrations.md) — the truthful checklist (status, what was tested for real, blockers, verification steps) plus Gmail, Shopify, Facebook/Instagram, YouTube, S3, headless browser, AI, exchange rates
- [Deployment](docs/deployment.md) — production configuration, backups and restore, shutdown, readiness, Docker (untested)
- [Limitations](docs/limitations.md) — what is not done, not verified, or needs credentials
- [Production readiness](docs/PRODUCTION_READINESS.md) — verdict, evidence strength, what only you can provide, prioritised remaining work
- [Verification report](docs/verification-report.md) — what was actually run, with results
- [Demo removal audit](docs/DEMO_REMOVAL_AUDIT.md) — what the demonstration mode was, what was deleted, what remains test-only
- [Project context](docs/PROJECT_CONTEXT.md), [work log](docs/WORK_LOG.md) and [requirements matrix](docs/REQUIREMENTS_MATRIX.md) — the master record, the chronological log, and requirement-by-requirement status (start here when resuming work)

## Configuration

Every setting is an environment variable, validated at start-up; an unsafe or invalid value stops the process with a
specific message. [`.env.example`](.env.example) documents all of them. With `NODE_ENV=production` the process refuses to
start if the token-encryption key or the worker database role is missing; session cookies default to `Secure`.

## Licence and attribution

Exchange rates, when the optional market-rate provider is enabled, come from open.er-api.com and require attribution
(shown in the app next to converted prices). Fonts (Bricolage Grotesque, IBM Plex Sans, Barlow Condensed) are self-hosted
under the SIL Open Font Licence.
