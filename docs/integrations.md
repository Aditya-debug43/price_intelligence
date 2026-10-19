# Integrations and credentials

**Rule of this document:** a status is only as strong as the test behind it. The words below are the project's status vocabulary and are
never used loosely:

| Status | Meaning |
| --- | --- |
| **Implemented, not tested** | The code exists; no test exercises it. |
| **Tested with automated mocks** | Exercised by automated tests against a stand-in written for the test (a fake of the provider's answers). Proves the code handles those answers; proves nothing about the real provider. |
| **Tested using isolated test fixtures** | Exercised against fictional websites or data served by the test suite itself. |
| **Tested against a real local service** | Exercised against a genuine program running on this machine (embedded PostgreSQL, a real SMTP server library, a real Chrome). |
| **Tested against a real external service** | At least one automated or recorded run sent real requests to the real provider and the answers were checked. |
| **Verified end to end with real website data** | The whole chain — add → check → confirm → collect → store → compare — ran on the real pages of a website you authorised, and what was stored was compared with the live pages. |
| **Blocked pending credentials or permission** | The code is ready; the next step needs something only you (or the provider) can supply. Nothing is faked in the meantime. |

Real credential values never go in this repository, the docs, the work log, test fixtures, logs or chat — only in your local `.env`
(git-ignored; copy `.env.example`). The app shows each integration's true state in **Settings → Integrations** and in
`GET /api/v1/ready`; it never shows "connected" for something that is unconfigured, expired, refused or unproven.

## Integration checklist (as of 2026-10-18)

"Core" means essential to the **price-comparison workflow** (check → collect → match → compare → report). Everything else is optional
and never blocks real public-web price collection. *Mock tests* and *real tests* are listed separately on purpose.

| Provider | Feature it provides | Core / optional | Environment variables | Permissions needed | Status | Tested with mocks / fixtures | Tested for real | Blocker | How to verify |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **PostgreSQL** | All data, row-level security, job queue | **Core** | `DATABASE_URL` (app role, RLS enforced), `WORKER_DATABASE_URL` (worker role), `DATABASE_ADMIN_URL` (setup and migrations only) | App role without `BYPASSRLS`; worker role with it (`npm run db:setup` creates both) | **Tested against a real local service** | — (the tests use the real database) | Embedded PostgreSQL 18: migrations, RLS (15 isolation tests), queue, every end-to-end test | None for development. Production needs a managed PostgreSQL you choose and pay for; none has been connected | `GET /api/v1/ready` → `database`, `migrations`, `tenant_isolation` all `ok` |
| **Public websites** (any URL you add) | Catalogue, prices, availability, offers, flyers | **Core** | none | Your own confirmation per website that you are entitled to collect from it (recorded; never presented as the website's approval); robots.txt is always obeyed | Public scraping sandboxes: **Tested against a real external service**. Your websites: **Blocked pending permission** — send me the first authorised address | Fictional shops served inside the tests: feeds, sitemaps, structured data, listing pages, blocked/challenge/login/failing sites (the end-to-end suites in `tests/e2e`) | `npm run test:live` against books.toscrape.com (listing-crawl: 40 products, GBP, every stored price and name found in the raw page it was read from, 0 mismatches), scrapeme.live (WooCommerce Store API: 40 products), scrapingcourse.com (robots.txt forbids the page → blocked, 0 pages read). See `docs/verification-report.md` | The first website you authorise — and a competitor that sells overlapping products, which the sandboxes cannot provide | Add the website → Websites → "Check this website" → confirm → Collect; or `LIVE_SOURCE_URL=… LIVE_COMPETITOR_URLS=… npm run test:live` |
| **SMTP email — Gmail** (or any SMTP server) | **Account verification and password reset (nobody can register without it)**, invitations, daily report, alert emails | **Core for sign-up**; not for price collection | `SMTP_HOST` (`smtp.gmail.com`), `SMTP_PORT` (587, or 465 with `SMTP_SECURE=true`), `SMTP_USER`, `SMTP_PASSWORD` (a Google **App Password**), `EMAIL_FROM` (empty for Gmail), `APP_BASE_URL` | 2-Step Verification on the Google account and an App Password; never the normal password | **Blocked pending credentials** (Gmail address and an App Password typed by you into `.env`) | Capture transport (messages as data) for every flow: register, verify, resend, login while unverified, reset, expired/used/replaced links, throttling, no enumeration, outbox states | An in-process SMTP server (real SMTP protocol, STARTTLS rules, authentication, rejected recipients, dropped connections, retry/failure states) = real local service. **Real Gmail: not run** | The Gmail address and App Password | `npm run email:check -- you@example.com`, then register → open the link → sign in → "Forgot password" → Settings → Notifications → "Send me a test email" |
| **Exchange rates** (open.er-api.com) | Convert competitor prices in other currencies; each converted price shows rate, provider, time | Optional | `FX_PROVIDER=peg` (default) or `open-er-api` (free, no key; the app shows the attribution) | none | **Tested against a real external service** (single call, no key, no cost) | Local imitation of the provider's answer; conversion maths, missing-rate behaviour | One real request on 2026-10-18: 164 rates, USD→GBP 0.7508 with source "open.er-api.com (market rate)" and the provider's own update time stored; the AWG peg (1.79, Central Bank of Aruba) stays a stated constant and is never overwritten | None | Prices page: a converted price shows the rate, provider and time; `npm run test:live` repeats the real request |
| **S3-compatible storage** (AWS S3, R2, MinIO) | Page snapshots and export files off-host | Optional | `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`, optional `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | `s3:GetObject`, `PutObject`, `DeleteObject`, `HeadObject` on the bucket | **Tested with automated mocks** (an S3-compatible fake); local-disk storage is **Tested against a real local service** | `s3-storage.test.ts` | Local disk only. **No real S3, R2 or MinIO** | A bucket and credentials (provider cost) | `GET /api/v1/ready` → `storage: ok`; export a report PDF → the object appears in the bucket |
| **Shopify** (merchant-authorised, read-only) | Exact stock quantities for **your own** shop → low-stock alerts | Optional | `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_REDIRECT_URI`, `SHOPIFY_SCOPES` (default `read_products,read_inventory,read_locations`), `SHOPIFY_API_VERSION`, `TOKEN_ENCRYPTION_KEY` | A Shopify app (Partner account) whose **merchant approves** the three read scopes. Never a competitor's store | **Blocked pending credentials** | The whole OAuth + sync flow against a local imitation (`shopify-oauth.test.ts`); stand-in inventory in `tests/support` | The public `products.json` feed of two real Shopify shops was probed (not collected) on 2026-10-14; collection through it has only run on fixtures. **No Shopify app, no merchant authorisation** | Shopify app credentials and your merchant authorisation | Settings → Integrations → enter `*.myshopify.com` → approve in Shopify → status *connected* → "Sync now" → My stock shows units labelled "Authorised inventory" |
| **YouTube Data API v3** | Public uploads and public view/like/comment counts of competitor channels | Optional | `YOUTUBE_API_KEY` | A Google Cloud project with the API enabled; an API key (10,000 units/day; about 3 per channel per sync) | **Blocked pending credentials** | `social-health.test.ts`, `social-providers.test.ts` (imitations of the API) | None | An API key from you | Settings → Integrations → YouTube *ready* → confirm a channel → "Sync now" → Marketing activity lists videos with counts |
| **Meta — Instagram** (Business Discovery) | Public posts and like/comment counts of competitors' **professional** accounts | Optional | `META_ACCESS_TOKEN`, `META_INSTAGRAM_BUSINESS_ACCOUNT_ID`, `META_APP_ID`, `META_APP_SECRET` | Meta developer app; token scopes `instagram_basic`, `pages_show_list`, `pages_read_engagement`; **App Review (Advanced Access) and Business Verification** for production | **Blocked pending credentials and Meta approval** | Imitation of the Graph API (token health, quotas, revoked grants, backoff) | None | Meta app credentials and Meta's review | Instagram card: *ready*, **token valid**, days left, no missing permissions → confirm an account → "Sync now" |
| **Meta — Facebook Pages** | Public posts of other Pages with reaction/comment/share counts | Optional | `META_ACCESS_TOKEN`, `META_APP_ID`, `META_APP_SECRET` | The **"Page Public Content Access"** feature (App Review + Business Verification). A Page owner connecting their own Page only helps with your own marketing | **Blocked pending credentials and Meta approval** | Same imitation | None | Same | Facebook card leaves *needs platform approval* and shows *ready* → "Sync now" |
| **Anthropic API** (optional AI) | Written daily summary, second opinion on uncertain matches, extraction fallback — every output checked against stored facts or discarded | Optional — the pipeline is fully deterministic without it | `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `AI_MODEL` | An API key; usage is billed to you, so nothing is called without your key and consent | **Blocked pending credentials** (and your decision to incur cost) | A fake provider and a local imitation of the Messages API | None | An API key and your approval of the cost | `GET /api/v1/ready` → `ai: ok`; generate a report: the summary appears as "validated" or is discarded |
| **Headless browser** (Playwright + Chrome/Edge/Chromium) | Collect JavaScript-only websites | Optional | `BROWSER_RENDERING_ENABLED=true`, `BROWSER_CHANNEL` (`chrome`/`msedge`) or `BROWSER_EXECUTABLE_PATH` | An installed browser; same robots/rate-limit/SSRF rules; never solves challenges | **Tested against a real local service** | — | Real system Chrome against local pages (`browser.test.ts`, 6 tests incl. the WebSocket-bypass fix). **No live JavaScript-only shop** | A JavaScript-only website you authorise | `GET /api/v1/ready` → `browser_rendering: ok`; the website's capability report no longer says it needs rendering |
| **Token encryption key** | Encrypts stored authorised-connection tokens | Required in production | `TOKEN_ENCRYPTION_KEY` — a key ring `id:base64(32 bytes)`; generate: `node -e "console.log('k1:'+require('crypto').randomBytes(32).toString('base64'))"` | none | **Tested against a real local service** (real AES-GCM) | — | Encrypt/decrypt, rotation and wrong-key behaviour | None | `GET /api/v1/ready` → `secrets: ok` |
| **Docker / hosting** | Running it for customers | Production | `deploy.env.example` | An account with a hosting provider (cost) | **Implemented, not tested** — never built or run (no Docker on the development machine) | — | None | A machine with Docker and your hosting decision | See `docs/deployment.md` |

## What I need from you, and when

| Needed | Why | Where it goes |
| --- | --- | --- |
| **Gmail address** (the sender) — in chat, or typed into `.env` as `SMTP_USER=` | To run the real verification/reset delivery test | `.env` only (git-ignored). Not secret, but never written into code or docs |
| **Gmail App Password** — typed by you into the local `.env` (`SMTP_PASSWORD=`), **never in chat** | Real mail delivery | `.env` only (git-ignored). I never print, echo or log it |
| **The first authorised website pair** — your own shop and one competitor, with the URLs | The real end-to-end collection and comparison run | Chat (URLs are not secrets). Nothing is collected from a site you have not named |
| Shopify / YouTube / Meta / Anthropic / S3 credentials | Only when you want those optional features verified live | `.env` only |

## Credential workflow (what to expect from me)

When an integration is ready for a live check I will tell you: the exact provider, why the credential is needed, the variable name,
where to get it, the minimum permissions, where to put it (your local `.env`), and ask you to supply it. I will not invent a key,
assume access exists, or mark something live that is not. Until you supply it, the integration shows an honest state
(*not set up*, *needs platform approval*, *token not valid*…) and everything else carries on.

## Provider notes

### Shopify — your own inventory (read-only)

1. In a Shopify Partner account, create an app with the redirect URL `https://<your-domain>/api/v1/integrations/shopify/callback`.
2. Set `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_REDIRECT_URI` (same URL), keep the default `SHOPIFY_SCOPES`, set
   `SHOPIFY_API_VERSION` and `TOKEN_ENCRYPTION_KEY`.
3. In **Settings → Integrations**, enter the store's `*.myshopify.com` address and approve on Shopify. The callback verifies Shopify's
   HMAC, a single-use state value and the signed-in user before storing anything.
4. Tokens are encrypted at rest, expire hourly and are refreshed under a row lock; the `app/uninstalled` webhook
   (`POST /api/v1/webhooks/shopify`, HMAC-verified) revokes the connection and wipes the tokens. **Disconnect** does the same.

Quantities only ever come from this connection (never from a public page, never for a competitor). The default
low-stock threshold is 5, configurable globally and per product. A sync that fails raises an *integration* alert that closes by itself
when the next sync succeeds.

### YouTube

Public uploads are stored with their URL, time, and the public view/like/comment counts the channel exposes (a count that is not
shown is stored as *not provided*, never as zero), and classified as promotion / launch / seasonal / brand content — **never as paid
advertising**. An API key does not expire. If the daily quota is used up the app records the exact time it resets (midnight Pacific)
and does not ask again until then; a refused key is reported as *needs a new credential* and is not retried until you replace it.

### Instagram and Facebook (Meta)

Reading *other* accounts' public content needs Meta approval; the app reports exactly what is missing instead of failing silently.

- **Token health** (no API quota used): the app asks Meta whether the token is valid, when it expires, and which permissions it carries.
  It warns 14 days before expiry, names missing permissions, and reports a revoked grant (password change, app removed, permission
  withdrawn) as *token not valid*. Needs `META_APP_ID` + `META_APP_SECRET`; without them it says the expiry cannot be checked.
- **Renewal:** Meta user tokens last about 60 days and are renewed by a person (generate a new token and update `META_ACCESS_TOKEN`);
  a Business Manager **system-user token does not expire** and is the right choice for production. The app does not auto-refresh a
  token it cannot store securely.
- **Rate limits / quotas:** the retry policy honours `Retry-After`, backs off exponentially (capped at 6 h), re-checks a missing approval
  daily, and never retries a refused credential until it is replaced. A person pressing "Sync now" cannot override a rate limit or quota.
- **Facebook Pages:** public posts of *other* Pages need "Page Public Content Access"; without it the status reads *needs platform approval*.

No scraping and no logged-in browsing is ever used as a fallback. Observed posts are **observed content**, never confirmed paid campaigns.

### Email

Real delivery over SMTP. **Without it nobody can register** (an account is usable only after its emailed verification link is opened) **and nobody can reset a
password**, and no report or alert email is sent. The app says so wherever it matters (registration page, Settings → Notifications, `/api/v1/ready`);
it never claims a message was sent unless the mail server accepted it.

**Gmail setup (about five minutes):**

1. Turn on **2-Step Verification** for the Google account that will send the mail (https://myaccount.google.com/security). An App Password is only offered once this is on, and some account types (for example accounts managed by a school or company, or with Advanced Protection) cannot create one.
2. Create an **App Password**: https://myaccount.google.com/apppasswords → give it a name such as "Shelfwatch" → Google shows 16 letters in four groups. Copy them. This is *not* your normal password; it can be revoked at any time without changing your real one.
3. Open the `.env` file in the project folder in a text editor (it is git-ignored) and set exactly these lines (add the lines if they are missing; leave `EMAIL_FROM` empty or delete it):

   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=your.address@gmail.com
   SMTP_PASSWORD=abcd efgh ijkl mnop
   EMAIL_FROM=
   APP_BASE_URL=http://localhost:5173
   ```

   Spaces in the App Password are fine (they are ignored). Port 465 with `SMTP_SECURE=true` works too. **Type the password into the file yourself; do not paste it into a chat, an issue, a screenshot or a commit.**
4. Check it from the terminal: `npm run email:check` (signs in only) or `npm run email:check -- someone@example.com` (also sends one real message). It prints what it is using — never the password — and, on failure, the plain-language reason (wrong password, App Password required, port blocked…).
5. Restart `npm run dev`. Register an account with an address you can read; the verification email arrives from your Gmail address.

Things to know: Gmail always sends as the signed-in account (so `EMAIL_FROM`, if set, must be that address); a normal Gmail account allows roughly 500 messages a day; messages sent to yourself may land in "All Mail" rather than the inbox; verification, reset and invitation links are built from `APP_BASE_URL`, so set it to the address people really use once the app is hosted.

**What is recorded:** every message goes into the `email_outbox` table first. `queued` → `sent` (the mail server accepted it; its Message-ID and final answer are stored) or `retrying` (a temporary problem such as a refused connection; retried up to six times at one-minute intervals) or `failed` (a permanent refusal such as bad credentials or a rejected recipient, with the reason) or `not_configured` (no mail server: never sent). Settings → Notifications shows the latest messages and can send a test message to you.

**Security:** the connection must be encrypted (STARTTLS is required unless the server is on this machine); credentials exist only in `.env`; the password is never logged, stored in the database, or included in an error message; registration, resend and reset answer identically whether or not an address has an account; a verification or reset link works once and expires (48 hours / 1 hour), and asking for a new one cancels the old.

### Headless browser (optional)

`BROWSER_RENDERING_ENABLED=true` lets the worker render JavaScript-only pages with Playwright, driving an installed browser
(`BROWSER_CHANNEL=chrome` default, `msedge`, or `BROWSER_EXECUTABLE_PATH`). Rendering obeys the same robots.txt, rate-limit and SSRF
rules: every sub-request **and every WebSocket** the page opens is screened, private and metadata addresses are aborted, and
challenges are never solved. For production, run rendering workers behind an egress firewall (see `limitations.md`: DNS rebinding
between the browser's own resolution and our check cannot be closed in application code).

### Object storage

`STORAGE_DRIVER=local` (default) or `s3`. Used for raw page snapshots (purged after 90 days; the evidence row stays) and cached
exports (deleted with their report after the history window). A file that cannot be deleted is retried on the next retention run.

### AI (optional, never required)

A written daily summary (every number checked against the stored facts, or the summary is discarded), a second opinion on uncertain
matches (a suggestion only; it can never confirm a match or upgrade past a hard conflict), and an extraction fallback whose output must
be supported by text on the page. Page text is passed as delimited, untrusted data. Costs are incurred only when you set a key.

### Exchange rates

`FX_PROVIDER=peg` (default): only the explicit, timestamped AWG/USD peg of 1.79; other currencies are *not* converted and the app says
so. `open-er-api` adds market rates (free; attribution shown). The AWG peg stays authoritative for AWG. Every converted price shows
the original amount and currency, the converted amount, the rate, the provider and the time.

## How the app reports integration state

| State shown | Meaning |
| --- | --- |
| not set up | The variable(s) are missing. The card lists exactly which, why, and where to get them. |
| ready | Configured, and nothing has contradicted that. For Meta it also means the token check passed. |
| token needs attention | Valid today, but expires soon or lacks a permission. |
| token not valid / needs a new credential | The provider refused it (expired, revoked, wrong key). Not retried until replaced. |
| needs platform approval | Configured, but the platform has not yet granted the feature (App Review, Business Verification). Re-checked daily. |
| waiting before trying again | The provider asked us to slow down or the quota is used up; the exact next-attempt time is shown. |
