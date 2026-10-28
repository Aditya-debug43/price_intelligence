# Shelfwatch — Project Context (master record)

> **Purpose.** This file lets a brand-new Claude Code session understand the whole project without the original conversation.
> Read it first, then `docs/WORK_LOG.md` (what happened after this file was written), then the verbatim prompts in
> `docs/original-prompt/`. It records **facts verified against the repository**, and labels anything that exists only in the
> conversation history ("transcript-only").
>
> **No secrets are recorded here.** Environment variables appear by name only.
>
> Created: 2026-10-15 (Phase 0 of the "real product" directive). Baseline commit at creation: `c28f8d3`.
> **Last updated: 2026-10-23, after directive 5 (see "Update 5" — it supersedes anything older). Previously 2026-10-19, after directive 3 (see "Update 3" below — it supersedes anything older in this file). Previously 2026-10-15, after Phase 8 (commit `aa30324`).** Sections A, B and the per-feature text in D describe the state at creation; the **Update log** below and the *Update* notes under each feature bring them current. Details of every change are in `docs/WORK_LOG.md`; the requirement-by-requirement status is in `docs/REQUIREMENTS_MATRIX.md`.
> Keep this file current: update it after every major implementation phase.

Contents: A Origin & requirements · B Chronological history · C Repository structure · D Feature inventory · E Database & data flow ·
F Environment, commands, integrations · G Testing & verification · H Known defects & incomplete work · I Roadmap.

---

# Update 11 — directive of 2026-10-28: every price card links to the product's own page at its own website (CURRENT STATE — read with Updates 5–10)

Verbatim directive: `docs/original-prompt/11_DIRECTIVE_PRODUCT_LINKS_2026-10-28.md` (the owner's professor: "customers should be able to click a product or its price card and open that exact product on the original website"). Details: `docs/verification-report.md` ("Product page links"), `docs/WORK_LOG.md` (directive 11).

- **Where the addresses come from (already true before this change):** collection stores the page each product and price was read from in `variants.url` (one per variant; Shopify `…/products/<handle>?variant=<id>`, WooCommerce the product permalink without a trailing slash, other sites the page itself); `products.canonical_url` is the identity `(site, canonical url)`. Every collection refreshes `variants.url`. Matching joins variants, so a matched pair always carries its own two addresses; saved reports are immutable snapshots that already held every row's and card's `url`. In the owner's local data all 7,959 variants have a valid on-site `http(s)` address and the 2,053 matched pairs have distinct addresses on their own websites. The Price Comparison page showed a vague "source ↗" and the report's Prices tab (the owner's screenshot) showed nothing.
- **Changed:** `packages/shared/src/source-link.ts` (`safeSourceUrl`/`sourceLink`: web addresses only, no credentials, no spaces or control characters, ≤ 2,048 characters, never a front page); `packages/services/src/source-url.ts` + `loadComparison` (a row's/card's `url` is the stored address only if it is safe **and on the product's own website**, otherwise `null`; `PriceView.sourceUrl` follows; prices, differences, matching and ranking are untouched); `ComparisonRow.url`/`ComparisonCell.url` are now `string | null` and the CSV/Excel export writes an empty cell for `null`; the web `SourceLink` component and a link row on every `PriceTag` ("View on quickmartaruba.com ↗": opens in a new tab with `rel="noopener noreferrer"`, names the website and the product for assistive technology, visible focus ring) on the live Price Comparison and the report's Prices tab; the same safe link replaces the ad-hoc anchors in Match review (both sides and candidates), Products, My Stock and the report's stock and assortment lists. A missing, damaged or foreign address shows **"No page link"**, never a link, never another shop's page.
- **Compatibility:** the new website works with the older backend (the addresses are the same strings; the website applies the safety rule itself) and an old report snapshot without an address shows "No page link". The server-side "own website" check only exists once the backend is updated.
- **Verified:** typecheck, lint (0 errors), build, the full suite; red/green proofs; real-data browser check; a bounded, polite comparison of 26 stored addresses with the real pages (20 reached and correct, 6 Quickmart pages unreachable from this computer). Numbers and honest limits in the verification report.
- **Not claimed:** the backend on EC2 is not updated (SSH still blocked — see Update 10); no logged-in check of the production website was possible (no credentials for the owner's account).

---

# Update 10 — directive of 2026-10-28: why 2,385 in Shelfwatch against 3,116 in the Shopify admin (CURRENT STATE — read with Updates 5–9)

Verbatim directive: `docs/original-prompt/10_DIRECTIVE_PRODUCT_COUNT_MISMATCH_2026-10-28.md`. Details: `docs/verification-report.md` ("Product count reconciliation"), `docs/WORK_LOG.md` (directive 10).

- **Finding:** no public product was missed. groceriestogoaruba.com publishes **2,381 products (2,385 variants)**: the public feed (paged past the collector's stop point), the product sitemaps and the database are the same set (0 differences). "2385 … products" on My Stock was the **variant** count mislabelled. The admin's 3,116 (the screenshot; the owner's text says 3,316) counts products that are not public (drafts, archived, not on the Online Store — likely, unproven); the breakdown is in the owner's admin or via the authorised Shopify connection (needs the owner's Shopify app credentials).
- **Fixed:** My Stock shows items and products; a feed run is cross-checked against the site's sitemaps before it may claim "complete" (missed products are read from their own pages; unreadable ones keep it partial); every collection result states what its number covers.
- **Verified:** 950 tests in 59 files; two real collections of the owner's store on the local data (backup first): 2,381/2,385, no duplicates, product ids, match decisions, reports and alerts unchanged.
- **Production not updated:** SSH to EC2 was blocked (security group drops port 22 from the current address, which keeps changing); the app itself was healthy. To deploy: allow SSH from the current address, then `sudo shelfwatch-update` on the server; the Vercel part deploys on push.
- **Local backup:** `.data/postgres-backup-2026-10-28-before-completeness-check` (199 MB, git-ignored). Two real collections added observations to the local copy of the owner's data.

---

# Update 9 — directive of 2026-10-26: the backend runs on AWS EC2 and the Vercel frontend is connected (CURRENT STATE — read with Updates 5–8)

Verbatim directive: `docs/original-prompt/09_DIRECTIVE_DEPLOY_BACKEND_TO_EC2_2026-10-26.md`. Details: `docs/deployment.md` ("The backend on AWS EC2"), `docs/WORK_LOG.md` (directive 9), `docs/verification-report.md` ("Backend on AWS EC2").

- **Deployed:** one Amazon Linux 2023 `t3.micro` at `18.212.221.70` (us-east-1c): systemd `shelfwatch-api` (127.0.0.1:4000) and `shelfwatch-worker` (exactly one), PostgreSQL 18 on loopback, nginx (80/443) with a Let's Encrypt certificate for **`18-212-221-70.sslip.io`**; code in `/opt/shelfwatch/app` (a clone of `main`), secrets only in `/etc/shelfwatch/shelfwatch.env` (`root:shelfwatch` 640). The web app stays on Vercel (`https://price-intelligence-psi.vercel.app`); `apps/web/vercel.json` forwards `/api/*` to the backend, so the browser stays same-origin. The backend's `APP_BASE_URL` is the Vercel address.
- **Verified** (real requests, a real browser on the live site, a full reboot): see the verification report. Everything in the checks passed; the database was left with no users (test accounts removed).
- **Operations** (on the server): `sudo shelfwatch-status`, `sudo journalctl -u shelfwatch-api -u shelfwatch-worker -f`, `sudo shelfwatch-update`, `sudo shelfwatch-backup` (daily timer, same disk), `bash /opt/shelfwatch/app/deploy/ec2/smoke-test`. The files are in `deploy/ec2/`.
- **Not done / owner's decisions:** an Elastic IP (the public IP changes on stop/start, which breaks the hostname, certificate and rewrite), limiting SSH in the security group, replacing the Gmail App Password shared earlier in chat, off-server backups, open sign-up (anyone can add websites that this server reads: terms and permissions still apply), copying the development data (the production database is fresh), a custom domain. The AWS firewall was opened by the owner in the Console; no AWS credentials were used and no billable resource was created.
- **Rule:** never write the SSH key's location or any secret into the repository; keep the production environment file out of Git.

---

# Update 8 — directive of 2026-10-26: the web app would not build on Vercel (CURRENT STATE — read with Updates 5–7)

Verbatim directive: `docs/original-prompt/08_DIRECTIVE_FIX_VERCEL_FRONTEND_BUILD_2026-10-26.md`. Details: `docs/WORK_LOG.md` (directive 8) and `docs/deployment.md` ("Hosting the web app on Vercel").

- **Root cause (reproduced):** with Root Directory `apps/web`, Vercel runs the install *inside* `apps/web`, which installs only that workspace's own dependency tree. `apps/web` used `tsc` in its build script but did not declare `typescript` (root devDependency only) → `sh: tsc: command not found`, exit 127. Locally everything is installed from the repository root, so it worked. A second, latent break (`apps/web/src/api.test.ts` importing the root-only `vitest`) was found and removed.
- **Fix:** `typescript` and `engines.node` in `apps/web/package.json` (lockfile +4 lines); the web test moved to `tests/unit/web-api.test.ts`; `apps/web/vercel.json` (Vite, `dist`, a page rewrite that excludes `/api`); `tests/unit/web-deploy.test.ts` guards all of it; docs section added. The `cache-dir` and `esbuild` npm warnings are not from the repository and do not affect the build.
- **API address:** the web app has none — it calls `/api/v1/…` on its own hostname — so on Vercel a rewrite of `/api/*` to the backend's https address is required, and **none is committed because no backend address exists yet.** Until it is added the pages load but sign-in and data calls answer 404. The backend's `APP_BASE_URL` must be the Vercel address.
- **Verified:** clean clones → `npm ci` / `npm install` from `apps/web` and a root install all build; repository checks clean; 943 tests in 58 files. Not verifiable here: Vercel's own Linux build.
- **Rule for future changes:** anything the web build needs must be declared in `apps/web/package.json`, and web tests live under `tests/unit`, not in `apps/web/src`.

---

# Update 7 — directive of 2026-10-26: "Remove website and its data" returned 400 (CURRENT STATE — read with Updates 6 and 5)

Verbatim directive: `docs/original-prompt/07_DIRECTIVE_FIX_WEBSITE_REMOVAL_400_2026-10-26.md`. Details: `docs/WORK_LOG.md` (2026-10-26, directive 7) and `docs/verification-report.md` ("Website removal").

- **Root cause (reproduced):** the web client's `api.del` sent `content-type: application/json` with no body; Fastify 5 answers 400 `FST_ERR_CTP_EMPTY_JSON_BODY` to that before authentication or the route runs. Every bodyless DELETE in the web app failed (website removal on the Websites and Setup pages, revoking an invitation, removing a member, disconnecting an integration). The API tests never sent that header, so they stayed green.
- **Fix:** the client declares a JSON content type only when it sends a body (`requestHeaders` in `apps/web/src/api.ts`); the API also tolerates a bodyless DELETE that declares one (an `onRequest` hook in `apps/api/src/app.ts`), so cached older bundles and other tools work; `removeSite` deletes by workspace and id; the confirmation dialog shows the server's message on failure, "Removing…" while pending, locks both buttons meanwhile, and refreshes the screens built on the website's data. The database was never at fault: every foreign key to `sites` cascades or sets null.
- **Verified:** tests 934 in 57 files (+20: `apps/web/src/api.test.ts`, `tests/e2e/site-removal.test.ts`), typecheck / lint / build clean; red-green proof (tests fail 10 of 13 with the server fix off); the real browser flow in a throwaway workspace. The user's workspace was not touched.
- **Rule for future tests:** an API test of a browser feature must send the headers the browser sends.

---

# Update 6 — directive of 2026-10-26: why "www.lingandsons.com" never collected (CURRENT STATE — read with Update 5 below; where they differ this one wins)

Verbatim directive: `docs/original-prompt/06_DIRECTIVE_FIX_LING_AND_SONS_COLLECTION_2026-10-26.md`. Details and evidence: `docs/WORK_LOG.md` (2026-10-26) and `docs/verification-report.md` ("Ling & Sons (2026-10-26)").

- **Root cause (confirmed on the real site):** `https://www.lingandsons.com/` is Ling & Sons' *information* website, not a shop. Its sitemap lists 19 ordinary pages (deals, news, rewards, contact, terms, articles); none is a product page. Its menu item "Online Shopping" links to **`https://shop.lingandsons.com/`**, a separate Shopify store (public feed, about 1,850 products, AWG; collected for real on 2026-10-19). The "VIP Deals" page builds its list in the browser from `/data/sp.json`, which is currently an empty file. So there is nothing to collect at the address the user entered, and the failed runs (0 requests, "no reliable collection method") were correct — but the explanations were wrong.
- **Product defects fixed:** the profiler counted the 19 sitemap pages as "about 19 products / ~20 requests" and listed barcode / brand / stock / currency warnings for products that do not exist; the failure advice said "ask the owner for a product feed" although the owner publishes one; the status said "not supported".
- **What now happens:** when none of the pages sampled from a sitemap is a product page (and no prices were found, the site is not JavaScript-built, nothing was refused by robots.txt), the capability report says so, drops the catalogue size, and — if the website's own menu links to a shop on the **same company domain** — names it (`SiteProfileData.storefront`, limitation `catalogue_elsewhere`; otherwise `not_a_shop`). The scan fails honestly with that explanation (error codes `catalogue_elsewhere` / `not_a_shop`, 0 requests), the website status reads "No products at this address", and the website page offers a button **"Add <host> as a website"**. The click is the customer's: the shop is never added, checked or collected on their behalf. Links to other companies, marketplaces or delivery apps are never suggested.
- **Nothing was collected from any competitor in this directive.** The real shop's data (1,850 products, 2,126 variants, 6,378 price observations) is the 2026-10-19 collection in "Exploration Workspace" (before the terms review). A fresh capability check of the shop (in a throwaway workspace) says: full access via the Shopify feed, terms page present but empty (`none_found`), robots.txt allows it. Whether Ling & Sons' website terms (which restrict commercial use without written consent) cover the shop is the owner's decision; asking Ling & Sons in writing is the safe path.
- **Latent test bug fixed:** `retention.test.ts` and one test in `reports.test.ts` started failing on 2026-10-24 because the test clock was pinned to 2026-10-14 while the database stamped rows with its real clock. Tests now start from the real time. No product code was involved.
- **Tests:** 914 passed in 55 files (was 885 in 53); typecheck, lint (0 errors) and build clean. New: `storefront.test.ts` (16), `catalogue-elsewhere.test.ts` e2e (12, incl. every other fixture kind unchanged), additions to `site-status`, `scan-explain`.
- **The user's working websites were not touched:** AdityaGraphics still holds 2,381 / 2,566 / 863 products (own shop / Quickmart / foodstore2go); no new scan ran there.
- **Ask the user for:** (1) whether to add `shop.lingandsons.com` (one click on the new button, then confirm its collection rules — their informed decision, see the terms note) and whether to remove `www.lingandsons.com` afterwards; (2) the earlier asks in Update 5 still stand (push of the local commits, permissions, AWS).

---

# Update 5 — directive of 2026-10-23: exhaustive functional, real-data and requirements audit (partly superseded by Update 6 above for Ling & Sons)

Verbatim directive: `docs/original-prompt/05_DIRECTIVE_EXHAUSTIVE_AUDIT_2026-10-23.md`. Evidence: `docs/verification-report.md` ("Exhaustive audit"). Requirement-by-requirement status against the ORIGINAL brief: `docs/REQUIREMENTS_MATRIX.md` Part 17. Compliance design: `docs/consent-and-compliance.md`.

**What is true now:**

- **Terms of use are read and enforced (new).** `packages/core/src/terms.ts` screens a website's terms page(s) for clauses that forbid automated access (`prohibits_automation`) or restrict copying/commercial use (`restricts_copying`); the profiler runs it right after the home page (`SiteProfileData.terms`), **stops before any catalogue probe** for a competitor whose terms forbid automation, and the consent step then needs `writtenPermission: true` + a note saying where the permission is kept (`sites.written_permission`, migration 0011; HTTP 409 `terms_prohibit`). A scan whose stored profile lacks the terms review (or whose permission flag changed) re-profiles first, so scheduled collections of already-consented websites are gated too. The customer's own website is never blocked by its own terms.
- **The five supplied websites** were used exactly as given (`www.lingandsons.com`, not `shop.lingandsons.com`). Verdicts from their public terms: Quickmart and Super Food Plaza **forbid** automated access; foodstore2go and Ling & Sons **restrict** copying / commercial use; the own shop is the owner's. **No competitor was collected in this audit.** Competitor data in the earlier workspace ("Exploration Workspace") was collected on 2026-10-19 before this check, is still stored, and was used for analysis only.
- **Fresh-account journey** (workspace "Audit Journey 2026-10-23", throwaway account that is a plus-address alias of the sender) verified in the browser end to end; own shop collected completely and reconciled in full (0 differences; 60/60 product pages).
- **Biggest data fix:** a shop's own `Size_9oz` / `Size_1kg` tags are a size source (`sizeFromTags`, `sizeHintOf`): the own shop's share of variants with a size went from 46 % to 98 %; on the held competitor data the products with an identical proposal went 207 → 605.
- **Other fixes:** unit class for dry products with drink words; model numbers, vintages, numbered sizes keep a pair out of "identical"; same product in another size is `different_pack`; baby weight ranges, leading-dot decimals, implausible tag sizes; catalogue estimate excludes non-product sitemap URLs; "We offer…" is not an offer (`isPromotionalText`); reports are **partial** when any active competitor was never collected; empty states name the uncollected websites (`apps/web/src/uncollected.tsx`); "Terms forbid collection" status.
- **CSV / Excel injection** guard was untested; `tests/e2e/export-safety.test.ts` now proves it for all 8 datasets and Excel.
- Test status: see the verification report (counts of the final run). **Nothing was pushed to GitHub in this directive** (commit `225a48c` plus the documentation commit are local); the 2026-10-19 push stands.

**Dev machine state:** the stack is stopped. The "Audit Co", "aditya" and "Exploration" workspaces have daily schedules that email through the real Gmail account and collect from their configured websites; with the terms gate, Quickmart and Super Food are blocked on their next scan, while foodstore2go and Ling & Sons (restrict-only) would still be collected for workspaces that confirmed them earlier — **keep the stack stopped unless you intend that.**

**Ask the user for:** (1) written permission from the competitors, or an informed decision for the restricted two, and whether to keep or remove the data collected on 2026-10-19; (2) whether to add `shop.lingandsons.com` (named in the original brief) and the "Cmart" address; (3) whether to push the audit commits to GitHub; (4) AWS access for deployment (see Update 4); (5) review of the proposed matches if they should reach the comparison.

---

# Update 4 — directive of 2026-10-19: real-data verification first, then GitHub and AWS (superseded by Update 5 where they differ)

Verbatim directive: `docs/original-prompt/04_DIRECTIVE_REAL_DATA_THEN_DEPLOY_2026-10-19.md`. Evidence: `docs/verification-report.md` ("Real-data audit"). Requirement status: `docs/REQUIREMENTS_MATRIX.md` Part 16 (and the updated rows D6, D13, D14). Verdict: `docs/PRODUCTION_READINESS.md`.

**What is true now:**

- **Real shops were collected and compared (2026-10-19).** The user named groceriestogoaruba.com (own shop) and four competitors. Collected completely: groceriestogoaruba.com (2,381 products, USD), shop.lingandsons.com (1,850, **AWG**), foodstore2go.com (863, USD; appears Bahamian), quickmartaruba.com (2,566, WooCommerce, USD). **Not collectable:** shop.superfoodaruba.com (Freshop/JavaScript, `ƒ` prices, robots asks 10 s crawl delay) and www.lingandsons.com (information site) → shown "unavailable", never "no match". "Cmart" was never given an address and is never guessed. Stored prices were checked against both live pages for 24 pairs; displayed differences equal an independent calculation (AWG ÷ 1.79); the report equals the comparison page.
- **No barcodes and no usable brands exist on these shops.** Shopify vendor values were "Aruba", Shopify's placeholder "Your Brand", or the shop's own name. They are cleared into `attrs.vendorLabel` at the end of every complete scan (`clearBrandLabels`, `core/brands.ts`) and ignored by matching. Every match is name + size and needs review → `POST /matches/bulk` (admin; class, min confidence, dry run, audit event) and the **Prices page defaults to confirmed matches only** with a "N proposed pairs wait" notice.
- **New matching/collection rules from real data:** zero price → empty; standing "regular price" display (`detectUniformCompareAt`) is not an offer; pack notation "12-12 oz"; pack-statement conflicts; beverage context from the shop's tags; flavour/variety words and **vintage years** (`yearsIn`) keep a pair out of "identical"; single vs multipack → `different_pack`; sitemap `product_cat-sitemap` is categories; `ƒ` price symbol; mail to reserved domains is refused (`unroutable_recipient`).
- **Production bundles were run locally** (`NODE_ENV=production`, https `APP_BASE_URL`, `SERVE_WEB=true`): 18/18 smoke checks, real browser sign-in. Static files: `/assets/*` immutable for a year, app shell `no-cache`.
- **Hosting rule:** the web app uses relative `/api/v1` calls and a same-origin `SameSite=Lax` cookie — it must be served from the same origin as the API (API with `SERVE_WEB=true`, or a proxy forwarding `/api/*`). A separately hosted frontend (e.g. GitHub Pages) will not work without a redesign. See `docs/deployment.md`.
- **Gmail:** besides the test and verification emails, the running worker's real daily schedule sent daily summaries and collection-failure digests (`email_outbox` status `sent`). Inbox arrival is unconfirmed; the App Password pasted in chat must be rotated.
- **GitHub:** repository `https://github.com/Aditya-debug43/price_intelligence` (public), branch `main`; it holds the whole monorepo including the web app source — there is **no hosting workflow** (no Pages, no deploy action). The local-only branch `full-history` (separate root; contains an older fake-token commit) must never be pushed.
- **AWS:** no AWS CLI, credentials, profile or deployment files exist on the development machine; nothing was inspected or deployed. Needed from the user: AWS access configured locally (not pasted), a description of the existing environment (service type, region, database, frontend hosting, domain), approval for any new resource or cost.

**Real-data workspace on the dev machine:** the dev database (`npm run dev:db`, port 54329) holds a throwaway verification account (a plus-address alias of the sender; password not recorded here) with an "Exploration Workspace" containing the four collected shops plus the two unavailable ones, 235 accepted identical matches (one bulk action, after a 24-pair spot check), 702 pairs awaiting review, 149 sale offers + 2 banners, and saved reports. Two other workspaces ("Audit Co", "aditya") have scheduled daily runs: **keep the stack stopped when idle** (they email through real Gmail).

**Ask the user for (in this order):** (1) AWS access (configured locally by them) and a description of the existing environment, for the deployment phases; (2) confirmation that the Gmail messages arrived, then rotation of the App Password; (3) a decision on foodstore2go.com and the missing "Cmart" address; (4) review of the 702 pending pairs if they want them in the comparison; (5) later, optional-integration credentials.

---

# Update 3 — directive of 2026-10-18: remove the demo, make Shelfwatch real (superseded by Update 4 where they differ)

Verbatim directive: `docs/original-prompt/03_DIRECTIVE_REMOVE_DEMO_2026-10-18.md`. Day-by-day record: `docs/WORK_LOG.md` (sections "Directive 3 …"). Status per
requirement: `docs/REQUIREMENTS_MATRIX.md` Part 14. Audit of what was removed: `docs/DEMO_REMOVAL_AUDIT.md`.

**What is true now (and where older text below is out of date):**

- **One product, no demo.** There is no demo/live workspace mode, no fixture/simulated data, no simulator, no developer clock, no seeded or default user. Fictional websites exist only in `tests/support`. Sections A–E below that describe `organizations.mode`, `is_fixture`, `dev:demo`, `demo:fixtures`, `bootstrap:dev`, `dev_logged` and `SCHEDULER_MODE` describe the *old* state. Migrations are `0000`–`0010` (`0008` removes demo mode, `0009` email delivery tracking, `0010` the site entry path).
- **Authentication is real.** Registration creates an *unverified* account and emails a single-use, expiring (48 h) token; sign-in needs a verified account; password reset (1 h token); no email configured ⇒ `503 email_not_configured`; generic answers (no enumeration); lockout after 8 failures; every message is an `email_outbox` row with a recorded outcome (`queued → sent | retrying | failed | not_configured`, provider Message-ID and response).
- **Email = Gmail SMTP (or any SMTP).** `SMTP_HOST/PORT/SECURE/USER/PASSWORD`, `EMAIL_FROM`, `APP_BASE_URL` (production must be a public `https://` address — enforced at start-up). `npm run email:check [-- address]`. The **App Password is typed by the user into the local `.env` only**; never in chat, Git, logs, docs or fixtures; never printed.
- **Websites.** Any public http(s) address; the page typed is kept as `sites.entry_path`; robots.txt is applied to it (and `/shop` ≡ `/shop/`). The customer's confirmation is called **collection rules** and is never presented as the competitor's approval.
- **Collection.** New `listing-crawl` connector (product cards on category/landing pages, pagination, category links; resumable `crawl_queue` kind `listing`; complete only when the frontier ran dry). The profiler reports `blocked` when robots.txt forbids the product pages or the typed page.
- **Comparison honesty.** `assortmentBasis`/`assortmentNote` (core): "no equivalent found" is worded as "nobody sells it" only when every competitor catalogue was read completely; the basis is saved in report snapshots and served by `/assortment`.
- **FX.** `FX_PROVIDER=open-er-api` verified against the real provider once (164 rates); the AWG peg remains a stated constant.
- **Live procedure.** `npm run test:live` (`tests/live`, project `live`, opt-in via `LIVE_TESTS=1`) sends real, polite, robots-obeying requests: default targets are public scraping sandboxes (books.toscrape.com, scrapeme.live, scrapingcourse.com); override with `LIVE_SOURCE_URL` / `LIVE_COMPETITOR_URLS` for the user's own authorised sites. Writes a JSON record to `.data/live-runs/` (git-ignored).

**Verification state (2026-10-19):** `npx vitest run` → **760 passed, 0 failed, 44 files**; typecheck clean; lint 0 errors (2 intentional `any` warnings). Live run 2026-10-18/19: books.toscrape.com collected via listing pages (40-product sample, 40/40 stored values found in the raw pages, 0 mismatches), scrapeme.live via the WooCommerce Store API (40), scrapingcourse.com blocked by robots.txt (0 pages read); real FX fetch OK.

**Gmail (2026-10-19):** the owner supplied the sender address and an App Password (pasted in chat; stored only in the local `.env`; never written to repo/docs/logs; they should revoke and rotate it). `npm run email:check` signed in, Gmail accepted a test message, and a registration through the running app produced a verification email Gmail accepted (outbox `sent` + Message-ID). A throwaway unverified account for a plus-address alias exists in the dev database. **Open:** the owner confirming the messages arrived; reset email through Gmail not yet sent.

**(Superseded by Update 4 — the user named real websites on 2026-10-19 and they were collected.) Still not done / blocked at the time of Update 3:** inbox arrival of the Gmail messages; a website the user authorised; Shopify/YouTube/Meta/Anthropic/S3 live; Docker never built; restore drill not run; no load test; the Cmart URL was never supplied and is never guessed.

**Status vocabulary** (used in `docs/integrations.md`, `docs/limitations.md`, the matrix): Implemented, not tested · Tested with automated mocks · Tested using isolated test fixtures · Tested against a real local service · Tested against a real external service · Verified end to end with real website data · Blocked pending credentials or permission.

**Commands now:** `npm run dev:db`, `npm run dev`, `npm run email:check`, `npm run live:probe -- <urls>`, `npm run test:live`, `npm run db:setup|migrate|generate`, `npm run db:purge-demo` (one-off upgrade tool), `npm test`, `npm run lint|typecheck|build`. Removed: `dev:demo`, `demo:fixtures`, `demo:setup`, `fixtures:serve`, `bootstrap:dev`.

---

# Update log — what changed after this file was first written (Phases 1–6, 2026-10-15)

Phase 0 (this file + the work log) and Phase 1 (audit + `docs/REQUIREMENTS_MATRIX.md`) changed no application code. Everything below is committed, tested and logged in `docs/WORK_LOG.md`.

| Phase | What now exists | Commits |
| --- | --- | --- |
| 2 | **Live vs demo workspaces**, enforced in the database (`organizations.mode` immutable; fixture sites only in demo), service layer, API and UI; **provenance** on every observation/evidence/offer/marketing row; one **honest site status** (not set up → … → collected/stale); guided **journey** card; honest **409** answers instead of silent no-ops; a report with nothing collected says so. | `a4864f5` |
| 3 | **Collection observability**: plain-language run explanations, failed/skipped URLs and reasons in the Websites page; SSRF re-audit (66 regression cases) and a **real defect fixed: page WebSockets bypassed request screening** in the headless browser. | `af0a872` |
| 4 | **Match review**: side-by-side evidence, search-and-choose an alternative product, a person's decision is stored as accepted/`manual` and survives every matching run. | `af0a872` |
| 5 | **Alert lifecycle** (open → acknowledged → resolved; automatic resolution with the resolving observation as evidence; manual resolution with a note; evidence/source links; stock-conflict display); **offer/flyer review** (confirm / correct — original reading kept / dismiss — survives re-collection); **marketing providers** (engagement counts, Meta token health, classified failures, persisted quota/rate-limit backoff with credential-change reset, evidence-based summaries — against local imitations only). | `71afa34`, `e1d09c0` |
| 6 | **Capped scan recovery** (no endless resumes, no website stuck "collecting"); **retention** now covers everything that grew forever and survives a failing storage backend; **email-verification honesty**; **`GET /api/v1/ready`**; **member invitations**; demo workspaces not scheduled without fixtures; **graceful shutdown** (in-flight collections handed back); integration reference table; backup/restore/health docs; marketing summary inside report snapshots, PDF, Excel, CSV. | `4b75d5d`, `334f24f`, `1e444ef` |
| 7 | **Live-workspace journey test** through the real HTTP API (28 tests; public hostnames, local imitations); **real-browser pass**: structural audit (18 views × 2 widths), colour contrast (0 failures after fixes), keyboard, long names — fixed: page titles, header-less tables, dialog focus, contrast, overflow; docs rewritten to match (verification report, limitations, README live-mode walkthrough). | `4b91223`, `fdfbe98`, `803a1c1` |
| 8 | **“What you can do” advice for every site limitation** (never a workaround; test-enforced); **connection colours reflect sync health** (`connectionSyncHealth`: Shopify pill and stock banner green only when the last sync succeeded and is < 36 h old); button audit; **`docs/PRODUCTION_READINESS.md`** (verdict, evidence strength per area, what only you can provide, prioritised remaining work, the precise next step). | `aa30324` + docs |

**Current state (verified):** `npx vitest run` → **695 passed / 0 failed, 40 files** (full run on commit `aa30324`); lint 0 errors (2 intentional warnings); typecheck clean; migrations `0000`–`0007`; 35 tables. **Still never done:** any real-site catalogue collection, any call to a real external provider (Shopify, Meta, YouTube, SMTP, S3, Anthropic, FX), a Docker build, a real restore drill, a real SIGTERM test. Phase 7 is done **except the one authorised real-world collection, which is blocked on the user's per-site permission**; Phase 8 (the production-readiness assessment) is the final deliverable in `docs/WORK_LOG.md` and the closing message.

**Corrections to earlier statements in this file:** (a) "stale-scan recovery has no direct test" was imprecise — a scheduler-level test checked re-queueing, but recovery was uncapped and an orphaned `queued` scan blocked its website forever (fixed, §D.11); (b) retention did not cover marketing, offers, flyers, daily runs or old profiles, and one failing file delete aborted it for every workspace (fixed, §D.12); (c) a password reset marked the address verified even when the "email" only sat in the development outbox (fixed, §D.1).

---

# A. Project origin and complete requirements

## A.1 What Shelfwatch is

Shelfwatch is a **standalone, multi-tenant competitor-intelligence web application** for business owners. A customer gives it
**one URL for their own ("source") website and three to five competitor URLs**. The system inspects each site, discovers and
collects the accessible product catalogue, normalises products/prices/currencies/variants, matches equivalent products across sites,
compares prices, finds offers/promotions/flyers, watches the customer's **own** stock, observes competitor marketing activity
(on-site banners plus official social APIs), keeps history, and produces timestamped, evidence-backed reports (dashboard, PDF, CSV,
Excel, email) on a schedule — the first daily report due by **09:00 `America/Aruba`**.

It must be a **reusable product, not a website-specific scraper**: arbitrary URLs submitted at run time, collection strategy chosen
per site, honest limitation messages when a site cannot be collected.

The two authoritative source texts are stored verbatim in the repository:

| File | What it is | Sent |
| --- | --- | --- |
| `docs/original-prompt/01_ORIGINAL_PROMPT.md` | The original 1,250-line specification ("Build a Complete Competitor Intelligence Platform") | 2026-10-13 18:02 UTC |
| `docs/original-prompt/02_DIRECTIVE_REAL_PRODUCT_2026-10-15.md` | The follow-up directive ("Context preservation and real-product implementation") with Phases 0–8 and acceptance criteria | 2026-10-15 07:38 UTC |

Other user messages (all short): "can u please continue, i shutted down pc last time" (2026-10-14), "please continue!" (2026-10-14),
"can u please continue, if something left" (2026-10-15). There were no other clarifications; all decisions below that are not in the
two prompts were made by the assistant and documented.

## A.2 Intended users and use cases

Business owners (initial demo: a grocery business, Groceries To Go Aruba) who want to know: who is cheaper on equivalent products,
what competitors promote, what is running low in their own shop, what changed since yesterday, and what competitors do on social
media. Billing, paid tiers and **price recommendations are out of scope** for the MVP.

## A.3 Requirements digest (from the original prompt)

Section numbers refer to the original prompt.

**Business flow (§2).** Create account → create workspace → enter own URL → add 3–5 competitor URLs → system profiles each site and
says what can be collected under access rules → discovers products, collects data → normalises products/prices/currencies/variants →
matches identical/comparable products → analyses prices, offers, availability, stock risk, promotions, assortment → generates insights →
saves a timestamped report → monitors regularly → sends alerts and a concise summary. **Never pretend every site exposes everything;
show limitations and reasons.** "Universal support" means *arbitrary URLs and an appropriate strategy per site*, not guaranteed
completeness.

**Specification decisions (§3).**
- One source site; **3–5 competitors** (max five); the *entire discoverable catalogue*; not restricted to groceries, a platform, region or fixed list; strategy chosen dynamically.
- Initial demo source: `https://groceriestogoaruba.com/`. Candidate competitors (availability/permission to be verified): `https://shop.lingandsons.com/`, `https://shop.superfoodaruba.com/`, `https://doit.aw/`. **No Cmart URL has been established — never invent one.** Choices must stay editable in the UI; nothing hard-coded.
- Reporting currency configurable; **detect each site's currency**; show original and normalised price; AWG/USD context for Aruba; fixed-rate assumptions must be explicit and timestamped.
- **Low stock (§3.3, §9):** own site only; competitor stock never triggers alerts. Public mode = availability only (never an invented quantity); connected-inventory mode = owner-authorised, read-only quantities. Default threshold **5**, configurable (global and per product); alert when quantity crosses from above to ≤ threshold; **no repeat alerts for an unchanged state**; low-stock, out-of-stock, restocked and collection-failure alerts; no "days until stock-out" estimates without authorised sales data.
- **Daily report (§3.4, §12):** ready by 09:00 `America/Aruba` (IANA zone, not a fixed offset); start time from measured durations + safety margins; rolling refresh for big catalogues; clearly labelled **partial** report at the deadline; never label stale data fresh; local dev scheduler mode.
- **Reports (§3.5):** interactive dashboard, PDF, CSV, Excel, concise daily email summary, in-app notifications, email alerts; history and structured observations ≈ **1 year**; raw snapshots **90 days** (configurable); retention job that does not break retained reports/evidence.
- **Multi-tenant (§3.6, §13):** isolated settings, websites, reports, alerts, private inventory connections; verify isolation at application **and** database level; never a hard-coded production admin password; safe local bootstrap.
- **Social (§3.7, §10):** Facebook, Instagram, YouTube via **official APIs** only; implement integration structure and clear status messages; never fabricate connections or API responses; also detect on-site banners/sale pages/announcements; "observed promotional post ≠ proof of a paid campaign"; map handles to sites from official links/structured data and let the customer confirm.
- **Permission (§3.9, §18):** explicit permission to collect/store the source business's information, demonstrate live competitor findings, or access private inventory has **not been confirmed** — record consent status and obtain permission before the corresponding live collection; do not bypass anti-bot, CAPTCHAs, logins, robots rules, rate limits; no proxies/identity rotation; no competitor accounts; no cart manipulation.
- **Demo (§3.11, §23):** timestamped data, saved reports, a *small live refresh* (not a full recrawl); fixture mode demonstrating blocked/partial/successful/failed outcomes; do not claim unavailable data was collected.

**Research (§4).** Verify official docs/limits for Shopify, WooCommerce Store API, sitemaps/feeds, JSON-LD, browser automation, PDF extraction, matching, currency, social APIs, email, jobs, PostgreSQL multi-tenancy, SSRF-safe collection. Avoid paid services without approval.

**Site profiler (§5).** On every URL: canonical host/identity, reachability, platform fingerprint, robots + crawl-delay, sitemaps, product/collection URLs, structured-data coverage, public catalogue APIs, prices/currency, variants/identifiers, availability, promotions/flyer links, JS-rendering need, login gates/barriers, missing fields/conflicts, estimated catalogue size/effort, request budgets. Persist results with timestamps. Statuses **Full / Partial / Limited / Blocked / Failed**; a failed collection is never an empty catalogue. Connectors (priority order): public APIs → sitemaps/feeds → JSON-LD/microdata → server HTML → validated site rules → headless browser → evidence-validated LLM fallback → PDF/image flyers → transparent "unavailable". Record extraction method, version and quality.

**Catalogue (§6).** Fields: title, brand, manufacturer/model, SKU/GTIN/UPC/EAN, description, category, variant ids, weight/volume/size/colour/pack count, price, compare-at price, currency, shipping (nullable), availability, URL, image URL, first/last seen, method + evidence. `null` for unavailable. Pagination, resumable jobs, de-duplication, **append-only timestamped observations**, per-product freshness, collection independent of the frontend.

**Matching & price comparison (§7).** Four classes: identical; same product different pack/variant; comparable other-brand; not comparable. Progressive pipeline: identifiers → brand/model → variant → pack size → category → normalised name → similarity → optional AI adjudication → human review. Confidence + reason. Original + normalised currency, FX rate + timestamp, unit prices, nullable shipping, conditional prices/offers. UI: one row per source product, competitors as columns; difference abs/%, class/confidence, availability, promotions, last-observed, evidence link; filter/sort by category, competitor, price difference, confidence, freshness; store/category statistics only with sufficient reliable data.

**Offers (§8).** Sale/compare-at prices, banners, coupon codes, minimum-order, bundles, buy-X-get-Y, bank/payment offers, cashback, free-shipping thresholds, time-limited discounts, weekly flyers/PDFs. Explicit conditions (unconditional vs conditional/deferred); source URL, products, prices, currency, first/last seen, stated validity, verification status. **Never trust the displayed reference price**; separate historical-discount measure when history exists, else "unverified"; defensible expiry policy; flyer pipeline for text-layer PDFs first (OCR/vision later, with confidence + human review).

**Marketing (§10).** Provider layer for Facebook/Instagram/YouTube with honest status; site-level banners/announcement bars/sale pages/landing pages/launches/seasonal offers; store URL, observed timestamp, platform, permitted text evidence, classification, confidence, product/competitor association; no unnecessary personal data from commenters.

**Insights (§11).** Deterministic analysis: above/below competitor price, large gaps, new products, launches/delistings, assortment gaps both ways, new offers, historical price movements, own low-stock, competitor availability changes, marketing activity, basket comparison. **Transparent ranking; every insight carries its supporting records;** LLMs may only explain already-computed results; numbers must originate from validated records; must work with no AI provider.

**Scheduling & reports (§12).** Daily + manual refresh, progress, resumable jobs, per-site/product status, adaptive budgets, rolling refresh (prioritise matched products, promotions, recent changes, alerts), **immutable report snapshots**, history, retention, alerts, PDF/CSV/Excel, email; no synchronous recrawl on dashboard visits.

**Auth & tenancy (§13).** Registration/login, hashing, sessions, logout, email verification & password reset (when an email provider is configured), organisations, owner/staff roles, workspace-scoped data, private inventory connections, RLS or equivalent verified at both levels.

**Frontend (§14).** React + TypeScript + Vite; pages A–L: login/registration/recovery; business setup (own site, 3–5 competitors, currency, timezone, schedule, threshold, alert prefs; all editable); website profiling; dashboard (real backend data); price comparison; offers; my stock (quantities only from authorised sources); marketing; product details; historical reports (compare dates, exports); data quality & coverage; settings (workspaces, users, schedules, notifications, thresholds, email, integrations). Loading/empty/error/partial states; every important control has a working backend action.

**Stack (§15).** TypeScript monorepo (apps/web, api, worker; packages core, database, connectors, shared); Fastify + Zod; PostgreSQL + Drizzle + migrations; pg-boss queue; Playwright only where needed and in the worker; local storage + configurable object storage; optional provider-independent AI; complete `.env.example` + startup validation; no secrets in frontend.

**Data model (§16), API (§17).** Identity, website config (sites, roles, capability profiles, access policies/budgets), discovery (products, variants, attributes, identifiers, matches, jobs), evidence/observations (price, stock, offers, snapshots, method/version, quality issues), intelligence (matches, insights, marketing, alert rules/alerts), reporting (snapshots, status, exports, schedule), private connections (encrypted tokens, inventory/location data, revocation). Authenticated, versioned, validated, paginated APIs with tenant enforcement on every relevant endpoint.

**Security (§18).** SSRF (localhost/private/link-local/metadata, redirect + DNS revalidation, protocol checks), timeouts, size/content-type limits, per-domain rate/concurrency caps, backoff, **stop-on-denial**, input validation, authn/authz, secure hashing, secret redaction, encrypted credentials, tenant isolation, safe uploads, backup guidance; **LLM security:** collected content is untrusted data; no tools/secrets for extraction models; validate outputs against evidence.

**Data-reliability invariants (§19)** — 14 rules, each needs automated tests: (1) unknown stock never "in stock"; (2) unknown shipping ≠ 0; (3) missing price ≠ 0; (4) blocked/failed ≠ empty catalogue; (5) stale ≠ fresh; (6) similarity ≠ identity; (7) apparent discounts not auto-verified; (8) social post ≠ paid campaign; (9) AI numbers validated against evidence; (10) partial coverage disclosed; (11) observations keep source URL + time; (12) alert transitions deduplicated; (13) report snapshot consistent across dashboard/exports; (14) no cross-customer access. Mapped to tests in `docs/data-reliability.md`.

**Phases (§20), acceptance (§21), tests (§22), demo (§23), operating rules (§24).** Eight phases (foundation → collection → matching/pricing → stock/offers → reporting → marketing → extra intelligence → hardening). Acceptance covers website management, real data collection with provenance (fixtures labelled as fixtures), comparison with evidence, offers, stock alerts, reports/exports, scheduling, marketing honesty, security, dev quality, documentation. Test strategy: unit, connector, security, integration, an end-to-end journey (register → workspace → sites → profile → collect → match → compare → offers/stock → report → reopen → export → notifications/scheduling → tenant isolation); ordinary tests must not depend on live sites — use fixtures and a separate live procedure; **report which live tests were actually run**. Operating rules: no hard-coded credentials, no pretending services are connected, no paid costs or external deployment without authorisation; distinguish *implemented & locally verified / implemented not fully verified / waiting for credentials / not implemented*.

## A.4 Follow-up directive of 2026-10-15 (digest)

Full text: `docs/original-prompt/02_DIRECTIVE_REAL_PRODUCT_2026-10-15.md`. Summary of its demands:

1. **Part 1 — preserve context:** reread everything, create `docs/PROJECT_CONTEXT.md` (this file) and `docs/WORK_LOG.md` *before* changing application code; separate repository-verified facts from transcript-only claims; no secrets in either file; keep both current and update before stopping for any usage limit.
2. **Part 2 — requirements checklist & core journey:** register/sign in → organisation → own site + 3–5 competitors → profile → collect → process catalogue → review matches → compare → offers/stock alerts → report → export → schedule. Every visible control must do its advertised action; verify persisted data and visible results, not just HTTP 200 or a fixture happy path. Keep the existing Shelfwatch UI where good.
3. **Part 3 — remove fictional data from the real product:** explicit **demo vs live** separation; live workspaces start empty or show real setup status; never fabricate competitors/prices/stock/offers/campaigns; provenance on all data (real observation, authorised API, user action, FX service, labelled fixture); honest statuses (not configured / not yet collected / in progress / partial / access denied / unsupported / awaiting review / stale / collected); "no match found" ≠ "competitor could not be collected"; audit the whole project for hard-coded demo URLs, seeded demo data, fake history, random values, mocks leaking into live mode, placeholder integrations shown as connected, static reports, fallbacks that hide failures.
4. **Part 4 — real collection:** layered strategy (platform id → supported connector → permitted public-page discovery); extensible adapters; whole accessible catalogue with pagination/variants/sitemap indexes/dedup/resumable jobs/budgets/progress; record discovered/collected/failed/skipped, coverage, last success, duration, per-site failures, complete vs partial and why; respect robots/terms; no bypassing; no private checkout/account probing; suggest authorised alternatives (merchant feed/platform integration); **re-audit the SSRF-safe fetcher and browser rendering** (every redirect, DNS changes, IPv4/IPv6 edge cases, subordinate browser requests) and add regression tests; website detail page must show strategy, support, progress, failures, latest observation, why a field failed, source evidence.
5. **Part 5 — matching & comparison:** reliable normalisation (name, brand, GTIN, manufacturer/model, size/quantity/units, multipacks, variants, category, currency, list/selling/unit price, availability, URL, timestamp); 1 L ≠ 2 L, multipack ≠ single; strongest identifiers first; confidence + evidence; **match-review UI** (accept/reject/search-and-choose alternative/side-by-side evidence/why proposed/correct mistakes); do not force uncertain matches into the matrix; real comparisons (our price, competitor, abs/% diff, cheapest, position, unit price, availability, confidence, last observed, evidence links); regular vs sale prices; currency detection + user correction; real attributable FX source with provenance — **ask the user for a key if a provider requires one**.
6. **Part 6 — own inventory:** public availability, authorised inventory (e.g. Shopify OAuth), exact quantity only from an authorised source, threshold default 5, out-of-stock/restock transitions, no duplicate alerts, alert status/evidence/timestamps/acknowledgement/**resolution**, conflict display between page availability and inventory, stock warnings in reports; never ask for a competitor's inventory access.
7. **Part 7 — offers/flyers:** regular/sale/absolute/percentage discount, descriptions, dates, conditions, affected product/category, multipack/bundle offers, flyer PDFs, source/evidence/time; changes between observations (new/expired); don't treat a low ordinary price as a sale; don't mistake `1.75L` for a price; displayed offer vs confirmed promotion; flyer review where uncertain.
8. **Part 8 — marketing:** Facebook, Instagram, YouTube with proper providers: account association, platform, URL, published time, caption, engagement metrics where permitted, product/promotion references, observation time, provider/source, limitations; summaries of themes/timing when evidence supports; **organic public activity ≠ paid campaign** (paid only with an authorised source that proves it); provider status, auth, token expiry/refresh, revoked permissions, quotas, backoff, errors; **ask the user for exact credentials/approvals when needed**; never display simulated campaigns as real.
9. **Part 9 — reports/schedule/notifications:** 09:00 `America/Aruba`; restart-safe scheduler; queue-based; retry/recovery; clear cutoff; partial reports; freshness; persistent history; duplicate-job prevention; late-start/missed-deadline reporting; report contents (price comparison, cheapest, differences/changes, availability, own stock warnings, offers, marketing, coverage/quality, product changes, exceptions, evidence + timestamps); PDF/CSV/Excel from the same snapshot, **test file contents**, CSV formula-injection safe; history viewing + comparison; dashboard alerts; real email when a provider is configured (outbox never shown as delivered); retention ≈1 year history / 90-day snapshots, implemented and tested.
10. **Part 10 — auth/tenancy:** audit registration/login/hashing/sessions/expiry/logout/reset/verification (do not silently treat unverified accounts as verified)/roles/org membership/invitations/tenant-scoped DB/RLS/cross-tenant protection/secure cookies/CSRF/validation/rate limits/safe errors/secrets; test at API **and** DB layers; development owner account must never be a default identity for real customers; onboarding for a genuine new customer to the first report.
11. **Part 11 — integrations & credentials:** follow the credential workflow (state provider, why, exact env var names, where to obtain, minimum permissions, where to configure (`.env`), ask for it when ready for live verification, continue unblocked work); a provider reference document; don't block public-web collection on optional integrations; deterministic functionality must work without an LLM key.
12. **Part 12 — UI:** guided setup (org → own site → 3–5 competitors → review capabilities → confirm permissions → start collection → progress → match review → comparisons/evidence → alerts/reports config); per-site capability/completeness/errors/freshness in one place; keep visual identity; verify desktop + mobile, tables, filters, charts, empty/loading/error states, long names, price formatting, accessibility, keyboard; no misleading green "connected/success".
13. **Part 13 — production hardening:** config validation, safe startup/shutdown, migrations/indexes, pooling, separate API/worker, job recovery, redacted structured logs, health **and readiness**, secrets, backups/recovery guidance, retention jobs, timeouts/limits, production builds, deployment instructions, secure callbacks, monitoring; keep PostgreSQL + RLS; test Docker if available else say so; no public deployment/purchases/paid APIs without approval.
14. **Parts 14–16 — process, acceptance, working rules:** Phases 0–8 (context → baseline audit → live onboarding/workspace → real collection → real price intelligence → offers/stock/marketing → reports/notifications → full-system verification → production-readiness assessment); acceptance criteria (core product, external services, engineering quality); never fake live results; no fake production users or fake observations; keep mocks confined to tests/demo; proceed autonomously, ask only for credentials/permissions/decisions; maintain context + work log; do not delete data/.env/user changes without understanding and approval; do not stop after docs; final deliverable list (summary, paths, working features, live-mode commands, how to create an account and configure the source + 3–5 competitors, every external prerequisite, tests/builds/real-world steps with results, limitations, remaining work, the precise next step).

## A.5 Core vs optional

*Core (MVP):* auth/orgs/tenant isolation; URL validation + SSRF-safe collection; profiler + capability report; connectors; persistence with provenance; matching + review; price comparison; offers; own-site stock + alerts; scheduler + immutable reports + exports; dashboard and the pages A–L; retention; documentation; the 14 invariants.
*Optional / integration-dependent:* connected inventory (Shopify OAuth), Facebook/Instagram/YouTube APIs, real email delivery, AI summaries/adjudication/extraction fallback, S3 storage, headless rendering, market FX rates.
*Explicitly out of scope:* billing, price recommendations, estimating days until stock-out.

## A.6 Ambiguous, unavailable or unresolved requirements

- **Live-collection permission is unconfirmed** for the source business and every candidate competitor (the original prompt says so; the 2026-10-15 directive asks for "authorised real-world" verification "where access permits" but does not itself record consent). → Ask the user to confirm, per site, before any live catalogue collection.
- **Fourth competitor (Cmart)**: no URL provided; must not be guessed.
- **Demo date**: never specified.
- **Email provider, Shopify app, Meta app, YouTube key, Anthropic key, FX provider key, S3 bucket**: none supplied. See §F.
- **FX source for non-peg currencies**: the code supports `open.er-api.com` (free, attribution) but it has never been called live; directive wants an attributable real source and the exact credential workflow if a key is needed (open.er-api.com's free endpoint needs none).
- "Learn from reviewed matches" (Part 5.2) is not specified further; implemented behaviour today is "manual decisions are preserved on re-match" (not a learning model).
- Alert "resolution" semantics (Part 6) are not defined beyond acknowledgement/restock transitions.

---

# B. Chronological implementation history

**Evidence legend:** `[commit]` = present in Git; `[test]` = covered by a currently passing automated test; `[doc]` = recorded in repo docs; `[transcript]` = only in the conversation history (not independently verifiable now).

## B.0 Environment (inspected at the start and re-checked 2026-10-15)

Windows 11 Home; Git Bash + PowerShell; Node v24.19.0 (project requires ≥ 22), npm 11.17; Git 2.55; Chrome and Edge installed; **no Docker, no Python**. Working directory `D:\competitive analysis\competitor-intelligence`. PostgreSQL is supplied by the `embedded-postgres` npm package (PostgreSQL 18.x); no system install.

## B.1 2026-10-13 — foundation

| Time/commit | Work |
| --- | --- |
| 18:02 UTC | Original prompt received. Repository initialised in its own directory. [transcript] |
| `3107816` | **Scaffold + core domain.** npm-workspaces monorepo; TypeScript strict ESM; ESLint/Prettier; Vitest `unit`/`integration` projects; `packages/shared` (enums, zod schemas, report/profile types, formatters); `packages/core` pure logic with unit tests: URL normalisation, IP/SSRF rules, robots.txt (RFC 9309), price/GTIN/quantity/text parsing, currency (FxTable, USD pivot, AWG peg), stock state machine, offer verification/expiry, schedule planning, crypto (scrypt, AES-256-GCM key ring, Shopify HMAC), redaction, config validation, matching, LLM guards, storage adapters, insight scoring. |
| `5e7061f` | **Database.** Drizzle schema (34 tables), SQL migration `0000_init`, post-migration step enabling and **forcing** RLS on every `org_id` table (3 documented exemptions), append-only triggers on `price_observations`/`stock_observations`, immutability trigger on published reports, roles `ci_app`/`ci_worker`; embedded-PostgreSQL test harness. |

## B.2 2026-10-14 — collection, services, API, UI

| Commit | Work |
| --- | --- |
| `1ab78f3` | **Connectors.** SSRF-safe fetcher (undici; connect-time DNS screening of every address, manual redirect re-validation, ports 80/443, robots cache, size/content-type caps, per-host limiter, stop-on-denial); site profiler; Shopify `products.json`, WooCommerce Store API, sitemap + structured-data, generic-HTML, browser, LLM-fallback connectors; flyer PDF extraction; social/inventory adapters; ten fictional **fixture sites** + control server. |
| `e6b4c05` | **Services.** auth, sites/consent, profiling, resumable scan runner, ingest, stock + alerts, matching, comparison, coverage, reports, exports, scheduler, retention, integrations, pg-boss queue wiring. |
| `2884e4c` | E2E pipeline tests; fixed "empty result reported as success", connector selection, promo-condition parsing, flyer de-duplication. |
| `ada51b9` | E2E stock/alerts, reports/exports/retention, scheduler; fixed PDF layout/glyph issues, refresh completeness, coverage warnings. |
| `12f777d` | **API + worker.** Fastify app (HttpOnly session cookie, CSRF header + Origin check, rate limits, security headers, tenant-bound transactions, membership check → 404); worker entrypoint; API e2e tests (39). |
| `c21fb6e` | **Scripts + live probe.** Dev launcher, embedded-DB tool, fixtures server, demo workspace scripts, live capability probe. **Live probing found real defects**, fixed here: NAT64 (`64:ff9b::/96`) addresses were all rejected (now judged by the embedded IPv4); a Freshop `.xml.gz` that was not gzip; utility pages (e.g. `/sitemap.html`) sampled as products; Next.js SPA (doit.aw) not detected as JS-rendered. |
| `c21ad94` | Lint pass. |
| `933bac4`, `a8edcca`, `4c7f864` | **Web UI** (React 19 + Vite): auth, dashboard, setup, websites + site detail, price comparison, offers, stock, marketing, products + detail, match review, alerts, data quality, reports (+compare), settings; design system "Shelfwatch" (lagoon `#10252B`, teal `#0E6E73`, salt `#F4F7F6`, tag-yellow `#FFD43B`; Bricolage Grotesque / IBM Plex Sans / Barlow Condensed, self-hosted); persistent data-honesty bar; **PriceTag** component; mobile menu and overflow fixes; Dockerfile, compose file, tsup build configs, docs. Found/fixed during browser verification: flyer size read as price ("1.75L"), "no match found" shown for blocked/failed competitors, silent inventory-vs-page disagreement (now flagged), delisted products counted, layout overflow at phone width. |
| `a75dc03` | Final report for the 2026-10-14 pass. |

Bugs found by development/testing on 2026-10-14 (all fixed; most have regression tests) [transcript + commits]: embedded-Postgres `initdb` locale; Drizzle error wrapping in assertions; fixture host collisions (identity is `host:port`); sitemap classification ("sitemap" contains "item"); price-range note for `AggregateOffer`; sibling text concatenation ("3.39Only"); flyer name hyphen loss and year-spanning validity ranges; scan "succeeded" with 0 products on an HTML site; promo condition "Afl. 150"; PDF text clipping/"→" glyph/`out_of_stock` underscores; coverage warnings from fixture notices; AI-summary validator rejecting product-name numbers; rolling refresh mislabelled partial; leaked DNS timeout timer; CSP header overwritten by global header; `listMatches` alias bug; per-IP rate limiter starving later tests.

## B.3 2026-10-15 — extra verification

| Commit | Work |
| --- | --- |
| `d17d545` | **Headless rendering verified with real Chrome** against local JS-only pages (5 tests); `render()` now refuses forbidden targets instead of throwing; `BROWSER_CHANNEL` / `BROWSER_EXECUTABLE_PATH`; probe script writes one file per run. |
| `fad66a1` | S3 driver tests against an S3-compatible fake; fixed `exists()` treating permission/network errors as "missing". |
| `cc88229` | SMTP delivery tests against an in-process SMTP server; email/PDF/Excel restyled to Shelfwatch branding. |
| `c28f8d3` | Shopify connect-flow test (signed callback, token exchange, sync, refresh, refused refresh, disconnect) against a local imitation of Shopify; Anthropic + FX client tests; fixed "refused refresh leaves connection `connected`". |
| 07:38 UTC | The follow-up directive arrived (Phase 0 onward). |

## B.4 What the historical claims are worth

The 2026-10-14/15 reports said "393 tests pass" — **re-verified at baseline on 2026-10-15 (see §G)**. Claims about live collection are *limited*: only a read-only capability probe of four real sites was ever run (2026-10-14); **no real catalogue has ever been collected and stored**. Everything the dashboards have shown so far came from local fictional fixtures.

---

# C. Actual repository structure

Root: `D:\competitive analysis\competitor-intelligence` (own Git repository; 17 commits and 195 tracked files at creation of this file — counts in this section are from then; see the Update log for what was added). Untracked at creation: `competitor-intelligence.zip`, `competitor-intelligence1.zip` (user-created archives of the project — not touched), and the new `docs/original-prompt/`. `.env` and `.data/` are git-ignored.

```
apps/
  web/        React 19 + Vite 8 UI                     (25 tracked files, ≈3.6k LOC)
  api/        Fastify 5 HTTP API                       (13 files, ≈1.0k LOC) + tsup build
  worker/     pg-boss worker entrypoint                (4 files, ≈50 LOC) + tsup build
packages/
  shared/     enums, zod request schemas, report/profile types, formatters  (≈0.8k LOC)
  core/       pure domain logic + its unit tests                              (≈3.8k LOC)
  database/   Drizzle schema, migrations, RLS/trigger post-migration, client   (≈1.7k LOC)
  connectors/ SSRF-safe fetcher, profiler, connectors, extractors, flyer, social, inventory, providers, fixtures (≈5.5k LOC)
  services/   application services joining the above                          (≈4.5k LOC)
scripts/      dev launcher, embedded DB tool, db setup/migrate, fixtures server, demo + live-probe scripts, tsup base
tests/        integration/ (database, queue), e2e/ (api, pipeline, stock-alerts, reports, scheduler, shopify-oauth, email-smtp — and since: workspace-modes, honest-controls, collection-observability, match-review, alert-lifecycle, offer-review, social-providers, scan-recovery, retention, email-verification, readiness, invitations), support/ (harness, db, global-setup, api-client). Integration files run sequentially against ONE shared database; the scheduler and retention are global, so tests scope their runs and `harness.close()` switches off the schedules of the workspaces it made
docs/         architecture, data-reliability, consent-and-compliance, integrations, deployment, demo-runbook, limitations, verification-report,
              live-probe-2026-10-14.json, original-prompt/ (verbatim prompts), PROJECT_CONTEXT.md, WORK_LOG.md
fixtures/     EMPTY directory (the fixture sites live in packages/connectors/src/fixtures/)
Dockerfile, docker-compose.yml, deploy.env.example, .dockerignore   (never built or run — Docker unavailable)
.env.example  complete configuration reference;   vitest.config.ts, eslint.config.js, tsconfig*.json, .prettierrc.json
```

## C.1 Package responsibilities and important files

**`packages/shared`** — `constants.ts` (enums: capability statuses, match classes, offer kinds/statuses/verification, stock states, alert types, platforms, DEFAULTS incl. `staleAfterHours: 36`), `schemas.ts` (zod request schemas), `profile-types.ts` (`SiteProfileData`), `report-types.ts` (`ReportData` and rows), `format.ts`.

**`packages/core`** (pure, no I/O) — `url.ts`, `ip.ts` (SSRF address rules; NAT64/6to4 judged by embedded IPv4), `robots.ts`, `price.ts`, `gtin.ts`, `quantity.ts` (sizes, units, unit price), `text.ts`, `currency.ts` (FxTable with USD pivot, explicit AWG peg 1.79, never assumes a rate), `stock.ts` (state machine + dedupe keys), `offers.ts` (`verifyDiscount`, expiry policy, promo classification), `schedule.ts` (`planStartTime`, `decideDailyAction`, request budgets), `crypto.ts`, `redact.ts`, `config.ts` (env schema + production safety checks), `matching.ts`, `llm.ts` (untrusted-content wrapper, number validation), `storage.ts`, `insights.ts`. Tests: `domain.test.ts`, `parsing.test.ts`, `url-ip-robots.test.ts`.

**`packages/database`** — `schema.ts` (35 tables after migration 0007), `client.ts` (`createPool`, `createDb`, `withTenant` using `set_config('app.org_id', …, true)` in a transaction), `post-migrate.ts` (RLS/policies/triggers/grants, `RLS_EXEMPT_TABLES`), `migrate.ts` (`runMigrations`, `setupRoles`), `migrations/0000_init.sql`, `0001_currency_source.sql`.

**`packages/connectors`** — `safe-fetch.ts` (SafeFetcher + DomainLimiter + robots cache), `profiler.ts` (capability reports), `registry.ts` (connector ranking), `shopify.ts`, `woocommerce.ts`, `page-crawl.ts` (sitemap+structured, generic HTML, browser, LLM-fallback connectors), `extract.ts` (JSON-LD → microdata → OpenGraph → heuristics), `sitemap.ts`, `challenge.ts` (bot-challenge/login-wall detection), `flyer.ts` (text-layer PDF extraction via `unpdf`), `social.ts` (YouTube/Instagram/Facebook clients), `inventory.ts` (Shopify OAuth + GraphQL, dev simulator), `providers.ts` (Anthropic client, FX client, PlaywrightRenderer), `types.ts`, `test-utils.ts`, `fixtures/catalogue.ts` + `fixtures/server.ts` (ten fictional sites).

**New since creation (by package).** *shared:* `ORG_MODES`, `PROVENANCE`, `SITE_STATES`, `RESOLVABLE_ALERT_TYPES`, `OFFER_REVIEW_STATUSES`, marketing-summary types, `manualMatchSchema`, `offerReviewSchema`, `inviteSchema`. *core:* `site-status.ts`, `scan-explain.ts`, `social-backoff.ts`, `marketing-summary.ts`. *database:* migrations `0002`–`0007`, new triggers, `expectedMigrationCount`. *connectors:* `social.ts` rewritten (engagement, failure classification, `checkMetaToken`), WebSocket blocking in `providers.ts`. *services:* `workspace.ts`, `readiness.ts` (per-workspace), `journey.ts`, `system-health.ts` (`/ready`), `invitations.ts`, `lifecycle.ts`, plus large changes to `alerts.ts`, `scan.ts` (`recoverScans`, `releaseActiveScans`), `retention.ts`, `social-sync.ts`, `matching.ts`, `promotions.ts`, `live.ts`, `exports.ts`. *api:* `GET /ready`, `/journey`, `/matches/candidates|manual`, `/alerts/:id/resolve`, `/offers/:id/review`, `/invitations…`, `/invitations/preview|accept`. *web:* `journey.tsx`, `social.tsx`, rewritten Matches/Alerts/Offers/Marketing pages, `/invite`.

**`packages/services`** — `context.ts` (Services, job names, `createServices`), `auth.ts`, `sites.ts` (add/update/remove, consent), `profiling.ts`, `scan.ts` (start/execute/recover/cancel; feed + page runners; resumable via `crawl_queue`), `ingest.ts`, `evidence.ts`, `matching.ts`, `comparison.ts`, `promotions.ts`, `stock.ts`, `alerts.ts`, `coverage.ts`, `live.ts` (offers/stock/marketing/assortment loaders), `report.ts`, `report-compare.ts`, `exports.ts` (PDF/CSV/XLSX), `scheduler.ts`, `retention.ts`, `social-sync.ts`, `integrations.ts`, `fx.ts`, `dashboard.ts`, `queries.ts`, `queue.ts` (PgBossQueue, InlineQueue, `grantQueueAccess`, producer-only boss), `jobs.ts` (handlers), `mailer.ts` (outbox mailer + templates), `s3-storage.ts`.

**`apps/api`** — `app.ts` (`buildApp`: cookies, CSRF hook, rate limit, security headers, error handler, org scope with membership pre-handler, optional static web), `main.ts`, routes `auth.ts`, `orgs.ts`, `sites.ts`, `catalog.ts`, `reports.ts`, `alerts.ts`, `integrations.ts`, `dev.ts` (outbox + scheduler tick, non-production only).

**`apps/worker`** — `main.ts`: worker DB role, `createBoss`, `grantQueueAccess`, optional `PlaywrightRenderer` (`BROWSER_RENDERING_ENABLED`), `ensureFxRates`, `registerWorkers`.

**`apps/web`** — `App.tsx` (routes, lazy chart pages, `/settings` redirect for the Shopify callback), `app-shell.tsx` (session/meta/org hooks, layout, sidebar, honesty bar), `api.ts` (fetch wrapper with `x-requested-with: ci-web`), `ui.tsx` (icons, toasts, pills, cards, tabs, `PriceTag`…), `styles.css`, `types.ts`, `pages/` (Auth, Dashboard, Setup, Websites, Prices, Offers, Stock, Marketing, Products, Matches, Alerts, Quality, Reports, Settings).

**`scripts`** — `dev.ts` (`--demo` flag), `dev-db.ts` (persistent embedded PG on 54329 + generates `.env` with random secrets), `db-setup.ts`, `db-migrate.ts`, `bootstrap-dev.ts`, `demo-fixtures.ts`, `demo-setup.ts`, `fixtures-serve.ts`, `live-probe.ts`, `tsup-base.ts`, `lib/cli.ts`, `lib/embedded-pg.ts`.

## C.2 How the parts communicate

```
Browser ──HTTP /api (cookie + CSRF header)──► apps/api ──► PostgreSQL as role ci_app (RLS enforced; org bound per transaction)
                                                  │ enqueue only (pg-boss, producer-only; cannot read queue/tenant tables)
                                                  ▼
                                          pg-boss queues in PostgreSQL
                                                  │
                                                  ▼
                                            apps/worker ──► PostgreSQL as role ci_worker (BYPASSRLS; passes org ids explicitly)
                                                  │
                         packages/services ──► packages/connectors ──► target websites / platform APIs / PDFs / social APIs / Shopify
                                                  └──► packages/core (pure rules)       Storage: local dir or S3 (snapshots, exports)
```
The web app never computes business numbers; every figure is an API response or a saved report snapshot.

---

# D. Detailed implementation inventory

Status vocabulary: **I** implemented · **F** tested with fixtures · **M** tested with mocks/local imitations · **L** tested against a real *local* service (embedded PostgreSQL, real Chrome) · **X** tested against a real external service · **—** not tested · **B** blocked by credentials/authorisation.
(Everything below in column "Verified" is limited to what the current test suite and the 2026-10-14/15 browser checks show. No feature has been tested against a real customer site's catalogue.)

> Endpoint prefix: org-scoped routes are `/api/v1/orgs/:orgId/…`; auth routes are `/api/v1/auth/…`.

### D.1 Authentication, sessions, organisations, roles
> **Update (2026-10-15):** Registration without email delivery keeps the account visibly **unverified** (banner, member list, `/auth/me`, `/meta.emailVerificationEnforced`); with `SMTP_URL`, verification is required to sign in; a reset link verifies only when mail is really delivered. **Invitations** (`invitations.ts`, `POST/GET/DELETE /orgs/:id/invitations`, `/invitations/preview|accept`, `/invite` page): single-use 7-day link, hash stored, must be accepted by the invited address, nobody joins unasked, 25-pending cap, owner/admin rules; `invitations` is the 4th documented RLS exemption. Tests: `email-verification.test.ts` (14), `invitations.test.ts` (24).
1. *Requirement:* register/login, hashing, sessions, logout, verification & reset, orgs, owner/admin/staff roles, tenant isolation (§13).
2. *Files:* `packages/services/src/auth.ts`, `apps/api/src/routes/auth.ts`, `orgs.ts`, `app.ts`, `packages/core/src/crypto.ts`, web `pages/Auth.tsx`, `Settings.tsx` (People tab).
3. *Endpoints:* `POST /auth/register|login|logout|forgot-password|reset-password|verify-email|resend-verification`, `GET /auth/me`, `GET|POST /orgs`, `GET /` (org), `GET|POST|PATCH|DELETE /members…`.
4. *Tables:* `users`, `sessions`, `email_tokens`, `organizations`, `memberships`, `org_settings`, `audit_events`, `email_outbox`.
5. *External:* SMTP for real email (**B**: `SMTP_URL` not supplied).
6. *Tests:* `tests/e2e/api.test.ts` (register/cookie, CSRF, generic wrong-password + lock-out + rate limit, logout, reset flow, roles, tenant isolation), `core/domain.test.ts` (hashing).
7. *Verified (L):* scrypt hashing, HttpOnly SameSite=Lax cookie, sha256-hashed server-side session, CSRF header + Origin check, per-route rate limits, lock-out, single-use reset tokens that revoke sessions.
8. *Not verified:* real email verification delivery. **Behaviour to audit:** when `SMTP_URL` is unset an unverified user can sign in (account remains `emailVerifiedAt = null`); with SMTP set, login requires verification (`auth.ts:118`).
9. *To do:* decide/verify the production verification policy; member **invitations** (currently "add an existing registered user by email"); onboarding flow polish.

### D.2 Websites, consent, profiler, capability report
1. *Requirement:* §5, §3.9. 2. *Files:* `services/sites.ts`, `services/profiling.ts`, `connectors/profiler.ts`, `connectors/challenge.ts`, `connectors/sitemap.ts`, web `Setup.tsx`, `Websites.tsx`.
3. *Endpoints:* `GET|POST /sites`, `GET|PATCH|DELETE /sites/:id`, `POST /sites/:id/profile`, `GET /sites/:id/profile|profiles`, `POST /sites/:id/consent`, `GET /site-names`, `POST /refresh`.
4. *Tables:* `sites`, `site_profiles`, `consent_log`, `audit_events`, `collection_health`.
5. *External:* the target websites (robots/home/sitemaps/≤3 sample pages).
6. *Tests:* `connectors/connectors.test.ts` (profiler against fixtures: Full/Partial/Blocked/Failed/Limited, SSRF refusal), `safe-fetch.test.ts`, `tests/e2e/pipeline.test.ts`, `api.test.ts` (add/limit/duplicates).
7. *Verified:* F + L (fixtures). **Live:** capability probe only (2026-10-14): groceriestogoaruba.com → Shopify/Full; shop.lingandsons.com → Shopify/Full; shop.superfoodaruba.com → Freshop/Limited; doit.aw → Next.js/Limited (needs JS rendering). Record: `docs/live-probe-2026-10-14.json` (holds only two sites; the other two were from an earlier run whose file was overwritten).
8. *Not verified:* any other platform; Magento/PrestaShop/BigCommerce/Wix/Squarespace etc. have no dedicated connector.
9. *To do:* consent is a per-site checkbox attestation; live-mode policy and wording; more connectors; onboarding UX.

### D.3 Catalogue collection (connectors, scans, resumability)
> **Update (2026-10-15):** Run explanations (`explainScanRun`), failed/skipped URL lists and an expandable run panel on the Websites page; headless-browser WebSockets are blocked; `recoverScans` resumes silent runs up to 3 times, re-queues orphaned queued runs, abandons runs that keep dying (`worker_lost`) and skips scheduled runs after their report cut-off; a worker that is stopping hands in-flight runs back (`releaseActiveScans`). Tests: `collection-observability`, `scan-recovery` (17), `lifecycle` (9).
1. *Requirement:* §5–§6, directive Part 4. 2. *Files:* `connectors/shopify.ts`, `woocommerce.ts`, `page-crawl.ts`, `extract.ts`, `registry.ts`, `services/scan.ts`, `ingest.ts`, `evidence.ts`, web `Websites.tsx`.
3. *Endpoints:* `POST /sites/:id/scans`, `GET /scans`, `GET /scans/:id`, `POST /scans/:id/cancel`, `POST /refresh`, `GET /quality`.
4. *Tables:* `scan_runs` (cursor, budgets, counters, `is_complete`), `crawl_queue`, `evidence`, `products`, `variants`, `price_observations`, `stock_observations`.
5. *External:* target sites; optional Chrome (render), Anthropic (LLM fallback).
6. *Tests:* connectors/extract/pipeline suites; `browser.test.ts` (real Chrome, local pages).
7. *Verified:* F + L: Shopify feed, WooCommerce Store API, sitemap + JSON-LD, generic HTML (partial), flaky feed (resume), empty-result = failed, delisting rules (two-miss on complete feed; 404 direct evidence; partial scans never advance counters), JS-only rendering with real Chrome on local pages.
8. *Not verified:* **any real full-catalogue collection** (no live collection was ever run); large-catalogue behaviour (thousands of products) and request-budget behaviour on real sites; JS rendering on a real site (doit.aw); LLM fallback live.
9. *To do:* real-site verification (needs consent), progress/failed-URL visibility per page, Super Food Aruba (Freshop) has **no** public feed → only profiling, no collector.

### D.4 Product normalisation and matching (+ review)
> **Update (2026-10-15):** `GET /matches/candidates` ranks competitor products for a source product (with the matcher's reasons); `POST /matches/manual` stores a person's choice as accepted/`manual`/confidence 1 and supersedes suggestions; the review page shows both products side by side. Test: `match-review.test.ts` (6).
1. *Requirement:* §7, Part 5. 2. *Files:* `core/matching.ts`, `price.ts`, `quantity.ts`, `gtin.ts`, `text.ts`, `services/matching.ts`, web `Matches.tsx`.
3. *Endpoints:* `GET /matches`, `POST /matches/run`, `POST /matches/:id/decision` (accept/reject/reclassify).
4. *Tables:* `product_matches` (class, confidence, status, method, reasons, components, decision fields), `variants`, `products`.
5. *External:* optional AI adjudication (never auto-accepts).
6. *Tests:* `core/domain.test.ts` (brand conflict, size, subset names, AI cap…), `pipeline.test.ts` (never calls different brands identical, decisions preserved).
7. *Verified (F):* GTIN → brand+MPN → attributes/name → cross-brand comparable; name-only identical capped at 0.9; manual decisions preserved on re-match.
8. *Not verified:* accuracy on real catalogues (no precision/recall measurement); non-grocery products; unit conversions beyond grocery units.
9. *To do:* "search and choose an alternative" in review UI (not present); side-by-side evidence (partial); learning from reviewed pairs (not implemented).

### D.5 Price comparison, price history, currency
1. *Requirement:* §7, Part 5.3–5.4. 2. *Files:* `services/comparison.ts`, `core/currency.ts`, `services/fx.ts`, `connectors/providers.ts` (FX client), `services/queries.ts`, web `Prices.tsx`, `Products.tsx`.
3. *Endpoints:* `GET /comparison`, `GET /products`, `GET /products/:id`, `GET /evidence/:id[/snapshot]`.
4. *Tables:* `variants`, `price_observations`, `product_matches`, `exchange_rates`, `evidence`.
5. *External:* `open.er-api.com` (optional; client never called live). Default `FX_PROVIDER=peg` = explicit AWG/USD 1.79 only.
6. *Tests:* `parsing.test.ts` (currency), `pipeline.test.ts` (comparison, FX provenance), `providers.test.ts` (FX client vs local imitation).
7. *Verified (F/M):* arithmetic, unit prices per 100 g/L/piece, different-pack handled per unit, stale flagging, no assumed rates, FX provenance (rate, source, time) shown.
8. *Not verified:* live FX; currency detection on real sites beyond the probe; user currency override exists (`sites.currency_source = 'user'`).
9. *To do:* confirm a non-peg real FX source with the user; multi-currency customers.

### D.6 Offers, promotions, flyers
> **Update (2026-10-15):** `POST /offers/:id/review` — confirm, correct (original reading kept, discount recomputed, impossible prices/dates refused) or dismiss; verdicts survive re-collection; dismissed offers vanish from lists/reports. Sale prices derived from product prices are not reviewable. Test: `offer-review.test.ts` (11).
1. *Requirement:* §8, Part 7. 2. *Files:* `core/offers.ts`, `services/promotions.ts`, `connectors/flyer.ts`, `connectors/extract.ts`, web `Offers.tsx`.
3. *Endpoints:* `GET /offers`. 4. *Tables:* `offers`, `flyers`, `evidence`, `price_observations`.
5. *External:* flyer PDFs on target sites. 6. *Tests:* `domain.test.ts`, `integrations.test.ts` (flyer parsing incl. `1.75L` regression), `pipeline.test.ts` (sale prices, banners, coupon code, flyer offers, expiry).
7. *Verified (F):* verification states verified / contradicted / insufficient_history / unverified; expiry policy; conditional offers; text-layer PDF.
8. *Not verified:* real flyers; image-only flyers (reported as `no_text_layer`, no OCR).
9. *To do:* flyer review UI actions (rows carry `needs_review`, no accept/reject action), OCR/vision (optional).

### D.7 Own stock monitoring and alerts
> **Update (2026-10-15):** Alerts have a lifecycle (open → acknowledged → resolved) with automatic resolution (stock back in a different state, website collected again, store sync succeeded) keeping the resolving observation as evidence, manual resolution with a note, evidence/source links, and a visible page-vs-inventory conflict on the Stock page. Test: `alert-lifecycle.test.ts` (16).
1. *Requirement:* §3.3, §9, Part 6. 2. *Files:* `core/stock.ts`, `services/stock.ts`, `services/alerts.ts`, `services/integrations.ts`, `connectors/inventory.ts`, web `Stock.tsx`, `Alerts.tsx`.
3. *Endpoints:* `GET /stock`, `PUT /variants/:id/threshold`, `GET|PUT /alert-rules`, `GET /alerts`, `POST /alerts/:id/ack`, `POST /alerts/ack-all`, integrations endpoints (see D.14).
4. *Tables:* `stock_states`, `stock_observations`, `alerts`, `alert_rules`, `variants`, `integration_connections`.
5. *External:* Shopify Admin GraphQL (read-only) — **B** credentials; simulator for dev.
6. *Tests:* `domain.test.ts`, `tests/e2e/stock-alerts.test.ts` (15), `shopify-oauth.test.ts` (8).
7. *Verified (F/M):* unknown never in-stock; no invented quantities; transitions + episodes + dedupe keys; threshold default/per-product; competitor stock never alerts; authorised quantity outranks public flag; conflict flag (page vs inventory).
8. *Not verified:* **real Shopify**; acknowledgement exists but **no "resolved" state**.
9. *To do:* alert resolution, evidence links on alerts, simulator restricted to demo workspaces.

### D.8 Marketing intelligence (site + social)
> **Update (2026-10-15):** YouTube/Instagram/Facebook clients now return engagement counts (null when not provided), classify failures, and `checkMetaToken` reports validity/expiry/permissions; per-account backoff (quota reset at midnight Pacific, Retry-After, exponential, daily re-check for missing approval, never retry a refused credential) is persisted with a credential fingerprint; `summariseMarketing` produces evidence-limited themes/brand mentions/timing/most-liked/most-viewed per competitor — shown on the Marketing page and saved in report snapshots, PDF, Excel and CSV. **Verified only against local imitations.** Tests: `social-health` (20), `social-providers` (26), `marketing-summary` (13), `social-backoff` (13).
1. *Requirement:* §10, Part 8. 2. *Files:* `connectors/social.ts`, `services/social-sync.ts`, `connectors/extract.ts` (banners), web `Marketing.tsx`, `Settings.tsx` (Integrations tab).
3. *Endpoints:* `GET /marketing`, `POST /social-accounts`, `PATCH /social-accounts/:id`, `POST /social/sync`, `GET /integrations`.
4. *Tables:* `social_accounts`, `marketing_activities`, `evidence`.
5. *External:* YouTube Data API (`YOUTUBE_API_KEY`), Instagram Business Discovery (`META_ACCESS_TOKEN`, `META_INSTAGRAM_BUSINESS_ACCOUNT_ID`), Facebook Page public content (App Review) — all **B**.
6. *Tests:* `integrations.test.ts` (clients vs mocked HTTP, status messages), `pipeline.test.ts` (observed content never called a paid campaign; `paidStatus` is the literal `'not_determined'`).
7. *Verified (M):* provider status messages, handle mapping, classification with confidence.
8. *Not verified:* any live API call. *To do:* engagement metrics, token expiry/refresh/quota/backoff handling per provider, theme/timing summaries, handle discovery quality.

### D.9 Insights engine
`core/insights.ts`, `services/report.ts` — ranked, evidence-bearing insights (`score = 100 × typeWeight × (0.4+0.6×magnitude) × confidence × freshness`); table `insights`; tests `reports.test.ts` ("every insight is ranked, scored transparently and traceable to evidence"). Optional AI summary validated by `findUnsupportedNumbers` (**F**; live AI not tested).

### D.10 Reports, exports, history
`services/report.ts`, `report-compare.ts`, `exports.ts`; endpoints `GET|POST /reports`, `GET /reports/latest|compare|:id|:id/export`; tables `reports` (immutable JSON snapshot + hash), `report_exports`, `insights`; web `Reports.tsx`. Tests: `reports.test.ts` (18), `api.test.ts` (downloads). **Verified (F):** PDF/CSV/Excel render from the saved snapshot with equal headline numbers; CSV formula-injection safe (`csvSafe`); immutability trigger. *Not verified:* PDF visual layout review on real data; large reports; email attachment (none: summary only).

### D.11 Scheduler and daily runs
> **Update (2026-10-15):** Demo workspaces are only scheduled on a server that allows fixtures; scan recovery as in §D.3; a stored profile without a `strategy` no longer crashes the pass.
`core/schedule.ts`, `services/scheduler.ts`, `queue.ts`, `jobs.ts`; table `daily_runs`, `scan_runs`; `POST /dev/scheduler/tick` (dev only). `scheduler-tick` runs every minute (pg-boss cron), `retention` daily 06:17, `refresh-fx` every 12 h if `FX_PROVIDER=open-er-api`. Tests: `scheduler.test.ts` (11, injected clock, partial at 08:50, idempotent ticks), `queue.test.ts`. *Not verified:* multi-day real run; behaviour across a worker restart. `recoverStaleScans` runs on every scheduler tick (`scheduler.ts:76`) but **no test references it directly** (to be covered in Phase 6).

### D.12 Retention
> **Update (2026-10-15):** Now also expires marketing activity, offers, flyers, finished daily runs and old capability profiles (the newest profile per website is kept); a file that cannot be deleted is counted and retried and never stops other files or workspaces; `runRetention(svc, { orgIds })` can clean selected workspaces; people's match decisions are never 'history'. Test: `retention.test.ts` (13).
`services/retention.ts` (snapshots purged after `snapshotRetentionDays` default 90; history after `historyRetentionDays` default 365; evidence rows and reports preserved). Test: `reports.test.ts` ("purges raw snapshots after the snapshot window but keeps evidence rows, reports and exports usable"). *Verify:* observation/history deletion rules end to end (see §H).

### D.13 Dashboard, data quality, settings
`services/dashboard.ts`, `coverage.ts`, `queries.ts`; endpoints `GET /dashboard`, `/quality`, `/settings`, `PUT /settings`; web `Dashboard.tsx`, `Quality.tsx`, `Settings.tsx`. Verified in a browser on fixture data (desktop + phone width); automated accessibility sweep over 17 views (names/labels/headers/h1).

### D.14 Integrations framework
`services/integrations.ts` (overview, Shopify OAuth start/callback/refresh/disconnect/webhook, dev simulator, social accounts); endpoints `GET /integrations`, `POST /integrations/shopify/start`, `GET /integrations/shopify/callback` (public), `POST /integrations/:id/sync`, `DELETE /integrations/:id`, `POST /integrations/dev-inventory[/simulate]`, `POST /webhooks/shopify` (HMAC). Tables `integration_connections`, `oauth_states`. Tokens AES-256-GCM encrypted (`TOKEN_ENCRYPTION_KEY`). **M** only.

### D.15 Security controls
> **Update (2026-10-15):** `GET /api/v1/ready` (database, schema version, RLS role, queue, worker heartbeat, storage, optional integrations; no secrets/SQL/tenants); live vs demo enforced by triggers; graceful shutdown with failsafes and fatal-error handling (`lifecycle.ts`); SSRF coverage extended (66 cases) and WebSockets screened.
SSRF fetcher, per-domain limiter, robots, stop-on-denial, redaction, CSRF, rate limits, headers/CSP, evidence snapshots served as inert attachments. Tests: `safe-fetch.test.ts` (45), `url-ip-robots.test.ts` (55), `api.test.ts`, `database.test.ts`.

---

# E. Database and data flow

## E.1 Tables (35 after migration 0007) — purpose and key relationships

> **Update:** new/changed columns since creation — `organizations.mode`; `provenance` on `evidence`, `price_observations`, `stock_observations`, `offers`, `marketing_activities`, `exchange_rates`; `alerts` (`evidence_id`, `resolved_at`, `resolution_kind|note|evidence_id`, `resolved_by`); `offers` (`review_status`, `reviewed_by|at`, `review_note`, `original_reading`); `social_accounts` (`failure_kind`, `consecutive_failures`, `next_attempt_at`, `credential_fingerprint`); `marketing_activities` (`engagement`, `engagement_observed_at`); `scan_runs.resume_count`; new table `invitations`.

*Identity (not tenant-scoped; protected in the application):* `users` (unique lower(email), scrypt hash, lock-out counters), `organizations` (unique slug), `sessions` (sha256 token hash, expiry), `email_tokens` (verify/reset, hashed, single-use), `memberships` (org↔user role: owner/admin/staff; **RLS-exempt**).
*Workspace config:* `org_settings` (one row per org: reporting currency, timezone `America/Aruba`, ready time `09:00`, schedule enabled, low-stock threshold 5, snapshot/history retention, alert prefs JSON, AI adjudication flag), `sites` (source/competitor, `is_fixture`, consent fields, platform, currency + `currency_source`, capability status, crawl delay, request budget; unique `(org, hostname)`; **at most one active source per org**), `consent_log`, `site_profiles` (profile JSON history), `collection_health` (failure-episode state), `alert_rules`, `social_accounts`.
*Collection:* `daily_runs` (one per org+date), `scan_runs` (kind discovery/refresh/sample, status, connector+version, request budget/used, urls discovered/fetched, products/variants saved, errors, estimated total, resumable `cursor`, `is_complete`, notes, heartbeat), `crawl_queue` (URL frontier per run), `evidence` (fetch metadata: URL, status, type, content hash, bytes, `snapshot_ref` + `snapshot_purged_at`, snippet, method/version, `is_fixture`).
*Catalogue and history:* `products` (per site, canonical URL, identifiers, first/last seen, `missed_complete_scans`, `delisted_at`), `variants` (current state + FK to latest observation; sku/gtin/options/qty label/price/compare-at/currency/shipping/availability/quantity+source), `price_observations` and `stock_observations` (**append-only**, each with `source_url`, `observed_at`, evidence/scan refs, method/version, `is_fixture`), `stock_states` (state machine memory: current/last-known state, episode, basis).
*Intelligence:* `product_matches` (source variant ↔ competitor variant; class, confidence, status auto/needs_review/accepted/rejected, reasons, components, decision metadata; unique pair), `offers` (kind, conditions, prices, claimed vs historical discount, verification + reason, validity, status, `missed_complete_scans`, dedupe key, confidence, needs_review), `flyers`, `marketing_activities`, `alerts` (unique `(org, dedupe_key)`; severity; acknowledgement), `insights`.
*Reporting:* `reports` (immutable JSON `data` + `data_hash`, status generating/ready/partial/failed, `is_partial`, `contains_fixture`, deadline fields), `report_exports` (cached files: storage key, bytes, checksum).
*Integrations/system:* `integration_connections` (encrypted tokens, scopes, expiry, simulated flag, status, last error), `oauth_states` (**RLS-exempt**), `email_outbox` (**RLS-exempt**; queued/sent/failed/dev_logged), `audit_events`, `exchange_rates` (global reference data: base/quote/rate/source/is_fixed/fetched_at).

## E.2 Tenant isolation, roles, RLS
- `packages/database/src/post-migrate.ts` runs after migrations: for **every** table with an `org_id` column except four documented exemptions (`memberships`, `oauth_states`, `email_outbox`, `invitations`) it enables and **forces** RLS and creates `tenant_isolation` (`org_id = nullif(current_setting('app.org_id', true), '')::uuid`, USING and WITH CHECK). New tables are covered automatically.
- Roles: `ci_app` (API; `NOSUPERUSER NOBYPASSRLS`) and `ci_worker` (worker; `BYPASSRLS`, `CREATE` on the database so pg-boss can create its schema). `scripts/db-setup.ts` creates them from the passwords in the three DB URLs.
- `withTenant(db, orgId, fn)` binds the org per transaction; with no binding the policy matches nothing (fails closed). Tests: `tests/integration/database.test.ts` (15), `queue.test.ts`, `api.test.ts` (another user gets 404 for every resource and cannot cross-reference ids).

## E.3 Retention and immutability
Snapshots: purged after `snapshotRetentionDays` (default 90) — evidence rows stay. History: `historyRetentionDays` (default 365, min 30). Reports are immutable once `ready`/`partial` (DB trigger). Observation rows are append-only against `UPDATE` (trigger); deletion by retention is by the worker role. Further triggers: `organizations_mode_immutable` (a workspace can never switch live↔demo) and `sites_fixture_only_in_demo` (a fixture website can never exist in a live workspace). See §D.12 for what retention now covers.

## E.4 Migration history
`0000_init` (all tables, 51 index/unique-index statements), `0001_currency_source`, `0002_provenance_and_org_mode` (+ backfill: workspaces with fixture sites became demo; fixture-derived rows labelled), `0003_alert_lifecycle` (+ backfill that resolves old alerts whose condition has cleared, using the next alert's time), `0004_offer_review`, `0005_social_health_engagement`, `0006_scan_resume_count`, `0007_invitations`. Apply with `npm run db:setup` (roles + migrations) or `npm run db:migrate`; generate with `npm run db:generate` after schema changes.

## E.5 Data flow: URL → report
1. **Add site** (`POST /sites`): URL normalised/validated (`core/url.ts`, SSRF host check unless fixture mode), role source/competitor, limits (1 source, ≤5 competitors), consent `pending`.
2. **Consent** (`POST /sites/:id/consent`) — recorded with actor, wording version, log row. Collection is refused until `confirmed`.
3. **Profile** (`profile-site` job): robots + crawl-delay, homepage, sitemaps, ≤3 sample product pages, API fingerprints → `site_profiles` + capability status + ranked connector strategy.
4. **Scan** (`scan-site` job): connector fetches pages/feed within request budget and crawl delay; each response → `evidence`; products/variants upserted; price/stock observations appended; offers/promos/flyers/marketing extracted; cursor persisted so an interrupted run resumes; empty extraction ⇒ run `failed` and the next connector is tried; `is_complete` only when the catalogue was fully enumerated.
5. **Match** (`match-products`): candidate generation across sites, scoring, status auto/needs_review; manual decisions preserved.
6. **Compare/live views**: `comparison.ts` joins source variants ↔ accepted/auto matches, converts currencies (FX table with provenance), computes unit prices and differences.
7. **Alerts**: stock state machine per variant → deduped alerts → in-app + email digest (outbox → SMTP if configured).
8. **Daily run** (`scheduler-tick`): plan start time (P90 slowest-site duration × 1.6 + 10 min), start budgeted scans, assemble at the cut-off; **report** (`generate-report`/`daily-assemble`) writes one immutable snapshot (+ insights) and emails a summary.
9. **Exports** render the snapshot to PDF/CSV/XLSX on demand and cache in storage (`report_exports`).

---

# F. Environment, commands, integrations

## F.1 Commands (run from the repository root)

| Purpose | Command |
| --- | --- |
| Install | `npm install` (Node ≥ 22) |
| Start database (embedded PG 18 on 127.0.0.1:54329; creates roles/migrations and a git-ignored `.env` with random local secrets on first run) | `npm run dev:db` |
| Worker + API + web with live reload (starts DB if none listening) | `npm run dev` |
| Check the mail server (and send one real message) | `npm run email:check [-- address]` |
| The live procedure against real websites (opt-in; sends real requests) | `npm run test:live` (`LIVE_SOURCE_URL`, `LIVE_COMPETITOR_URLS`, `LIVE_SAMPLE`) |
| One-off upgrade tool for databases created before 0008 | `npm run db:purge-demo [-- --yes]` |
| Live capability probe of real sites (read-only) | `npm run live:probe -- <urls>` |
| Roles + migrations / migrations only / generate migration | `npm run db:setup` / `npm run db:migrate` / `npm run db:generate` |
| Tests (all / unit / integration) | `npm test` / `npm run test:unit` / `npm run test:integration` |
| Lint / typecheck / format check | `npm run lint` / `npm run typecheck` / `npm run format:check` |
| Production builds (web, API, worker) | `npm run build` |

## F.2 Environment variables (names only — never record values)

Status column: **set** = generated locally by `dev:db`; **unset** = not provided; **unverified** = never exercised against the real service. Source of truth: `packages/core/src/config.ts` and `.env.example`.

| Variable(s) | Controls | Required? | Used by / status |
| --- | --- | --- | --- |
| `NODE_ENV`, `LOG_LEVEL` | environment / logging | no | all — set |
| `APP_BASE_URL`, `API_HOST`, `API_PORT`, `CORS_ORIGIN`, `SERVE_WEB` | URLs/binding; single-origin serving of the built web app | `APP_BASE_URL` needed in prod | API — set (dev) |
| `DATABASE_URL`, `WORKER_DATABASE_URL`, `DATABASE_ADMIN_URL` | API role (RLS), worker role (BYPASSRLS), migration/admin role | yes (worker URL required in production) | API/worker/scripts — set (embedded PG) |
| `SESSION_TTL_DAYS`, `SESSION_COOKIE_SECURE` | session lifetime; Secure cookie (default true in production) | no | API |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM key ring for integration tokens (`id:base64`) | required in production | integrations — set (dev) |
| `STORAGE_DRIVER`, `STORAGE_LOCAL_DIR`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | evidence snapshots/export storage | S3 vars only for `s3` | unset (local used); S3 **unverified on a real service** |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` | real email delivery (Gmail: `smtp.gmail.com`, 587, an App Password; `EMAIL_FROM` empty) | **yes for anyone to register** | unset → registration answers 503, outbox rows `not_configured`; SMTP path tested against an in-process SMTP server only — **Gmail not yet exercised** (the user types `SMTP_PASSWORD` into `.env` themselves) |
| `COLLECTOR_USER_AGENT`, `COLLECTOR_TIMEOUT_MS`, `COLLECTOR_MAX_HTML_BYTES`, `COLLECTOR_MAX_JSON_BYTES`, `COLLECTOR_MAX_PDF_BYTES`, `COLLECTOR_DEFAULT_DELAY_MS`, `COLLECTOR_DEFAULT_MAX_REQUESTS` | collector identity, limits, politeness | no (set a real contact URL in the UA) | fetcher/scans |
| `BROWSER_RENDERING_ENABLED`, `BROWSER_CHANNEL`, `BROWSER_EXECUTABLE_PATH` | optional headless rendering and which browser | no | worker — verified with real Chrome on local pages |
| `RETENTION_SNAPSHOT_DAYS`, `RETENTION_HISTORY_DAYS` | retention defaults (also per-org settings) | no | retention job |
| `FX_PROVIDER` | `peg` (default) or `open-er-api` | no | FX — open-er-api **verified once against the real provider (2026-10-18)** |
| `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `AI_MODEL` | optional AI | no | unset → AI off |
| `YOUTUBE_API_KEY` | YouTube Data API v3 | for YouTube | unset (**B**) |
| `META_APP_ID`, `META_APP_SECRET`, `META_ACCESS_TOKEN`, `META_INSTAGRAM_BUSINESS_ACCOUNT_ID` | Instagram Business Discovery / Facebook | for Meta | unset (**B**; needs Meta app + review) |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_SCOPES`, `SHOPIFY_API_VERSION`, `SHOPIFY_REDIRECT_URI` | Shopify read-only inventory OAuth | for Shopify | unset (**B**) |
| `DEV_DB_PORT`, `API_URL` | script-only helpers (db/proxy) | no | scripts |

Docker deployment variables (`POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `WORKER_DB_PASSWORD`) appear in `deploy.env.example`.

## F.3 Integration status summary

| Integration | Status |
| --- | --- |
| PostgreSQL (embedded) | **L** verified |
| Real websites | **X** public scraping sandboxes collected 2026-10-18 (books.toscrape.com via listing pages, scrapeme.live via WooCommerce API, scrapingcourse.com blocked by robots.txt); capability probe of 4 shops 2026-10-14; **no website the user authorised yet** |
| Headless Chrome | **L** (real Chrome, local pages); not on a live site |
| Shopify inventory | **M** (local imitation of Shopify endpoints) — **B** credentials + merchant authorisation |
| Facebook / Instagram / YouTube | **M** (local imitations of the provider answers: engagement, token health, quota/rate-limit/revocation, backoff) — **B** credentials/approvals; **no live call** |
| SMTP / Gmail | **L** (real SMTP library in process: auth, STARTTLS rules, rejections, retries) — **B** Gmail address + App Password; **not yet sent through Gmail** |
| S3-compatible storage | **M** (in-process fake) — not on a real service |
| Anthropic | **M** (local imitation) — **B** key; optional |
| open.er-api.com | **X** one real fetch (164 rates, 2026-10-18); optional |
| Docker / compose | written, **never built or run** (no Docker here) |

---

# G. Testing and verification history

## G.1 Baseline verification run (2026-10-15, before any change in this directive)

| Check | Command | Result |
| --- | --- | --- |
| Tests | `npx vitest run` | **393 passed, 0 failed, 0 skipped**, 19 files, ≈68 s (re-confirmed with the JSON reporter) |
| Typecheck | `npm run typecheck` | clean (all workspaces) |
| Lint | `npm run lint` | 0 errors, 2 intentional `any` warnings (`connectors/src/extract.ts:23`, `services/src/jobs.ts:17`) |
| Build | `npm run build` | web, API, worker bundles built |

Per-file counts (tests): connectors — browser 5, connectors 26, extract 26, integrations 19, providers 5, safe-fetch 45; core — domain 53, parsing 21, url-ip-robots 55; services — s3-storage 3; e2e — api 39, email-smtp 4, pipeline 20, reports 18, scheduler 11, shopify-oauth 8, stock-alerts 15; integration — database 15, queue 5. (Unit project 258, integration project 135.)
Known harmless noise: Vitest occasionally prints "close timed out after 10000ms" after all tests pass (exit code 0).

## G.1b Current verification (2026-10-15, after Phase 7, commit `803a1c1`)

| Check | Command | Result |
| --- | --- | --- |
| Tests | `npx vitest run` | **695 passed, 0 failed**, 40 files |
| Typecheck | `npm run typecheck` | clean (all workspaces) |
| Lint | `npm run lint` | 0 errors, the same 2 intentional `any` warnings |

Growth since the baseline (393 tests, 19 files): +293 tests, +19 files, including a **live-workspace journey test through the real HTTP API** (public hostnames served by local imitations). Browser verification: structural audit of 18 views at two widths, colour contrast on 21 views + 4 public pages (0 failures after fixes), keyboard and long-name checks. Beyond tests: the app was walked through in the in-app browser (live workspace empty-state and URL validation; demo workspace match review, picker and choice; alert history; offer correction dialog; marketing and integrations pages; invitation wrong-account / register-and-accept; the readiness endpoint on the running stack). `npm run build` was re-run after Phase 6: the web, API and worker bundles build, and the built API bundle was started against the dev database where `GET /api/v1/ready` answered `ready` with all 8 migrations recognised.

## G.2 Statuses by test type
- **Unit (pure logic):** implemented and passing — URL/IP/robots, prices, GTIN, quantities, currency, stock transitions, offers, schedule planning, crypto, redaction, matching, LLM guards.
- **Connector tests (fixtures/mocks):** Shopify, WooCommerce, sitemap/JSON-LD, HTML, flaky feed, blocked/failed/challenge/login/JS-only profiling; flyer PDF; social clients; Shopify OAuth pieces.
- **Real local service:** embedded PostgreSQL 18 (migrations, RLS, triggers, pg-boss queue, roles); real Chrome (render tests).
- **End-to-end:** pipeline (register → sites → consent → profile → scan → match → compare → offers → report), stock/alerts, reports/exports/retention, scheduler, API security, Shopify connect flow (imitation), SMTP (in-process).
- **Real external service:** **none**, apart from the read-only live capability probe (not an automated test).
- **Browser (manual, 2026-10-14/15, fixture data):** 17 views opened; sign-in; match rejection; mobile menu; automated accessibility sweep (labels/names/headers/h1); phone width (375 px) no horizontal page scroll. Colour contrast, screen-reader use, tablet width **not** checked.
- **Builds:** web/API/worker bundles built; API bundle started once with `SERVE_WEB=true` (health, SPA, sign-in cookie, CSRF 403); worker bundle started once. **Docker not verified.**

## G.3 The 14 reliability invariants
Mapped to specific tests in `docs/data-reliability.md` (all currently passing).

---

# H. Known defects and incomplete work

## H.1 Resolved since this file was created (see the Update log and `docs/WORK_LOG.md`)

No demo/live separation (→ enforced at the database); no provenance model (→ `provenance` everywhere); match review without search/choose (→ done); alerts without resolution/evidence (→ lifecycle); flyers needing review had no workflow (→ confirm/correct/dismiss); marketing without engagement, token expiry, quota/backoff or summaries (→ implemented against imitations); unverified accounts silently treated as fine (→ visibly unverified, enforced where email exists); no member invitations (→ done); no readiness endpoint (→ `/api/v1/ready`); onboarding unaudited (→ journey card, honest statuses). Defects found *by the new work* and fixed: browser WebSockets bypassed request screening; scan recovery uncapped and an orphaned queued scan blocked its website; one failed storage delete aborted retention for every workspace; several tables never expired; the readiness endpoint would have repeated raw SQL from database errors; a second shutdown signal after a fatal error hid the failing exit code; a stored profile without a strategy crashed the scheduler pass; the scheduler started demo workspaces on servers that cannot serve fixtures.

## H.2 Still open

**Needs the user (cannot be done alone):** (1) permission, per website, to run live collection — none has been given, so **no real catalogue has ever been collected** and behaviour on thousands of products, long crawls under real rate limits and failure mixes is unmeasured; (2) the fourth competitor URL ("Cmart", never guessed); (3) an email provider; (4) Shopify app credentials + merchant authorisation; (5) Meta (App Review, Business Verification) and YouTube credentials; (6) FX provider choice; (7) optional Anthropic key.

**Product gaps:** Super Food Aruba (Freshop storefront) and doit.aw (Next.js) cannot be collected without additional work or permission; non-peg real FX is untested live; flyers without a text layer are reported "no text layer" (no OCR); no match "learning"; no engagement *history* (latest counts only); the Meta user token is renewed by a person (a system-user token never expires); the staff role is view-only with no finer permissions.

**Verification gaps:** no real external service has ever been called by any test; Docker/compose never built or run; the backup **restore drill was not executed** (no `pg_dump`/`pg_restore` here); graceful shutdown not tested with a real `SIGTERM` (Windows); residual DNS-rebinding risk for browser rendering (mitigate with an egress firewall); colour contrast, screen-reader use and tablet width not checked; the dev demo workspace shows a failed morning run from before the scheduler fix (re-seed with `npm run demo:fixtures`).

**Engineering:** two ESLint `any` warnings (intentional); tsup bundles keep third-party deps external (`node_modules` must ship); `fixtures/` (root) is an empty directory; the live-probe record file holds only two of the four probed sites.

**Permission / credential blockers:** see §A.6 and §F.3.

---

# I. Next implementation roadmap (prioritised)

**Blockers to ask the user about (do not guess):** (1) per-site consent to run live collection for the source and each real competitor; (2) the fourth competitor URL; (3) email provider/SMTP; (4) Shopify app credentials + store authorisation; (5) Meta/YouTube credentials; (6) FX provider choice; (7) Anthropic key (optional).

**Remaining directive phases:** Phase 7 — full-system verification (a desktop + mobile pass over every page, keyboard and long-name checks, `npm run build`, the live-mode run commands, and **one authorised live end-to-end run**, which needs the user's per-site permission); Phase 8 — production-readiness assessment and the final deliverable list (summary of changes, both context docs, working features, live-mode commands, how to create an account and configure a source plus 3–5 competitors, every external prerequisite, tests/builds/real-world steps with results, limitations, prioritised remaining work, the precise next step).

**Integrations:** credential-gated verification of Shopify, YouTube, Meta, SMTP, FX, S3, AI (each only after the user supplies the item, using the credential workflow in directive Part 11 and the table in `docs/integrations.md`).

**Production hardening still to do:** build and run the Docker image; execute the restore drill; test a real `SIGTERM`; add monitoring/alerting on `degraded` readiness; egress firewall for rendering workers.

**Optional:** OCR/vision flyers, match learning, dedicated adapters (Magento, PrestaShop, BigCommerce), engagement history, finer role permissions.
