<!-- Verbatim copy of the user's message, saved for context preservation. Wrapper tags removed; text otherwise unchanged. Sent 2026-10-19. -->

SHELFWATCH — REAL-DATA VERIFICATION FIRST, THEN GITHUB AND AWS DEPLOYMENT
Continue working on the existing Shelfwatch project. Do not rebuild it from scratch.
My priorities are:

1. Thoroughly audit the real-data price comparisons and all important features that have not yet been verified.
2. Fix the problems found and rerun the required tests using real collected data.
3. Check that the latest frontend code is uploaded to the existing GitHub repository and update it if needed.
4. Check the existing AWS setup and deploy or update the backend there.
5. Verify that the deployed frontend and backend actually communicate correctly.

Do not start by deploying potentially incorrect code. Complete the audit first, then deploy the verified version.
PHASE 1 — AUDIT REAL PRICE COMPARISONS AND UNVERIFIED FEATURES
First, reread:

* `docs/PROJECT_CONTEXT.md`
* `docs/WORK_LOG.md`
* `docs/REQUIREMENTS_MATRIX.md`
* `docs/PRODUCTION_READINESS.md`
* `docs/limitations.md`
* The latest verification report and relevant test results.

Inspect the actual source code, current database state, latest Git commit, and the earlier live-test results.
Do not assume something works just because its unit tests pass or its code exists.
A. Re-run the real-data comparison workflow
The previous report said that real product catalogues had been collected from these websites:

* `groceriestogoaruba.com`
* `shop.lingandsons.com`
* `foodstore2go.com`
* `quickmartaruba.com`

Previous collection checks reported thousands of products for several of these stores and successful checks against their source feeds.
However, the last report also said that price matching and comparison had encountered issues, some fixes had not been verified by another complete live run, and real-data screens had not all been visually checked.
Investigate these gaps first.
For each website, determine whether the existing observations are still usable and whether the catalogue can be safely refreshed. Check the source website's current accessibility, applicable collection rules, and existing authorisation before making requests. Do not invent permission or collect from a site where access is not permitted.
Collect fresh data where appropriate, using polite request rates, respecting applicable robots directives, and avoiding unnecessary full-catalogue downloads.
B. Verify actual price comparisons
Test the complete pipeline:

1. Collect genuine product names, prices, variants, sizes, and source URLs.
2. Confirm that data is persisted in the correct organisation.
3. Normalise product names, brands, sizes, pack quantities, and currencies.
4. Generate equivalent-product match suggestions.
5. Review uncertain matches and correct the matching logic where necessary.
6. Calculate price differences and unit prices accurately.
7. Verify comparison results against actual product pages.
8. Open the price-comparison page in the browser and check that the displayed values agree with the stored observations.
9. Generate a report and check that it contains the same correct observations as the comparison page.

Investigate these previously reported concerns in particular:

* Brand information is missing or unreliable on some catalogues.
* The `groceriestogoaruba.com` vendor field reportedly contains `Aruba` for most products.
* A regular price displayed above a selling price was previously incorrectly interpreted as a genuine discount for many products.
* Previous matching and comparison fixes were covered by automated tests but had not been fully verified with a new live-data run.
* Different product sizes, multipacks, and variants must not be compared as identical without an appropriate normalisation.
* Prices in AWG and USD must be compared correctly using the configured reporting currency and the appropriate exchange rate.
* Inaccessible or incompletely collected competitor catalogues must not be presented as having no matching products.

Do not force products to match merely to populate the comparison table.
For each important comparison, preserve the source product URLs, observed prices, observation timestamps, match confidence, and evidence supporting the calculation.
Produce a small, auditable set of actual examples showing:

* Source website product and price.
* Competitor product and price.
* Whether the products are genuinely equivalent.
* Currency or unit conversion, where applicable.
* Calculated price difference.
* What the application displayed.
* Whether the result passed independent verification.

If products from the selected stores do not overlap sufficiently, find genuinely comparable products among authorised sites where possible. If no valid cross-store comparison can be established, report that limitation instead of inventing matching products.
C. Audit the other important features
Recheck the unverified features from the existing requirements matrix, especially:

* Authentication and email verification.
* Product-match review.
* Offers and flyer parsing.
* Own-store stock alerts.
* Report generation and PDF/Excel/CSV exports.
* Daily report scheduling in `America/Aruba`.
* Social media integrations.
* Data retention.
* Tenant isolation and access control.
* Missing integration credentials.
* Production API and worker configuration.

Prioritise core features needed for the first usable customer workflow. Optional integrations should not block real price collection when they are not required.
Distinguish clearly between real external verification, automated tests, fixture-based tests, and mocked integrations.
Do not waste time rerunning every test repeatedly if it already passes. Run the relevant targeted tests after fixes and then the complete suite once the audit changes are complete.
D. Visual and functional verification
Start the current application and inspect the actual screens populated with real collected data, where available.
Verify the website setup, collection status, Products, Match review, Price comparison, Offers, My stock, Data quality, Reports, and Settings pages.
Look for:

* Incorrect displayed prices.
* Misleading green success indicators.
* Empty data represented as successful results.
* Broken links or buttons.
* Incorrect currency formatting.
* Missing evidence or timestamps.
* Browser console errors.
* Layout problems at desktop and mobile widths.

Do not claim that a page was visually verified if the browser could not open it.
At the end of Phase 1, update the existing verification report and requirements matrix with what passed, what failed, and what remains unverified.
PHASE 2 — AUDIT GITHUB AND UPDATE THE FRONTEND
The frontend is already supposed to be uploaded to my existing GitHub repository. Check its actual state rather than assuming it is current.
Before changing the remote repository:

1. Inspect `git status`, the current branch, recent commits, remotes, and the GitHub repository state.
2. Identify committed local changes that have not been pushed.
3. Identify remote changes that are not present locally.
4. Confirm which repository and branch contain the frontend.
5. Determine whether the frontend is only stored on GitHub or also deployed through a hosting workflow.

Do not overwrite newer remote changes or force-push.
If the existing GitHub configuration is correct, update it with the verified changes that are not already present. Preserve the existing repository structure and relevant deployment workflows.
If the frontend is deployed through GitHub Pages or another existing workflow, inspect whether that deployment remains appropriate for this project and whether the latest changes are published. Do not assume that uploading source code to GitHub automatically means the website is deployed.
Ensure:

* Only intended, verified source changes are included.
* `.env` files, App Passwords, API keys, tokens, passwords, generated credentials, local databases, and other secrets are excluded.
* No fictional customer or fixture data has been committed accidentally.
* `.gitignore` is correct.
* Build and typechecking succeed.
* Frontend production configuration points to the correct backend API URL, not `localhost`.
* Authentication cookies, CORS, credentials, and CSRF settings match the actual frontend origin.

Do not create an entirely new repository unless the existing repository is genuinely unusable and you have asked for approval.
PHASE 3 — AUDIT AWS AND UPDATE THE BACKEND
The backend is intended to run on AWS. Inspect the existing AWS deployment before changing anything.
Check the available AWS CLI, current identity and permissions, configured region, existing deployment files, environment configuration, current service or instance, and actual deployed version.
Do not expose AWS credentials or secrets in terminal output, chat, logs, documentation, or Git.
Determine how the existing backend is hosted. Inspect the applicable service, such as the currently configured EC2, ECS, App Runner, Elastic Beanstalk, or other AWS deployment. Do not assume which service is being used.
Preserve the existing architecture and infrastructure wherever possible.
Required deployment checks
Verify that the deployment includes the components the application genuinely requires:

* Backend API.
* PostgreSQL database or correctly configured existing database.
* Background worker and job queue.
* Database migrations.
* Scheduled collection and daily report processing.
* File or object storage, if the current implementation requires it.
* Correct environment variables and secrets.
* Logging, health checks, readiness checks, and error handling.

Do not run local-demo commands as the production startup method.
Check that the deployed API can start from its production build, connect to the intended database, execute the required migrations, and process background jobs.
Confirm that the worker is genuinely running. A successful API health endpoint alone is not sufficient if scheduled collections and reports depend on a separate worker.
Run database backups before any potentially destructive production migration. Never drop the production database, reset production data, or replace a database merely to simplify deployment.
If the existing AWS environment lacks a required resource, security permission, or configuration, tell me exactly what is missing. Do not silently create expensive services, purchase infrastructure, or change billing-related resources without my explicit approval.
Verify the running deployment
After updating the existing AWS backend:

1. Confirm the deployed application version matches the verified local version.
2. Check API health and readiness.
3. Confirm the database migration status.
4. Verify API-to-database connectivity.
5. Confirm the worker is healthy and can execute jobs.
6. Check HTTPS and TLS.
7. Verify CORS, cookies, CSRF protection, authentication, and frontend origin configuration.
8. Check logs for startup failures and missing environment variables.
9. Confirm that errors do not expose secrets or database internals.
10. Verify that the frontend can reach the deployed API.

Do not report a successful deployment based only on a build, an upload, or a successful process start.
If new AWS resources, DNS changes, domain changes, or additional costs are required, stop before taking those actions and explain what approval is needed.
PHASE 4 — CONNECT THE GITHUB FRONTEND TO THE AWS BACKEND
Verify the complete deployed customer journey.
The intended architecture is:

* Frontend: the existing GitHub repository and its configured hosting or deployment workflow.
* Backend: the existing AWS deployment.
* Database and background worker: the existing correctly configured backend infrastructure.

Do not assume that GitHub itself hosts the frontend unless that is actually configured.
Ensure the deployed frontend uses the actual public backend URL and correct production settings.
Where permitted, test:

1. Open the deployed frontend.
2. Register a test account.
3. Verify email delivery if SMTP is configured.
4. Sign in and create a workspace.
5. Add an authorised website and competitor.
6. Start a collection job.
7. Confirm that the deployed worker runs the job.
8. Check that actual collected observations reach the database.
9. Open product and price-comparison results.
10. Generate and download a report.
11. Confirm the relevant information persists after reloading the application.

Use a disposable test account and clearly identified test records. Do not modify real customer data or send emails to unintended recipients.
If no safe production test account is available, use an authorised staging environment or ask me before creating or modifying production data.
Never use fictional data as proof of successful production operation.
PHASE 5 — FINAL VERIFICATION AND REPORT
Keep the existing `docs/PROJECT_CONTEXT.md`, `docs/WORK_LOG.md`, `docs/REQUIREMENTS_MATRIX.md`, and `docs/PRODUCTION_READINESS.md` updated with factual results.
When finished, report concisely:
A. Comparison audit

* What was verified against real websites.
* What bugs were found and fixed.
* Which actual comparisons passed validation.
* What still cannot be verified and why.

B. GitHub

* Repository and branch verified.
* Whether any changes needed to be pushed.
* Commit hash containing the verified changes.
* Whether the frontend is hosted or only stored on GitHub.

C. AWS

* Existing AWS hosting service and region.
* Whether the backend was deployed or updated.
* Deployed version or commit.
* API health and readiness results.
* Database migration and worker status.
* Any missing environment variables or blocked integrations.

D. End-to-end status

* Whether the hosted frontend communicates with the AWS backend.
* Whether authentication works.
* Whether real website collection works.
* Whether verified price comparisons and reports work.
* Which features are still incomplete.

E. What you need from me
Ask only for specific credentials, decisions, permissions, or infrastructure approvals that are genuinely required.
Do not ask me to paste secrets into chat. Direct me to configure them securely in the appropriate local or AWS secret configuration.
EXECUTION RULES

* Start with Phase 1. Do not deploy code until the unverified price-comparison workflow has been audited and relevant issues have been fixed.
* Continue autonomously through the available work; do not stop after writing a plan.
* Preserve working code and existing user data.
* Use the existing GitHub repository and AWS infrastructure.
* Do not force-push, overwrite newer remote changes, delete production data, or expose secrets.
* Do not invent website permissions or claim unsupported integrations work.
* Do not claim real-data verification based on test fixtures or mocks.
* If a task is blocked, finish the independent work and give me the exact blocker and next action.
* Do not declare Shelfwatch production-ready until the actual deployment and critical customer workflows have been verified.

Start now by auditing the unverified real-data price comparisons and other important gaps. Fix and verify those issues first, then check GitHub and update the existing AWS backend deployment.
