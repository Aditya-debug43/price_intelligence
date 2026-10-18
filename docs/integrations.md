# Integrations and credentials

**Rule of this document:** nothing here is described as *live* unless it was verified against the real service. Everything below was
tested against **local imitations** of the provider (never a real provider, never a real credential) unless the "Verified" column
says otherwise. Real credential values never go in this repository, the docs, the work log, test fixtures or logs — only in your
local `.env` (git-ignored; copy `.env.example`). The app shows each integration's true state in **Settings → Integrations** and in
`GET /api/v1/ready`; it never shows "connected" for something that is mocked, unconfigured, expired or refused.

## Reference table

| Provider | Purpose | Environment variables | Permissions needed | Essential to the core price-comparison workflow? | Can the local build run without it? | Works without it | Blocked until configured | How to verify after configuration | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **PostgreSQL** | All data, row-level security, job queue | `DATABASE_URL` (app role, RLS enforced), `WORKER_DATABASE_URL` (worker role), `DATABASE_ADMIN_URL` (setup/migrations only) | App role: no `BYPASSRLS`. Worker role: `BYPASSRLS`. Created by `npm run db:setup` | **Yes** | Yes — `npm run dev:db` starts an embedded PostgreSQL | — | Everything | `GET /api/v1/ready` → `database`, `migrations`, `tenant_isolation` all `ok` | Real (embedded PostgreSQL 18 in tests and dev) |
| **Public competitor websites** | Catalogue, prices, availability, offers, flyers | none | Your **recorded consent per website** (the app will not collect without it); robots.txt is always obeyed | **Yes** | Yes | — | Collection from a website until its owner/you confirm permission | Add the website → Websites page shows its status → "Check this website" → "Collect" | Fixtures + local imitations only. **No live collection has been run** (permission not yet confirmed) |
| **SMTP email (Gmail or any SMTP server)** | **Account verification and password reset (required for anyone to register)**, invitations, daily report summary, alert emails | `SMTP_HOST`, `SMTP_PORT` (587 STARTTLS, or 465 with `SMTP_SECURE=true`), `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` (optional; defaults to `Shelfwatch <SMTP_USER>`), `APP_BASE_URL` (the public address used inside email links) | For Gmail: 2-Step Verification on the Google account and an **App Password** (never the normal password) | **Yes for customer sign-up** (not for price collection) | The app runs, but **nobody can register or reset a password** and no email is sent | Registration, password reset, every email | Run `npm run email:check -- you@example.com`; then Settings → Notifications → "Send me a test email" | Tested with a test mail server and an in-process SMTP server; **not yet against Gmail** — see "Email" below |
| **S3-compatible storage** (AWS S3, R2, MinIO) | Raw page snapshots, export files off-host | `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`, optional `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | `s3:GetObject`, `PutObject`, `DeleteObject`, `HeadObject` on the bucket | No | Yes — local disk (`STORAGE_LOCAL_DIR`) is the default | Everything (files stay on the server's disk) | Off-host storage | `GET /api/v1/ready` → `storage: ok`; generate a report → export a PDF → the object appears in the bucket | S3-compatible fake only (`s3-storage.test.ts`) — **not AWS/R2/MinIO** |
| **Shopify** (merchant-authorised, read-only) | Exact stock quantities for **your own** shop → low-stock alerts | `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_REDIRECT_URI`, `SHOPIFY_SCOPES` (default `read_products,read_inventory,read_locations`), `SHOPIFY_API_VERSION`, **`TOKEN_ENCRYPTION_KEY`** | A Shopify app (Partner account) whose **merchant approves** the three read scopes. Never a competitor's store | No | Yes | In-stock / sold-out from your public pages; threshold alerts need a quantity, so none are raised | Exact quantities; unit-count low-stock alerts | Settings → Integrations → enter `*.myshopify.com` → approve in Shopify → status *connected* → "Sync now" → My stock shows units with "Authorised inventory" | Whole OAuth + sync flow against a local imitation (`shopify-oauth.test.ts`) — **never a real store** |
| **YouTube Data API v3** | Public uploads and public view/like/comment counts of competitor channels | `YOUTUBE_API_KEY` | A Google Cloud project with "YouTube Data API v3" enabled; an API key (quota 10,000 units/day; about 3 units per channel per sync) | No | Yes | Everything except YouTube posts | YouTube activity | Settings → Integrations → YouTube card shows *ready* → confirm a channel → "Sync now" → Marketing activity lists videos with counts | Local imitation (`social-health.test.ts`, `social-providers.test.ts`) — **no live call** |
| **Meta — Instagram (Business Discovery)** | Public posts and like/comment counts of competitors' **professional** accounts | `META_ACCESS_TOKEN`, `META_INSTAGRAM_BUSINESS_ACCOUNT_ID`, `META_APP_ID`, `META_APP_SECRET` (the last two let the app check the token's expiry) | Meta developer app; token scopes `instagram_basic`, `pages_show_list`, `pages_read_engagement`; **App Review (Advanced Access) + Business Verification** for production | No | Yes | Everything except Instagram posts | Instagram activity | Settings → Integrations → Instagram card: *ready*, **token valid**, days left, no missing permissions → confirm an account → "Sync now" | Local imitation — **no live call** |
| **Meta — Facebook Pages** | Public posts of other Pages with reaction/comment/share counts | `META_ACCESS_TOKEN`, `META_APP_ID`, `META_APP_SECRET` | The **"Page Public Content Access"** feature (App Review + Business Verification). The alternative — a Page owner connecting their own Page — only helps with your own marketing | No | Yes | Everything except Facebook posts | Facebook activity | Facebook card leaves *needs platform approval* and shows *ready* → "Sync now" | Local imitation — **no live call** |
| **Exchange rates** | Convert competitor prices in other currencies | `FX_PROVIDER=peg` (default) or `open-er-api` (free, no key; the app shows the required attribution) | none | No | Yes | Fixed, timestamped AWG/USD peg 1.79 (authoritative for AWG); other currencies are **not** converted and the app says so | Conversion of non-peg currencies | Prices page: a converted price shows the rate, provider and time | Local imitation of open.er-api.com — **no live call** |
| **Anthropic API** (optional AI) | Written daily summary, second opinion on uncertain matches, extraction fallback — all evidence-checked | `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `AI_MODEL` | An API key (usage is billed to you; nothing is called without a key) | **No — the pipeline is fully deterministic** | Yes | Everything | AI summary and adjudication | `GET /api/v1/ready` → `ai: ok`; generate a report: the summary appears with "validated" or is discarded | Fake provider + local imitation of the Messages API — **no live call** |
| **Headless browser** (Playwright + Chrome/Edge/Chromium) | Collect JavaScript-only websites | `BROWSER_RENDERING_ENABLED=true`, `BROWSER_CHANNEL` (`chrome`/`msedge`) or `BROWSER_EXECUTABLE_PATH` | An installed browser. Same robots/rate-limit/SSRF rules; never solves challenges | No | Yes | Websites that serve products in HTML/JSON/feeds | JavaScript-only sites are reported *Limited*, with the reason | `GET /api/v1/ready` → `browser_rendering: ok`; the website's capability report no longer says it needs rendering | Real system Chrome against **local** pages (`browser.test.ts`) — no live site |
| **Token encryption key** | Encrypts stored authorised-connection tokens | `TOKEN_ENCRYPTION_KEY` — a key ring `id:base64(32 bytes)`; generate one with `node -e "console.log('k1:'+require('crypto').randomBytes(32).toString('base64'))"` | none | No (required in production) | Yes in development | Everything except storing Shopify tokens | Shopify connection | `GET /api/v1/ready` → `secrets: ok` | Real |

"Essential" means essential to the **core website-comparison workflow** (profile → collect → match → compare → report). None of the
optional integrations ever blocks real public-web price collection.

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

Quantities only ever come from this connection (or the development simulator, labelled SIMULATED, demo workspaces only). The default
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
| simulated / fixture | Development or demonstration data, labelled as such everywhere it appears. |
