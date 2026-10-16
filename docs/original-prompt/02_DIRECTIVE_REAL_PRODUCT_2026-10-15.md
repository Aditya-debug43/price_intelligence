<!-- Verbatim copy of the user's message, saved for context preservation. Wrapper tags removed; text otherwise unchanged. Sent 2026-10-15T07:38Z. -->

SHELFWATCH — COMPLETE PROJECT CONTEXT PRESERVATION AND REAL-PRODUCT IMPLEMENTATION
Your role
Act as a senior full-stack engineer, software architect, data engineer, security engineer, QA engineer, and technical project lead.
You have already spent substantial time building a project called Shelfwatch, a competitor intelligence platform for businesses.
I ran the demo application. I do not want to spend time reviewing a dashboard whose data comes from fictional fixture websites. I want to move beyond the demo and make the actual product work with real users, real websites, real catalogues, real prices, real comparisons, real inventory connections where authorised, real notifications, and genuinely usable reports.
Do not restart the project from scratch. First understand, document, and verify everything already built. Then continue from the current codebase.
This is an implementation task, not a request to create another plan, mockup, prototype, or documentation-only deliverable.
PART 1 — FIRST PRIORITY: PRESERVE ALL PROJECT CONTEXT
1.1 Do this before modifying application code
Before implementing new features, thoroughly reconstruct the history and current state of this project.
First, locate and reread my original, complete project prompt, in which I explained what the platform should do. Read the entire original prompt, not merely a short summary or selected requirements.
Also reread the relevant conversation history and your previous implementation notes that are accessible in this environment.
Examine the actual repository, Git history, existing documentation, configuration templates, test suites, database schema, scripts, and current application code.
Do not assume that your previous statements about features being implemented or tested are necessarily correct. Verify them against the actual repository and available test evidence.
If you cannot access the original prompt, explicitly record that limitation and ask me to provide the original prompt. Do not pretend to have read material that is unavailable. You may continue a non-destructive audit and document verified existing work, but do not silently invent or change original requirements.
1.2 Create the master context file first
Before changing the application, create:
`docs/PROJECT_CONTEXT.md`
This must be a detailed, persistent record of the entire project history and current state, from initial setup through the most recent work.
I want enough detail that, if I open a completely new Claude Code session in the future, Claude can read this file and understand the project without needing the original conversation.
Do not create a short, generic overview. Document the actual work performed, using repository evidence and the available historical conversation.
Include the following sections.
A. Project origin and complete requirements

* The purpose of Shelfwatch.
* The full requirements from my original prompt.
* All subsequent clarifications and decisions.
* The intended users and business use cases.
* Every required major feature and expected user workflow.
* All explicit constraints, deadlines, time zones, retention requirements, and data-quality requirements.
* Features that are core requirements versus optional enhancements.
* Any requirements that remain ambiguous, unavailable, or unresolved.

Preserve the original intent and terminology. Do not silently replace requirements with your preferred architecture or reduce the scope.
B. Chronological implementation history
Create a chronological record of work performed, beginning with initial repository inspection.
Include, as far as the accessible history and repository evidence allow:

* Initial environment inspection.
* Repository structure and architecture decisions.
* Dependencies and technologies installed.
* Packages and applications created.
* Database schema and migration work.
* Algorithms implemented.
* Connectors and collection strategies developed.
* Backend APIs and services implemented.
* Frontend pages and components created.
* Authentication and security implementation.
* Background workers and scheduled jobs.
* Report generation and notification systems.
* Bugs discovered, their causes, and how they were fixed.
* Changes to commands, scripts, configuration, and environment variables.
* Test suites added and important test results.
* Production build checks and browser tests.
* Integrations attempted, mocked, or verified.
* Git commits and major checkpoints.
* Features left incomplete because of time, tooling, permissions, credentials, or other blockers.

Distinguish clearly between work that is confirmed by repository evidence and claims that exist only in the historical transcript.
Do not invent a file change, successful test, or completed integration if you cannot verify it.
C. Actual repository structure
Document the actual directory tree, including:

* `apps/web`
* `apps/api`
* `apps/worker`
* `packages/shared`
* `packages/core`
* `packages/database`
* `packages/connectors`
* `packages/services`
* `fixtures`
* `scripts`
* `tests`
* `docs`

Include other relevant folders and files that actually exist.
For every significant directory, explain its responsibility and important files, and show how the frontend, API, worker, business logic, connectors, and database communicate.
D. Detailed implementation inventory
Create a feature-by-feature inventory.
For each feature, record:

1. The requirement.
2. The primary implementation files.
3. The associated API endpoints.
4. The services or modules involved.
5. The database tables used.
6. The external services or integrations required.
7. Existing tests.
8. What has been verified.
9. What has not been verified.
10. What remains to be implemented or improved.

Cover the dashboard, websites, product catalogue, product matching, price comparison, price history, stock monitoring, promotions, marketing intelligence, alerts, reports, exports, users, organisations, integrations, scheduling, data quality, and settings.
E. Database and data flow
Document:

* Every actual database table and its purpose.
* The relationships between tables.
* Organisation and tenant isolation.
* Product and product-variant modelling.
* Website and competitor records.
* Observations and historical snapshots.
* Product matches and manual review.
* Stock history and alert records.
* Promotion and marketing observations.
* Report snapshots and generated exports.
* User authentication and session storage.
* Retention and deletion policies.
* Migration history.
* Database roles and Row-Level Security policies.

Explain the data flow from entering a website URL to collecting products, normalising data, comparing competitors, producing insights, and generating reports.
F. Environment, commands, and integrations
Document all important development commands, including:

* Dependency installation.
* Database startup.
* Development startup.
* Fixture demo startup.
* Testing.
* Typechecking.
* Linting.
* Production builds.
* Migrations.
* Environment setup.

List environment-variable names, what each controls, whether it is required, and which integration uses it.
Never put actual API keys, passwords, OAuth tokens, session secrets, private connection strings, or other sensitive values into the context file. Record only variable names and whether they are configured, missing, or unverified.
G. Testing and verification history
Record the latest verifiable results for unit tests, integration tests, end-to-end tests, linting, typechecking, browser behaviour, mobile behaviour, production builds, and external integrations.
The previous implementation report claimed 393 tests passed and documented several integrations that had only been tested against mocks. Treat those figures as historical claims that must be verified against the current repository and actual results.
Separate these statuses explicitly:

* Implemented.
* Tested using fixtures.
* Tested using mocks.
* Tested against a real local service.
* Tested against a real external service.
* Not tested.
* Blocked by credentials or authorisation.

H. Known defects and incomplete work
Include all known issues, technical debt, unverified features, limitations in website support, missing credentials, incomplete documentation, deployment limitations, and remaining product requirements.
I. Next implementation roadmap
Create a prioritised roadmap that distinguishes blockers, core live functionality, integrations, production hardening, and optional enhancements.
1.3 Create an implementation work log
Also create:
`docs/WORK_LOG.md`
This is a chronological engineering log that you will update throughout this task.
Record each major action, important files changed, commands executed, tests run, results, problems discovered, decisions made, and outstanding issues.
Use dated or timestamped entries where practical.
The master context file describes the complete project and its current state. The work log records what happens next.
After creating both files, inspect them for accuracy and consistency with the repository. Then continue implementing the project in the same session. Do not stop after writing documentation.
Update the context file and work log after each major implementation phase and before stopping due to a usage limit.
PART 2 — REREAD AND APPLY MY ORIGINAL REQUIREMENTS
After preserving the existing context, revisit the original complete prompt and build a requirements checklist.
The following requirements must also be treated as the core acceptance criteria, together with any additional requirements in my original prompt.
Do not discard earlier requirements simply because this implementation will be large.
2.1 The core business workflow
A real customer must be able to open Shelfwatch, authenticate, create or access their organisation, enter the URL of their own business website, and enter between 3 and 5 competitor website URLs.
The application must then:

1. Validate and profile the submitted websites.
2. Determine what data can realistically be collected from each website.
3. Collect the available product catalogue from supported sites.
4. Normalise product information, prices, sizes, identifiers, currencies, and availability.
5. Match equivalent products across websites.
6. Compare prices of genuinely comparable products.
7. Identify promotions, discounts, and offers.
8. Monitor stock on the customer's own website.
9. Collect permitted public marketing observations where supported.
10. Generate evidence-backed insights.
11. Produce a dashboard and downloadable reports.
12. Maintain historical observations and detect changes over time.
13. Schedule recurring scans, daily reports, and alerts.
14. Explain gaps, stale data, inaccessible pages, and unsupported capabilities honestly.

The user should not have to select each product manually before the platform can discover the catalogue. Catalogue discovery and collection must be automated wherever the website permits it.
The application must work with newly entered customer and competitor URLs, not only a hardcoded list of demonstration stores.
2.2 Make the primary workflow genuinely functional
The critical user journey must work end to end:
Register or sign in → set up organisation → enter own website → enter 3–5 competitors → profile sites → start collection → process catalogue → review product matches → compare prices → view offers and stock alerts → generate report → export results → schedule future monitoring.
Every visible control associated with this workflow must perform its advertised action.
Do not consider a feature finished because a page exists, a button renders, an API returns HTTP 200, or a test fixture demonstrates a happy path.
Verify the persisted data and the actual user-visible result.
Do not redesign everything unnecessarily. Keep the existing Shelfwatch interface and working implementation where they are good, and improve them where needed to support real usage.
PART 3 — REMOVE FICTIONAL DATA FROM THE REAL PRODUCT EXPERIENCE
This is one of my highest priorities.
The application currently has a fixture-driven demonstration mode. Keep it for development and testing, but separate it clearly from real customer workspaces.
3.1 Explicit demo and live environments
Implement and verify a clear separation between:

* Demo mode: fictional websites, seeded products, and synthetic observations.
* Live mode: real user-submitted websites, actually collected data, and genuinely connected external services.

Demo fixtures must never silently appear as live business information.
Do not initialise a new real customer workspace with made-up competitors, fabricated price observations, fictional stock quantities, simulated sales offers, or fake marketing campaigns.
The live workspace must start empty or display its real setup status until collection succeeds.
If a customer has collected only part of a catalogue, show that the catalogue is partial. Never fill missing competitors or products with fictional records to make a comparison table appear complete.
Store data provenance so the application knows whether information came from a real observation, an authorised API, a user action, an exchange-rate service, or a clearly labelled fixture.
When a capability is unavailable, display an honest status such as:

* Not configured.
* Not yet collected.
* Collection in progress.
* Partially collected.
* Access denied.
* Unsupported by this website.
* Awaiting manual product-match review.
* Stale data.
* Successfully collected.

Do not convert failures into empty successful results. Distinguish “no matching product found” from “the competitor website could not be collected.”
3.2 Remove hardcoded demo assumptions from live logic
Audit the whole project for:

* Hardcoded demonstration URLs.
* Seeded demo products being loaded into live accounts.
* Fixed competitor names.
* Fake price history.
* Random prices or stock values.
* Mocked API responses accidentally used in live mode.
* Buttons that only display sample results.
* Placeholder integrations reported as connected.
* Reports assembled from static example data.
* Default fallback responses that conceal collection failures.

Refactor these where appropriate.
Keep fixtures and mocks in dedicated development or testing paths. Production code must use actual collection and configured integrations.
PART 4 — REAL WEBSITE COLLECTION AND CATALOGUE DISCOVERY
This is a major engineering priority.
4.1 Build a general website-collection system
The user can submit their own website and any 3–5 competitors. Do not assume that every website uses Shopify or WooCommerce.
For each submitted website, implement a collection strategy that uses suitable methods, such as:

* Platform identification.
* Public product feeds and storefront endpoints where legitimately accessible.
* Sitemap and sitemap-index discovery.
* Public product listing and product detail pages.
* JSON-LD structured product data.
* Open Graph and other useful metadata.
* HTML extraction.
* Pagination and product variants.
* Browser-based rendering where necessary and feasible.
* PDF catalogues and promotional flyers where appropriate.
* Platform-specific adapters.

Use a layered strategy: identify the platform, use a reliable supported connector when possible, and fall back to permitted public-page discovery and extraction.
Do not hardcode a specific site as the only supported website.
Build a clear, extensible adapter architecture so future platforms can be supported without rewriting the whole application.
4.2 Catalogue completeness
The system must attempt to discover the whole accessible catalogue, not merely a few sample pages.
Handle pagination, variants, sitemap indexes, product URLs, deduplication, resumable jobs, request budgets, and collection progress.
For large websites, use background jobs and incremental or rolling collection strategies. Make it possible to resume incomplete collection rather than starting all over again.
Record:

* Products discovered.
* Products successfully collected.
* Products failed or skipped.
* Product pagination or sitemap coverage where measurable.
* Last successful collection time.
* Collection duration.
* Per-site failures and reasons.
* Whether the catalogue is complete or partial.
* The reason any portion of the catalogue could not be collected.

Do not claim 100% catalogue coverage without evidence.
Use appropriate timeouts, bounded concurrency, response-size limits, retries with backoff, per-domain rate limiting, and caching.
Respect website terms, access permissions, and robots directives where applicable. Do not bypass CAPTCHAs, logins, paywalls, anti-bot protections, or other access controls. Do not probe private checkout or account information to obtain competitor data.
The system should explain when a site cannot be collected and identify an authorised alternative, such as a merchant-provided feed or supported platform integration.
4.3 Secure the collector
Review the existing SSRF-safe fetching and browser-rendering code thoroughly.
Validate user-submitted URLs and every redirect. Prevent requests to loopback, private, link-local, reserved, and cloud-metadata addresses. Account for DNS resolution changes and IPv4/IPv6 edge cases.
Apply the same security policy to browser-rendered navigation and subordinate requests. Prevent a public page from using the browser to access internal services.
If the existing protections are incomplete, fix them and add regression tests.
Never expose arbitrary internal-network access through a URL-submission feature.
4.4 Make collection observable
The user must be able to open a website detail page and understand:

* Which collection strategy was used.
* Whether the website is supported.
* Whether collection is running.
* What has been discovered.
* How much has been processed.
* Which pages or products failed.
* When the latest observation occurred.
* Why any field could not be extracted.
* Which source evidence supports the collected information.

Do not present a website as fully operational simply because its homepage loaded.
PART 5 — REAL PRODUCT MATCHING AND PRICE COMPARISON
5.1 Build reliable product normalisation
Normalise information such as:

* Product name.
* Brand.
* GTIN, EAN, UPC, or other product identifier when available.
* Manufacturer and model where relevant.
* Product size and quantity.
* Units of measurement.
* Multipack information.
* Product variants.
* Category.
* Currency.
* Current list price.
* Current selling price.
* Unit price.
* Availability.
* Source URL.
* Observation timestamp.

Respect the difference between products that have similar names and products that are actually equivalent.
For grocery products, a 1-litre product and a 2-litre product must not be treated as the same purchasable unit merely because their names are similar.
A multipack must not be confused with a single item. Different flavours, sizes, models, variants, and pack counts must be handled appropriately.
5.2 Matching workflow
Implement matching that uses the strongest available identifiers first, followed by brand, normalized name, category, size, variant, and other relevant attributes.
Use confidence scores and evidence.
Provide a match-review interface where authorised users can:

* Accept a proposed equivalent-product match.
* Reject an incorrect match.
* Search and choose an alternative.
* See source evidence side by side.
* Understand why a match was proposed.
* Correct a mistaken mapping.

Do not silently force uncertain matches into the price-comparison matrix.
Learn from reviewed matches where appropriate, without automatically turning every reviewed pair into a global truth.
5.3 Real price comparisons
For genuinely equivalent products, show:

* Our price.
* Competitor price.
* Absolute price difference.
* Percentage difference.
* Cheapest observed comparable offer.
* Relative price position.
* Unit-price comparison where comparable.
* Availability status.
* Product-match confidence.
* Last-observed timestamp.
* Source links and supporting evidence.

Use correct arithmetic and consistent units.
Distinguish regular prices from sale prices. Do not compare a single unit against a multipack without an appropriate unit-price conversion.
Handle unavailable, stale, partial, and conflicting data without inventing a price.
5.4 Currency conversion
Detect and record the currency of each source price where possible, and let the user correct it when necessary.
Convert currencies using a real, attributable exchange-rate source where applicable. Record the original amount, original currency, converted amount, conversion rate, provider, and conversion timestamp.
Preserve the agreed Aruba context and its AWG/USD currency considerations, but do not assume all future customers use the same currency.
Do not use a fabricated exchange rate or silently substitute an outdated one.
If an exchange-rate provider requires an API key, explain exactly which provider and configuration are required and ask me for the required credential when it becomes necessary.
PART 6 — MY INVENTORY AND LOW-STOCK ALERTS
Low-stock alerts primarily concern the customer's own website, not exact inventory quantities on competitor websites.
Implement the following:

1. Read product availability from the customer's own site when supported.
2. Connect to the customer's authorised inventory platform where available.
3. Support exact quantities only when they are returned by a genuinely authorised inventory source.
4. Allow the low-stock threshold to be configured; use 5 units as the initial default.
5. Support out-of-stock and restock transitions.
6. Generate alerts without repeatedly generating duplicate notifications for an unchanged condition.
7. Track alert status, evidence, timestamps, acknowledgements, and resolution.
8. Show a conflict when public product-page availability disagrees with authorised inventory data.
9. Include relevant stock warnings in reports.

If exact stock quantities cannot be retrieved, do not invent them. Use only a justified public availability classification where available and show that the exact quantity is unknown.
Implement real inventory integration only through an authorised connection. For example, a Shopify connection requires genuine merchant-authorised OAuth credentials and the appropriate access scopes.
Never ask for a competitor's private inventory access.
PART 7 — REAL DISCOUNTS, OFFERS, FLYERS, AND PROMOTIONS
Extract actual publicly available promotional information where accessible.
The system should handle:

* Regular price.
* Sale price.
* Absolute discount.
* Percentage discount.
* Offer descriptions.
* Start and end dates where stated.
* Promotional eligibility or purchase conditions.
* Product or category affected.
* Multipack and bundle offers.
* Public flyer PDFs and catalogue documents.
* The source URL.
* Evidence and observation time.

Track changes between observations, including newly appearing and expired offers.
Do not treat an ordinary price as a sale price simply because it is numerically low. Do not mistake sizes such as `1.75L` for prices.
Clearly distinguish a displayed offer from a confirmed promotion that meets a stated validity period.
Where flyer parsing is uncertain, allow appropriate review and show the source.
PART 8 — COMPETITOR SOCIAL MEDIA AND MARKETING INTELLIGENCE
Marketing intelligence is part of the original requirement. Do not omit it.
Support collection of permitted information from Facebook, Instagram, and YouTube where platform rules, public access, API permissions, and credentials allow.
Implement the relevant provider integrations properly.
For observed activity, record:

* Brand or verified account association where established.
* Platform.
* Public post or video URL.
* Published time, when available.
* Caption or description where permitted.
* Public engagement metrics where available and permitted.
* Relevant promotion or product references.
* Observation timestamp.
* Provider and data source.
* Collection limitations.

Develop useful summaries of observed marketing activity, recurring themes, product promotions, and promotional timing when the evidence supports them.
Important distinction: public social media posts are not automatically confirmed paid campaigns. Label organic public activity as observed content. Mark a paid campaign as confirmed only when a reliable authorised data source establishes that status.
Do not imply that the system can see private campaigns, private account information, or every advertisement on a platform.
Implement provider status, authentication, token expiry, refresh where applicable, revoked permissions, API quotas, backoff, and clear errors.
When the API requires an application, access token, app review, business verification, or approved permission, identify the exact requirement and ask me for the needed information or credential. Do not bypass those requirements.
Where no authorised API access is available, the feature must show a genuine limitation or an appropriate alternative. Never display a simulated campaign as real marketing intelligence.
PART 9 — REAL REPORTING, DAILY SCHEDULES, AND NOTIFICATIONS
9.1 Daily report
Preserve the requirement that the daily competitor intelligence report should be ready by 9:00 AM Aruba local time, using the `America/Aruba` timezone.
The scheduler must work across normal restarts and delayed or failed jobs.
Implement:

* Scheduled website collection.
* Queue-based processing.
* Retry and recovery behaviour.
* A clear reporting cutoff.
* Partial reports when collection misses the cutoff.
* Data-freshness indicators.
* Report generation.
* Persistent report history.
* Appropriate duplicate-job prevention.
* Late-start and missed-deadline reporting.

A report must not claim to be current if it is based on old observations.
If some websites fail, the report should show which sources are missing and what that means for the conclusions.
9.2 Report content
Include the business intelligence supported by collected evidence:

* Price comparison.
* Cheapest comparable products.
* Price differences and changes.
* Product availability.
* Own-site stock warnings.
* Discounts and offers.
* Observed competitor marketing activity.
* Catalogue coverage and quality.
* Important product changes.
* Significant exceptions and collection failures.
* Source evidence and timestamps.

Make the report genuinely useful for business decisions rather than merely presenting generic charts.
9.3 Exports and notifications
Make dashboard reports and exports work from the same persisted report snapshot.
Provide:

* PDF.
* CSV.
* Excel.
* Historical report viewing.
* Report comparison over time where supported.
* Dashboard alerts.
* Email summaries and relevant notifications.

Test file contents, not merely whether a download button works. CSV files must be safe from formula injection.
Configure real email delivery when a provider is available. A local mock or development outbox is acceptable for tests but must never be represented as a successfully delivered production email.
If an email provider requires configuration, tell me precisely what is needed.
Retain historical observations and reports for approximately one year, and raw snapshots for the previously agreed default of 90 days, subject to the original prompt and any necessary legal or operational constraints.
Implement retention consistently and test it.
PART 10 — REAL AUTHENTICATION, ORGANISATIONS, AND DATA ISOLATION
Treat authentication and tenant separation as production-critical requirements.
Audit the existing system instead of assuming its current implementation is complete.
Verify:

* Registration and sign-in.
* Secure password storage.
* Session handling and expiration.
* Logout and session invalidation.
* Password-reset workflow.
* Email verification where configured.
* Appropriate role and permission checks.
* Organisation creation and membership.
* Member invitation or onboarding where supported.
* Tenant-scoped database operations.
* Row-Level Security policies.
* Protection against cross-tenant access.
* Secure cookies.
* CSRF protection for state-changing requests.
* Input validation.
* Authentication and resource rate limiting.
* Safe error handling and logging.
* Appropriate secret handling.

A user in one organisation must never be able to read or change another organisation's products, prices, website credentials, alerts, reports, or integrations by guessing IDs or altering requests.
Test these cases at the API and database layers, not only in the frontend.
The architecture must support multiple customer organisations. Preserve any agreed demo conveniences, but do not let a development owner account become the default identity or data source for real customers.
Implement a sensible onboarding workflow so a genuine new customer can create an account, set up a workspace, enter websites, and reach their first report.
If production email verification requires an email service, explain the required provider and credentials. Do not silently treat an unverified account as verified merely because the development environment allows login.
PART 11 — INTEGRATIONS AND API KEYS
Some parts of the system cannot become genuinely operational without external credentials, permissions, or accounts.
Examples include merchant-authorised Shopify inventory access, Facebook/Instagram APIs, YouTube APIs, production email delivery, optional AI-generated summaries, and cloud storage.
Do not claim every service is live merely because its integration code compiles.
11.1 Credential workflow
When you reach an integration that requires a credential:

1. Determine whether the integration is actually required for the current milestone.
2. Complete any implementation and testing that can be done without the credential.
3. Tell me the exact provider or service.
4. Explain why the key or permission is required.
5. Give me the precise environment-variable name or required configuration fields.
6. Explain where to obtain the credential and the minimum permissions required.
7. Tell me where to configure it locally, preferably in `.env`.
8. Ask me to provide the required credential or configuration when the integration is ready for live verification.
9. Continue with other tasks that are not blocked.

I am willing to provide the required API keys and configuration. Ask me when they are genuinely needed rather than inventing credentials or assuming access exists.
Never hardcode secrets into source files. Do not put real credential values in `docs/PROJECT_CONTEXT.md`, `docs/WORK_LOG.md`, source control, test fixtures, logs, or documentation.
Use `.env.example` for placeholders and keep actual `.env` files out of Git.
If a key or permission is unavailable, clearly mark the specific integration as blocked or unverified and explain the next step. Do not fabricate successful external API responses.
11.2 Distinguish required and optional integrations
Create a document or configuration reference that lists:

* Provider.
* Purpose.
* Required environment variables.
* Required permissions.
* Whether it is essential to the core website-comparison workflow.
* Whether the current local build can operate without it.
* What works without the credential.
* What is blocked until it is configured.
* How to verify the integration after configuration.

Do not unnecessarily block real public-web price collection while an optional social or AI integration is awaiting credentials.
AI may assist in extraction or insight generation, but the core data pipeline must remain evidence-based, and deterministic functionality must work without an LLM API key wherever feasible.
PART 12 — LIVE MODE, DEMO MODE, AND USER INTERFACE
Make the UI understandable to real customers.
A new customer should not need to understand the source-code architecture to use Shelfwatch.
Implement or refine the setup experience so it guides the user through:

1. Creating or entering an organisation.
2. Registering their own business website.
3. Adding 3–5 competitor URLs.
4. Reviewing collection capabilities.
5. Confirming appropriate collection permissions.
6. Starting collection.
7. Monitoring progress.
8. Reviewing product matches requiring decisions.
9. Viewing comparisons and evidence.
10. Configuring alerts and reports.

Display site-specific collection capability, completeness, errors, and freshness.
Make it possible to identify what is working and what requires action from a single place.
Keep the existing visual identity where it is effective. Focus on a professional, clear business intelligence interface rather than an unnecessary redesign.
Verify the interface at desktop and mobile sizes.
Check tables, filters, charts, empty states, loading states, error states, long product names, price formatting, accessibility labels, keyboard navigation, and actionable feedback.
Do not display misleading green “connected” or “success” states when a service is only mocked, credentials are absent, or a collection job has failed.
PART 13 — PRODUCTION HARDENING AND DEPLOYMENT
Review the existing project before changing its deployment configuration.
Verify or implement, as appropriate:

* Production configuration validation.
* Safe startup and shutdown.
* Database migrations and indexes.
* Connection pooling.
* Separate API and worker processes.
* Background job recovery.
* Structured logging with sensitive-data redaction.
* Health and readiness endpoints.
* Proper secret management.
* Database backups and recovery guidance.
* Retention jobs.
* Request timeouts and resource limits.
* Production frontend and API builds.
* Deployment instructions.
* Environment-specific configuration.
* Secure integration callback handling.
* Monitoring and actionable operational errors.

Keep the existing PostgreSQL and tenant-isolation design unless there is a demonstrated reason to change it.
Inspect the existing Dockerfile and compose configuration. Test them if Docker is available. If it is not available, report the limitation clearly rather than claiming the containers were verified.
Do not deploy publicly, purchase services, incur paid API charges, or create external production resources without my explicit approval.
PART 14 — REQUIRED IMPLEMENTATION PROCESS
Follow this sequence, updating the context and work log as you progress.
Phase 0: Context preservation

* Read the original prompt and relevant history.
* Inspect the repository and Git status.
* Create and validate `docs/PROJECT_CONTEXT.md`.
* Create `docs/WORK_LOG.md`.
* Record the actual baseline and known limitations.
* Do not make application changes before this phase is complete.

Phase 1: Baseline audit

* Run the available existing tests.
* Check typechecking, linting, and builds.
* Audit current application startup.
* Verify authentication and tenant isolation.
* Trace the main website-registration, collection, matching, comparison, and reporting workflows.
* Identify exactly what currently uses fictional data.
* Create a requirements-to-implementation matrix.
* Preserve unrelated working changes and commits.

If something fails at baseline, record it before changing anything so existing defects are not confused with newly introduced ones.
Phase 2: Real customer onboarding and live workspace

* Remove fixture seeding from the normal real-customer workflow.
* Establish explicit separation between live and demo data.
* Implement or verify real authentication and organisation setup.
* Implement the URL-entry workflow for one source website and 3–5 competitors.
* Validate website URLs and record applicable collection permissions.
* Show capability and collection status.

Phase 3: Real data collection

* Audit all current connectors.
* Fix catalogue discovery, extraction, pagination, variants, and deduplication.
* Complete the entire accessible catalogue workflow for supported sites.
* Add resumable collection jobs, meaningful errors, and data freshness.
* Verify against actual authorised websites when appropriate.
* Do not mark a site as fully supported if the required collection is still untested.

Phase 4: Real price intelligence

* Validate product normalisation.
* Improve equivalent-product matching.
* Verify unit-price calculations and currency conversion.
* Implement reliable price matrices and evidence links.
* Ensure uncollected competitors are never represented as having no matching products.
* Verify that price changes derive from real historical observations.

Phase 5: Offers, stock, and marketing

* Validate public offer extraction and flyer parsing.
* Verify own-site low-stock alerts.
* Implement or verify the authorised inventory integration.
* Prepare and verify social integrations.
* Request credentials or permissions when each integration reaches that stage.
* Distinguish known facts from unavailable or inferred information.

Phase 6: Reports and notifications

* Verify the daily scheduler and Aruba timezone.
* Verify daily report generation, freshness, partial-report handling, PDF, CSV, Excel, and historical viewing.
* Configure and test real email delivery when credentials are supplied.
* Verify retention and alert deduplication.

Phase 7: Full-system verification
Test the complete journey using real collected data, where authorised and technically available.
Do not rely only on unit tests or fixtures.
Test multiple websites, partial failures, unavailable competitors, duplicate products, incorrect product matches, changing prices, expired promotions, stock transitions, missing credentials, invalid URLs, authentication failures, and cross-tenant access.
Rebuild demo fixtures separately if required. The existence of a working demo must not be used as proof that the live product works.
Phase 8: Production-readiness assessment
Run the complete available verification suite.
Update the project documentation with exact test commands and results.
Provide a clear report of what works in real conditions, what works only in fixtures or mocks, what remains unverified, and what requires credentials, permission, or a deployment decision.
PART 15 — ACCEPTANCE CRITERIA
Do not declare the task complete until the following criteria have either been verified or explicitly marked as blocked with a specific reason.
Core product

* A real user can register or sign in.
* A customer can create or access the correct organisation.
* A user can enter one source website and 3–5 competitors.
* New URLs are processed without relying on a hardcoded demonstration catalogue.
* The collector attempts to discover the complete accessible catalogue for supported websites.
* Collection status and completeness are persisted and accurately presented.
* At least one authorised real-world end-to-end collection workflow has been tested where access permits it.
* Products are normalised and equivalent items can be matched and reviewed.
* Genuine price comparisons are calculated from collected observations.
* Source evidence and observation timestamps are available.
* Missing or inaccessible data is never fabricated.
* Promotions are extracted only when evidence supports them.
* Own-site low-stock logic works with real or properly authorised inventory data.
* Daily report generation, downloads, and historical observations work correctly.
* Demo data cannot leak into live customer workspaces.
* Users cannot access another organisation's data.

External services

* Each connected provider has a genuine connection status.
* Required keys and permissions are documented.
* Configured integrations are tested against real services where possible.
* Unavailable integrations are clearly identified rather than simulated as successful.

Engineering quality

* Existing useful functionality is preserved.
* Automated tests, lint, typechecking, and builds are run and reported accurately.
* Regression tests cover important fixes.
* Authentication and data-isolation tests pass.
* Security-sensitive URL handling is tested.
* Documentation matches the actual commands and implemented code.
* The context file and work log remain current.

If a criterion cannot be completed because of an external restriction, do not conceal it. Explain precisely what is blocked, what has already been implemented, what you need from me, and how completion will be verified.
PART 16 — HOW YOU MUST WORK

1. Actually implement the application. Do not respond with only a plan or a list of suggested changes.
2. Preserve the existing architecture and reuse existing working code wherever reasonable.
3. Avoid unrelated rewrites or large dependency changes without justification.
4. Work in small, verifiable phases.
5. Run relevant tests after each meaningful change and the full suite at appropriate checkpoints.
6. Fix regressions introduced by your changes.
7. Never fake a successful live collection, login, inventory connection, social integration, or email delivery.
8. Do not create fake production users or fake competitor observations to make dashboards appear complete.
9. Keep mock data confined to clearly labelled tests and demo mode.
10. Do not ask for permission after every ordinary implementation phase; proceed autonomously within these requirements.
11. Ask me when you genuinely need a credential, permission, external decision, or clarification.
12. If a task is blocked by a key, continue with independent tasks and tell me exactly what remains blocked.
13. Maintain `docs/PROJECT_CONTEXT.md` and `docs/WORK_LOG.md` throughout implementation.
14. Do not delete existing data, `.env`, or user modifications without understanding their purpose and obtaining approval when destructive action is necessary.
15. Do not commit secrets or expose credentials in logs or documentation.
16. Do not declare something production-ready merely because it compiles.
17. Do not stop after the initial audit or context-file creation. Continue with the implementation until the available work is complete or a genuine blocker prevents progress.

If you approach a session or usage limit, prioritise a safe stopping point, save all work, update the context and work log, run the most relevant checks, and leave exact instructions for resuming.
FINAL DELIVERABLE
When you finish the available implementation work, provide:

1. A summary of the actual changes.
2. The path to `docs/PROJECT_CONTEXT.md`.
3. The path to `docs/WORK_LOG.md`.
4. The real features now working end to end.
5. The exact commands to run the application in live development mode.
6. How to create a genuine account and configure the source website and 3–5 competitors.
7. Every API key, OAuth permission, email configuration, or other external prerequisite still required from me.
8. The exact tests, builds, and real-world verification steps completed, with results.
9. Known limitations and unverified integrations.
10. Remaining work, prioritised by what is necessary to make the product genuinely usable.
11. The precise next step I should take.

Start now with Phase 0: thoroughly reconstruct the project history and create the context files before modifying application code. Then continue through the implementation phases without stopping at documentation or planning alone.
My objective is a genuinely operational competitor intelligence platform for real customers and real websites, not a dashboard that merely looks finished.
