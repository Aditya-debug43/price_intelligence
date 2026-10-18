# Demo removal audit (directive of 2026-10-18, Phase 2)

**Result:** Shelfwatch has one product experience: a real customer's. There is no demo mode, no fixture mode, no simulator, no developer clock, no
seeded data and no setting that can switch any of them back on. Fictional websites exist only in test code and are served under ordinary public
hostnames that the product's normal rules apply to.

Commit: see the `git log` entry "remove the demo product". Verified by `tests/e2e/real-product-only.test.ts` (18 tests) plus the full suite.

## 1. What was found (the audit)

Searched the whole repository for `demo`, `fixture`, `mock`, `fake`, `sample`, `seed`, `simulat`, `localhost.test`, hard-coded users and URLs,
synthetic data, developer routes and scripts. Every occurrence was classified; those that took part in product behaviour are below.

| Area | What existed | Why it mattered |
| --- | --- | --- |
| **Database** | `organizations.mode` (`live`/`demo`), `sites.is_fixture`, `is_fixture` on evidence / price & stock observations / marketing, `reports.contains_fixture`, `integration_connections.is_simulated`; triggers `organizations_mode_immutable`, `sites_fixture_only_in_demo`; provenance value `fixture`; quantity source `simulated` | A second, fictional kind of workspace living in the same schema as real ones |
| **Config** | `ALLOW_LOCAL_FIXTURES` (let a workspace add `127.0.0.1` sites), `DEMO_AUTO_CONSENT` (auto-confirmed collection consent), `SCHEDULER_MODE=dev` (a settable clock) | Switches that weaken SSRF protection, fake consent, or fake time |
| **Services** | `getOrgMode`, `loopbackAllowed`, `requireDemoWorkspace`, `WorkspaceModeError`; `createDevInventory` / `simulateQuantity` (invented stock quantities); `DevInventoryProvider`; fixture labelling in reports ("CONTAINS FIXTURE DATA") | Code paths that produce or tolerate invented data |
| **API** | `POST /integrations/dev-inventory[/simulate]`, `GET /dev/outbox`, `POST /dev/scheduler/tick`; `/meta` fields `schedulerMode`, `devTools`, `allowLocalFixtures`; `mode` in the organisation payload | Developer and simulator surface on the production API |
| **Web** | Demo banner and "Demo" pill, `FixturePill` on websites/products/reports/dashboard/quality, Settings → *Developer tools*, the *Inventory simulator* cards (Settings and My stock), `isDemo` logic in Setup; **a fabricated "Example competitor – 7.4 % cheaper" price tag on the sign-in/registration page** | Fictional numbers and controls in the customer interface |
| **Connectors package** | `fixtures/` (ten fictional websites + server) and `test-utils.ts` exported from `@ci/connectors`, so they were part of every bundle that imported the package | A fixture server shipped as library code |
| **Scripts** | `demo-fixtures`, `demo-setup`, `fixtures-serve`, `bootstrap-dev` (created a dev owner account), `dev --demo`; **`live-probe` had the four real Aruba shop URLs hard-coded** as defaults | Demo workspace creation, seeding, a default identity, and real third-party sites contacted on a bare command |

## 2. What was deleted or changed

* **Deleted:** `apps/api/src/routes/dev.ts`; `scripts/{demo-fixtures,demo-setup,fixtures-serve,bootstrap-dev}.ts`, `scripts/lib/cli.ts`; the simulator code in `packages/connectors/src/inventory.ts` and `packages/services/src/integrations.ts`; the npm scripts `dev:demo`, `fixtures:serve`, `demo:setup`, `demo:fixtures`, `bootstrap:dev`; all fixture/demo UI (above); the `ALLOW_LOCAL_FIXTURES` / `DEMO_AUTO_CONSENT` / `SCHEDULER_MODE` settings from the config schema, `.env.example`, `deploy.env.example` and the production checks; the old `tests/e2e/workspace-modes.test.ts`.
* **Database migration `0008_remove_demo_mode`:** drops the columns and triggers above. It **never deletes data**: if the database still holds demo workspaces or fixture-labelled rows it stops with an explanation and changes nothing.
* **`live-probe` has no built-in websites** any more: it requires the addresses on the command line.
* **Registration/organisation creation** never inserts websites, products, settings beyond defaults, or alert rules beyond the four default types. A workspace starts empty (tested at the database, service and API level).
* **A real defect found and fixed:** editing a website's address kept everything collected from the *old* address attached to the site. In the developer's own database the fictional test catalogues were showing up under the names *amazon.in*, *myntra.com*, *snapdeal.com*, *nykaa.com*, *flipkart.com* and *meesho.com*, although every stored page had come from `127.0.0.1` and nothing was ever collected from those shops. A website's address can no longer be changed to a different host (409 "remove this one and add the new address"); the Setup page now offers an explicit, confirmed *replace* (delete + add).

## 3. What is retained, strictly for tests

All of it lives under `tests/` (typechecked with the rest of the repository by `npm run typecheck`) and is imported by no application, worker, script or package:

| File | Purpose |
| --- | --- |
| `tests/support/fixtures/catalogue.ts`, `server.ts` | Ten fictional websites (Shopify-style feed, WooCommerce API, JSON-LD, plain HTML, robots-blocked, bot-challenge, failing, JavaScript-only, login-gated, flaky) served by local listeners. **Each has an ordinary public hostname** (`mine.test`, `rival-woo.test`, …); the test DNS stub makes those names look public, so the product's own host rules, production fetch policy and public-host check run unchanged. Only the last network hop is replaced (`fixtures.transport`). The fictional sites read the **harness clock** (this also fixed the time-dependent flyer test that failed at the baseline). |
| `tests/support/harness.ts` | Builds the real services against an isolated PostgreSQL, with the production fetch policy and the fixtures above as the "internet". |
| `tests/support/inventory.ts` | A stand-in for an *authorised* inventory source (the product has no way to invent quantities): it creates a connection row and feeds the product's real `applyInventory` the numbers a test chooses — what a Shopify sync does after fetching levels. |
| `tests/support/net.ts` | Fetcher helpers. `loopbackFetcher` (real local sockets) is used only by the fetcher's own security tests and the real-Chrome rendering tests. |
| `tests/unit/{connectors,browser}.test.ts` | Moved here from `packages/connectors/src` because they need the fixtures. |

The `allowLoopback` option on `SafeFetcher` / `PlaywrightRenderer` remains as a **constructor-level test seam**: `fetchPolicyFrom(config)` always sets it to `false`, no setting, request or workspace can change that, and a test fails if `allowLoopback: true` appears in any production source.

## 4. How we know fictional data cannot enter a customer's workspace

1. **No source of it exists in the product.** Nothing in `apps/`, `packages/` or `scripts/` can create a fictional website, product, price, stock quantity, offer or report; a source scan (`real-product-only.test.ts` §6) fails if any removed identifier (or an import from `tests/`) reappears.
2. **No route to the fiction exists.** A customer's websites are fetched over the real network; loopback, private, link-local, metadata and internal addresses are refused when a site is added *and* when it is fetched (connect-time DNS screening, every redirect, every browser sub-request); there is no switch to relax that (tested, §2).
3. **Nothing carries across.** A website cannot be re-pointed at another host, so one website's data can never stand in for another's (tested).
4. **The schema cannot express it.** No column or provenance value marks data as fixture/simulated; a test queries `information_schema`, the triggers and every provenance/quantity-source column.
5. **Production bundles contain none of it.** After `npm run build`, `apps/api/dist`, `apps/worker/dist` and `apps/web/dist` contain none of `rival-woo.test`, `Fixture Grocery`, `startFixtureServer`, `dev-inventory`, `ALLOW_LOCAL_FIXTURES`, `DEMO_AUTO_CONSENT`, `SIMULATED` (checked with `grep` on 2026-10-18).
6. **Empty means empty.** A new workspace's API answers (`sites`, `products`, `alerts`, `offers`, `reports`, `comparison`, `marketing`, `stock`) return empty lists (tested).

## 5. The developer's local database

The local development database held one demo workspace ("Fixture Demo — Groceries To Go (not live data)": 6 websites, 114 fictional products, 687 price observations, 8 reports, 289 stored page copies). With the user's approval the whole database folder was first copied to `.data/postgres-backup-2026-10-18` (git-ignored), then only that workspace was removed with the one-off tool `npm run db:purge-demo -- --yes` (it lists first and changes nothing without `--yes`), and migration 0008 was applied. The "Audit Co" workspace, all user accounts and `.env` were not touched. The purge tool exists only to upgrade databases created before 0008; on any other database it reports that there is nothing to do.
