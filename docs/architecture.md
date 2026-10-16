# Architecture

```
 browser ──► apps/web (React)  ──/api──►  apps/api (Fastify) ──► PostgreSQL (role ci_app, RLS enforced)
                                               │ enqueue only                    ▲
                                               ▼                                 │
                                         pg-boss queues (in PostgreSQL)          │
                                               │                                 │
                                               ▼                                 │
                                       apps/worker ───────────────────────────────┘ (role ci_worker, BYPASSRLS)
                                               │
                       packages/connectors ────┴──► websites, platform APIs, PDFs, official social APIs
```

## Layers

- **`packages/core`** — pure functions with no I/O, so they can be exhaustively unit-tested: URL and IP rules (SSRF), robots.txt,
  price/GTIN/quantity parsing, currency (FX table with a USD pivot, never an assumed rate), the product matcher, the stock state
  machine, offer verification and expiry, scheduling arithmetic, insight scoring, crypto, secret redaction, config validation.
- **`packages/connectors`** — everything that touches the outside world: the SSRF-safe fetcher (connect-time DNS screening of every
  address, manual redirect re-validation, size and type caps, robots cache, per-host limiter with stop-on-denial), the site
  profiler, the platform connectors (Shopify `products.json`, WooCommerce Store API, sitemap + structured data, generic HTML,
  optional Playwright, optional AI fallback), flyer PDF text extraction, official social API clients, inventory providers, and the
  fictional fixture websites used by tests and the demo.
- **`packages/database`** — Drizzle schema, SQL migrations and the post-migration step that enables **and forces** row-level
  security with the policy `org_id = current_setting('app.org_id')::uuid` on every tenant table, installs append-only triggers on
  observations and the immutability trigger on published reports, and grants the two roles. `withTenant(db, orgId, fn)` binds the
  organisation for one transaction. Three tables are exempt and documented: `memberships`, `oauth_states`, `email_outbox`.
- **`packages/services`** — the application: auth, sites and consent, profiling, scan runners, matching, comparison, offers,
  stock and alerts, coverage, report assembly, exports, scheduler, retention, social/inventory sync, queue wiring.
- **`apps/api`** — HTTP only: validation (zod), cookie sessions, CSRF header + Origin check, rate limits, membership check before
  every organisation route (404 for non-members), uniform `{error:{code,message,details}}`. It can enqueue jobs but not read
  queue tables or other tenants' rows.
- **`apps/worker`** — registers the job handlers and the schedule; owns the `pgboss` schema.
- **`apps/web`** — presentation. It never computes a business number: every figure comes from an API response or a saved report.

## One collection, end to end

1. **Profile** (`runProfile`): robots.txt, homepage, sitemaps, ≤3 sample pages → a capability report (status Full / Partial /
   Limited / Blocked / Failed, platform, currency, estimated size, fields found, effort, limitations).
2. **Consent gate**: a scan is refused until permission is recorded for that website.
3. **Scan** (`startScan` → `executeScan`): the best connector for what the profile found, within the request budget and crawl
   delay; every product page or API response becomes an *evidence* row (URL, time, status, content hash, optional raw snapshot).
   A run that extracts nothing is `failed` and the next method is tried; it is never recorded as an empty catalogue.
4. **Ingest**: products and variants are upserted; every price and stock reading is an **append-only observation** with source
   URL, time and method. Missing values stay `null`.
5. **Match**: GTIN → brand + MPN → attributes/name → cross-brand comparable, in four classes with stored confidence and reasons.
   Uncertain pairs wait for review; manual decisions are never overwritten.
6. **Compare / offers / stock / marketing** are live views over the same rows, using the same functions the report uses.
7. **Report**: one immutable JSON document (stable hash) with KPIs, comparison rows, offers, stock, marketing, insights with
   evidence, coverage, FX rates used, warnings. The dashboard, PDF, CSV and Excel render from it and only from it.

## Daily report timing

`planStartTime` = P90 of the slowest site's measured duration × 1.6 safety margin + 10 min assembly, computed in the workspace's
IANA time zone (not a fixed offset). `decideDailyAction` runs every minute: start budgeted scans when due; at the cut-off
publish a clearly labelled **partial** report from what exists. Rolling refreshes cover large catalogues by priority.
`SCHEDULER_MODE=dev` adds a tick endpoint with a fake "now" for demonstrations.

## Decisions worth knowing

- **Why row-level security, not just `WHERE org_id`**: a forgotten filter cannot leak across customers; the API role cannot bypass it.
- **Why append-only observations**: price history and "was price" verification need what was true *then*.
- **Why snapshots for reports**: a number that changes after the fact cannot be audited; exports must equal the screen.
- **Why connectors fall through instead of guessing**: a site that cannot be read is reported as such, with the reason.
- **Why AI is optional and boxed in**: it can suggest, never confirm; numeric claims must match stored facts.
- **Why an embedded PostgreSQL for development**: the integration tests exercise real RLS, triggers and queues without Docker.
