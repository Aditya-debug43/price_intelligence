# Consent, permissions and responsible collection

This document describes what the platform collects, the conditions it enforces, and the decisions that remain with the
operator. It is a description of the software's behaviour, **not legal advice**; whether collecting a given website is
permitted depends on that website's terms and on local law, and has to be decided by the people responsible for the workspace.

## Status of permissions for the intended demonstration

At the time of writing, explicit permission has **not** been confirmed for:

- collecting and storing information from the source business (Groceries To Go Aruba),
- demonstrating live findings about named competitors (Ling & Sons, Super Food Aruba, Do-It Aruba, and a fourth competitor
  whose URL has not been supplied — it is deliberately not guessed),
- reading any private inventory.

Consequently:

- `npm run demo:setup` creates website entries with consent **pending**; the collect buttons stay disabled until a person records
  permission in the app (Websites → site → *Record permission…*).
- The only live access performed so far was a light **capability probe** (robots.txt, the home page, sitemap index files and
  at most three sample product pages per site, honouring robots.txt and a polite delay; no catalogue was collected, nothing
  was stored in a database). Its result is summarised in [demo-runbook.md](demo-runbook.md).
- Private inventory is not accessed. The inventory features are verified only against a clearly labelled **simulator**.

## What the software enforces

**Per website**

- Collection is refused (HTTP 409 `consent_required`) until consent is recorded; revoking consent cancels any queued or
  running scan for that site. Consent is stored with who recorded it, when, the version of the wording they saw, and an
  optional note; every change is appended to `consent_log` and `audit_events`.
- Changing a website's address resets consent and its profile: a different address is a different data source.
- Fixture sites (local, fictional) may be auto-consented only when `DEMO_AUTO_CONSENT` is on, which production forbids.

**While collecting**

- `robots.txt` is fetched and obeyed (RFC 9309 semantics, including `Crawl-delay`; 401/403/429 on robots.txt is treated as
  closed; a missing file is "no restrictions"; a 5xx is a technical failure, never permission).
- Requests are spaced per host (default 1.5 s or the site's own crawl delay if larger), with at most one concurrent request,
  `Retry-After` honoured, and a hard per-run request budget.
- Repeated 401/403/429 responses stop collection of that site; the denial is recorded and shown, and nothing is retried
  around it.
- The collector identifies itself with an honest `User-Agent` (configurable, should include a contact URL).
- Only ports 80/443; private, loopback, link-local and metadata addresses are refused (SSRF), including after redirects and
  when a name resolves to a mix of public and private addresses.
- The software **never**: solves or bypasses CAPTCHAs or bot challenges, logs in, creates accounts at competitors, adds items
  to carts, uses proxies or rotates identities, or ignores rate limits. A login wall or challenge is reported as *Blocked*.
- Content from pages is treated as untrusted data. It is never executed, and when an AI model is used (optional) the page text
  is delimited as data and the model's output is validated against the page.

**Your own shop's inventory**

- Quantities come only from a connection the shop owner authorises (Shopify OAuth, read-only scopes
  `read_products, read_inventory, read_locations`). Tokens are encrypted at rest (AES-256-GCM key ring), expire and refresh
  automatically, and are revoked and wiped on disconnect or when Shopify reports the app uninstalled.
- Competitor stock is only ever "in stock / sold out" from the public page, and never raises an alert.

**Social media**

- Only official APIs (YouTube Data API; Instagram Business Discovery and Facebook Page public content via a Meta app), with
  credentials the operator supplies. Accounts found on a website's footer are only used after the workspace confirms them.
  No scraping and no logged-in browsing.
- What is stored is public content with its URL and time. It is classified (promotion / launch / seasonal / brand) with a
  stated confidence and is **never** described as a paid campaign.

## Data held

- Workspace users: email, display name, scrypt password hash, sessions.
- Business data: websites, products, prices and stock observations, offers, flyers, marketing items, reports, alerts, audit log.
- Evidence: the fetched page (or API response) for each observation for 90 days by default, then deleted (the observation and
  its source link remain). History is kept ~365 days by default. Both are configurable in Settings → Reports & schedule.
- No end-customer personal data of any shop is collected. Shopify access is limited to products, inventory and locations.
- Removing a website deletes its products, observations, offers, evidence and matches. Saved reports are immutable and are
  retained according to the workspace policy.

## Decisions that stay with the operator

1. Whether each website's terms allow automated reading of its public pages for price comparison, and in which jurisdiction.
2. A contact page for the bot (`COLLECTOR_USER_AGENT`) so site owners can reach you or ask you to stop.
3. A privacy notice for your users and a data-processing agreement where one is required.
4. Meta App Review / Business Verification for Instagram and Facebook; a YouTube API key and its quota.
5. Permission from the shop owner before connecting inventory, and before showing their data to third parties.
6. Retention periods that match your obligations.

If a competitor asks you to stop, set the site to inactive or revoke consent in the app; collection stops immediately and
queued work is cancelled.
