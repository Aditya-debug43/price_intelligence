# Collection rules, authorisation and responsible collection

This document describes what the platform collects, the conditions it enforces, and the decisions that remain with the customer.
It describes the software's behaviour and is **not legal advice**: whether collecting a given website is lawful and within that
website's terms depends on the website and on local law, and has to be decided by the people responsible for the workspace.

## Four different things — and the product keeps them apart

| What | Whose decision | How the product treats it |
| --- | --- | --- |
| **Public information on a competitor's website** (prices, product pages, banners, flyers shown to every visitor) | The customer, for their own business analysis, within the website's terms and the law that applies to them | The customer **confirms the collection rules** for each website (see below). This is the customer's confirmation, recorded with their name, the time and the wording they saw. **It is never described as the competitor's approval, and the product never asks a competitor for any.** |
| **The customer's own website** | The customer (they own it or are authorised by its owner) | The customer confirms they are entitled to have it analysed. |
| **Private inventory quantities of the customer's own shop** | The store owner, through the platform's own authorisation | A separate, real authorisation: a merchant-authorised, read-only connection (Shopify OAuth). Never inferred, never assumed, never requested for a competitor. |
| **Websites that prohibit or block collection** | The website | Respected, not worked around: a robots.txt that disallows collection, a login wall, a CAPTCHA / bot challenge, repeated 401/403/429 answers all end collection for that website. The website is reported as *Blocked* with the reason and the authorised alternatives (a product feed, API access, written permission, replacing the competitor). |

## Why the customer's confirmation is required

Shelfwatch cannot read a website's terms of use for you. Before collecting from a website, the customer confirms — in the
website's page in the app (*Websites → site → Confirm collection rules…*) — that they understand what the software does
(only what every visitor can see, a polite pace, robots.txt followed, no sign-in, no challenge-solving, stops when refused),
that this is **their** confirmation rather than the website owner's approval, and that they have checked that the website's terms and the
law that applies to them allow the use they intend, accepting responsibility for it. Collection does not start without it (HTTP 409
`consent_required`), and *Stop collecting from this website* ends it at once and cancels queued work. This design does **not** need
any competitor's personal sign-off to collect public pages: that would not be a real-world requirement for public information, and
pretending otherwise would only produce a meaningless checkbox.

What is stored: who confirmed, when, the wording version (`v2`), an optional note ("read the terms of use on 18 Oct"), in `consent_log`
and `audit_events`. Changing a website's address is not possible (the data belongs to the website it came from): remove it and add the new one.

## What the software enforces while collecting

- `robots.txt` is fetched and obeyed (RFC 9309 semantics, including `Crawl-delay`; 401/403/429 on robots.txt is treated as closed; a missing file means "no restrictions"; a 5xx is a technical failure, never permission).
- Requests are spaced per host (default 1.5 s or the site's own crawl delay if larger), with at most one concurrent request, `Retry-After` honoured, and a hard per-run request budget.
- Repeated 401/403/429 responses stop collection of that site; the denial is recorded and shown, and nothing is retried around it.
- The collector identifies itself with an honest `User-Agent` (configurable; set a contact URL so website owners can reach you or ask you to stop).
- Only ports 80/443; private, loopback, link-local, metadata and internal addresses are refused (SSRF) when a website is added **and** when it is fetched, including after redirects and when a name resolves to a mix of public and private addresses. No setting relaxes this.
- The software **never**: solves or bypasses CAPTCHAs or bot challenges, logs in, creates accounts at competitors, adds items to carts, uses proxies or rotates identities, or ignores rate limits. A login wall or challenge is reported as *Blocked*.
- Content from pages is treated as untrusted data. It is never executed, and when an AI model is used (optional) the page text is delimited as data and the model's output is validated against the page.

## Your own shop's inventory

- Exact quantities come only from a connection the store owner authorises (Shopify OAuth, read-only scopes `read_products, read_inventory, read_locations`). Tokens are encrypted at rest (AES-256-GCM key ring), expire and refresh automatically, and are revoked and wiped on disconnect or when Shopify reports the app uninstalled.
- Without that connection the product shows only what the public page says ("in stock" / "sold out"), and says that the exact quantity is unknown. It never estimates a quantity.
- Competitor stock is only ever "in stock / sold out" from the public page, and never raises an alert.

## Social media

- Only official APIs (YouTube Data API; Instagram Business Discovery and Facebook Page public content via a Meta app), with credentials the operator supplies. Accounts found on a website's footer are used only after the workspace confirms them. No scraping and no logged-in browsing.
- What is stored is public content with its URL and time. It is classified (promotion / launch / seasonal / brand) with a stated confidence and is **never** described as a paid campaign.

## Data held

- Account: email, display name, scrypt password hash, sessions (hashed), emailed single-use tokens (hashed).
- Business data: websites, products, prices and stock observations, offers, flyers, marketing items, reports, alerts, audit log.
- Evidence: the fetched page (or API response) behind each observation for 90 days by default, then deleted (the observation and its source link remain). History is kept ~365 days by default. Both are configurable in Settings → Reports & schedule.
- No end-customer personal data of any shop is collected. Shopify access is limited to products, inventory and locations.
- Removing a website deletes its products, observations, offers, evidence and matches. Saved reports are immutable and are retained according to the workspace policy.

## Decisions that stay with the customer / operator

1. Whether each website's terms allow automated reading of its public pages for price comparison, and under which jurisdiction.
2. A contact page for the bot (`COLLECTOR_USER_AGENT`) so website owners can reach you or ask you to stop.
3. A privacy notice for your users and a data-processing agreement where one is required.
4. Meta App Review / Business Verification for Instagram and Facebook; a YouTube API key and its quota.
5. Authorisation from the store owner before connecting inventory, and before showing their data to third parties.
6. Retention periods that match your obligations.

If a website's owner asks you to stop, press *Stop collecting from this website* (or remove it): collection ends immediately and
queued work is cancelled.

## What has actually been collected from real websites

Only the capability probes recorded under `docs/` (read-only: robots.txt, the home page, sitemap index files and at most three
sample pages per site). The first real catalogue collection happens only on websites the customer names and confirms; see
[verification-report.md](verification-report.md) for exactly which live tests were run and against what.
