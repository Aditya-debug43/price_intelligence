<!-- Verbatim copy of the user's message, saved for context preservation. Wrapper tags removed; text otherwise unchanged. Sent 2026-10-18. -->

STRICT DIRECTIVE: REMOVE THE DEMO PRODUCT AND FINISH REAL SHELFWATCH
You are continuing development of my existing Shelfwatch competitor intelligence platform.
I do not want another demo, mockup, simulated dashboard, prototype, or list of recommendations. I want a real application that actual customers can register for, configure with their own website and competitor URLs, and use to obtain genuine competitor intelligence from collected data.
You have already built substantial code in this repository. Do not rebuild the whole application unnecessarily. Inspect the current code, retain useful working functionality, fix incomplete implementations, and finish the real product.
Your objective is to eliminate all demo functionality from the actual customer-facing application and normal runtime, implement genuine authentication and email delivery, and make the real website collection and price-comparison workflow work end to end.
Do not claim completion without evidence.
PHASE 1 — READ THE EXISTING PROJECT CONTEXT FIRST
Before modifying application code, thoroughly read:

* `docs/PROJECT_CONTEXT.md`
* `docs/WORK_LOG.md`
* `docs/REQUIREMENTS_MATRIX.md`
* `docs/PRODUCTION_READINESS.md`
* `docs/limitations.md`
* `docs/integrations.md`
* `README.md`
* My original complete project prompt, if accessible.
* The existing source code, configuration, tests, migrations, and Git history relevant to these documents.

Do not rely exclusively on your previous memory or status messages. Verify claims against the actual repository.
If the original prompt is inaccessible, say so instead of pretending to have reread it. Continue auditing the available project and preserve all verifiable requirements.
Before changing anything, record the current Git status, current commit, existing uncommitted changes, environment configuration status, and baseline test/build results.
Do not delete my existing data, `.env`, user changes, or database contents without first understanding their purpose and obtaining my approval where destructive action is necessary.
PHASE 2 — EXHAUSTIVELY AUDIT AND REMOVE DEMO FUNCTIONALITY
I do not want customers to use demo mode. I want one real product experience.
Search the entire repository for demo-specific behaviour and related concepts, including:

* `demo`
* `fixture`
* `mock`
* `fake`
* `sample`
* `seed`
* `simulator`
* `localhost.test`
* Hardcoded demonstration users.
* Hardcoded competitor URLs.
* Synthetic products, prices, stock quantities, price histories, offers, and observations.
* Mocked provider responses used outside automated tests.
* Demo API routes and developer-only data controls.
* Demo banners and demo-only interface controls.
* Scripts that create demonstration workspaces or populate example business data.
* Logic that silently substitutes fictional data when live collection fails.
* Development credentials or default passwords being used in a real customer workflow.

Inspect each occurrence and determine whether it participates in actual application behaviour.
Required changes

1. Remove the demo-mode experience from the actual customer-facing product.
2. Remove demo workspace creation and demo-data seeding from normal application startup.
3. Remove demo-specific UI, sample products, synthetic business insights, demo dashboards, demo login instructions, and demo-only controls from the real product.
4. Remove demo functionality from production routes and production execution paths.
5. Ensure production builds do not include unused fixture servers, sample-data generators, or demonstration credentials.
6. Remove unnecessary demo scripts and obsolete runtime code once you have verified that nothing depends on them.
7. Remove hardcoded example businesses from normal user workflows.
8. Remove automatic fixture initialisation from customer registration and workspace creation.
9. Ensure the application starts with a genuinely empty customer workspace until that customer supplies websites and real data is successfully collected.
10. Remove any fallback that converts failed collection into fake success, invented prices, random quantities, or fabricated observations.

Search beyond the obvious `demo` folder names. A component may be simulated even if its filename does not contain the word `demo`.
Important distinction concerning tests
Keep automated testing reliable.
If a fixture, mock, or synthetic record is genuinely required for unit and integration tests, isolate it strictly inside test-only code. It must never seed real customer workspaces, enter live reports, become accessible through production APIs, or be bundled into production as an alternative data source.
I do not want a demo mode retained as a second customer-facing product. Test fixtures may exist only when genuinely necessary to test software behaviour.
Do not simply rename demo variables to live variables while retaining simulated behaviour.
At the end of this phase, produce a removal audit showing what was deleted, what was retained exclusively for testing, and how you verified that fictional data cannot enter real customer accounts.
PHASE 3 — MAKE AUTHENTICATION GENUINELY REAL
Authentication is the first major customer workflow. It must be implemented and verified before treating the application as ready for customers.
Audit the current authentication implementation and complete the following features.
Registration
A genuine customer must be able to:

1. Open the registration page.
2. Enter their name, email address, and password.
3. Create an account with securely hashed password storage.
4. Receive an actual verification email.
5. Verify their address using a secure, expiring, single-use verification token.
6. Sign in after meeting the verification requirements.
7. Create or access their own organisation.

Do not automatically mark an account as email-verified if no email was actually delivered or the verification link was never used.
Sign-in and session management
Implement and verify:

* Secure login.
* Invalid-password handling.
* Logout.
* Session expiry and invalidation.
* Secure cookies and appropriate `HttpOnly`, `Secure`, and `SameSite` settings.
* CSRF protection for state-changing operations.
* Login rate limiting.
* Appropriate input validation and error handling.
* Password reset using a genuine email.
* Expiring, single-use password-reset tokens.
* Secure password replacement.
* Protection against account enumeration where appropriate.

Do not introduce plaintext password storage, hardcoded production credentials, or development authentication shortcuts into the live application.
Organisations and user isolation
Every customer must work in the correct organisation.
Verify that an authenticated user cannot access another organisation's websites, products, prices, integrations, alerts, reports, or credentials by modifying an ID or making a direct API request.
Verify the existing tenant isolation and PostgreSQL Row-Level Security implementation. Fix any real defects discovered.
Do not rely on hiding other customers' data in the frontend as the only security measure.
No fake authentication shortcuts
Remove fake owner accounts, hardcoded demo credentials, automatic production login, simulated email verification, and any endpoint that bypasses real authentication in production.
Tests may create temporary test accounts inside isolated test environments.
Acceptance criterion: A newly registered customer must be able to complete genuine email verification, sign in, create a workspace, and reach their own empty live workspace without inheriting fictional products or competitor data.
PHASE 4 — CONFIGURE REAL GMAIL SMTP AND REQUEST MY DETAILS
I want real email delivery using my Gmail account, not a simulated outbox presented as successful delivery.
I am willing to provide my Gmail sender address and Google App Password.
When the implementation is ready for SMTP configuration, explicitly ask me for the required details and guide me through configuring them.
Do not silently leave email delivery mocked because credentials are missing.
SMTP requirements
Implement and verify genuine SMTP delivery for:

* Account verification emails.
* Password-reset emails.
* Member invitations.
* Daily intelligence report emails.
* Relevant alerts, where configured.

Use a proper email service abstraction so the application can record delivery attempts, failures, retries, and successful provider responses.
For Gmail SMTP, use the appropriate Gmail SMTP configuration, normally:

* Host: `smtp.gmail.com`
* Port: `587` with STARTTLS, or port `465` with SSL/TLS.
* Authentication: Gmail sender address and the Google App Password.
* Sender address: the configured Gmail account.

Check the installed email library and implement the correct configuration for it.
Do not use the Gmail account's ordinary login password. Explain that an App Password generally requires two-step verification and may be unavailable for some account configurations.
Request configuration when needed
First inspect the actual environment schema and implement the SMTP integration.
Then tell me precisely which values you need, including the exact environment-variable names.
Use the existing project's environment-variable naming where appropriate. Do not invent a second overlapping configuration system.
For example, the configuration may include variables equivalent to:

* SMTP host.
* SMTP port.
* SMTP username.
* SMTP App Password.
* Sender email address.
* Sender display name.
* Application base URL used to generate verification and reset links.

The actual required variable names must match the implemented configuration.
Ask me for my Gmail address and guide me through adding the App Password to my local `.env` configuration when it is time to test real delivery.
Keep the secret out of source code, Git, logs, documentation, context files, screenshots, and test fixtures. Prefer having me enter the App Password directly into the local environment configuration rather than exposing it in chat.
Do not print or echo the configured password.
If configuration is missing, report the email integration as not configured. Never tell the user an email has been sent merely because the application accepted a request into an outbox.
Real email verification
After I configure SMTP:

1. Start the application.
2. Register a new test account using an email address I control.
3. Send an actual verification email through Gmail SMTP.
4. Verify receipt and inspect the generated link.
5. Complete verification.
6. Test login.
7. Test a password-reset email and actual password reset.
8. Verify invalid, expired, and reused tokens are rejected.
9. Test delivery failure and retry handling.

Do not declare email verification complete based solely on mocked SMTP tests.
If delivery is blocked or Gmail authentication fails, show the precise actionable error, protect the secret, and request the required correction.
PHASE 5 — THE MAIN REQUIREMENT: REAL WEBSITE URL INPUT
The actual customer workflow must allow a customer to enter:

* One URL for their own business website.
* Between 3 and 5 URLs for competing businesses.

The customer must be able to supply arbitrary suitable website URLs rather than being restricted to the current demonstration URLs.
Build on the existing website-management implementation.
Do not hardcode my own business website, competitor names, product catalogue, or expected prices.
Expected workflow
A real customer should be able to:

1. Register and verify their email.
2. Sign in.
3. Create an organisation.
4. Enter their own website URL.
5. Enter 3–5 competitor website URLs.
6. Validate each URL and inspect its collection capabilities.
7. Start catalogue collection.
8. See actual collection progress.
9. See discovered products and collection errors.
10. Review product matches.
11. See comparisons calculated from real observations.
12. View discounts, offers, and supported stock information.
13. Generate a report from the collected data.
14. Export the report and schedule future updates.

No developer assistance or code change should be necessary simply to enter a different competitor URL.
The application must process website URLs dynamically and choose an appropriate supported collection strategy.
Collection permission and website access
Do not invent permission or falsely claim that another website's owner has approved collection.
Differentiate:

* Public information accessible under the relevant site's terms and restrictions.
* The customer's authority to connect their own website.
* Merchant-authorised APIs that expose private inventory quantities.
* Sites where collection is prohibited, blocked, or unavailable.

Implement an honest, policy-compliant collection workflow. Respect applicable laws, site terms, access permissions, and relevant robots directives. Do not bypass CAPTCHAs, authentication walls, paywalls, or anti-bot protections.
For the customer's own private inventory connection, require genuine authorisation.
For competitor sites, do not misrepresent a user's confirmation as actual approval from a competitor. If the current collection-permission workflow prevents any real competitor collection without the competitor's personal sign-off, audit and correct that design while preserving the necessary legal, consent, and site-policy controls.
Do not weaken SSRF protection or permit arbitrary internal-network access to make URL collection work.
PHASE 6 — IMPLEMENT AND VERIFY REAL CATALOGUE COLLECTION
The collector must attempt to discover all accessible products from each submitted website, not a small fixed sample or an example catalogue.
Audit and complete the existing connectors.
Use legitimate methods appropriate to each supported site, such as:

* Accessible product feeds.
* Supported public storefront interfaces.
* Sitemaps and sitemap indexes.
* Product listing and detail pages.
* Structured JSON-LD product metadata.
* Platform-specific connectors.
* HTML extraction.
* Browser rendering where technically feasible.
* Public PDF catalogues and flyers.

Handle pagination, product variants, repeated products, unavailable pages, retries, resumable scans, rate limits, timeouts, and large catalogues.
Show how many products were discovered, collected, skipped, or failed. Record the source page and observation timestamp for each collected result where applicable.
Clearly distinguish:

* Complete collection.
* Partial collection.
* Collection in progress.
* Blocked collection.
* Unsupported website.
* Failed collection.
* Stale observations.

Do not report a catalogue as complete when only a few pages were inspected.
Do not fabricate missing products or silently mark a failure as successful.
Real-data requirement
Once the collector is ready, ask me for the first authorised real website to test.
Actually collect the accessible catalogue, inspect the resulting database records, and compare the stored names and prices against the source website.
Then test one competitor and continue expanding coverage based on real results.
Do not stop after successful fixture-based tests.
If the website does not expose extractable prices or products, identify the exact limitation and determine whether a supported alternative is available.
PHASE 7 — MAKE PRICE COMPARISON REAL
Use only genuinely collected observations and reviewed product matches for customer-facing comparisons.
Implement and verify:

* Product-name and brand normalisation.
* GTIN/EAN/UPC or another suitable identifier where available.
* Product size, quantity, flavour, model, and variant distinctions.
* Pack-size and multipack validation.
* Confidence-based matching.
* Manual match acceptance, correction, and rejection.
* Source URLs and supporting evidence.
* Current and historical observed prices.
* Currency normalisation and conversion.
* Correct unit-price calculations.
* Sale prices and discounts.
* Observation timestamps.
* Price differences and percentages.
* Comparison freshness and completeness.

Never compare different pack sizes as if they were identical without a valid unit-price normalisation.
Never equate missing competitor data with no match.
Never generate fake price history to make charts look populated.
If a competitor fails collection, show that the competitor was not collected.
If an item is not found after a successful catalogue collection, distinguish that from an inaccessible product page or incomplete catalogue.
Currency and exchange rates
Preserve the Aruba requirements in my original prompt, including the AWG/USD context, while supporting the currency configuration required by each customer.
Use a real, attributable exchange-rate source for currencies that need conversion. Record the source and timestamp of rates.
Do not silently use fictional exchange rates.
If an exchange-rate provider requires a key, request it when the integration is ready for live verification. Do not block otherwise functioning website collection while optional credentials are being configured.
Required end-to-end proof
Run a test with a genuinely accessible, authorised source website and at least one genuinely accessible competitor.
Verify that:

1. Product data was retrieved from the real websites.
2. The database contains those collected products and observations.
3. Comparison calculations use those actual stored observations.
4. The user can open the comparison and inspect the source evidence.
5. The numbers match the source prices after applying any appropriate currency or unit conversion.

Report exactly which parts were verified.
PHASE 8 — REAL STOCK, OFFERS, MARKETING, AND REPORTING
Preserve the previous business requirements and finish these features without introducing mock data into live accounts.
Own-site inventory and stock
Low-stock alerts apply primarily to the customer's own website.
Use exact quantities only when an authorised inventory API or connection provides them. Otherwise report the available public stock status and clearly identify exact quantity as unknown.
Preserve the configurable threshold, initially 5 units. Test stock transitions, restocking, alert deduplication, and disagreements between public product pages and authorised inventory.
Shopify
Shopify is an optional authorised inventory integration for businesses whose own store uses Shopify. It is not mandatory for all URL-based price comparisons.
Do not require Shopify credentials merely because a customer wants public prices compared.
When exact private stock quantities are required from the customer's own Shopify store, implement the appropriate merchant-authorised OAuth connection, permissions, token lifecycle, and sync health.
When this integration is ready, request the exact app credentials and merchant authorisation required. Do not claim the integration works live until it has been tested.
Offers and flyers
Extract genuine publicly available discounts and promotional conditions where accessible. Record evidence, source URL, observation time, validity period where stated, and review status.
Do not mistake product sizes for prices or invent discount percentages.
Marketing intelligence
Maintain the Facebook, Instagram and YouTube integration work from the existing codebase.
Use official, permitted APIs and genuine credentials where required. Distinguish public posts from confirmed paid campaigns.
Request Meta or YouTube credentials and necessary permissions when each integration is ready to test. Do not simulate successful connections.
Reports and alerts
Keep the daily report requirement of 9:00 AM Aruba local time, using `America/Aruba`.
Ensure scheduled collection and report generation use real persisted observations, display data freshness accurately, and show partial reports when a website fails.
Preserve PDF, CSV, Excel, report history, alert workflows, and the agreed retention requirements.
Configure genuine email delivery through the SMTP setup described above.
PHASE 9 — API KEYS AND OTHER EXTERNAL CREDENTIALS
Do not assume that every feature needs a key. Determine exactly which integrations require credentials, and request them when required.
Create and maintain a truthful integration checklist with:

* Provider.
* Feature enabled by the integration.
* Whether the feature is core or optional.
* Exact required environment-variable names.
* Required permissions.
* Current configuration status.
* Whether the integration has been tested with a mock or a real external service.
* Outstanding blockers.
* Verification steps.

Possible integrations include Gmail SMTP, an authorised Shopify app, Meta, YouTube, an exchange-rate provider, optional Anthropic AI, and production storage.
The public website-collection workflow must not be unnecessarily blocked by missing credentials for unrelated integrations.
Credential policy
When an actual credential becomes necessary:

1. Explain the provider and why it is required.
2. Give me the exact environment variable names and setup instructions.
3. Request the required information explicitly.
4. Tell me how to configure secrets locally in `.env`.
5. Test the integration after configuration.
6. Never hardcode secrets or put them in Git, test fixtures, documentation, logs, or persistent context files.

I am prepared to provide my Gmail sender address, Google App Password, and additional required API credentials when you identify what is needed.
Do not keep postponing the Gmail setup after the email implementation is ready. Ask me for the sender address and guide me through safely configuring the App Password as soon as you can perform a genuine SMTP test.
PHASE 10 — TESTING, SECURITY, AND PRODUCTION READINESS
Use the existing architecture: React/Vite, Fastify, the database layer, background worker, reusable services, and existing job queue. Change the architecture only when a demonstrated technical issue warrants it.
Test authentication, organisation isolation, database permissions, API validation, the website collector, product matching, price calculations, alerts, reports, scheduled jobs, email delivery, and external integrations.
Run and record:

* Unit tests.
* Integration tests.
* Authentication and tenant-isolation tests.
* Collection and comparison end-to-end tests.
* Lint.
* Typechecking.
* Production builds.
* Real browser checks.
* Mobile layout checks.

Keep automated fixtures isolated from the live application.
Do not make production claims based solely on mocked external services.
Verify SSRF protection for URL input and redirects, safe handling of private addresses, authentication security, token storage, input validation, and rate limiting.
Finish the deployment instructions for a genuine hosted API, worker, and PostgreSQL database. Clearly distinguish local readiness from public production readiness.
Do not purchase hosting, incur paid API costs, or create production resources without my approval.
PHASE 11 — KEEP CONTEXT AND WORK LOGS CURRENT
Continue maintaining:

* `docs/PROJECT_CONTEXT.md`
* `docs/WORK_LOG.md`
* `docs/REQUIREMENTS_MATRIX.md`
* `docs/PRODUCTION_READINESS.md`
* `docs/integrations.md`
* `docs/limitations.md`

Update them as implementation changes. Document real accomplishments, actual failures, tested behaviour, missing credentials, external-service blockers, and unresolved defects.
Do not report a feature as complete just because source code exists.
Use these distinct statuses:

* Implemented, not tested.
* Tested with automated mocks.
* Tested using isolated test fixtures.
* Tested against a real local service.
* Tested against a real external service.
* Verified end to end with real website data.
* Blocked pending credentials or permission.

FINAL ACCEPTANCE CRITERIA
I will consider this work successful only when the actual customer-facing application satisfies the following:

1. Demo mode and fictional data have been removed from the normal product experience and production runtime.
2. A genuine customer can register, receive a real verification email, verify the account, sign in, and manage their own organisation.
3. Password resets and other required authentication emails use genuine SMTP delivery.
4. A customer can enter their own website URL and 3–5 competitor URLs without hardcoded website assumptions.
5. The platform can actually collect products and prices from supported, authorised real websites.
6. Genuine database observations drive the price-comparison dashboard.
7. Product matching is sufficiently reliable and supports human review.
8. Inaccessible websites, missing prices, stale data, and partial catalogues are reported honestly.
9. Stock alerts, offers, marketing observations, and reports do not fabricate live data.
10. Required external connections are configured and verified, or their exact blockers are documented.
11. The existing automated tests, lint, typechecking, and builds pass.
12. A full real-data workflow has been tested and documented with specific source websites, collection outcomes, actual product observations, and comparison results.

If any acceptance criterion is blocked, tell me exactly why, what credentials or permissions you need, and what I should do next.
Do not claim the product is fully real or production-ready until the real end-to-end collection and comparison have been demonstrated.
HOW TO START
Start now.
First reread the project context, original requirements and current readiness report. Audit and record the baseline. Then systematically remove demo functionality from the real product and proceed through the implementation phases.
Do not stop after writing a plan or report.
Ask me for the Gmail sender address and the configuration needed for the Google App Password when the SMTP integration is ready for a genuine test. Request other API keys or permissions when the corresponding feature actually needs them.
Keep implementing everything that can proceed without credentials, and pause only for genuine external prerequisites.
The final objective is a real customer-facing competitor intelligence platform where I can create my account, enter real website URLs, collect genuine data, and obtain actual competitive price comparisons.
