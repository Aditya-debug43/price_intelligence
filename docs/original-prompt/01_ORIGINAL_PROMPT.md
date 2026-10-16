<!-- Verbatim copy of the user's message, saved for context preservation. Wrapper tags removed; text otherwise unchanged. Sent 2026-10-13T18:02Z. -->

# Build a Complete Competitor Intelligence Platform — Full Development Instructions

## 1. Your role and objective

Act as a senior software architect, full-stack developer, data engineer, web research specialist, product designer, and technical lead.

Your task is to **design, develop, test, and deliver a functional, standalone competitor intelligence web application** for business owners.

This is an actual software development assignment. Do not stop after creating a research document, architecture proposal, roadmap, or static frontend. Build the application, integrate its components, test the resulting system, fix issues, and continue until a useful end-to-end MVP is working.

You have the freedom to make appropriate technical decisions, research solutions, and choose the most reliable architecture for the requirements below.

Do not ask me to approve every phase. Make reasonable decisions independently, document important assumptions, and keep implementing. Ask questions only when a genuine blocker requires information that cannot safely be handled with a configurable default.

The finished product should be capable of accepting website URLs from different customers, inspecting the websites, analysing their competitive landscape, and producing useful business intelligence reports.

---

# 2. Business requirement

The project is intended to solve the following business problem.

A customer provides:

- One URL for their own/source website.
- Three to five competitor website URLs.

The system analyses the customer's entire discoverable product catalogue and compares it against the catalogues of the provided competitors.

The resulting intelligence report should include:

1. Product price comparisons.
2. Low-stock alerts for the customer's own website.
3. Competitor social media and marketing activity.
4. Discounts, offers, promotions, and promotional flyers.
5. Historical changes and price trends.
6. Product assortment gaps and newly discovered products.
7. Other useful, evidence-backed business insights.

The customer should be able to repeat this process and receive updated information on a regular schedule.

This should become a reusable software product, not a website-specific scraper.

## Core user journey

The expected workflow is:

1. The user creates an account.
2. The user creates a business workspace.
3. The user enters their own website URL.
4. The user adds three to five competitor URLs.
5. The system inspects each website and identifies which information is technically available and can be collected under the applicable access rules.
6. The system discovers product pages and collects available data.
7. It normalises product information, prices, currencies, and product variants.
8. It identifies identical and comparable products across websites.
9. It analyses prices, offers, availability, stock risks, promotional activity, and product assortment.
10. It identifies important changes and generates business insights.
11. It saves a timestamped report that the customer can reopen.
12. It monitors the websites regularly and generates subsequent reports.
13. It sends alerts and a concise report summary to the customer.

The system must not pretend that every website exposes all the necessary information. When data is unavailable or collection is blocked, the customer should see the limitation and its reason.

**Universal website support means the system can accept arbitrary customer-submitted URLs and choose an appropriate collection strategy for each site. It does not mean every website is guaranteed to expose every field or support complete automated collection.**

---

# 3. Customer requirements and decisions

Treat this section as the current product specification.

## 3.1 Source and competitor websites

One source website and three to five competitor websites.

The initial maximum is five competitors per workspace.

The entire discoverable website catalogue should be considered, subject to the collection limits of the site.

Do not restrict the product to grocery stores, a particular e-commerce platform, a single region, or a fixed list of websites.

The collection method must be selected dynamically based on the website being inspected.

## 3.2 Initial demonstration

The source website for the initial demonstration is:

`https://groceriestogoaruba.com/`

This is the website of the grocery business whose competitive intelligence should be demonstrated.

The initial demonstration is expected to use Aruba's local business context, but the product must ultimately support businesses in other regions and industries.

The reporting currency must be configurable. Detect the currency used by each website rather than assuming all sites use the same currency.

The customer should see both the original displayed price and the normalised comparison price when currency conversion is required.

## 3.3 Low-stock monitoring

Low-stock alerts apply to the customer's own website only.

Competitor availability may be displayed in comparison reports, but competitor stock must not trigger the customer's low-stock notifications.

Use the following two collection modes.

**Public mode:** Collect publicly visible availability information. This may reveal whether a product is available or unavailable, but not necessarily the number of units remaining.

**Connected inventory mode:** If the store owner explicitly authorises an inventory integration, obtain actual inventory quantities using the relevant platform's documented, read-only permissions.

The default low-stock threshold is five units. Make it configurable.

When the quantity crosses from above the configured threshold to the threshold or below, generate an alert.

Do not generate repeated alerts for the same unchanged low-stock state.

Support low-stock, out-of-stock, restocked, and collection-failure notifications where appropriate.

Never invent stock quantities. If only availability is public, report availability changes rather than claiming that a product has five units left.

Do not estimate days until an item runs out unless adequate authorised sales data becomes available.

## 3.4 Daily reporting

The initial report must be ready by **9:00 AM Aruba local time**.

Use the IANA timezone identifier `America/Aruba`, rather than manually assuming a universal UTC offset.

Design scheduling so the collection and analysis jobs start early enough to finish before the report deadline.

Some websites may take significantly longer to inspect than others. Use measured durations, safety margins, and a rolling-refresh strategy where a complete daily catalogue refresh is infeasible.

If a website is incomplete at the deadline, produce a clearly labelled partial report when possible.

Never label stale data as freshly observed.

## 3.5 Reports and historical data

Support:

- An interactive web dashboard.
- Downloadable PDF reports.
- CSV exports.
- Excel exports.
- A concise daily email summary.
- In-app notifications.
- Email alerts.

Keep historical reports and structured observations for approximately one year initially.

Set raw webpage or document snapshot retention to 90 days by default, configurable through application settings.

Use a retention job to remove expired data without breaking references to retained reports or evidence.

## 3.6 Multiple customers

Design the architecture to support multiple business organisations and users.

For the initial demonstration, it is sufficient to configure one customer workspace and prove that the application works end to end.

The architecture must support isolated customer settings, websites, reports, alerts, and private inventory connections.

Billing is outside the current scope.

## 3.7 Social media platforms

Social media campaign and marketing information is a required product feature, not an optional idea to discard.

The initial target platforms are:

- Facebook.
- Instagram.
- YouTube.

Use official APIs and access methods that are available and permitted.

Some integrations will require application approval, business verification, customer connections, API credentials, or additional permissions.

Implement the integration structure and clear status messages for unavailable integrations. Do not fabricate connected accounts or invent successful API responses.

The system may also detect marketing banners, promotional pages, sale collections, and promotional announcements on the competitor websites themselves.

Use accurate terminology. A publicly observed promotional post is not proof that a paid advertising campaign is currently running.

## 3.8 Competitor website selection

The product must accept arbitrary competitor URLs at runtime.

Do not hardcode the demonstration competitors into the architecture.

The following websites are possible candidates for initial testing, but their final use depends on current availability and verification:

- `https://shop.lingandsons.com/`
- `https://shop.superfoodaruba.com/`
- `https://doit.aw/`

A suitable Cmart website URL has not been established. Do not invent one.

You can use representative public websites, local fixture sites, and recorded responses to test collection behaviour before the final competitor list is confirmed.

These choices must remain editable through the normal user interface.

## 3.9 Access permission and collection restrictions

Explicit permission to collect and store the source business's information, demonstrate live competitor findings, or access private inventory has not been confirmed.

Record the required consent and authorisation status. Obtain the necessary permissions before the corresponding live collection or demonstration.

Do not bypass anti-bot protections, CAPTCHAs, login requirements, robots rules, rate limits, or applicable website and platform restrictions.

Where a competitor cannot be collected appropriately, explain the limitation and allow the remaining analysis to continue.

## 3.10 Price recommendations

Price recommendation is not required for the first working MVP.

Prioritise the competitor intelligence workflow first. A future pricing recommendation module may be added separately when reliable competitor comparisons and sufficient cost data are available.

Do not delay the core project in an attempt to build advanced pricing optimisation prematurely.

## 3.11 Demo deadline

The final demo date has not been specified.

Build the application incrementally and make the first end-to-end MVP demonstrable as soon as practical.

The initial demonstration should use fresh, timestamped data, saved reports, and a small live refresh where feasible. It should not depend entirely on recrawling thousands of products during a presentation.

---

# 4. Research and technical discovery

Before selecting and implementing individual connectors, perform targeted research into current official documentation and relevant technical references.

Verify the capabilities, limitations, rate limits, permissions, and maintenance status of any external API, library, package, or service you intend to use.

Prioritise official documentation and reproducible testing over assumptions and third-party claims.

Research the following areas:

- Shopify product and inventory interfaces.
- WooCommerce's public Store API.
- Sitemaps and product feeds.
- JSON-LD, schema.org, and structured product data.
- HTML parsing.
- JavaScript-rendered product pages.
- Browser automation.
- PDF and flyer extraction.
- Product matching and variant normalisation.
- Currency conversion and unit pricing.
- Public social media APIs.
- Email delivery.
- Background jobs and scheduled reporting.
- PostgreSQL multi-tenant isolation.
- Secure collection of customer-submitted URLs.
- Hosting requirements for workers and browser rendering.

Do not spend the entire task researching. Use research to guide real implementation.

Avoid technologies that require paid access unless the integration is necessary and its costs have been approved. Prefer working local development and test paths when external credentials are unavailable.

---

# 5. Build a universal website profiler

The site profiler is a foundational subsystem.

Whenever a user submits a website URL, the application should inspect it and produce a capability report.

The profiler should attempt to discover:

- Canonical hostname and site identity.
- Website reachability and HTTP response behaviour.
- Platform fingerprint, where possible.
- Robots.txt rules and crawl-delay information.
- Sitemap locations.
- Product, collection, category, and relevant page URLs.
- Product structured-data coverage.
- Available public catalogue APIs.
- Publicly available prices and currency.
- Product variants and identifiers.
- Availability information.
- Promotions and flyer links.
- Whether JavaScript rendering is necessary.
- Login gates or other access barriers.
- Missing fields and conflicting evidence.
- Estimated catalogue size and collection effort.
- Applicable request budgets and crawl restrictions.

Persist profiling results and their timestamps.

Provide capability statuses that a nontechnical customer can understand.

| Status | Meaning |
|---|---|
| Full | The main requested information is accessible with good coverage |
| Partial | Useful information is available, but some fields or products are missing |
| Limited | Only a restricted subset of the analysis is feasible |
| Blocked | Collection cannot proceed under the permitted access conditions |
| Failed | A temporary or unexpected technical error occurred |

A failed collection must not be treated as an empty catalogue.

## Collection strategy

Implement a site-adaptive connector system.

Use the most reliable practical method for each website, choosing among:

1. Documented and permitted public catalogue APIs.
2. Sitemaps and product feeds.
3. JSON-LD, schema.org Product/Offer metadata, and microdata.
4. Server-rendered HTML parsing.
5. Validated site-specific extraction rules.
6. Headless browser rendering where necessary and permitted.
7. Evidence-validated LLM extraction as a fallback.
8. PDF or image-based flyer extraction where practical.
9. A transparent unavailable status when sufficient information cannot be collected.

Do not implement every possible method merely for completeness.

Start with robust extraction paths that cover the most useful sites, then expand the adapter library without changing the entire application.

Each connector should have a clearly defined interface and a separate implementation.

Record which extraction method was used, its version, and the quality of the results.

---

# 6. Product catalogue and historical data collection

For each discovered product, collect fields where available:

- Product title.
- Brand.
- Manufacturer or model.
- SKU, GTIN, UPC, or EAN.
- Description.
- Category.
- Variant and product identifiers.
- Weight, volume, size, colour, and pack count.
- Current selling price.
- Reference or compare-at price.
- Currency.
- Shipping cost, where available.
- Availability.
- Product URL.
- Image URL for internal display where permitted.
- First-seen and last-seen timestamps.
- Extraction method and source evidence.

Use null for unavailable values.

Handle paginated catalogues and large sites efficiently.

Implement resumable collection jobs so a temporary failure does not require restarting the entire catalogue.

De-duplicate repeated product URLs and variants using appropriate canonical URLs and product identifiers.

Preserve timestamped observations over time. Do not overwrite historical prices with only the latest price.

Track per-product freshness so customers can see when a price was last observed.

Allow catalogue discovery and monitoring to operate independently of the frontend so long-running jobs can continue when the user closes the browser.

---

# 7. Price comparison and product matching

The objective is to compare equivalent products, not simply similarly named products.

Implement four match classes:

1. Identical product.
2. Same product with a different pack size or variant.
3. Comparable product from another brand.
4. Not sufficiently comparable.

Use a matching pipeline that progressively applies:

- Valid product identifiers.
- Brand and model.
- Variant attributes.
- Pack size and quantity.
- Category.
- Normalised product names.
- Similarity scoring.
- Optional AI-assisted adjudication for ambiguous cases.
- Human review where needed.

Maintain a match confidence score and reason.

Do not label a comparison as identical unless the supporting evidence warrants it.

For groceries, size and packaging are especially important. For other sectors, model numbers and technical attributes may be decisive.

## Price normalisation

Support:

- Original currency and amount.
- Normalised reporting currency.
- Exchange rate and conversion timestamp.
- Unit prices for comparable weights, volumes, and pack quantities.
- Nullable shipping costs.
- Relevant conditional prices and offers.
- Product variants.

Keep original values for auditing.

For Aruba, the candidate sites may use both AWG and USD. Verify the actual site currencies and use a configurable currency-rate source. Any fixed exchange-rate assumptions should be explicit and timestamped rather than silently embedded in calculations.

## Price comparison interface

Display one row per source product, with competitors represented in separate columns or expandable comparison cards.

For each comparison, show:

- Product and variant.
- Source price.
- Competitor price.
- Absolute and percentage difference.
- Match class and confidence.
- Availability, where known.
- Relevant discounts or promotions.
- Last observation time.
- Evidence link.

Allow filtering and sorting by category, competitor, price difference, match confidence, and freshness.

Provide category-level or store-level statistics only when sufficient reliable matched data exists.

---

# 8. Discounts, offers, and promotional flyers

Detect publicly visible:

- Sale prices.
- Compare-at prices.
- Promotional banners.
- Coupon codes.
- Minimum-order promotions.
- Bundle offers.
- Buy-X-get-Y offers.
- Bank or payment offers.
- Cashback.
- Free-shipping thresholds.
- Time-limited discounts.
- Weekly promotional flyers and PDF specials.

Represent the offer conditions explicitly.

Distinguish unconditional discounts from conditional or deferred offers.

Store source URL, related products, original and sale prices, currency, offer conditions, first-seen date, last-seen date, stated validity dates, and verification status.

Do not automatically trust the reference price shown beside a sale price.

Use historical observations to calculate a separately labelled historical discount measure when sufficient data exists.

For newly discovered offers without adequate history, display the claimed discount and mark its historical validity as unverified.

If an offer disappears, retain its history and use a defensible expiry policy instead of immediately assuming it ended.

For flyer extraction, implement an initial pipeline that can process accessible text-layer PDFs. Add OCR or vision-based extraction where necessary and practical, with confidence indicators and human review for ambiguous entries.

Do not block the main price-comparison workflow while waiting for advanced flyer support.

---

# 9. Low-stock monitoring and inventory integration

Implement own-site inventory monitoring as a first-class feature.

## Public mode

Detect explicit product availability through structured product data or other validated public signals.

Store states such as:

- In stock.
- Out of stock.
- Limited availability.
- Explicitly claimed low quantity.
- Unknown.

Track changes between successive observations.

Do not infer exact units from simple availability indicators.

## Authorised mode

Implement the architecture for an optional read-only inventory integration.

For Shopify, use the current documented OAuth and Admin API flow, with only the permissions required to read products and inventory.

Requirements:

- Owner authorisation.
- Encrypted access tokens.
- Secure token lifecycle and revocation.
- Location-aware inventory where supported.
- Explicitly untracked inventory handling.
- Token redaction in logs.
- Configurable per-product threshold.
- Idempotent alert generation.

The default threshold is five units.

Do not fabricate successful authentication or inventory data when credentials are unavailable.

Build a development/test adapter so the stock-alert workflow can be tested without a live store connection.

---

# 10. Competitor marketing and social media activity

Social media intelligence is part of the required product scope.

Build a provider-based integration layer for Facebook, Instagram, and YouTube.

Research and use the currently available official APIs and permissions.

### YouTube

Investigate how to discover public channel uploads, titles, publication timestamps, and descriptions using the official YouTube Data API.

### Instagram

Investigate public professional-account access through the currently documented Instagram API, including requirements for a connected professional account and application permissions.

### Facebook

Investigate the requirements for access to public Page content, including application review and business verification where applicable.

### Site-level marketing

Independently of social APIs, collect accessible:

- Promotional banners.
- Announcement bars.
- Sale collection pages.
- Public campaign landing pages.
- Product launch announcements.
- Seasonal and weekly offers.

Map social handles to competitor sites using evidence from official site links or structured metadata, then let the customer confirm the account when necessary.

Do not fabricate platform connectivity. Expose integration status and required permissions in the interface.

If a public campaign cannot be reliably identified, say so.

Distinguish observed social activity from an active paid campaign.

Store original post or campaign URLs, observed timestamps, platform, permitted textual evidence, classification, confidence, and relevant product or competitor association.

Use official sources and appropriate API permissions. Do not bypass social platforms' access restrictions or collect unnecessary personal information from commenters and reviewers.

---

# 11. Business insight engine

Build a deterministic analysis layer that turns collected data into useful findings.

Potential outputs include:

- Products priced above or below matched competitors.
- Large price gaps.
- Newly discovered products.
- Apparent product launches and delistings.
- Products available at competitors but absent from the source catalogue.
- Products available at the source but absent from competitor catalogues.
- New promotional offers.
- Significant historical price movements.
- Own-site products approaching or crossing low-stock thresholds.
- Competitor availability changes.
- Important marketing activity.
- Basket-price comparisons for matched grocery items where data supports them.

Rank insights by a transparent relevance or impact score.

Every insight must include the records and observations that support it.

Do not generate generic conclusions without data.

LLMs may produce explanatory summaries of already computed results, but all prices, percentage differences, stock quantities, and other numeric facts must originate from validated records.

The analysis engine must remain useful when no AI provider is configured.

---

# 12. Reporting and scheduled monitoring

Implement daily reporting with a deadline of 9:00 AM Aruba time.

Use a proper scheduler. Compute collection start times based on expected duration and safety margins.

Track scheduled jobs independently of HTTP request lifetimes.

Requirements:

- Daily scheduled collection.
- Manual refresh.
- Progress tracking.
- Resumable jobs.
- Per-site and per-product status.
- Adaptive refresh budgets.
- Rolling refresh for large catalogues.
- Saved immutable report snapshots.
- Historical report retrieval.
- Configurable retention.
- Alert generation.
- PDF/CSV/Excel export.
- Daily email delivery where configured.

Do not recrawl an entire 10,000-product catalogue synchronously on every dashboard visit.

Prioritise matched products, current promotions, recently changed items, and products relevant to existing alerts. Rotate through the remaining catalogue under the site's collection budget.

Use last-observed timestamps to communicate freshness.

If the deadline is missed because a site is slow or unavailable, publish a partial report with an explicit warning rather than silently using empty or stale values as current results.

Build a local development scheduler mode so scheduled reporting can be tested without waiting until 9:00 AM.

---

# 13. Authentication, accounts, and tenant isolation

Implement secure authentication and organisation-level data separation.

Include:

- Registration and login.
- Secure password hashing.
- Session management.
- Logout.
- Email verification and password-reset flows when an email provider is configured.
- Business organisations/workspaces.
- Membership and role management suitable for owners and staff.
- Workspace-specific websites and settings.
- Secure access to reports and alerts.
- Private inventory connections.

Design the database for multiple organisations, with strong tenant isolation.

PostgreSQL Row-Level Security is worth considering where suitable. Regardless of the implementation, verify at both application and database levels that one organisation cannot access another organisation's private information.

Never hardcode a production administrator password.

Provide a safe local bootstrap process for development.

Billing and paid account tiers are not part of this assignment.

---

# 14. Frontend pages

Build a distinct, polished business-intelligence interface.

Use React, TypeScript, and Vite unless there is a compelling technical reason to choose another stack.

The application should be responsive and usable by a nontechnical business owner.

Create the following pages.

## A. Login and registration

Authentication, registration, and account recovery.

## B. Business setup

Input forms for the source website, three to five competitors, reporting currency, timezone, report schedule, own-stock threshold, and alert preferences.

Make all website entries editable.

## C. Website profiling

Show the collection capabilities, product discovery progress, site platform, access restrictions, available fields, missing fields, and errors.

Explain limitations in plain language.

## D. Main dashboard

Show the latest important findings, price position, matched products, stock alerts, new offers, marketing activity, catalogue coverage, and data freshness.

Use real backend data, not hardcoded KPI values.

## E. Price comparison

Provide a filterable, sortable product-versus-competitor matrix.

## F. Discounts and offers

Display observed promotions, terms, reference and sale prices, historical verification, and validity.

## G. My stock

Show low-stock, out-of-stock, restocked, and unknown states for the customer's own inventory.

Display quantities only when they have been collected through an authorised source.

## H. Marketing activity

Display permitted public campaign-related information with links, dates, classification, and evidence.

## I. Product details

Show product matches, variant details, comparison history, observations, promotions, and evidence.

## J. Historical reports

Open previous reports, compare different dates, and download PDF, CSV, or Excel exports.

## K. Data quality and coverage

Show per-site completeness, failed collections, extraction methods, confidence, and stale information.

## L. Settings

Manage workspaces, users, schedules, notification preferences, thresholds, email configurations, and authorised integrations.

Implement loading, empty, error, and partial-result states properly. Every important button or form should have a working backend action.

---

# 15. Recommended technical stack

Use an independently deployable TypeScript monorepo as the default architecture.

Suggested structure:

```text
competitor-intelligence/
├── apps/
│   ├── web/
│   ├── api/
│   └── worker/
├── packages/
│   ├── core/
│   ├── database/
│   ├── connectors/
│   └── shared/
├── tests/
├── docs/
├── scripts/
├── .env.example
├── docker-compose.yml
├── package.json
└── README.md
```

Adjust the structure if a simpler design is justified, but maintain clear boundaries between the frontend, API, worker, database, and integration code.

### Frontend

- React.
- TypeScript.
- Vite.
- A consistent component design system.
- A suitable charting library.
- Accessible tables and forms.

### Backend

- Node.js.
- TypeScript.
- Fastify.
- Zod or an equivalent runtime validation library.

### Database

- PostgreSQL.
- Drizzle ORM.
- Versioned database migrations.
- Proper indexes, constraints, and foreign keys.
- Organisation isolation.
- Timestamped observations.

### Worker

A separate background worker handles crawling, collection, matching, monitoring, scheduled reports, exports, and alerts.

Evaluate a PostgreSQL-backed queue such as pg-boss before adding Redis or additional infrastructure.

### Browser rendering

Use Playwright only where normal requests and structured data cannot obtain the needed information and where rendering is permitted.

Keep expensive browser workloads separate from the main API process.

### Storage

Support local development storage and a configurable object-storage adapter for deployment.

Do not require paid storage or cloud services for basic local development.

### AI integration

Use an optional, provider-independent abstraction.

AI may assist with ambiguous matching, flyer interpretation, fallback extraction, and summaries. Validate its outputs against evidence.

Do not require an AI API key to run the core application.

### Configuration

Create a complete `.env.example` and validate configuration at startup.

Do not commit real credentials or put provider keys in frontend code.

---

# 16. Data model

Build a clean schema appropriate for the actual implementation.

The conceptual model should cover:

### Identity

- Users.
- Organisations.
- Memberships and roles.

### Website configuration

- Sites.
- Workspace site relationships and source/competitor roles.
- Site capability profiles.
- Site access policies and crawl budgets.

### Product discovery

- Site products.
- Variants.
- Product attributes.
- Product identifiers.
- Canonical product identities or matched product pairs.
- Discovery and collection jobs.

### Evidence and observations

- Price observations.
- Stock observations.
- Offers and promotions.
- Raw snapshots or snapshot references.
- Evidence metadata.
- Extraction method and version.
- Data quality issues.

### Intelligence

- Product matches.
- Business insights.
- Marketing activity.
- Alert rules.
- Alerts and acknowledgements.

### Reporting

- Report snapshots.
- Report status.
- Export files.
- Schedule settings.
- Historical report metadata.

### Private connections

- Authorised store connections.
- Encrypted tokens.
- Inventory records and location-specific data.
- Connection and revocation status.

Use append-only observations where practical.

Preserve historical records while making current product state efficiently queryable.

Keep customer-specific inventory, settings, reports, and matches separate from publicly collected competitor information.

Use migrations for schema changes and test them on a fresh local database.

Do not create unnecessarily complicated tables before understanding their purpose.

---

# 17. API specification

Implement authenticated, versioned APIs with consistent validation and error handling.

### Authentication endpoints

Support login, registration, verification, session management, password reset, and logout.

### Website endpoints

Create, read, update, and remove source and competitor sites. Trigger profiling and retrieve capability reports.

### Collection endpoints

Start scans, read job progress, request a permitted refresh, and retrieve catalogue coverage.

### Product endpoints

Read products and variants by site, retrieve historical observations, and inspect evidence.

### Matching endpoints

List matches, filter by confidence or classification, inspect ambiguous pairs, and accept or reject match decisions.

### Intelligence endpoints

Read price comparisons, offers, stock alerts, marketing activity, assortment changes, and business insights.

### Report endpoints

List reports, retrieve a report snapshot, check report generation status, and export PDF, CSV, and Excel.

### Alert and settings endpoints

Manage thresholds, alert rules, acknowledgements, schedule configuration, email settings, and authorised connections.

Use appropriate pagination and filtering. Enforce tenant access on every relevant endpoint.

---

# 18. Security and legal requirements

Security is mandatory because customers will submit arbitrary URLs and may connect private inventory sources.

Implement:

- SSRF protection.
- Blocking of localhost, private IP addresses, link-local addresses, and cloud metadata endpoints.
- Redirect and DNS revalidation.
- Safe protocol validation.
- Request timeouts.
- Response-size and content-type restrictions.
- Per-domain rate limits and concurrency caps.
- Backoff for transient failures.
- Stop-on-access-denial handling.
- API input validation.
- Authentication and authorisation.
- Secure password hashing.
- Secret redaction.
- Encrypted connection credentials.
- Tenant isolation.
- Safe file upload and processing.
- Database backup guidance.

Respect applicable site terms, access rules, robots.txt instructions, and API conditions.

Do not bypass CAPTCHAs, anti-bot systems, login requirements, or rate limits. Do not use proxies or identity rotation to evade restrictions. Do not create competitor accounts or manipulate shopping carts to infer stock.

If a website cannot be accessed under the allowed conditions, provide the appropriate limitation state.

### LLM security

Collected webpage content is untrusted input.

A webpage, PDF, or product description may contain malicious instructions designed to influence an AI model. Treat all extracted content strictly as data.

Do not give extraction and summarisation models unrestricted access to tools, secrets, or external systems.

Validate outputs against the corresponding source evidence.

---

# 19. Data reliability rules

Implement automated tests for these invariants.

1. Unknown stock is never automatically stored as in stock.
2. Unknown shipping cost is not zero.
3. Missing prices are not converted to zero.
4. Blocked and failed collections are distinguishable from an empty catalogue.
5. Stale observations are not described as fresh.
6. Product similarity does not prove product identity.
7. Apparent discounts are not automatically described as historically verified.
8. A social media post does not automatically prove an active paid campaign.
9. AI-generated numerical facts must be validated against evidence.
10. Partial catalogue coverage must be disclosed.
11. Product observations retain their source URL and observation time.
12. Alert transitions are deduplicated.
13. A report snapshot remains consistent across dashboard and export formats.
14. One customer cannot access another customer's private data.

Every significant reported insight should be traceable to supporting observations.

---

# 20. Implementation phases

These phases define the execution order. Do not stop for approval between phases.

## Phase 1 — Project foundation

- Initialise the independent repository.
- Configure TypeScript, linting, tests, formatting, and environment validation.
- Set up the database and migrations.
- Implement authentication and workspace foundations.
- Add URL validation and SSRF-safe collection.
- Implement the site profiler and capability report UI.

At the end of this phase, a user should be able to enter a website and inspect its collection capabilities.

## Phase 2 — Product collection

- Implement the connector interface.
- Build Shopify public product collection where supported.
- Build WooCommerce collection where applicable.
- Implement sitemap discovery.
- Implement structured-data parsing.
- Implement generic HTML extraction.
- Add collection jobs and persistent status tracking.
- Save real product records with evidence and timestamps.

## Phase 3 — Product matching and pricing

- Implement product identity and variant normalisation.
- Implement identifier and attribute-based matching.
- Distinguish identical, different-pack, comparable, and unmatched products.
- Add confidence scoring and human review.
- Implement currency and unit-price normalisation.
- Build the actual price comparison UI.

## Phase 4 — Stock and offers

- Implement public availability monitoring for the source site.
- Implement the configurable threshold system and alert engine.
- Build the optional authorised inventory connection.
- Add promotion extraction and discount tracking.
- Add evidence-linked historical observations.

## Phase 5 — Daily reporting

- Implement the scheduler and background job execution.
- Make schedules timezone-aware.
- Generate and store report snapshots.
- Build the main dashboard.
- Implement PDF, CSV, and Excel.
- Implement email delivery and alert notifications.
- Add historical reports and retention.

At this point, the initial end-to-end MVP should be demonstrable.

## Phase 6 — Marketing activity

- Add discovery of on-site promotional activity.
- Implement supported YouTube API integration.
- Implement Instagram and Facebook integration pathways.
- Clearly expose missing permissions and application-review requirements.
- Add flyer extraction where practical.

## Phase 7 — Additional intelligence

- Improve assortment analysis.
- Detect new products, delistings, and historical changes.
- Implement basket-price comparisons where data is sufficient.
- Rank business insights by a transparent methodology.
- Add optional AI-generated summaries backed by validated data.

## Phase 8 — Hardening

- Fix test failures.
- Improve collection resilience.
- Verify access control.
- Validate report consistency.
- Test full end-to-end workflows.
- Improve performance and monitoring.
- Complete setup and deployment documentation.
- Prepare a demo runbook.

Continue working through these phases. If the complete scope exceeds the time available for one session, finish the most valuable working end-to-end MVP first and then implement the remaining capabilities as far as practical.

---

# 21. Acceptance criteria

The MVP is not complete merely because the application opens.

It must demonstrate the following.

### Website management

The user can create a workspace, enter one source URL and up to five competitor URLs, and see a persisted capability report for each website.

### Real data collection

The application retrieves actual product information from supported websites, saves the results, and shows provenance. Test fixtures must be identified as fixtures rather than presented as live data.

### Product comparison

The system matches appropriate products across sites, calculates differences in the backend, displays confidence, and provides evidence links.

### Offers and promotions

It displays available promotional information, validity, conditions, and historical verification status where possible.

### Stock alerts

It monitors the customer's own website, obeys the configured threshold in connected inventory mode, and does not fabricate exact quantities in public mode.

### Reports

It generates a saved report from collected data, supports historical retrieval, and exports consistent PDF/CSV/Excel versions.

### Scheduling

It supports a scheduled report ready by 9:00 AM Aruba time, with partial-result handling, data freshness, and job status.

### Marketing activity

It displays evidence-backed activity from accessible sources and accurately identifies unavailable integrations.

### Security

The URL collector rejects unsafe targets, tenant access tests pass, secrets are not committed, and critical data-quality rules are tested.

### Development quality

The project starts locally, database migrations work, linting and type checking pass, production builds succeed, and automated tests cover the primary workflows.

### Documentation

Provide setup instructions, configuration reference, migration commands, integration documentation, tests, limitations, and a demo runbook.

---

# 22. Test strategy

Implement a real test suite throughout development.

### Unit tests

Test URL normalisation, IP validation, robots parsing, product parsing, price extraction, unit conversion, currency conversion, variant handling, identifier checks, product matching, stock transitions, discount verification, and alert deduplication.

### Connector tests

Test representative responses from supported platforms and structured-data formats.

Include missing fields, conflicting prices, malformed pages, duplicate products, unsupported site structures, and invalid responses.

### Security tests

Test SSRF protection, unsafe redirects, private network access, invalid protocols, oversized responses, unauthorised endpoints, and cross-tenant attempts.

### Integration tests

Test migrations, persistence, collection job tracking, report snapshots, alert generation, exports, scheduling, and retention.

### End-to-end test

Demonstrate this entire flow:

1. Register a test user.
2. Create a business workspace.
3. Add a source site and competitor sites.
4. Profile the websites.
5. Collect products using live connectors where appropriate or deterministic local fixture servers.
6. Generate product matches.
7. Produce a price comparison.
8. Inspect offers and stock signals where available.
9. Generate and save a report.
10. Reopen the saved report.
11. Export PDF, CSV, and Excel.
12. Test notification and scheduling flows.
13. Confirm that one workspace cannot access another's private data.

Do not let the ordinary automated test suite rely entirely on live external websites. External sites can change or become temporarily unavailable; use controlled fixtures for deterministic tests and a separate live integration test procedure.

Report which live tests were actually executed.

---

# 23. Demo-specific setup

Use `https://groceriestogoaruba.com/` as the initial source website in the demo configuration.

Potential competitors are:

- `https://shop.lingandsons.com/`
- `https://shop.superfoodaruba.com/`
- `https://doit.aw/`

Verify their current behaviour and whether relevant information can be accessed appropriately.

Do not assume that every suggested competitor exposes its complete catalogue or prices.

The demo must show:

- A working onboarding process.
- Actual website profiling.
- Real product data wherever collection is supported.
- A price comparison between appropriately matched products.
- Offers and discounts where available.
- Public availability or authorised low-stock data, depending on the connection.
- Marketing activity when accessible.
- Honest data coverage and freshness information.
- A saved report and downloadable exports.

Build a way to perform a small live refresh without recrawling the entire catalogue.

Provide a development fixture mode to demonstrate blocked, partial, successful, and failed collection outcomes.

Do not claim that unavailable external data was collected.

---

# 24. Operating instructions

Begin by inspecting the working directory and available tools. Initialise the standalone project in its own directory and Git repository.

Then implement the application in coherent increments.

Use migrations for schema changes. Run targeted tests after each subsystem and broader tests after integration.

Do not hardcode credentials, pretend external services are connected, or incur paid provider costs without explicit authorisation.

Where API credentials or application approvals are missing, build and test the adapter boundary, explain exactly which prerequisite is outstanding, and continue with the rest of the application.

Do not deploy to an external production environment without explicit authorisation.

Do not finish by providing another roadmap while the implementation remains untouched.

When reporting progress, distinguish between:

- Implemented and locally verified.
- Implemented but not yet fully verified.
- Waiting for credentials or external approval.
- Not implemented.

At completion, provide:

1. A summary of working features.
2. The important files and modules created.
3. Exact commands for local setup and execution.
4. Database initialisation instructions.
5. Required environment variables.
6. Actual test results.
7. Integrations verified against live data.
8. Integrations still awaiting authorisation.
9. Remaining limitations.
10. Instructions for presenting the demo.

**Start implementing the standalone competitor intelligence platform now. The expected outcome is a working, tested application with a genuine end-to-end data collection and intelligence workflow, not just a prototype of the interface or another planning document.**
