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

---

## 2026-10-26 — Directive 6: "www.lingandsons.com" never collects

Verbatim: `docs/original-prompt/06_DIRECTIVE_FIX_LING_AND_SONS_COLLECTION_2026-10-26.md`. The user reported (with screenshots) that collection works for their own shop and two competitors but Ling & Sons always fails with "No reliable collection method is available", 0 requests, 0 pages.

### Root cause (confirmed; not assumed from the screenshots)

* Read the stored profiles and scan runs in the database; read the real site with a few polite requests (robots.txt, sitemap, home page, specials page, the shop's robots.txt and terms page — the product's bot identity, 2 s apart).
* `www.lingandsons.com` is the company's **information website**. Its sitemap has 19 ordinary pages (home, deals, news, rewards, customer service, about, location, contact, terms, privacy, articles); none is a product page. Its menu item **"Online Shopping" links to `https://shop.lingandsons.com/`**, a separate Shopify store.
* "VIP Deals" builds its list in the browser from `/data/sp.json`; that file is **empty** right now (HTTP 200, 0 bytes, a normal ETag, changed 2026-10-26 08:09 GMT) — not a block, simply no deals published.
* The scan made 0 requests because it reuses the stored capability report, finds no method that ranks, and stops before crawling. That is by design and honest. What was wrong: the profiler counted the 19 pages as "about 19 products / ~20 requests"; it listed barcode / brand / stock / currency warnings for products that do not exist; the failed run and the website status told the user to "ask the owner for a product feed" and called the site "not supported" — while the owner already publishes a feed.

### Changes

* `packages/connectors/src/profiler.ts`: `findStorefrontLink` (a menu link labelled like a shop, to a **different host on the same company domain**; nothing fetched; other companies, marketplaces, delivery apps and social links never suggested); `noProductPages` verdict (every sampled page read normally, none is a product, no prices, not JavaScript-built, nothing refused by robots.txt, no listing found, no feed) → catalogue estimate dropped ("The sitemap lists ordinary pages, not products"), `profile.storefront`, limitations `catalogue_elsewhere` / `not_a_shop`, product-field noise suppressed, honest summary. `shared/profile-types.ts` (+`storefront`), `shared/limitation-advice.ts` (+2 codes).
* `services/scan.ts`: error codes `catalogue_elsewhere` / `not_a_shop` with a precise message (still `failed`, still 0 requests, never a success); `core/scan-explain.ts` (new wording, no "feed" advice); `core/site-status.ts` + `services/coverage.ts` ("No products at this address", next step "Add <store> as a website").
* `apps/web/src/pages/Websites.tsx`: a callout with **"Add <host> as a website"**. It is the customer's click: it adds the website (collection rules still pending) and queues its capability check; if the store is already in the workspace it links to it instead. Nothing is added or collected automatically.

### Verified

* Real site, real profiler (no database): 17 requests, status limited, catalogue size none, storefront `https://shop.lingandsons.com/` ("Online Shopping"), two relevant warnings only (terms restrict commercial use; the shop is elsewhere).
* Real browser, throwaway account and workspace (reserved `.test` address, no email sent; its schedule switched off afterwards): Ling & Sons page shows the new summary, explanation and button; the button added `shop.lingandsons.com`, opened its page and ran its capability check → **full, Shopify feed, about 1,850 products, terms page present but empty (`none_found`)**. **No collection was started and nothing was confirmed.**
* The genuine shop data from 2026-10-19 (Exploration Workspace) is intact: 1,850 products, 2,126 variants, 6,378 price observations, AWG, 3 successful runs. The user's own workspace was not touched: 2,381 / 2,566 / 863 products, no new scan.
* Tests: 914 passed in 55 files (was 885 / 53); typecheck, lint (0 errors, 2 known warnings), build clean. New: `storefront.test.ts` (16), `catalogue-elsewhere.test.ts` (12; two fixture sites on one company domain, plus every other fixture kind checked unchanged: jsonld, html, woo, listing, homegrid, jsrender, termscopy), additions to `site-status` and `scan-explain`.
* Found by the full run: `retention.test.ts` (2) and one test in `reports.test.ts` failed from 2026-10-24 on — the test clock was pinned to 2026-10-14 while the database stamps rows with its real clock, so the windows drifted with the calendar. Tests-only fix (the clock starts at the real time). Not related to this change; reported as such.

### Left for the user

Whether to add `shop.lingandsons.com` (one click), then confirm its collection rules — Ling & Sons' website terms restrict commercial use without written consent, whether they cover the shop is the owner's decision, and the shop's own terms page is empty. Whether to remove `www.lingandsons.com` afterwards. Nothing was pushed (commit is local).

---

## 2026-10-26 — Directive 7: "Remove website and its data" answered 400 Bad Request

Verbatim: `docs/original-prompt/07_DIRECTIVE_FIX_WEBSITE_REMOVAL_400_2026-10-26.md`.

### Root cause (reproduced, not assumed)

* The web client's `api.del` sent `content-type: application/json` with **no body** (`post`/`put`/`patch` default their body to `{}`; `del` did not). The API is Fastify 5, which answers **400 `FST_ERR_CTP_EMPTY_JSON_BODY` "Body cannot be empty when content-type is set to 'application/json'"** to a request that declares a JSON body it does not carry — and it does so in the body-parsing step, before authentication, validation or the route run. Reproduced against the repo's own Fastify (5.12.7): DELETE with no content type → 200; DELETE with the JSON content type and no body → 400; with `{}` → 200.
* Every bodyless DELETE in the web app was affected, not only websites: remove a website (Websites page and Setup page), revoke an invitation, remove a member, disconnect an integration.
* Why it was never caught: the API tests' client sent DELETE with no content type at all, so the browser's real request shape was never exercised.
* Not the cause (checked): the route and its validation (`siteId` must be a UUID), permissions (admin required; staff get 403), and the database — every foreign key to `sites` is `ON DELETE CASCADE` or `SET NULL`, so removal cleans up products, variants, prices, evidence, scans, profiles, consent, offers, flyers, matches and alerts; saved reports are snapshots and stay.

### Changes

* `apps/web/src/api.ts`: `requestHeaders(hasBody)` — a JSON content type is declared only when there is a JSON body (the CSRF header is always sent).
* `apps/api/src/app.ts`: an `onRequest` hook drops the content type of a DELETE that declares one but carries no body (no `content-length`, no `transfer-encoding`), so older cached web bundles and other HTTP tools work too. A DELETE with a body is parsed as before; other methods are untouched.
* `packages/services/src/sites.ts`: `removeSite` deletes by workspace **and** id (it already looked the website up by workspace first).
* `apps/web/src/pages/Websites.tsx`: the dialog shows the server's message when removal fails ("The website was not removed. …", `role="alert"`), shows "Removing…" with both buttons disabled while the request runs (and cannot be dismissed half-way), resets its error when closed, shows a "Website removed." toast on success, and refreshes every screen that is built on the removed website's data.

### Tests and checks

* `apps/web/src/api.test.ts` (new, 7): DELETE and GET send no content type, POST/PUT/PATCH keep sending JSON, error responses become readable messages.
* `tests/e2e/site-removal.test.ts` (new, 13), through the real API with the browser's exact header shapes: a DELETE with the JSON content type and no body removes the website and zero rows remain in 13 tables while other websites, the same hostname in another workspace and the saved report are unchanged; the audit event is written; the current web request shape works; a DELETE with a body works; removal twice is 404; invalid id 400; unknown id 404; another workspace's id 404 (both paths); not signed in 401; staff 403; missing CSRF header or foreign Origin 403; a removed website can be added again; removing a member works with the same shape.
* Red/green proof: with the server hook switched off the new tests fail with `FST_ERR_CTP_EMPTY_JSON_BODY` (10 of 13); with it on they pass.
* Real browser, throwaway workspace only ("UI Check Workspace", `.test` account): the dialog's confirm → `DELETE … 200 OK`, back to the list, the website and its rows gone, audit event written. A failing DELETE (forced in the page, HTTP 500) shows the red message inside the still-open dialog, "Removing…" with both buttons locked while pending, and a retry with the real network removed the website. The user's workspace (2,381 / 2,566 / 863 products) and the Exploration Workspace were never touched.
* Full run: see the verification report (final counts).

---

## 2026-10-26 — Directive 8: the web app would not build on Vercel (`tsc: command not found`)

Verbatim: `docs/original-prompt/08_DIRECTIVE_FIX_VERCEL_FRONTEND_BUILD_2026-10-26.md`. Vercel was building commit `417cd2b` with Root Directory `apps/web`.

### Root cause (reproduced in a clean clone, not assumed)

* Vercel's docs: "the install path is set by the root directory". So `npm install` runs **inside `apps/web`**, and npm installs only that workspace's own dependency tree (125 packages in the reproduction). `apps/web/package.json` declared `vite` but **not `typescript`**; `typescript` was only a root `devDependency`. Result: the install succeeds, `vite` is there, `tsc` is not — `sh: tsc: command not found`, exit 127. (On Windows the same step prints "'tsc' is not recognized".)
* It worked locally because everyone installs from the repository root, which installs every workspace plus the root tools.
* A second, latent break found while testing the fix: `apps/web/src/api.test.ts` (added in directive 7) imports `vitest`, also root-only; the web `tsc` scans all of `src`, so the next deploy would have failed with "Cannot find module 'vitest'".
* The lockfile is fine: it already holds the Linux x64 builds of Rolldown, esbuild and lightningcss with integrity hashes, and `npm ci --os=linux --cpu=x64 --libc=glibc` resolves them.
* Warnings: `Unknown project config "cache-dir"` is not from this repository (no `.npmrc`, no `cache-dir` anywhere) — it comes from Vercel's environment. The `esbuild` postinstall notice is npm 11's "install script not yet approved" message; esbuild is only an optional peer of Vite 8 (which builds with Rolldown); the build passes regardless, so nothing was configured.

### Changes

* `apps/web/package.json`: `typescript` `~5.9.3` in devDependencies (same range as the root) and `engines.node >=22.12.0` (Vite 8 needs it; Vercel reads it). `package-lock.json`: +4 lines only (the `apps/web` entry), no version changed.
* `apps/web/src/api.test.ts` moved to `tests/unit/web-api.test.ts` (checked by the root project, which has `vitest`); the deployable workspace now contains no test files.
* `apps/web/vercel.json` (new): Vite framework, `dist`, and a rewrite of every page address to `/index.html` — the app has client-side routes (`/login`, `/o/<id>/websites`) that would 404 on refresh — but **not** for `/api/…`. No backend address is invented.
* `tests/unit/web-deploy.test.ts` (new, 9): every command in the web scripts has its package declared in `apps/web`; every package its sources import is declared there; no test files in `apps/web/src`; workspace dependencies exist; the lockfile's `apps/web` entry matches the manifest; the Node requirement matches the root; `vercel.json` sends pages (not `/api`) to the app and points nowhere outside the repository. Red proof: with `typescript` removed and a test file added back, 4 of 9 fail, naming the cause.
* `docs/deployment.md`: new section "Hosting the web app on Vercel" (settings table, the one rule to add when a backend URL exists, warnings explained, how to verify).

### Verified

* Clean clones of the committed code with the changes applied: `npm ci` from `apps/web` (126 packages) then `npm run build` passes (`tsc --noEmit` + `vite build`, 765 modules, `dist/`); plain `npm install` from `apps/web` gives the same and leaves the lockfile content unchanged; root `npm ci` (676 packages) then `npm run build -w @ci/web` passes. Before the fix the same first step failed exactly as on Vercel.
* Repository: typecheck, lint (0 errors, 2 known warnings) and build (web, api, worker) clean; **943 of 943 tests in 58 files** (934 before; +9).
* Not verifiable here: running Linux binaries (needs Linux) and Vercel's own build — the final proof is a redeploy.

### Needs the user

Push the commit; then in Vercel: Root Directory `apps/web`, the "include source files outside the Root Directory" switch on, Node 22.x or newer, no `NODE_ENV=production` / "exclude development dependencies". Add the `/api` rewrite when the backend has an https address (see deployment.md), and set the backend's `APP_BASE_URL` to the Vercel address.

---

## 2026-10-26 — Directive 9: deploy the backend to AWS EC2 and connect the live Vercel frontend

Verbatim: `docs/original-prompt/09_DIRECTIVE_DEPLOY_BACKEND_TO_EC2_2026-10-26.md` (the SSH key's location is deliberately not recorded). Result: the backend is **deployed and verified**; the Vercel site is connected to it.

### What was found first

* Architecture (from the code): Fastify API (`apps/api`, port 4000), one worker with the scheduler (`apps/worker`), PostgreSQL 15+ with three roles set up by `scripts/db-setup.ts`; the web app has no API address setting and calls `/api/v1/…` on its own origin; the production configuration refuses to start unless `APP_BASE_URL` is a public https address, and registration needs SMTP.
* The instance: a fresh Amazon Linux 2023 `t3.micro` (2 vCPU, 913 MB RAM, no swap, 8 GB disk), nothing installed, only SSH listening, no firewall on the host, no IAM role. **The AWS security group allowed only SSH**: ports 80/443 were blocked from the internet (probed from outside). I cannot edit security groups without AWS credentials, so the owner opened 80 and 443 in the Console (4000 stays closed).
* There was no production database: the development data lives in an embedded PostgreSQL on the owner's computer, which EC2 cannot reach. A **fresh** production database was created (no old test accounts or pre-terms competitor data); copying the development data is the owner's decision.

### What was done

* **Server:** Node 22, PostgreSQL 18, nginx, git, certbot from the Amazon repositories (nothing downloaded from elsewhere); 2 GB swap; persistent size-capped journal; user `shelfwatch`; PostgreSQL on loopback with password authentication. Code: clone of `main`, `npm ci`, the existing build scripts for API and worker. Environment file generated on the server (`root:shelfwatch` 640); email settings copied over SSH from the owner's local `.env`. Migrations with the project's own `db-setup` (12 of 12). systemd services for worker then API (restart on failure and at boot, 45 s clean-stop window, hardened sandbox, API bound to 127.0.0.1).
* **HTTPS:** `18-212-221-70.sslip.io` (free public name for the IP; the owner approved it) with a Let's Encrypt certificate; nginx serves only the challenge over HTTP until the certificate existed, then HTTPS with `/api/` proxied to the API.
* **Frontend connection:** `apps/web/vercel.json` forwards `/api/:path*` to the backend (committed only after the address was verified from outside); the backend's `APP_BASE_URL` is the Vercel address, so the Origin check, the host-only cookie and the verification links all fit; no CORS involved.
* **Repository** (commit `7e0ff1e`): `deploy/ec2/` (unit files, nginx templates, `shelfwatch-status`, `shelfwatch-update`, `shelfwatch-backup` + daily timer, `enable-https`, `smoke-test`), the extended guard test, `docs/deployment.md` ("The backend on AWS EC2"), directive 9. The stale "nothing is deployed" statements in the other documents were corrected.

### Problems met and fixed on the way

* A directory check in my own stage script failed because it ran as the wrong user (fixed, re-run; idempotent).
* `shelfwatch-update` aborted on the first refused connection while the API was still starting (`set -o pipefail`): fixed and re-tested to exit 0 with readiness `ready`.
* Two checks of my smoke test were wrongly specified (an anchored `LIKE`, and a check that ran before the worker had processed the mail job): fixed; 30 of 30.
* The first capability check on the server took 75 s (later runs 14.4 s and 14.6 s, like locally); cause not established.
* A duplicate HSTS header (nginx and the API both sent it): removed from nginx.

### Verified (see verification-report.md, "Backend on AWS EC2")

Ready on every check; trusted certificate; 30 of 30 smoke requests, also through the Vercel address; a real browser on the live site registered, verified, signed in, created a workspace and loaded the protected pages with a clean console; a worker job ran; a full reboot recovered everything with identical data and a still-valid session; no secrets in logs, process lists or the application directory. Test accounts were removed afterwards (the production database holds no users).

### Left for the owner

Attach an **Elastic IP** (otherwise a stop/start of the instance changes the address and breaks the hostname, certificate and rewrite), consider limiting SSH to your own IP, replace the Gmail App Password that was shared in chat, decide about open sign-up (anyone can add websites for this server to read), copy backups off the server, and (if wanted) restore the development data. Nothing billable was created.

---

## 2026-10-28 — Directive 10: "Shelfwatch shows 2,385 products, my Shopify admin says 3,116"

Verbatim: `docs/original-prompt/10_DIRECTIVE_PRODUCT_COUNT_MISMATCH_2026-10-28.md`. The screenshot reads **3116**; the owner's text and prompt say 3,316 — flagged to the owner.

### What the evidence says

* The public store was enumerated independently of the collector on 2026-10-28 (polite requests to the owner's own shop): the feed paged **past** the collector's stop rule has 2,381 products (pages 11 and 12 empty), the product sitemaps list the same 2,381, and the database holds the same 2,381 — **0 differences in every direction**. 2,385 variants (one gift card has 5). No product is missed, duplicated or merged.
* "2385 of 2385 **products**" on My Stock is the **variant** count: `loadStock` joins variants to products and printed `rows.length` as products. The store has 2,381 products.
* The admin's 3,116 is a different population (everything in the admin, including products that are not public). Shelfwatch uses the public storefront only; the breakdown by status and sales channel is in the owner's admin, or reachable through the authorised Shopify connection (needs the owner's Shopify app credentials, not configured).
* A weakness in the completeness logic (not triggered for this store): a feed run was declared complete as soon as the feed returned a short page and at least one product was saved; it never compared that with the independent sitemap estimate.

### Changes

* `packages/services/src/live.ts`, `apps/web/src/pages/Stock.tsx`, `apps/web/src/types.ts`: My Stock reports items (variants) and products separately ("of 2,385 items · 2,381 products"); the page tolerates a backend that predates the field (the website and the backend are deployed separately).
* `packages/connectors/src/{types,shopify}.ts`, `packages/services/src/scan.ts`: `FeedConnector.reconcile` and `crossCheckFeed`. A feed run may claim "complete" only when the site's product sitemaps list nothing more than was collected. If they list more (a feed that ended early), the products the feed missed are read from their own pages (at most 300 per run, bounded by the request budget) and saved once; anything unreadable keeps the run `partial` (error code `feed_shorter_than_catalogue`) with the numbers and examples, and is not counted. When the feed already covers the profile's estimate (the normal case) no extra request is made; a stale, too-high estimate is checked against freshly read sitemaps and does not cause a false partial.
* `packages/core/src/scan-explain.ts`, `apps/web/src/pages/Websites.tsx`: every collection result now says what the number covers ("N products collected of the M the website lists publicly… A store's own admin total can be higher: drafts, archived products and products not sold on the website are not public…"); the pill reads "Complete public catalogue"; new wording for the partial reason above.
* Tests: `tests/e2e/catalogue-completeness.test.ts` (6) with two new fictional shops whose feed ends after 12 of 30 products (one where three of the missing products have no readable page). Red/green proof: with the check off, the short-feed shop ends with 12 of 30 reported as a complete catalogue; with it on, 30 are saved and the run is complete (or 27 and partial).

### Verified

* typecheck, lint (0 errors), build; **950 of 950 tests in 59 files** (944 before).
* Two real collections of the owner's store on the local copy of the data, after a backup (stopped the embedded database cleanly and copied its folder to `.data/postgres-backup-2026-10-28-before-completeness-check`, git-ignored): both complete via the Shopify feed, 11 requests, 2,381 discovered/saved, 2,385 variants, 0 errors; products, variants, product-id fingerprint, the 879 person-made match decisions (2,053 matches), 2 reports and 3 alerts all unchanged; observations +2,385 per run by design.

### Not done

**Production was not touched at the time (updated later the same day, see directive 11).** SSH to the EC2 instance stopped working during this work: the AWS security group now drops port 22 from this computer's address (which also changes — the connection moved between three different public addresses), while the API, the database and Vercel were healthy (`ready`, worker heartbeat 0 min). The owner must either allow this address for SSH or run `sudo shelfwatch-update` themselves; the production figures cited are the ones in the owner's screenshot (2,385 variants — the same as the local copy). The Vercel website part deploys on push and is safe against the older backend.

---

## 2026-10-28 — Directive 11: "Add direct links to the original product pages for price verification"

Verbatim: `docs/original-prompt/11_DIRECTIVE_PRODUCT_LINKS_2026-10-28.md` (the owner's professor reviewed the live report's Price tab: each card should open that exact product on its own website).

### What the evidence says (traced origin website → discovery → extraction → database → matching → comparison → report → screen)

* The address of every product already existed. Collection stores the page a product and price were read from in `variants.url` (NOT NULL, refreshed on every collection; Shopify keeps `?variant=<id>`, WooCommerce the permalink without a trailing slash). Identity is `(site, canonical url)`, so a renamed page is a new product (existing behaviour, unchanged). In the owner's local data: 7,959 variants, none empty, none non-http(s), none with credentials, none on another website; 2,053 matched pairs, every pair with two different addresses, each on its own website; every saved report snapshot already held the address of every row and every card.
* The gap was in the screen: the live Price Comparison showed a small "source ↗"; the report's Prices tab — the screenshot — passed no address to the price card at all. Nothing checked an address before it became a link.

### Changes

* `packages/shared/src/source-link.ts` (new): `safeSourceUrl` / `sourceLink` — an address may become a link only if it is an `http(s)` address, has no user/password, no spaces or control characters, is at most 2,048 characters long and is not a website's front page.
* `packages/services/src/source-url.ts` (new) and `comparison.ts`: `productPageLink` additionally requires the address to be on the product's own website (same registrable domain as the site record); otherwise the row's/card's `url` — and `PriceView.sourceUrl` — is `null`. Nothing is built or guessed; no other competitor's address is ever used as a substitute. Prices, differences, availability, match classes, ranking and the stored data are untouched (proved by test: damaged addresses change only the link fields).
* `packages/shared/src/report-types.ts`, `exports.ts`: `ComparisonRow.url` / `ComparisonCell.url` are `string | null`; CSV/Excel write an empty cell.
* `apps/web/src/ui.tsx`, `styles.css`: `SourceLink` component and a link row on every `PriceTag`: "View on <website> ↗" (opens in a new tab, `rel="noopener noreferrer"`, accessible name "View on shop.lingandsons.com: <product> (opens shop.lingandsons.com in a new tab)", underlined website name, the global focus ring, the website name wraps instead of being cut off), or an italic "No page link" with an explanation instead of a link. The whole card is not a link, so selecting and copying a price still works.
* `apps/web/src/pages/Prices.tsx`, `Reports.tsx` (Prices tab, stock tab, both assortment lists), `Matches.tsx` (both products in the comparison table and every candidate), `Products.tsx` (list and product header), `Stock.tsx`: the same safe link replaces the ad-hoc anchors.
* Tests (24 new): `tests/unit/source-link.test.ts` (6: safe/unsafe addresses, own-website rule), `tests/unit/web-source-links.test.ts` (10: the markup a customer gets), `tests/e2e/product-links.test.ts` (8: own product and three competitors in one row each link to a different page on their own website, equal to the fixture shops' own pages and to the stored address; pack-size variants keep their own pages; 11 kinds of damaged or foreign address give `null` while the rest of the comparison is identical; a new collection keeps the links while the price moves; a saved report carries the same links; the export stays valid with a missing link). Red/green: with the safety rule removed the damaged-address test and 6 of the render tests fail; restored, all pass.

### Verified

* typecheck, lint (0 errors), build, **974 of 974 tests in 62 files** (950 before).
* Real data, real browser (local copy of the owner's data, temporary read-only staff account that was removed afterwards): the live Price Comparison and the saved report's Prices tab show a link on every card (the report: 150 of 150 rows; hosts groceriestogoaruba.com, quickmartaruba.com, foodstore2go.com); the 24 Poland Spring row links to its own shop page (`?variant=40612263559308`) and to Quickmart's own page for the matched product; the link is reachable with the Tab key with a visible focus ring; Match review and Products render their links; no new console errors. The real shop.lingandsons.com link for a matched product opened its product page in the browser.
* Stored addresses compared with the real pages (bounded, polite, one request per page, 2.5 s apart, robots.txt honoured): 13 matched pairs → 26 pages; 20 reached the right product (HTTP 200, same website, all title words found, price equal to the stored price, `?variant` id present on the page); 6 Quickmart pages could not be reached at all from this computer (the server resets automated connections, even robots.txt; the browser pane could not open it either) — **not verified**, they are the same kind of address as the ones from the same store's API that were checked against live pages on 2026-10-19.

### Not done / limits

* **Website deployed, backend not.** Commit `3c83c80` was pushed to `main`; the live Vercel site now serves the new code (its `app-shell-cWYcWmC2.js` chunk is byte-identical to the local production build and contains the link code; `/api/v1/health` through the Vercel rewrite answers). The links were not clicked on the production site itself (no credential for the owner's account there).
* **Production backend updated (after the owner allowed SSH from their current address).** backup first (`/var/backups/shelfwatch/…T134759Z.dump` and the update script's own `…T134806Z.dump`, 6.3 MB each), then `sudo shelfwatch-update` took the server from `ad828d6` to `46f2aed` (so it also carries directive 10's completeness cross-check), no new migration (12 applied), worker restarted first, readiness `ready`, smoke test **30 of 30**; the smoke test's own throw-away account and workspace were removed again and the 3 real accounts and workspaces were not touched. Read-only check of the production data under the new rule: the owner's workspace has 7,959 variants (2,385 / 878 / 2,570 / 2,126 on its four websites), **0** without a page address and **0** on another website, and 2,056 matched pairs, so no card is hidden by the server-side rule. (Before that, SSH had been dropped by the security group on three tries from two different addresses.)
* No logged-in check of the production website: there is no credential for the owner's account there and no account was created on it.
* Redirects: an address is shown as stored; if a shop later moves or removes a page, the shop's own redirect or "not found" page appears. Shelfwatch does not claim the page still exists — a re-collection refreshes the address, and a product that disappears from a complete catalogue is marked delisted.

---

## 2026-10-28 — Directive 12: "Remove the minimum of 3 competitor URLs"

Verbatim: `docs/original-prompt/12_DIRECTIVE_REMOVE_MINIMUM_COMPETITORS_2026-10-28.md`.

### Root cause (found by searching every layer, then proved with a failing test before any fix)

There was **no** database constraint, no API validation and nothing in collection, matching, comparison or reports that needed more than one competitor. The "minimum of 3" lived in four places, all consequences of one setting:

1. `DEFAULTS.minCompetitors = 3` in `packages/shared/src/constants.ts`, **sent to the website by the API** (`GET /sites` → `limits.minCompetitors`).
2. The getting-started guide (`packages/services/src/journey.ts`): the step "Add 3–5 competitors" was only "done" with 3 or more. With 1 or 2 it stayed the **current** step forever ("Add at least 3 for comparisons that mean something"), so the guide never moved on to checking the websites, never reached "You're set up", and kept sending the customer back to Setup — the "does not work properly / prevents them from proceeding".
3. The Setup page (`apps/web/src/pages/Setup.tsx`): pre-filled **three empty lines**, titled the section "Competitors (3–5)" and said "Add at least 3 competitors".
4. Wording: the Websites page empty state ("three to five competitors"), the README and the requirements matrix.

(`maxCompetitors = 5`, enforced in `addSite`, is unchanged on purpose.)

### Changes

* `constants.ts`: `minCompetitors` removed; `api/routes/sites.ts` and the web `SitesResponse` type no longer carry it (an older website build falls back harmlessly; a newer one never reads it).
* `journey.ts`: the step is "Add your competitors", **done with one**, and says "N competitor(s) added. You can add up to 5, whenever you like."; with none it says "Add at least one website you compete with."
* `apps/web/src/competitor-rows.ts` (new) + `Setup.tsx`: the list starts with the competitors the workspace already has, or **one** empty line; the title is "Competitors (up to 5)"; the only hint ("Add the website of at least one competitor…") disappears as soon as one URL is typed. "Add competitor", "Remove", editing, the replace-website confirmation and every URL check are unchanged.
* `Websites.tsx`, README, `REQUIREMENTS_MATRIX.md` (J3): wording.
* Nothing in the database changed, so **no migration** and no production data is touched.

### Tests (all new tests fail on the old code)

* `tests/e2e/competitor-count.test.ts` (7, real collections of fictional shops): exactly one competitor (journey step done, the guide moves on to the next real step; collect, match, compare, report all work; every comparison row has one card; the report is complete, not partial); a competitor never collected (empty comparison, partial report, "not collected yet", no error); 1 to 5 competitors added one by one, the sixth still refused (limit unchanged), removed one by one back to none (the step becomes "to do" again), and re-added; every kind of unsafe or malformed address still refused; three competitors collected, matched and compared exactly as before. Red first: 5 of 7 failed on the old code.
* `tests/unit/competitor-minimum.test.ts` (7): the regression guard — no `minCompetitors`-style setting, no "at least 3 competitors" / "3–5 competitors" wording, no list padded to 3 lines, no competitor count compared with 3 anywhere in `apps/` or `packages/`, no competitor-count constraint in any migration; the Setup rows helper (one empty line or exactly the saved competitors; never padded) and hint. Red/green: re-adding the constant fails it.
* `tests/e2e/api.test.ts`: `limits` is now `{ maxCompetitors: 5 }`.

### Verified

* typecheck, lint (0 errors), build, full suite (numbers in the verification report).
* **Deployed 2026-10-28 — commit `f082b7f` pushed; Vercel serves the new entry bundle `index-CBa5uHu0.js` (byte-identical to the local production build, contains the new Setup page) and `/api/v1/health` answers through it; the EC2 backend was updated with `sudo shelfwatch-update` (automatic backup first, `…T141736Z.dump`, 46f2aed → f082b7f, no migration, readiness `ready`). Production check with a throw-away account in a new workspace, example.com/example.org only, nothing profiled or collected: `GET /sites` → `limits` is `{"maxCompetitors":5}`; the guide step with no competitor is "to do" ("Add at least one website you compete with"); after adding exactly ONE competitor it is "done" ("1 competitor added. You can add up to 5, whenever you like.") and the next step is "check what each website allows"; an unsafe address is still refused (400); dashboard and reports answer 200. The account and workspace were removed again (the 3 real accounts, 11 websites and 7,660 products were untouched). Not checked live: the Setup page itself on the production site (no login for the owner's account) — it was checked in a real browser on the local app, and the production bundle is identical.**
* Real browser (local app, throwaway account and its own empty workspace, example.com / example.org / example.net only, no worker so nothing was collected): the Setup page of a new workspace shows one empty competitor line, "Competitors (up to 5)" and the one-competitor hint; with ONE competitor typed it saved and went to Websites; the guide showed "1 competitor added … You can add up to 5", step done, next step "check what each website allows"; "Add competitor" twice, saved three; "Remove" on one, saved two (guide: "2 competitors added"); an address in the cloud-metadata range was still refused with its message. The throwaway account, workspace, queued jobs and mail record were removed afterwards.

---

## 2026-10-28 — Directive 13: "Collection of lasfit.com fails: Failed query: insert into variants …"

Verbatim: `docs/original-prompt/13_DIRECTIVE_FIX_COLLECTION_FAILURE_AFTER_URL_CHANGE_2026-10-28.md` (two screenshots: the website page and the collection history).

### Root cause (proved with the production data, the live feed and a failing test that reproduced the error byte for byte)

* The owner's own Shopify feed lists, for ONE variant (`2019-2023-jeep-renegade-led-bulbs?variant=50715214446839`), a **compare-at price of 139982999149929.98** next to a price of 317.94 (the shop's own data; fetched from the public product page on 2026-10-28). Prices are `numeric(14,4)` (10 digits before the point, so < 10 billion), so the database refused it: SQLSTATE 22003 "numeric field overflow".
* The collector saved each batch of 250 products in ONE transaction. The refusal rolled the whole batch back, nothing in the code caught it, the scan "crashed", and the run ended `failed`, 0 saved, "not a full catalogue". Nothing half-written was left: production held 0 products, 0 variants and 0 price observations for that website after two attempts.
* The screen showed `Failed query: insert into "variants" (…) values (…) params: …` because the query layer's error message is the SQL statement and every value; the database's real reason sits in the error's `cause`, which the code never read (the worker log carried the same useless text, with the shop's values).
* **The URL change was not involved.** The audit trail of that workspace shows the lasfit address was never changed (added at 09:05; at 14:31 the Setup form re-saved the existing websites' names and added a new competitor, allalighting.com; 14:32 the rules were confirmed; 14:32 and 14:34 two collections failed identically). The same feed fails the same way for any workspace. Changing a website's URL was already hardened earlier (a different website cannot be re-pointed: it must be removed and added; the same website keeps its data), and nothing in that path was touched.

### Changes

* `packages/core/src/storable.ts`: what the database can hold (money below 10,000,000,000; 32-bit counts). A test ties the limit to the real columns.
* `packages/services/src/ingest.ts`: an amount or count that cannot be stored is **left out, as unknown** — never clamped, rounded or invented — before the save; a price that cannot be stored takes its compare-at price with it; the product itself and its other values are saved; each left-out value is remembered with its product address and value, and the run's notes say so in plain words ("…the compare-at price 139982999149929.98 is not a usable amount …, so it was left out; the rest of the product was saved"). The existing rule that a price of 0 means "no price" is unchanged.
* `ingest.ts`: if the database still refuses the data of some product (any other kind of bad data), the already rolled-back batch is saved **one product at a time**, so only that product is skipped; the run ends **partial, never complete** (`errorCode products_skipped`, `errors_count`, the product address and the database's reason in the error and notes), and the next collection retries it. A lost connection, a full disk or any non-data failure still stops the run as before.
* `packages/services/src/db-errors.ts` (new), `scan.ts`, `core/scan-explain.ts`: the database's real reason (SQLSTATE and column when it gives one) replaces the SQL statement and values in the run's error, the plain-language explanation and the worker log; the crash path now also records the requests made.
* No schema change, no migration, no change to matching, comparison, reports, product links or authentication.

### Tests (13 new; 1,001 in 66 files)

* `tests/e2e/collection-data-errors.test.ts` (6, real collections of a fictional Shopify shop): the exact lasfit case (price 317.94 with compare-at 139982999149929.98) and an impossible price → run succeeded and complete, every product saved, only the impossible amounts left out, notes name the product and value; a second collection → no duplicate products, variants or records (observations grow by one per variant, as always); the limit equals the real column precision; the real "numeric field overflow" is read correctly (code 22003) and the statement/values never appear; connection-type failures are not treated as bad data; a variant the database refuses (a trigger in the test database stands in for any rejected data) → only that product skipped, run partial with the reason, what the refused product had before is unchanged, the other product's new price saved, and the next collection completes. **Red first:** on the old code three of these failed with the production error (`Failed query: insert into "variants" … 317.94,139982999149929.98,AWG …`).
* `tests/unit/storable-values.test.ts` (7): the limits and the error descriptions.
* `tests/live/real-catalogues.live.test.ts`: the independent feed comparison now models the amounts that cannot be stored and the existing zero-price rule, and reports them.

### Verified on real data

* **Live check on the real lasfit.com** (the owner's own website; temporary database; real DNS, robots.txt, 6 requests, 1.5 s pacing): profile `full`; collection **succeeded, complete: 1,129 products, 9,199 variants** (the capability estimate said 1,127); **0 differences** from an independent re-read of the website's own feed for every product and variant (prices, compare-at, availability, titles, addresses); **10 of 10** real product pages show the stored price and availability; 9,199 observations all traceable; the variant with the impossible compare-at price was stored with price 317.94 and no compare-at; two gift lines priced 0.00 are stored as "no price" (existing rule); a **second complete collection**: still 1,129 / 9,199, observations 9,199 → 18,398, no price changed. 9 of 9 live checks pass.
* **Production** (after deploying; throw-away account and workspace, removed afterwards): the same website collected on the real worker and database: succeeded, complete, 1,129 products, 9,199 variants, 6 requests, about 70 seconds, 0 errors, 0 duplicate products or variants, the odd variant stored as 317.94 with no compare-at, the notes as above; the server's memory stayed fine (583 of 913 MB used).

### Deployed

* Commit `8bb4f09` pushed; the backend was updated on EC2 (automatic backup first, `…T150326Z.dump`, f082b7f → 8bb4f09, no migration, readiness `ready`). The change is entirely in the backend; the website (Vercel) needs no update.
* The owner's real data was untouched: the "Aditya" workspace still has 7,660 products / 7,959 variants; the `adi` workspace's lasfit.com has **0 products because nobody has collected it since the fix** — the failed attempts saved nothing. The owner must click "Collect catalogue" once more.
* The two failed runs stay in that website's history with their old long error text (history is not rewritten).

---

## 2026-10-28 — Directive 14: "auxito.com stopped at 750 of 1,483 (HTTP 429) — and fix collection reliability in general"

Verbatim: `docs/original-prompt/14_DIRECTIVE_COLLECTION_RELIABILITY_AUXITO_2026-10-28.md` (two screenshots of the website page and its history).

### The incident (production database and the live website)

* auxito.com (a Shopify store; the owner recorded the website's written permission) was collected from the feed: pages 1–3 of 6 (3 × 250 = **750 products, 1,039 variants**, all stored, no duplicates), then page 4 answered **HTTP 429** three times in a row (the original request and two retries after 2 s and 4 s). The run ended `partial`, `error_code http_error`, cursor `{"page": 4}`, 7 requests, 39 s. The website's rate limit is temporary: one request for the same page from the server's address ten minutes later was answered normally (HTTP 200).
* **The same thing had already happened to shop.lingandsons.com that morning** (the 12:30 scheduled run: "partial, 750 of 1,850, Shopify feed returned HTTP 429"): also three pages, then 429.
* "Progress was saved and the run can resume" / "Run the collection again to continue where it stopped" were **not true** for feed collections: starting a collection always created a NEW run with no cursor, i.e. it began at page 1 again and would meet the same limit at the same place. The cursor was only used to resume a run whose worker had died.
* Production record before the fixes (full-catalogue "discovery" runs): see the verification report.

### Systemic weaknesses found by reading the whole pipeline (each proved by a test that failed on the old code)

1. A paused collection could not be continued (above); the website's "slow down" was retried twice within about 6 seconds and then the run ended; nothing tried again by itself.
2. A "slow down" (429) was counted as an access **denial**: three in a row flagged the host as blocked in the limiter that the **whole worker process shares**, with no way back, so every later collection of that website — in every workspace, the capability check included — failed as "blocked" until the worker was restarted.
3. A 429 or 5xx on robots.txt was read as "robots.txt forbids everything" (cached for the run), so a website that was merely busy became "blocked", and the capability check recorded a verdict it had no basis for ("the store has disabled it or restricted it") for a feed that had only answered 429/5xx.
4. A first-page 429 sent the run to the next, more request-hungry method (sitemap and every product page) instead of waiting.
5. A throttled or briefly unavailable **product page** returned an empty result that the crawl counted as "read"; a throttled **sitemap** file was skipped without making the page list "incomplete". Both could end as a "complete" catalogue that was missing products.
6. A feed that ignores its page number would be read page after page until the request budget was spent.
7. The number of "products saved" was a tally per page: a listing crawl meets the same product on several pages and reported 65 for a 28-product website (the database held 28).
8. (Already fixed in directive 13) one impossible value failed a whole batch; the database's reason was hidden.

### Changes

* **Pause and continue** (`packages/services/src/scan.ts`, migration `0012_scan_continuation`: two new columns on `scan_runs`, no data touched): a run that stops because the website asked us to slow down, was briefly unavailable, timed out or answered something that was not its feed keeps everything it saved, ends `partial` with `nextAttemptAt`, and is continued **by the scheduler's recovery pass (every minute) as the same run, from its saved page/queue**: after 2, 4, 8, 16, 32, then 60 minutes while nothing new is saved (never sooner than the website's own Retry-After, never later than an hour), starting over whenever a sitting saved something. After 6 idle attempts it stops trying by itself, keeps what it saved, says so, and a click on Collect catalogue continues it (24 hours; after that a new collection starts afresh). "Collect catalogue" after a pause continues the same run too. Runs saved before this existed (recorded as `http_error` with HTTP 429/5xx and a page) are recognised and continued.
* **Politeness** (`packages/connectors/src/safe-fetch.ts`): "slow down" is waited out only when it names a wait of 30 s or less (a long one ends the sitting instead of holding a worker), widens the spacing of that host's later requests (doubling to 20 s, easing as requests succeed), is never a "denial", and a refusal (401/403) now stops **only the run that met it**.
* **Classification** (`feed-errors.ts`, Shopify/WooCommerce/page/sitemap connectors, robots.txt, the capability check): 429 → `rate_limited`, 5xx/408 → `temporarily_unavailable`; a robots.txt that cannot be read is a pause (never cached, never "forbidden"); a website that was limiting us while it was checked is not judged — the run pauses and checks again; a throttled page stays in the queue unread; a throttled or unreadable sitemap makes the page list incomplete.
* **No hidden escalation**: a temporary stop never switches to a method that needs more requests.
* **Honest numbers and wording**: "saved" is the number of distinct products the run saved as the database holds them; a feed that does not advance ends `feed_not_paging`; the capability report says that a large catalogue may be paused and continued; the run explanation says "Paused … continues by itself" and when; the website's status says so.

### Tests (60 new; 1,061 in 69 files) and the measurement

* `tests/e2e/collection-resilience.test.ts` (13): pause → continue → complete as ONE run with nothing read twice (600 observations, not 1,100); the waiting ladder and its end; Retry-After; a brief 503; manual continue; a run recorded the way auxito.com's is; limits at the first page, while the website is being checked, in sitemaps and product pages; a feed that does not advance.
* `tests/unit/fetch-resilience.test.ts` (14): the fetcher, robots.txt, error classification and the schedule. `tests/e2e/collection-reliability.test.ts` (33): the measurement below.
* Updated tests that encoded the old behaviour: a 5xx on a feed is `temporarily_unavailable` (not `http_error`); an unreadable robots.txt (5xx) is "not now" (not "forbidden"); a paused run's summary reads "Paused"; the test harness disarms paused runs when a file ends.

### Reliability measurement (fictional websites through the real pipeline; nothing clicked)

24 eligible scenarios (13 healthy kinds, 9 rate-limit/outage situations, 1 brief outage, 1 dead worker) and 8 websites that must not be collected. Success = last run succeeded and complete, exactly the published products, no duplicates after a second collection.

* **Before** (the same scenarios against the code of the previous commit): **14 of 24 = 58.3%**; the 10 failures: 5 ended partial after a 429/503 (the auxito.com situation), 1 ended "blocked" (throttled product pages), 3 ended "failed"/unsupported because the website was limiting us while it was checked (capability check, robots.txt, sitemap), and the listing storefront reported 65 products for a 28-product website.
* **After**: **24 of 24 = 100%**; the 8 non-collectable websites end in their honest state (blocked ×4, failed ×2 after the waiting ladder or as "catalogue elsewhere", partial ×2 for a feed that cannot be paged and a website limiting us for a month).
* Limits of this number: the websites are fictional (written from the behaviour of the real ones), so it measures the software against known situations, not the world; the list was written by the developer and was fixed before the fixes were measured, but it cannot contain situations nobody has met. Real evidence follows.

### Real collections

* The owner's own websites with the new code (temporary database, real requests, polite pace): **groceriestogoaruba.com** complete, 2,381 products / 2,385 variants, 11 requests, 0 differences from the website's own feed, 8 of 8 real pages agree, a second collection adds nothing; **lasfit.com** complete, 1,129 products / 9,199 variants, 6 requests, 0 differences, 8 of 8 pages agree, no duplicates. (The safeguard that refuses a competitor whose terms forbid automation without recorded permission also fired once when the harness tried to add lasfit.com as a competitor: correct behaviour.)

### Deployed and verified on production (directive 14)

* On production, after the update (backup first, `…T170239Z.dump`, 11 MB; the owner had allowed SSH from their new address): within about a minute the scheduler found auxito.com's and shop.lingandsons.com's paused runs (recorded the old way: `http_error`, HTTP 429, cursor page 4) and continued them from page 4 as the same runs. **auxito.com: succeeded, complete, 1,483 products (= the 1,483 the website lists), 3,602 variants, 3,602 price observations (one per variant: pages 1–3 were not read again), 11 requests in total, 0 duplicate products or variants, 0 delisted.** **shop.lingandsons.com: succeeded, complete, 1,850 of 1,850 products, 2,126 variants, 0 duplicates.** The "Aditya" workspace is unchanged (7,660 products / 7,959 variants / 2,056 matches); the workspace "Groceries To Go Aruba" (another person) was not touched; products now total 10,678 = 7,660 + 3,018. A faulty variant tally (0) on those two runs was found in this check, fixed (`03aa072`, with a test) and the two rows corrected from the stored data; the products and variants themselves were right throughout. Smoke test 30 of 30 (its throw-away account removed). The website part is live: the entry bundle is byte-identical to the local build.
* Real-world record of full-catalogue ("discovery") runs on production before the fixes, read from the database: **13 of 17 completed (76.5%)** — the 4 that did not: shop.lingandsons.com 750/1,850 (429), auxito.com 750/1,483 (429), lasfit.com ×2 (the impossible price, fixed in directive 13). After: the same 17 runs read 15 complete + 2 failed, the two 429 runs having been finished (the two failed ones are the lasfit.com attempts that are kept as history). That is the real-world evidence; it covers 7 websites and 17 runs, so it is a small sample, and the "after" figure counts the same runs completed by continuation, not new independent attempts. The fresh test of the new code on a different, independent website will be the next scheduled collection (12:30 UTC daily) — not yet observed.
