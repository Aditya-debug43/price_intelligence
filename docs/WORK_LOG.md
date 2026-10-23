# Shelfwatch — Engineering Work Log

Chronological log of work done **after** `docs/PROJECT_CONTEXT.md` was written (2026-10-15). The master file describes the whole
project and its state; this file records what happens next: actions, files changed, commands, results, problems, decisions, open items.

Conventions: times are UTC (`date -u`) where known; "Result" lines are real command output summaries; secrets are never recorded.
Update this file after every major phase and before stopping for any usage limit.

## How to resume (always keep this block current)

1. Read `docs/PROJECT_CONTEXT.md`, then this file from the bottom up, then `docs/original-prompt/*`.
2. `git status` and `git log --oneline | head` — commits listed below are the checkpoints (see the commit list at the bottom of the latest entry).
3. Baseline commands: `npm run lint && npm run typecheck && npm test && npm run build`.
4. Live dev: `npm run dev:db` (terminal 1), `npm run dev` (terminal 2) → http://localhost:5173 . There is no demo mode or demo data any more (removed 2026-10-18); registering needs working email (`npm run email:check`).
5. **Do not run live catalogue collection against any website the user has not named.** `npm run test:live` defaults to public scraping sandboxes only; for the user's sites set `LIVE_SOURCE_URL` / `LIVE_COMPETITOR_URLS`. Never invent the Cmart URL. Never ask for, print or store the Gmail App Password (the user types it into `.env`).
6. Current open items and what to ask the user for: `docs/PROJECT_CONTEXT.md` → "Update 3", and `docs/PRODUCTION_READINESS.md` → "The precise next step".

---

## 2026-10-15 — Phase 0: context preservation

**07:38** User sent the directive (`docs/original-prompt/02_DIRECTIVE_REAL_PRODUCT_2026-10-15.md`): preserve context, then move beyond the fixture demo to a real, usable product.

**Actions (no application code changed in Phase 0):**
- Located the transcript (`C:\Users\<user>\.claude\projects\D--competitive-analysis\<session>.jsonl`, ≈13.8 MB) and extracted the **original prompt** (45,423 chars, 2026-10-13T18:02Z) and the **directive** (43,377 chars) programmatically; confirmed there are exactly three further short user messages ("continue" ×3). Stored verbatim copies (wrapper tags removed) in `docs/original-prompt/01_ORIGINAL_PROMPT.md` and `02_DIRECTIVE_REAL_PRODUCT_2026-10-15.md`.
- Re-read the whole original prompt (all 1,250 lines).
- Inventoried the repository: 195 tracked files; 34 DB tables; 2 migrations; ≈23k LOC TypeScript/CSS/SQL; API routes; job names; env schema; npm scripts; tests per file.
- Found 2 untracked archives in the repo root (`competitor-intelligence.zip`, `competitor-intelligence1.zip`) — user-created, left untouched. `fixtures/` at the root is an empty directory.
- **Baseline verification (read-only):**
  - `npm run lint` → 0 errors, 2 warnings (`extract.ts:23`, `jobs.ts:17`, intentional `any`).
  - `npm run typecheck` → clean.
  - `npx vitest run` → **393 passed / 0 failed / 0 skipped, 19 files, ≈68 s** (unit project 258, integration project 135; exact per-file counts in PROJECT_CONTEXT §G.1).
  - `npm run build` → web, API, worker built.
- Quick audit for fiction in production code: no hard-coded demo URLs outside `scripts/demo-setup.ts`; no `Math.random` in logic (only a toast id); `is_fixture` flags exist on sites/evidence/observations/marketing; dev-only endpoints/simulator are enabled whenever `NODE_ENV != production` for **any** workspace; fixture hosts are permitted by the **global** flag `ALLOW_LOCAL_FIXTURES`. → motivates Phase 2.
- Wrote `docs/PROJECT_CONTEXT.md` (sections A–I) and verified selected claims against the code (retention behaviour, org routes, competitor limit, auth verification rule). **Corrected one wrong claim** (stale-scan recovery has no direct test).

**Decisions:** keep the existing architecture (PostgreSQL + RLS, Fastify, pg-boss, React UI); implement demo/live separation as an **organisation-level `mode`** rather than relying on flags; add a provenance model rather than relying on `is_fixture` booleans alone.

**Open questions for the user (to ask at the right moment, not now):** live-collection permission per site; Cmart URL; email provider; Shopify/Meta/YouTube credentials; FX provider; Anthropic key.

**Phase 0 complete.** Next: Phase 1 (baseline audit + requirements matrix).

---

## 2026-10-15 — Phase 1: baseline audit (no application code changed yet)

**Live-mode walk-through** (`npm run dev`, no demo flags; `GET /api/v1/meta` → `devTools:true, allowLocalFixtures:false, emailConfigured:false, aiProvider:none`):
- Registered a throwaway local test account in the browser (generated password, not recorded) → onboarding → created workspace "Audit Co (live audit workspace)" → Setup page empty (no fabricated competitors) → Dashboard shows only "Start by telling us about your business" (good).
- **Findings (⚠️ = defect):**
  - ⚠️ RD1: clicking **Generate report now** on an empty workspace creates a `ready` report whose headline says *"No significant changes or price gaps were detected in the collected data."* although nothing was collected. (Absence presented as a finding.)
  - ⚠️ J12: **Small live refresh** with no websites returns `202 {"started":[],"skipped":[]}` (UI would show a success toast for nothing). `POST /matches/run` and `/social/sync` likewise enqueue jobs with nothing to do.
  - ⚠️ F1: the inventory **simulator** endpoint (`POST /integrations/dev-inventory`) is reachable in a *live* workspace (only refused because no source site existed yet); dev routes are enabled for every org whenever `NODE_ENV != production`.
  - ⚠️ J3: URL validation is strong (javascript:, ftp:, localhost, 127.0.0.1, [::1], 169.254.169.254, 10.x, NAT64-of-private, embedded credentials, junk all rejected with clear messages) **but `http://example.com:8080` is accepted** at add time although the fetcher only allows ports 80/443 (collection would later fail confusingly). Test site created and deleted again.
  - ⚠️ C9: `GET /scans/:id` returns queue counts and the first 20 failed URLs with errors, but **the web UI never calls it**.
  - ⚠️ F6: a competitor that has simply **not been collected yet** (no products, capability not blocked/failed) is rendered as "no match found" in the price matrix.
  - ✅ AU2 (live): as the new user, every read/write against the fixture-demo workspace in the same database returned 404 (`/`, sites, products, reports, alerts, integrations, dashboard, members, settings, stock, comparison, POST sites).
- Code reading: `Setup.tsx` saves settings + sites, then profiles the touched sites and lands on `/websites`; permission and collection are separate manual steps on each site page; there is no checklist/next-step guidance (J13). Auth: with no `SMTP_URL`, unverified users can sign in (flag stays null) — to be surfaced/enforced (AU3). `recoverStaleScans` is invoked from every scheduler tick but has no direct test (SC2). Retention (`retention.ts`) deletes snapshots at 90 d and history/reports/exports at 365 d per org settings.

**Artifacts:** `docs/REQUIREMENTS_MATRIX.md` (requirements → implementation → gap → phase).

**Decisions for Phase 2 (design):**
1. `organizations.mode` = `'live' | 'demo'` (default `live`) via migration `0002`; demo orgs are created only by the demo scripts (or an explicit admin-only dev path); live orgs refuse fixture/loopback sites, the simulator and dev-only conveniences regardless of environment flags.
2. Add a `provenance` column (`public_web | authorised_api | official_social_api | user_input | exchange_rate_service | fixture`) to evidence and observation tables; derive/back-fill from existing columns; show it in the UI.
3. One server-computed **site collection status** taxonomy (not configured / not profiled / awaiting permission / not yet collected / collecting / partially collected / collected / stale / access denied / unsupported / failed) used by Websites, Dashboard, Comparison and Reports.
4. `GET /journey` returns the onboarding step states + the next action; the UI shows a checklist until the first report exists.
5. Controls that cannot act return an honest `409` with a reason (no silent `202` no-ops); reports with no usable data say so explicitly.

**Next:** Phase 2 implementation (commit docs first).

---

## 2026-10-15 — Phase 2 (part 1): live/demo separation, provenance, honest status, guided journey

**Migration `0002_provenance_and_org_mode`** (drizzle-kit generated, plus a hand-written backfill): `organizations.mode` (`live`|`demo`, default `live`); `provenance` on `evidence`, `price_observations`, `stock_observations`, `offers`, `marketing_activities`, `exchange_rates`. Backfill: workspaces containing fixture sites become `demo`; fixture-derived rows become `fixture`; authorised-inventory stock rows `authorised_api`; fixed pegs `configuration`; official-API marketing `official_api`. The append-only trigger is paused only inside the migration for the observation backfill and re-enabled. **Applied to the real dev database and verified:** the demo workspace became `demo`, "Audit Co" stayed `live`, 202 evidence rows and 458 price rows were labelled `fixture`, and the triggers exist.

**Database guards (post-migrate):** `organizations_mode_immutable` (a workspace's mode can never change) and `sites_fixture_only_in_demo` (a fixture website can never exist in a live workspace, on insert or update).

**Services:** new `workspace.ts` (`getOrgMode`, `provenanceFor`, `loopbackAllowed`, `WorkspaceModeError`, `ActionNotPossibleError`), `readiness.ts` (`loadReadiness`, `assertCanReport/Match/SyncSocial`), `journey.ts` (`loadJourney`). `createOrganization(..., {mode})` (the public API always creates live). Site validation is mode-aware: loopback only for fixture sites in demo workspaces on servers that allow fixtures; the fetcher default is `allowLoopback:false`, decided per site in profiling and scanning; the headless renderer never allows loopback; **port rule enforced at add time** (80/443 only). The inventory simulator and the developer clock are demo-only (service and API level, `wrong_workspace_mode`). Provenance is written at every storage point.

**Core:** `site-status.ts` — `deriveSiteStatus` (inactive / not_profiled / awaiting_permission / access_denied / unsupported / not_collected / collecting / failed / partial / collected / stale), attached to `SiteCoverage.status` and `consent`, and returned by `GET /sites`, the comparison facets and the dashboard.

**API:** memberships and `GET /orgs/:id` carry `mode`; `GET /journey`; honest **409** answers for `POST /refresh` (`nothing_to_refresh`, with per-site reasons), `POST /reports` (`nothing_to_report`), `POST /matches/run` (`nothing_to_match`), `POST /social/sync` (`no_social_accounts`). A report with no source or no collected data now says "This report has no findings: …" instead of "No significant changes…".

**Web:** demo banner and "Demo" tag; `ProvenancePill` (evidence, offers, marketing); `SiteStatusPill` on Websites, Dashboard and the price matrix ("not available — <state>" instead of "no match found" for uncollected competitors); honesty bar counts "need attention" from the unified status; numbered `JourneyCard` on an empty dashboard and compact on Dashboard and Websites; dashboard buttons disabled with reasons; demo-only hints hidden in live workspaces.

**Tests added (26):** `tests/e2e/workspace-modes.test.ts` (13), `tests/e2e/honest-controls.test.ts` (6), `packages/core/src/site-status.test.ts` (7). Existing tests adapted: the harness creates **demo** tenants by default (`newTenant(label, {mode})`); `api.test.ts` creates a live org through the API and a demo org the way the demo scripts do.

**Bugs found by my own tests/walk-through while building this (fixed):** the journey said "permission recorded" for unchecked websites with consent pending (now uses recorded consent); the journey counted an empty-workspace report as progress (now requires collected data); the fixture hint showed in live workspaces.

**Results:** `npx vitest run` → **419 passed / 0 failed, 22 files**; lint 0 errors (2 intentional warnings); typecheck clean.

**Live browser walk-through (live workspace "Audit Co"):** the guided "Get started" card renders; adding three IANA documentation domains through the real Setup form created the websites with status "Not checked yet / Next: Check this website". The browser session later returned to the login page (not yet investigated; no data impact).

**Next:** finish the live walk-through, Phase 3 (collection observability: scan detail with failed URLs, per-field extraction reasons), update docs/matrix, commit.

---

## 2026-10-15 — Phase 3 (collection observability) and Phase 4 part 1 (match review) — commit af0a872

**Phase 3 — collection observability.**
- `packages/core/src/scan-explain.ts` (`explainScanRun`): turns a scan run's counters and error text into a plain-language outcome ("Checked 40 of 40 products", "Stopped: the website refused access", …), a list of reasons, and next steps. 6 unit tests.
- `GET /scans/:id` now returns `explanation`, `failureReasons`, `failedUrls` (with errors) and `skippedUrls`. The Websites page shows them in expandable run rows (`ScanDetailPanel`) — previously the UI never called this endpoint (finding C9).
- `tests/e2e/collection-observability.test.ts` (6): complete, partial, denied, unsupported and failed runs produce the right explanation through the real API.
- **SSRF / rendering re-audit.** Read the fetcher end to end; it holds up. Added 21 regression cases to `safe-fetch.test.ts` (66 total): alternative spellings of loopback/private IPv4 and IPv6 (decimal, octal, hex, short forms, mapped, NAT64), DNS answers that map to private ranges, redirects to internal spellings. **Real defect found in the browser path:** a page could open a WebSocket to an internal address because only HTTP sub-requests were screened. Added a test that fails without the fix (a local WebSocket server sees no upgrade), then `routeWebSocket` blocking in `packages/connectors/src/providers.ts`. `browser.test.ts` now has 6 tests against real Chrome. Residual risk (documented, not fixable in application code): DNS rebinding between the browser's own resolution and our check → production rendering workers should sit behind an egress firewall.

**Phase 4 part 1 — match review.**
- `searchMatchCandidates` / `setManualMatch` in `packages/services/src/matching.ts`; `GET /matches/candidates` (ranked by the matcher with its reasons, optional text and site filter) and `POST /matches/manual` (admin; stores accepted / method `manual` / confidence 1; rejects the suggestion being replaced and other open suggestions for that product and site; audit event `match.manual`). The match list now returns both variants' availability, observed-at, GTIN, SKU and category plus `competitorSiteId`, `decidedByPerson`.
- `Matches.tsx`: side-by-side table (differing rows highlighted; a missing barcode is shown as "not published", not zero), source links, "Choose a different product…" picker with class selector, "decided by a person".
- `tests/e2e/match-review.test.ts` (6): evidence fields present, candidates ranked and filtered, manual choice supersedes the suggestion, survives the next matching run, the comparison uses it, invalid pairs rejected (400), other workspaces get 404.
- **Verified in the real browser** against the seeded demo workspace: the fixture data proposes "Horizon Whole Milk 1.89L" ↔ "Horizon Chocolate Whole Milk, 1.89L" at 82% *identical* (a genuine false positive); the picker ranked the right product first (90%); choosing it moved the wrong suggestion out of "Needs review" and showed the choice under "Confirmed by you" (100%, decided by a person).

**Results:** `npx vitest run` → **459 passed / 0 failed, 25 files**; lint 0 errors (2 intentional warnings); typecheck clean in every workspace.

**Next:** Phase 5 — alert resolution state and evidence links; flyer/offer review actions; social providers (engagement metrics, token expiry/refresh/quota/backoff); then Phase 6 (readiness endpoint, stale-scan recovery test, retention tests, email-verification policy, invitations, integration reference table, graceful shutdown, backup guidance).

---

## 2026-10-15 — Phase 5 part 1: alert lifecycle, stock-conflict display, offer/flyer review

**Alert lifecycle (migration `0003_alert_lifecycle`).** `alerts` gained `evidence_id`, `resolved_at`, `resolution_kind` (automatic|manual), `resolved_by`, `resolution_note`, `resolution_evidence_id` and a partial index on unresolved alerts. Status is derived: open → acknowledged → resolved.
- **Automatic resolution** (`resolveClearedAlerts`): low/out-of-stock alerts close when an observation shows the item is no longer in that state (the observation is kept as resolution evidence; an "unknown" reading resolves nothing); collection-failure alerts close when the website is collected successfully again; integration-issue alerts close when the sync succeeds or the connection is disconnected. A person's resolution is never rewritten later.
- **Manual resolution** (`POST /alerts/:id/resolve`, any member, optional note ≤500 chars): records who/when/why and acknowledges at the same time; refused with a reason (409) when already resolved or when the alert is a one-off notice (restocked, report ready…); 404 for other workspaces' alerts. `acknowledge-all` leaves resolved alerts alone; the dashboard counts only unresolved+unacknowledged alerts.
- **Evidence**: new alerts carry the page observation that raised them (`evidence_id`) plus `data` (quantity, threshold, basis, from→to, observedAt, connectionId); authorised-connection alerts say there is no page. `GET /alerts` now returns status, product/site, evidence (URL, observed-at, provenance, snippet, whether the stored copy was purged), acknowledger and resolution details; filters open/acknowledged/resolved/all.
- **Backfill** for existing alerts: the next stock alert for the same item (or next failure alert for the same website) is real evidence that the earlier condition ended and supplies the resolution time; for the rest, current state decides and the note says the exact time was not recorded. Applied to the dev database (2 older-episode alerts resolved; current ones left open).
- **UI**: Alerts page with Needs attention / Acknowledged / Resolved / All tabs, "Evidence and history" panel, "Mark resolved…" dialog with note. **Stock page** now shows the page-vs-inventory conflict text and a link to the page, not only a tooltip.
- **Tests**: `tests/e2e/alert-lifecycle.test.ts` (16) — real scans + simulated authorised inventory + API.

**Offer / flyer review (migration `0004_offer_review`).** `offers` gained `review_status` (unreviewed|confirmed|corrected|dismissed), `reviewed_by/at`, `review_note`, `original_reading`. `POST /offers/:id/review` (admin): confirm; correct (title, sale/original price, currency, validity — original must exceed sale, end after start; the machine's first reading is kept; discount recomputed; confidence 1; verification stays "unverified"); dismiss ("not an offer"). Dismissed offers disappear from lists, reports and product pages unless asked for. Re-collecting a flyer only refreshes "last seen" — the verdict is permanent (tested by forcing the flyer to be read again). Sale prices derived from product prices are catalogue facts and cannot be reviewed (409 `not_reviewable`). `GET /offers?review=needs_review|reviewed|dismissed`. UI: Review filter, confirm / "Correct what was read…" dialog / "This is not an offer", review history with the machine's original reading. Verified in the browser against the demo flyer data. **Tests**: `tests/e2e/offer-review.test.ts` (11).

**Results:** `npx vitest run` → **486 passed / 0 failed, 27 files**; lint 0 errors (2 intentional warnings); typecheck clean.

**Next:** Phase 5 part 2 — marketing providers (engagement metrics, token expiry/refresh/quota/backoff, theme/timing summaries); then Phase 6.

---

## 2026-10-15 — Phase 5 part 2: marketing providers (engagement, token health, quota/backoff, summaries)

All verified against **local imitations** of the YouTube and Meta APIs — no real provider was contacted and no real credential exists in this project.

**Connectors (`packages/connectors/src/social.ts`).** Engagement counts: YouTube (`videos?part=statistics`, one call for all videos; a failed statistics call never discards the uploads), Instagram (`like_count`, `comments_count`), Facebook (reaction/comment summaries, shares). A count the platform does not give is `null`, never 0. Every provider failure is classified (`quota | rate_limit | transient | permission | not_found | auth`) with Retry-After support; Meta OAuth sub-codes 458/459/460/463/467 are reported as a revoked grant. `checkMetaToken` (Meta `debug_token`, costs no API quota): validity, expiry date and days left (warning at 14 days), missing permissions (instagram_basic, pages_show_list, pages_read_engagement), data-access expiry; says exactly which variables to set when the check cannot run. Tests: `social-health.test.ts` (20).

**Core (pure, unit-tested).** `social-backoff.ts`: next Pacific midnight (DST-correct) for the YouTube quota reset, exponential backoff capped at 6 h, Retry-After honoured, missing approval re-checked daily, wrong handle weekly, refused credential never retried by itself; `shouldSkipSync` — a person can retry a bad credential or an early hiccup but **never override a quota or rate limit**; a changed credential starts fresh. 13 tests. `marketing-summary.ts`: counts, recurring themes (a term must appear in ≥2 *different* items), brand mentions in promotions (word-boundary, labelled "not proof of a discount"), weekday timing only with ≥5 dated promotions in the customer's time zone (otherwise it says how many it has), most liked / most viewed **ranked separately** (found and fixed: my first version compared views with likes), per-competitor limitations. 13 tests.

**Services/DB (migration `0005_social_health_engagement`).** `social_accounts`: `failure_kind`, `consecutive_failures`, `next_attempt_at`, `credential_fingerprint` (a 16-hex one-way fingerprint; the credential is never stored). `marketing_activities`: `engagement` + `engagement_observed_at` (refreshed each sync; if the platform stops giving counts, the last known counts stay with their own timestamp). `syncSocial` honours persisted backoff across restarts; scheduled syncs never retry a refused credential; `loadMetaTokenHealth` caches the `debug_token` answer for an hour. `Services.socialHttp` allows injecting the provider imitation in tests. `GET /integrations` now returns token health and each account's backoff state; `GET /marketing` returns the summary and engagement.

**Web.** New `social.tsx` (`ProviderCard` with token health and "what this can/cannot show / what is needed", `AccountSync` with the exact next-attempt time, `MarketingSummaryCard`); Marketing page gets the summary card and an engagement column ("not provided" is shown as such); Settings → Integrations uses the same components. Verified in the browser against the dev workspace (no providers configured: each shows exactly what is required).

**End-to-end test** `tests/e2e/social-providers.test.ts` (26): counts stored/refreshed/kept; quota recorded with the exact reset time and not retried by schedule or by a person; Retry-After; repeated rate limits; revoked grant → "needs a new token", not hammered; manual retry counted; replacing the credential resets; missing approval re-checked daily (manual allowed); token health warning/bad/missing scopes and the one-hour cache; **no API response contains any credential or the app secret**; summary themes/brands/timing/most-liked/limits; empty window says nothing was observed; tenant isolation.

**Findings along the way:** the fixture websites advertise their own social links, which are discovered but stay unconfirmed and unread until a person confirms them (correct behaviour; my test assumed otherwise); session lifetime is 14 days, so tests that jump the clock must stay inside it.

**Results:** `npx vitest run` → **558 passed / 0 failed, 31 files**; lint 0 errors (2 intentional warnings); typecheck clean.

**Remaining for Part 8 (needs the user):** real Meta app (App Review + Business Verification) and token, `YOUTUBE_API_KEY` — asked in the final message. Summaries are not yet part of report snapshots (Phase 6).

**Next:** Phase 6 — readiness endpoint, stale-scan recovery test, retention tests, email-verification policy, invitations, integration reference table, graceful shutdown, backups.

---

## 2026-10-15 — Phase 6 part 1: scan recovery, retention, email-verification honesty, readiness

**Correction to the record.** PROJECT_CONTEXT/the matrix said stale-scan recovery "has no direct test". There was a scheduler-level test that a stale run is *re-queued*; what was untested (and what turned out to be wrong) was everything after that.

**Scan recovery (`recoverScans`, migration `0006_scan_resume_count`).** Real defects found by reading the code: (1) a run whose worker kept dying was resumed **forever** (no cap); (2) a run left `queued` because its job was lost **blocked its website for ever** (`startScan` returns the existing active run). Now: stale running runs resume up to 3 times, each with a fresh grace period (claimed atomically, so concurrent schedulers cannot queue the same attempt twice); orphaned queued runs are re-queued under their original job key; after the cap a run is closed as `failed` / `worker_lost` with an honest explanation, a collection-failure alert, and the website can be collected again; scheduled runs are **not** resurrected after their report's assembly cut-off (the existing cut-off logic cancels them). `TickResult.abandonedScans`. `explainScanRun` explains `worker_lost`. Also hardened `chooseKind` against a stored profile with no `strategy` (it crashed the whole scheduler pass). Tests: `scan-recovery.test.ts` (14) + 1 unit.

**Retention.** Real defects/gaps: one failing storage delete aborted retention for **every** workspace; marketing activity, offers, flyers, finished daily runs and old site profiles never expired. Now: per-file try/catch (the evidence row keeps its reference so the file is retried next run; a report whose export file cannot be deleted is kept until it can be), those tables expire with the history window, the newest profile of every website is always kept, people's match decisions are never "history", `storageErrors` is reported, and `runRetention(svc, { orgIds })` can clean selected workspaces. Tests: `retention.test.ts` (13) — two workspaces on different windows (7/30 vs 90/365) walked through days 5/40/100/400, exact boundary (kept at the cut-off, purged 1 ms older), the new tables, failing storage and idempotence.

**Email verification (AU3).** `/meta.emailVerificationEnforced`; a password-reset link now verifies the address **only when email is really delivered** (previously it also verified accounts whose "email" only sat in the development outbox); member list shows "not verified"; an unverified user sees a banner saying exactly what can be done on this server. Tests: `email-verification.test.ts` (14) against two server configurations.

**Readiness (`GET /api/v1/ready`, `system-health.ts`).** Database, schema version vs this build's migration list, web-tier role not bypassing RLS (fail in production), job queue, worker heartbeat (last completed/failed `scheduler-tick`), storage probe, and informational email/secrets/browser/AI. 503 only when unsafe to serve; `degraded` when pages work but work would not happen. **A test found a leak**: error text from the database library contains the whole failed SQL statement, which the public endpoint would have repeated — now only the database's own one-line message is used (`safeReason`). Read-only grant on `drizzle.__drizzle_migrations` for the app role. Verified against the running dev stack ("ready", worker heartbeat 0 min). It also explained a live symptom: the dev worker's scheduler had been failing every minute because the dev database was one migration behind — exactly what the endpoint now reports.

**Test-suite hygiene.** Integration files share one database and the scheduler is global, so a finished file could change the next file's scheduler pass. `harness.close()` now switches off schedules for the workspaces it created; retention tests scope their runs. Full suite run three times in a row: stable.

**Results:** `npx vitest run` → **619 passed / 0 failed, 35 files** (3 consecutive runs); lint 0 errors (2 intentional warnings); typecheck clean.

**Next:** Phase 6 part 2 — member invitations (AU4), integration reference table (I1), graceful-shutdown audit, backup/restore guidance, report snapshot includes the marketing summary; then Phase 7.

---

## 2026-10-15 — Phase 6 part 2: member invitations; demo workspaces not scheduled without fixtures

**Invitations (AU4; migration `0007_invitations`).** Until now an admin could only add someone who already had an account — silently, without their consent. New flow: an admin invites an email address; the invitee gets a single-use link valid for 7 days (only a SHA-256 hash of the token is stored); the link opens a page that says what the invitation is for; **acceptance requires being signed in as exactly the invited address** (a forwarded link is useless to anyone else; the mismatch message shows the address masked), and, where email delivery is configured, a verified address. Inviting the same address again replaces the link (the old one stops working); revoke stops it immediately; at most 25 invitations wait per workspace; owners can invite owners, admins cannot (and cannot revoke an owner invitation); staff can do none of it. When this server cannot send email, the inviter is handed the link to pass on (never when email is configured). Acceptance is atomic (two simultaneous requests create exactly one membership) and never lowers an existing role. Audit events for create/resend/revoke/accept. The `invitations` table is the fourth documented RLS exemption (acceptance happens before the person belongs to any workspace); every list/revoke is explicitly workspace-scoped and tested across workspaces. Old invitations are purged by retention after a year. Web: "Invite someone" + invitations table on Settings → People, the `/invite` page, sign-in/registration return to the invitation (only `/invite?token=…` paths are accepted as a redirect target — no open redirect); the registration email is locked to the invited address. **Tests:** `invitations.test.ts` (24). **Verified in the real app:** wrong-account refusal, sign-out, register-and-accept, the unverified-email banner (a throwaway local test account, removed afterwards).

**Scheduler.** Found while viewing the live dev stack: the worker had started the scheduled morning collection for the *demo* workspace, whose fictional sites this server does not serve, so every site failed and false "collection failed" alerts appeared. A demo workspace is now only scheduled on a server that allows fixtures (`ALLOW_LOCAL_FIXTURES`). Test added. (The dev demo workspace itself still shows that morning's failed run; re-seeding with `npm run demo:fixtures` restores it.)

**Results:** `npx vitest run` → **644 passed / 0 failed, 36 files**; lint 0 errors (2 intentional warnings); typecheck clean.

**Next:** integration reference table (I1), graceful-shutdown audit, backup/restore guidance, marketing summary in report snapshots; then Phase 7.

---

## 2026-10-15 — Phase 6 part 3: integration reference, graceful shutdown, backups, marketing summary in reports

**Integration reference (I1).** `docs/integrations.md` rewritten around the table the directive asks for: provider, purpose, environment variables, permissions, essential?, can the build run without it?, what works without, what is blocked, how to verify, and a **Verified** column that says "local imitation — no live call" wherever that is the truth. Includes the credential workflow, the Meta token-health/renewal/backoff behaviour and the state vocabulary the UI uses. (I first wrote a wrong command for generating `TOKEN_ENCRYPTION_KEY`; corrected against `.env.example` — the format is `id:base64(32 bytes)`.)

**Graceful shutdown (H1) — audit findings and fixes.** (1) The worker waited at most 20 s for jobs, but a scan can run for hours; on timeout the process exited with scans still `running` and recovery only noticed after the 15-minute silence window, so a routine redeploy delayed collection by 15 minutes. (2) No unhandled-rejection/uncaught-exception handlers, no force-exit failsafe if shutdown hangs, a second Ctrl-C did not force exit. New `installShutdown` (`lifecycle.ts`) used by both processes: first signal = clean stop, second = exit now; a stop that outlives its grace period is abandoned with a log line; fatal errors exit 1. The worker now **hands back** in-flight collections (`releaseActiveScans` marks them heartbeat-less, so the next scheduler pass of any worker resumes them within about a minute). A test found a real flaw while I wrote it (a second signal after a fatal error hid the failing exit code) — fixed. Tests: `lifecycle.test.ts` (9) + 3 in `scan-recovery.test.ts`. **Not verified with a real SIGTERM** (Windows).

**Backups / restore / health (H3, H2 docs).** `docs/deployment.md` now covers: what to back up and what is not a backup, dumping with the admin role (the app role would dump nothing), roles are not in the dump, consequences of losing the encryption key, RPO/RTO, a numbered restore drill, what a restore reproduces, stopping/deploying (grace period ≥ 40 s), health vs readiness semantics, the egress-firewall recommendation for rendering workers. **The restore drill was not executed** (no `pg_dump`/`pg_restore` here) and the doc says so. Docker: still never built or run, stated plainly with a checklist.

**Marketing summary in reports (K5).** The summary types moved to `@ci/shared`; `assembleReportData` computes it into the immutable snapshot; the report view's Marketing tab shows it; the PDF has a section; the Excel workbook and a new CSV dataset `marketing_summary` carry it. Old snapshots without it still export (tested). Tests added to `reports.test.ts` (2).

**A tooling lesson recorded** (cost me two corrupted files, both caught and repaired before commit): in Git Bash, `sed 's/\\`/x/'` and `grep '\\`'` treat `\\`` as "start of buffer" and prefix/match every line. Use the Edit tool or `grep -F`.

**Results:** `npx vitest run` → **658 passed / 0 failed, 37 files**; lint 0 errors (2 intentional warnings); typecheck clean.

**Next:** update `PROJECT_CONTEXT.md` for everything since Phase 1; then Phase 7 — full-system verification across the whole stack (desktop + mobile browser pass over every page, accessibility/keyboard, long names), the live-mode run commands, and the one **authorised** live end-to-end run, which needs your per-site permission.

---

## 2026-10-15 — Phase 7 part 1: the live path end to end, and a real-browser accessibility pass

**Live-workspace journey test (`tests/e2e/live-journey.test.ts`, 28 tests).** Every earlier end-to-end test ran in a *demo* workspace, so the live-mode code path had never been exercised end to end. This test runs in a **live** workspace through the **real HTTP API**, with websites on ordinary public hostnames (`mine.test`, `rival-woo.test`, …) that pass the production public-host policy — no loopback exception, no fixture flag. Only the final network hop is imitated: the fetcher's `transport` hook serves each hostname from a local fictional site (URL validation and the SSRF policy still run). Covered in one story: sign-up → live workspace (even when "demo" is requested) → empty state → 11 invalid/unsafe URLs refused with reasons → a local fixture origin refused (demo data cannot leak) → one source + five competitors (sixth and duplicate refused) → profiling → consent gate (refused without attestation) → collection with a **blocked** and an **unreachable** competitor reported as exactly that → every stored page copy/price/stock reading is `public_web` and never a fixture, evidence URLs are the public hostnames → matching, review, a comparison that says "not available — <why>" for the two uncollected competitors → a **price change** recorded as a new observation (history only grows) → own-site **stock** going out raises one alert (repeat scan raises none), restock resolves it automatically, no invented quantity → the stock simulator refused in a live workspace → a **flyer offer expires** when its validity passes → a **partial report** naming both missing competitors, not labelled fixture, with PDF/CSV/Excel from the same snapshot and history/compare → missing credentials shown as missing (Shopify, YouTube, Instagram, Facebook), impossible actions answered with reasons → wrong password and unknown address indistinguishable → another customer gets 404 on 16 paths and sees zero rows at the database level. It passed on its first run apart from two test assumptions (the fictional sites apply a per-site price factor; a product's evidence list includes the matched competitor's pages) and exposed one real gap: **`GET /evidence/:id` omitted `provenance`** (fixed). **What this does not prove:** that any real website behaves like these imitations; no real site was contacted, and the connect-time DNS validation is bypassed by the transport hook (it is covered by `safe-fetch.test.ts`).

**Real-browser pass (in-app browser, demo workspace refreshed with `npm run demo:fixtures`).** An automated audit (accessible names for links/buttons/controls, form labels, table headers, one `h1`, duplicate ids, document title, sideways page scroll) ran over **18 views at 1280 px and 18 views at 375 px**. Real defects found and fixed: (1) **the page title never changed** — every page showed whichever title was set last ("Compare reports · Shelfwatch") — `PageHead` and the auth frame now set a descriptive title per page (`useDocumentTitle`); (2) two tables had no header cells (product-detail Matches, website-detail Earlier capability checks) — added screen-reader-only headers; (3) **the dialog (`Modal`) had two focus bugs**: its effect depended on `onClose`, so every parent re-render pulled focus back to the dialog frame (overriding the search box's autofocus) and recorded a stale "element to return to", and the opener was recorded too late because React's `autoFocus` moves focus at commit time — fixed with a stable close ref, the opener captured during the first render, an explicit Tab/Shift+Tab trap and no stealing from an autofocused control. **Verified in the browser:** opening the picker puts focus in the search box, typing survives list refreshes, Shift+Tab wraps inside the dialog, Escape closes it and focus returns to the button that opened it. A first false positive in my own audit (links inside a closed `<details>`) was fixed in the audit, not the app.

**Not covered in this part:** colour-contrast measurement, a screen reader, tablet width, long product names/price formatting stress, and the one **authorised live collection** (needs your per-site permission).

**Results:** typecheck clean; lint clean; full suite last run **686 passed / 0 failed, 38 files** (before the web-only accessibility fixes, which touch no tested server code).

**Next:** colour-contrast sweep, long-name/price-format stress pass, the full-suite + build run, the verification report rewrite, final deliverable list, and the request for the live-collection permission and credentials.

---

## 2026-10-15 — Phase 7 part 2: contrast, long names, full verification, documentation

**Colour contrast (previously unmeasured).** An in-page sweep computes, for every visible text element, the text colour against its composited background (4.5:1; 3:1 for large text). It found real failures on all 21 signed-in views: the coral danger colour (4.28:1: danger buttons, nav badge, "out of stock" and "need attention" text), the green "cheaper" colour (4.08:1), the muted-grey text token used for real text such as "no match found" and struck-through old prices (**2.74:1, 71 places**), and a pale legend swatch (2.18:1). Fixed at the source: `--coral` → 4.9:1, `--palm` → 5.1:1, text that used `--faint` now uses `--mute` (5.2:1), the legend uses bordered swatches matching the bar. Re-run: **0 failures on 21 signed-in views and on sign-in, register, forgot-password and the invitation page.**

**Long names.** A 250-character sentence, a 120-character unbroken string, emoji and right-to-left text were temporarily set on two demo products (restored afterwards). The sentence wrapped; **the unbroken string widened the whole product page to 2424 px**. Fixed with `overflow-wrap: anywhere` on the page container and `min-width: 0` on the page header. Re-checked on Products, product detail, Prices, Matches, Stock and Offers at 1280 px and 375 px: no sideways scroll.

**Full verification (commit `803a1c1`):** `npx vitest run` → **686 passed / 0 failed, 38 files**; `npm run typecheck` clean; `npm run lint` 0 errors (2 intentional warnings); `npm run build` succeeds; the built API bundle starts and `/api/v1/ready` answers `ready`.

**Documentation rewritten to match the code:** `docs/verification-report.md` (exact per-file counts, a map from every Phase 7 scenario to the test that covers it, what the live-workspace journey does and does not prove, the browser pass and its gaps, the defects found, an explicit "not verified" list), `docs/limitations.md` (what works in real conditions, the largest gap — no real website collected —, what needs credentials), the README (a "Using it for real (live mode)" walkthrough and the new documents).

**Phase 7 status against the directive.** Done: the complete journey in a live workspace through the real API (public hostnames, local imitations of the sites), every scenario the directive lists, tenant isolation at API and database level, browser verification at desktop and phone width. **Blocked on the user:** "at least one authorised real-world end-to-end collection" — it needs your confirmation, per website, that collection is permitted. Nothing was collected from any real site.

**Next:** Phase 8 — the production-readiness assessment and the final deliverable (below), and the specific requests to the user.

---

## 2026-10-15 — Phase 7 part 3: "what to do next" advice, honest connection colours, button audit

**C7 — advice for every limitation.** The site profiler reports limitations (robots disallow, bot protection, login wall, JavaScript-only storefront, unknown currency, …). Each now has a plain-language "What you can do" line under it (`packages/shared/src/limitation-advice.ts`, rendered on the website page). A test reads the profiler's source and fails if a limitation code is emitted without advice, and another asserts that blocking limitations only ever suggest an authorised alternative (a feed, API access, written permission, waiting, replacing the competitor) — never a workaround. Checked in the browser on the robots-blocked demo site.

**U2 — green must mean true.** I read every green pill, banner and toast against the fact it claims. Two were optimistic: the Shopify "connected" pill and the stock page's "Connected inventory mode" banner stayed green when the last sync had failed, never ran, or was days old. A new `connectionSyncHealth` (ok / failed / stale / never; an error beats age; window 36 h) now drives both: green only for ok, otherwise amber/red with the reason. The `/stock` API reports `syncHealth` and `lastError`; unit tests (5) plus an API assertion cover it.

**J12 — buttons.** All ≈70 `<button>` elements in the web app were checked against their handlers; each performs the one action its label names. No mismatches found. The audit was a code read plus the earlier browser passes — it is not an automated click-through of every control.

**Matrix:** U1, U2, J12, C7 and "docs match code" are ✅. Remaining non-✅ rows are environment- or decision-bound (see Phase 8).

---

## 2026-10-15 — Phase 8: production-readiness assessment

Wrote `docs/PRODUCTION_READINESS.md`: the verdict (**not ready for production use with real competitor data; ready for a supervised pilot once one real website is authorised and a host exists**), evidence strength per area (high for data model, isolation, safety rules, report logic; medium for collection/matching/marketing because only fixtures and local imitations were used; unverified: Docker, restore drill, real SIGTERM, load), everything only the user can provide, known risks, prioritised remaining work, and the precise next step.

**Final verification at `aa30324`:** `npx vitest run` → **695 passed / 0 failed, 40 files**; typecheck clean; lint 0 errors (2 intentional warnings). Counts in README, verification report and project context updated.

**Not done, and why:** the single authorised real-world collection (needs the user's per-site permission); Docker build, restore drill, real SIGTERM (no Docker / PostgreSQL client tools / POSIX signals on this machine); live verification of Shopify, Meta, YouTube, SMTP, FX (no credentials; none invented).

---

# Directive 3 (2026-10-18) — "Remove the demo product and finish real Shelfwatch"

Verbatim text: `docs/original-prompt/03_DIRECTIVE_REMOVE_DEMO_2026-10-18.md`. Phases: 1 baseline · 2 demo removal + audit · 3 genuine authentication · 4 Gmail SMTP (ask the user when a real test is possible) · 5 real URL input + honest collection basis · 6 real catalogue collection (ask the user for the first authorised real site) · 7 real price comparison + FX · 8 stock/offers/marketing/reports without mock data · 9 credential checklist · 10 tests/security/production · 11 keep docs current. Status vocabulary for the docs from now on: *Implemented, not tested · Tested with automated mocks · Tested using isolated test fixtures · Tested against a real local service · Tested against a real external service · Verified end to end with real website data · Blocked pending credentials or permission.*

## Phase 1 — baseline (before any change)

| Item | Value |
| --- | --- |
| Original prompt | Accessible and re-read: `docs/original-prompt/01_ORIGINAL_PROMPT.md` (1,250 lines); directive 2 in `02_…`; this directive in `03_…` |
| Git | `main` = `origin/main` = **`2574a4a`** (one public commit; the 35-commit development history exists only in the local branch `full-history`), **0 uncommitted changes** at the start |
| GitHub | https://github.com/Aditya-debug43/price_intelligence (public) |
| `.env` | Present, git-ignored, **not touched**. Non-empty variables (names only): app/db/collector settings, `TOKEN_ENCRYPTION_KEY`, `EMAIL_FROM` (placeholder address), plus **`ALLOW_LOCAL_FIXTURES=false`, `DEMO_AUTO_CONSENT=false`, `SCHEDULER_MODE=normal`**. Empty: `SMTP_URL`, `ANTHROPIC_API_KEY`, `YOUTUBE_API_KEY`, `META_*`, `SHOPIFY_CLIENT_ID/SECRET/REDIRECT_URI`, `S3_*`. So **email delivery is not configured**, and no external provider credential exists |
| Dev database (embedded PostgreSQL on 54329, still running) | 2 workspaces: *"Fixture Demo — Groceries To Go (not live data)"* (mode `demo`, 6 fictional fixture sites — created by my `demo:fixtures` script) and *"Audit Co (live audit workspace)"* (mode `live`, 3 sites, created during my browser audit); 2 users (1 verified); 114 products, 687 price observations, 11 reports, 3 integration connections (incl. simulated), 24 outbox rows. **Nothing was deleted.** Both workspaces are my own test artefacts; removing them needs the user's approval (see Phase 2) |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, 2 intentional `any` warnings |
| `npm run build` | web, API, worker build |
| `npx vitest run` | **694 passed, 1 failed**, 40 files. The failure — `tests/e2e/live-journey.test.ts` "a flyer offer … expires when that date passes" — is a **defect in the test fixture, not in the product**: the fixture flyer server derives the PDF's validity dates from the *wall clock* (`opts.now ?? new Date()`) while the harness uses a fixed test clock; it passed on 2026-10-15 only because real time happened to be close to the test clock. Fix: give the fixture server the harness clock (done as part of moving the fixtures out of the product, Phase 2) |

Baseline claims in `docs/PRODUCTION_READINESS.md` (695 passing) were therefore true on 2026-10-15 and are **stale** as of today for the reason above.

## Phase 2 — demo removal (done; commit `1c4a882`; audit in `docs/DEMO_REMOVAL_AUDIT.md`)

* Removed the whole demo product: the `live`/`demo` workspace split, fixture and simulator flags, developer routes (`/dev/outbox`, scheduler clock), the inventory simulator, demo banners and pills, a fabricated example price on the sign-in page, the demo/bootstrap/fixture scripts, the fixture servers from `@ci/connectors`, and the settings `ALLOW_LOCAL_FIXTURES`, `DEMO_AUTO_CONSENT`, `SCHEDULER_MODE`. Migration `0008` drops the columns/triggers and **refuses to run while demo data exists** (it never deletes). `live-probe` no longer has the four Aruba shops built in.
* Fictional websites now exist only in `tests/support`, under public-looking hostnames (`mine.test`, `rival-woo.test`…) and served through the product's **unchanged** fetch policy and host rules (only the last network hop is replaced). The harness now feeds them the test clock — which also fixed the baseline's one failing test (flyer validity was derived from the wall clock).
* **Real defect found in the user's dev data and fixed:** the "demo" workspace's six sites had been re-pointed by editing their addresses to *amazon.in, myntra.com, snapdeal.com, nykaa.com, flipkart.com, meesho.com* while keeping the fictional test catalogues collected from `127.0.0.1` — fictional data standing in for real shop names. Fix: a website cannot be re-pointed at a different host (409); the Setup page offers a confirmed replace. With the user's approval the dev database folder was backed up (`.data/postgres-backup-2026-10-18`, git-ignored) and only that workspace removed via `npm run db:purge-demo -- --yes`; migration 0008 then applied on the real dev database.
* Result: 695 → 696 tests, all passing; `npm run typecheck` now also covers `tests/` and `scripts/` (it did not before — latent type errors in tests were fixed).

## Phase 3 & 4 — genuine authentication and real email (done in code; Gmail not yet exercised)

Verified against: automated mocks (a test mail server stand-in), an in-process SMTP server (real SMTP conversation), a real local PostgreSQL. **Not yet verified against Gmail** — blocked on the owner's address and App Password (instructions in `docs/integrations.md`).

* Registration creates an unverified account (scrypt hash) and queues an emailed link (48 h, single use, hashed in the database); **nobody is signed in by registering and sign-in always requires a verified address**. A new link cancels the older ones; at most one a minute per account.
* **No email configured ⇒ registration, resend and password reset answer 503 with the reason** and create nothing; the registration page, Settings, `/ready` and `/meta` say so. Previously registration auto-signed-in and the "development outbox" viewer exposed links.
* Anti-enumeration: registering an existing address answers exactly like a new one (the real owner receives a throttled "you already have an account" email); resend/forgot answer identically for unknown addresses; login errors are identical and timing-equalised; repeated failures lock the account for 15 minutes.
* Password reset: link valid one hour, single use, replaced by newer requests, signs every session out; using it also verifies the address. New `POST /auth/change-password` (current password required, other sessions revoked).
* **SMTP configuration** is now `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`, `APP_BASE_URL` (the old single `SMTP_URL` is gone: a Gmail App Password has spaces and an address has "@", which break URLs). Gmail rules are enforced in `core/smtp.ts` (App Password spaces stripped, sender must equal the account, STARTTLS required unless the server is local); failures are translated into advice (wrong password, App Password required, blocked port, TLS mismatch, quota…) without echoing secrets.
* **Delivery is recorded, never assumed:** `email_outbox` statuses `queued → sent` (the mail server accepted it; Message-ID and final response stored) / `retrying` (temporary failure; up to six attempts) / `failed` (permanent, with the reason) / `not_configured` (never sent). Migration `0009` adds the delivery columns and converts old `dev_logged` rows to `not_configured`.
* Settings → Notifications has an **Email delivery** panel (configured or not, "Send me a test email" showing the server's own answer, latest messages with status). `npm run email:check [-- address]` does the same from the terminal.
* Tests: `auth.test.ts` (32 — verification, expiry, single use, resend, duplicates, lockout, sessions, reset, change password, delivery failures/retries, the panel), `smtp.test.ts` (13), plus the in-process SMTP delivery tests; all existing API tests now sign up through the real verify-by-link flow.

## Phase 5 — collection rules (customer's confirmation, not a competitor's approval)

The "permission" step is now **Confirm collection rules**. The wording (`v2`) says plainly that this is the customer's own confirmation — that they understand what the software does (only what every visitor sees, polite pace, robots.txt, no sign-in or challenge-solving, stops when refused), that it is *not* the website owner's approval, and that they accept responsibility for the website's terms and the law. No competitor sign-off is needed or implied; robots.txt, blocks and logins still end collection. The source website's wording and the separate merchant-authorised inventory connection are distinct. See `docs/consent-and-compliance.md`.


## Phases 6, 7, 9, 10, 11 — real collection, honest comparison, integration checklist, production readiness, documentation (2026-10-18/19; commit `2a1ad8e` + docs)

**Real-network evidence first.** `npm run test:live` (new; `tests/live`, opt-in project) sends real, polite (1.5 s per host), robots-obeying requests through the production fetch policy to real websites and checks the *stored* values against the *raw pages the collector kept*. Default targets are public scraping sandboxes (not the user's sites): books.toscrape.com, scrapeme.live, scrapingcourse.com. Four runs, each one teaching something:

| Run | What the real network showed | Fix |
| --- | --- | --- |
| 1 (earlier) | books.toscrape.com has no sitemap or structured data → "limited", nothing collectable; a catalogue whose robots.txt forbids its product pages was reported "limited" instead of blocked; a rule for `/shop/` did not stop `/shop` | Built the **listing-crawl connector** (product cards on landing/category pages, pagination and category links, resumable queue); profiler reports **blocked** when robots.txt forbids product pages; `/shop` ≡ `/shop/` for robots rules |
| 2 | books.toscrape.com: 53 pages requested but only the first page's 20 products stored; scrapingcourse.com still "limited" (the typed `/ecommerce/` path was dropped, only the home page was checked) | Root cause 1: for a shop whose listing starts on the home page, `canonicalizeUrl('')` threw `Invalid URL` on every later page (fixtures always had a category start page) → fixed + a `homegrid` fixture shaped like the real shop + regression test (verified to fail without the fix). Root cause 2: **the typed page is now kept** (`sites.entry_path`, migration `0010`), robots.txt is checked against it, and listings are looked for there first |
| 3 | books 40/40 stored values found in their raw pages; scrapeme.live (WooCommerce API) 40; scrapingcourse.com **blocked, 0 pages read**; real FX fetch: 164 rates, USD→GBP 0.7508, source and provider time stored. One test failed only because the AWG peg was not seeded before the FX test | Test order fixed (seed the peg first); a provider outage now shows as a *skipped* test, never a pass |
| 4 | **9 of 9 pass**; the comparison step correctly finds no matches between books and monsters (40 source products, 40 without counterpart) | Page counters (`urlsFetched`/`urlsDiscovered`) now persist the true frontier counts at the end of a run and on every batch (a sample that reached its limit used to show 1 page read) |

Also done:

* **Entry page** (`entryPath` on `normalizeSiteUrl`, `sites`, profiler, listing seeds, API list, Websites page shows "the shop starts at this page").
* **Honest "no equivalent found"** (`core/assortment.ts`: `assortmentBasis`, `assortmentNote`): the strong wording only when every competitor catalogue was read completely; blocked/failed/never-collected/stale/partial competitors are named with the reason, and an incomplete own catalogue weakens "missing from your shop". Saved in report snapshots, served by `/assortment`, shown in the report with a warning callout; card titles no longer claim "no competitor does".
* **Production config** refuses a non-https or localhost `APP_BASE_URL` (emailed links are built from it).
* **Text-reading fix** in listing extraction: neighbouring elements are joined in reading order (a count right after a link was read as one word).
* **Docs:** `integrations.md` rewritten around the status vocabulary and a truthful checklist (mock vs real tested, blockers, verification steps, what is needed from the user); `limitations.md`, `PRODUCTION_READINESS.md`, `verification-report.md`, `README.md`, `architecture.md`, `deployment.md`, `data-reliability.md` (rules 15–16), `REQUIREMENTS_MATRIX.md` (Part 14 + stale rows), `PROJECT_CONTEXT.md` ("Update 3"); `docs/demo-runbook.md` deleted (it described the removed demo scripts).
* **Not done / blocked (unchanged):** real Gmail delivery (needs the user's address and an App Password typed into `.env`); any website the user authorised; real price comparison on overlapping products; Docker; restore drill; load test; Shopify/YouTube/Meta/Anthropic/S3 live. The `.env` still holds a placeholder `EMAIL_FROM` that must be emptied before Gmail will accept it.

Results at the end of this phase: typecheck clean; lint 0 errors (2 intentional `any` warnings); `npx vitest run` all passing (see `docs/verification-report.md` for counts); production bundles rebuilt and grepped — no fixture traces; live procedure 9/9.

Commits: `2a1ad8e` (code, tests, scripts), followed by the documentation commit.

## 2026-10-19 — Gmail configured by the owner; first real SMTP messages

* The owner pasted the sender address and a Google App Password into chat (the directive had preferred typing it into `.env`) and asked me to proceed alone because they were busy. I wrote `SMTP_HOST/PORT/USER/PASSWORD` and `EMAIL_FROM` into the local git-ignored `.env` with a script that printed no values, deleted the script, and have not written the password anywhere else (repo, docs, tests, logs, memory). I told the owner it is now in the conversation record and should be revoked and rotated.
* `npm run email:check`: connected over STARTTLS and signed in. `npm run email:check -- <owner address>`: Gmail answered `250 2.0.0 OK`; Message-ID recorded. Starting the dev stack again showed `/meta.emailConfigured: true`.
* Registered a throwaway account through the real UI (`/register`) with a plus-address alias of the owner's address and a test password: the page changed to "Check your email"; the outbox row went `queued → sent` (attempts 1, Message-ID and `250 2.0.0 OK` stored). The account is unverified; I did not read the owner's inbox and did not use the outbox body to verify it.
* Not done: confirming arrival in the inbox (only the owner can), the verification link, a reset email through Gmail.
* **Website pair — deliberately not collected.** The owner replied "skip taking details for now, do it yourself". The original brief names `groceriestogoaruba.com` (source) and `shop.lingandsons.com`, `shop.superfoodaruba.com`, `doit.aw` (candidates) and says permission to collect from them "has not been confirmed"; the collection-rules step is the customer's own attestation. A request to proceed without details is not that confirmation, so no real shop was collected. One line from the owner ("yes, collect a small sample from groceriestogoaruba.com and shop.lingandsons.com") unlocks `LIVE_SOURCE_URL=… LIVE_COMPETITOR_URLS=… npm run test:live`.
* The dev stack and embedded database were stopped afterwards (the scheduled "Audit Co" workspace would otherwise have tried to email its daily report to `.test` addresses through the real Gmail account and caused bounces).

# Directive 4 (2026-10-19) — "Real-data verification first, then GitHub and AWS deployment"

Verbatim: `docs/original-prompt/04_DIRECTIVE_REAL_DATA_THEN_DEPLOY_2026-10-19.md`. Order required: audit and fix first, deploy only the verified version.

## 2026-10-19 — the owner names the real shops; first real collection and comparison

* The owner replied with real addresses: own shop `https://groceriestogoaruba.com/`; competitors `https://www.lingandsons.com/`, `https://foodstore2go.com/`, `https://shop.superfoodaruba.com/`, `https://quickmartaruba.com/` ("check in detail, exhaustively"). This replaced the earlier "skip, do it yourself" and is the naming of the websites the earlier work had been waiting for. No fourth ("Cmart") address was given and none was guessed.
* Through a throwaway verification account the stack was started (`npm run dev`), the sites were added, the collection-rules confirmation was recorded for each, and the real capability check + collection ran. `shop.lingandsons.com` (the shop behind the information site `www.lingandsons.com`) was added as well. Results: groceriestogoaruba.com 2,381 products, Ling & Sons 1,850 (AWG), foodstore2go.com 863, Quickmart 2,566; Super Food Plaza and www.lingandsons.com not collectable (shown unavailable). Every run: robots.txt obeyed, 1.5 s pacing, 5–29 requests.
* The exhaustive live procedure (`tests/live/real-catalogues.live.test.ts`, `npm run test:live` with `LIVE_SOURCE_URL` / `LIVE_COMPETITOR_URLS`) was written and run: per-site completeness, feed-exact counts, spot checks against live pages, a record under `.data/live-runs/`.
* **First comparison on real overlapping goods** exposed what fixtures could not (commit `762624b`): junk vendor "brands" ("Aruba", "Your Brand", shop names), $0 prices, a standing "regular price" counted as sales, "12-12 oz" pack notation, flavour/variety conflicts, single vs multipack, every match needing review (→ bulk accept), the comparison page mixing unreviewed pairs into results (→ confirmed-only default), mail to `.test` addresses bouncing through Gmail (→ `unroutable_recipient`).

## 2026-10-19 — Phase 1 audit continued (uncommitted at the time, committed with the verified build)

* 24 identical pairs checked against both live product pages; differences recomputed independently (AWG ÷ 1.79) and compared with the comparison API: 22 agree exactly, 2 explained (script read the 375 ml variant of a page; a pair later removed by the improved rules). Report and exports compared with the comparison page. Offers (149 sale prices + 2 banners) checked. Cross-tenant, CSRF and unauthenticated probes against the real API. The daily scheduler observed running (real clock, Gmail daily summaries and failure digests recorded `sent`).
* Code fixes: quantity parser (`N-M unit`, pack-statement conflicts, beverage words), matching (variety words, single-vs-multipack, **vintage years** `yearsIn` added late after the audit found a 2013 wine matched to an undated listing), placeholder-brand detection (`core/brands.ts`) with `clearBrandLabels` at scan end, uniform "regular price" detection, `Prices` default `confirmed`, mailer guard, bulk accept (`POST /matches/bulk` + UI), sitemap `product_cat` classification, `ƒ` price symbol, page counters.
* UI checks in the in-app browser on real data (1280 px: dashboard, websites, a website, products, a product, match review incl. bulk dialog, price comparison, offers, stock, alerts, quality; 375 px: dashboard, comparison, review, reports, report, settings) — no overflow, no console errors beyond one transient 502 during my own API restart.
* **Production bundles run locally** with `NODE_ENV=production` (API from `dist`, worker from `dist`, `SERVE_WEB=true`, https `APP_BASE_URL`, email off): 18/18 smoke checks and a real browser sign-in. Found and fixed: hashed assets were served `max-age=0` (now immutable; app shell `no-cache`; test `tests/e2e/web-serving.test.ts`).
* **Finding for hosting:** the web app is strictly same-origin (relative `/api/v1`, `SameSite=Lax` cookie, no CORS headers). It cannot be served from a separate hostname such as GitHub Pages without a proxy for `/api/*`. Documented in `docs/deployment.md`.
* Full suite after the first batch of fixes: 48 files, 796 tests passed. **Final run on the code that was pushed (after the vintage-year rule and the static-caching fix): typecheck clean, lint 0 errors / 2 intentional warnings, build succeeds, 48 files, 798 tests passed.**
* Docs rewritten: `verification-report.md` (real-data audit section), `REQUIREMENTS_MATRIX.md` (rows D6, D13, D14 + Part 16), `PRODUCTION_READINESS.md`, `limitations.md`, `integrations.md`, `deployment.md`, `PROJECT_CONTEXT.md` (Update 4).

## Phase 2 — GitHub (done 2026-10-19)

* Remote `origin` = `https://github.com/Aditya-debug43/price_intelligence.git`; `origin/main` was still `2574a4a` (no newer remote work); local `main` 8 commits ahead, 0 behind → a fast-forward push is possible. A local-only branch `full-history` (separate root, older history containing a credential-shaped fake token) is **not** pushed.
* Secret/personal-data scan of tracked files and of every pending commit: no `.env`, keys, tokens, App Password or the owner's Gmail address; only `.env.example` is tracked.
* **Pushed:** fast-forward `2574a4a..56e5094` of `main` (no force; 0 commits behind) after typecheck, lint, build and the full suite (798 tests) passed on the same code. Confirmed through the public GitHub API: latest commits are the two audit commits, `apps/web/src/pages` is present, `.env` is absent, `.env.example` present.
* The repository holds the whole monorepo including the web source; GitHub state before the push: public repo, one branch (`main`, one old commit from 2026-10-16 that still contained the demo), **no GitHub Pages site (404), no workflows**. The frontend is therefore *stored* on GitHub, not *hosted* from it.

## Phase 3/4 — AWS and the deployed journey — blocked

* No AWS CLI, profile, credentials, SSO configuration or deployment files exist on the development machine, so nothing was inspected, created or deployed. See `docs/PRODUCTION_READINESS.md` for exactly what is needed from the owner.

# Directive 5 (2026-10-23) — "Exhaustive functional, real-data, and requirements audit"

Verbatim: `docs/original-prompt/05_DIRECTIVE_EXHAUSTIVE_AUDIT_2026-10-23.md`. Method: re-read the original brief (all 24 sections) and the project records; check permission first; run a fresh-account journey in the real browser on the real websites; reconcile the own shop in full; audit the matching on the real data already held; fix, add regression tests, re-verify.

## Permission first (a gap in the product, not only in the audit)

* Read robots.txt and the public terms pages of the five supplied websites (≈ 2 s apart). robots.txt allows the pages; the **terms** forbid automated access at Quickmart ("spider, crawl, or scrape") and Super Food Plaza ("spiders, robots") and restrict copying / commercial use at foodstore2go and Ling & Sons. The product had only ever read robots.txt.
* Built the terms review (`core/terms.ts`, profiler step 2b, `sites.written_permission` migration 0011, consent gate, scan re-check for old profiles, UI quote + written-permission dialog, "Terms forbid collection" status, honest "Automated access" row). Followed the instruction "permission unclear ⇒ report the blocker": **no competitor was collected**. Only the owner's own shop was.
* Honest correction: the 2026-10-19 collection of Quickmart / foodstore2go / Ling & Sons ran before this check; that data is still stored (analysis only).

## Fresh-account journey (browser, real Gmail)

* Registered with validation checks; Gmail accepted the verification email; verified the resend throttle, replaced-link rejection, unverified-sign-in refusal; signed in/out; created the workspace "Audit Journey 2026-10-23"; entered the five exact URLs (a private address was refused); ran the capability check; recorded consent for the own shop; ran a 25-product sample and the full collection; used Products, Price comparison, Websites, Reports (PDF / Excel / CSV, two-report comparison), Settings (validation, persistence, test email), keyboard dialog; audited 15 routes at 1280 px and 375 px; checked the console in a quiet window.
* The own shop: 2,381 / 2,381 products, feed = sitemap = stored; every variant reconciled on 11 fields (0 differences); 60 / 60 product pages agree; 4 full re-collections without duplicates or spurious changes.

## Matching and calculation audit on the real data held

* Independent calculator over every confirmed cell (217): 0 differences (before and after the fixes). Read all 235 accepted identical pairs one by one → fixes for model numbers, vintages, numbered sizes, unit class of dry products, "same product in another size". Replayed the new rules over the 937 stored pairs. Found that 54 % of the own shop's variants had no readable size because it lives in `Size_…` tags → fixed; on the competitor data already held the products with an identical proposal went 207 → 605 (90-pair sample of the new proposals ≈ 98 % right; all await review).
* Scanned the parser over 7,959 real variants: no size-looking text fails to parse; baby weight ranges, implausible tag sizes and leading-dot decimals fixed.

## Other fixes and tests added

* Report is partial when any active competitor was never collected; empty states name the uncollected websites; catalogue estimate no longer counts the home page; banner "We offer… service" is not an offer; invalid `<ul>` in `<p>` removed (self-introduced).
* New tests: `terms.test` (7), `terms-of-use` e2e (7), `promo-text` (21), `export-safety` e2e (17: CSV/Excel formula injection — the guard existed without a test), `size-in-tags` e2e (3), `web-serving` earlier, parsing / domain additions, partial-report test, site-status label.
* Commits (local, **not pushed**): `225a48c` (code + tests) and the documentation commit that follows it.

## Not done / blocked

Any competitor collection (permission); Super Food's feasibility; real flyers; real low-stock; Shopify / Meta / YouTube; inbox arrival; deployment (no AWS access); multi-day schedule.
