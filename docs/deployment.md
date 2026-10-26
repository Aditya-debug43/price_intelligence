# Deployment

Since 2026-10-26 the backend runs on one AWS EC2 instance and the web app on Vercel (see "The backend on AWS EC2" and "Hosting the web app on Vercel" below). The rest of this guide describes how the pieces fit; the Docker files are **untested** because Docker was not
available where they were written — the EC2 deployment does not use them. Any paid hosting or provider cost is your decision.

## Pieces

| Process | Command | Needs |
| --- | --- | --- |
| API (also serves the built web app when `SERVE_WEB=true`) | `node apps/api/dist/main.js` | `DATABASE_URL` (role `ci_app`, row-level security enforced) |
| Worker (jobs, scheduler, retention, syncs) | `node apps/worker/dist/main.js` | `WORKER_DATABASE_URL` (role `ci_worker`, `BYPASSRLS`), outbound internet |
| Database job (run once, and after every upgrade) | `npm run db:setup` (roles + migrations) or `npm run db:migrate` | `DATABASE_ADMIN_URL` |
| PostgreSQL 15+ | — | Developed and tested on 18 |

Build everything with `npm ci && npm run build`. The API and worker bundles contain the workspace packages; third-party packages
(pdfkit, pg-boss, …) are loaded from `node_modules`, so deploy `node_modules` with them. Both bundles and the single-origin
build (API serving the web app, sign-in through cookies and the CSRF header) were run locally with `NODE_ENV=production` on
2026-10-19 and passed an 18-check smoke test (health, readiness incl. migrations and worker heartbeat, served app, CSRF/Origin
rules, cookie flags, authenticated read, browser sign-in) — see [verification-report.md](verification-report.md).

## Where the web app can live (read before choosing hosting)

The web app calls the API with **relative** paths (`/api/v1/…`) and a **same-origin, `SameSite=Lax`, `HttpOnly`, `Secure`** session cookie plus an
`x-requested-with` header and an Origin check. It has **no setting for a different API address**, and the API sends no CORS headers. So:

- **Supported:** one origin. Either the API serves the built web app (`SERVE_WEB=true`, the Docker default), or a reverse proxy / CDN serves the
  static `apps/web/dist` and forwards **`/api/*`** to the API on the same hostname (for example CloudFront with two origins, or an ALB with path rules).
  `APP_BASE_URL` must be that public https address. Nothing else needs to change.
- **Not supported as-is:** the static site on one hostname (GitHub Pages, a bucket website) and the API on another. The browser would not send the
  `Lax` cookie on cross-site API calls and the calls would be blocked by the missing CORS headers. Making that work means a build-time API address,
  CORS with credentials, `SameSite=None; Secure` cookies and a revised CSRF design — a security decision, deliberately not made.
- `CORS_ORIGIN` only adds one more origin to the CSRF Origin allow-list; it does not enable cross-origin reads.

Build-file caching is built in: files under `/assets` are content-hashed and served `immutable` for a year; the app shell is `no-cache`. Behind a CDN,
keep those two rules.

Run one API and one worker to begin with. Jobs go through PostgreSQL (pg-boss) with de-duplication keys, so more workers are
safe, but each website is limited to one request at a time by the per-host limiter inside a process; do not scale workers
up to hit a competitor harder.

## Hosting the web app on Vercel

`apps/web` is a static single-page app (Vite), so Vercel can host it while the API runs elsewhere (for example on EC2). Two facts decide everything:

1. **Vercel installs only the Root Directory's own dependency tree.** With Root Directory `apps/web` the install command runs *inside* `apps/web` (Vercel: "the install path is set by the root directory"), so tools that sit only in the repository root's `devDependencies` are not installed. The build script is `tsc --noEmit -p tsconfig.json && vite build`; `typescript` used to be a root-only dependency, so Vercel stopped with `sh: tsc: command not found` (exit 127). It worked locally because everyone installs from the repository root. `apps/web` now declares `typescript` and its Node requirement itself, ships no test files (their runner exists only at the root), and `tests/unit/web-deploy.test.ts` fails if any of that regresses.
2. **The app has no API address setting** (see above): it calls `/api/v1/…` on its own hostname. Vercel serves only the static files, so `/api/*` must be forwarded to the backend.

**Vercel project settings** (Project → Settings → Build and Deployment):

| Setting | Value |
| --- | --- |
| Root Directory | `apps/web` |
| Include source files outside of the Root Directory in the Build Step | **On** (the default for new projects) — the app imports `@ci/shared` from `packages/shared`, and `tsconfig.json` extends `../../tsconfig.base.json` |
| Framework Preset / Output Directory | Vite / `dist` (also set in `apps/web/vercel.json`) |
| Install Command | the default (`npm install`), or `npm ci` for a lockfile-exact install — both verified |
| Build Command | the default (`npm run build`) |
| Node.js Version | 22.x or newer (`apps/web/package.json` → `engines.node` is `>=22.12.0`; Vite 8 does not run on older Node) |
| Environment variables | none are needed to build. Do **not** set `NODE_ENV=production` for the build or enable "Exclude development dependencies": the build needs `typescript` and `vite`, which are development dependencies |

`apps/web/vercel.json` sends every page address (`/login`, `/o/<id>/websites`, …) to `index.html`, so a refresh or a pasted link does not 404, and deliberately does **not** do that for `/api/…`.

**The backend connection.** `apps/web/vercel.json` forwards `/api/*` to the API on EC2 (`https://18-212-221-70.sslip.io`, see the next section), before the page rule. The browser only ever talks to the Vercel address, so the app stays same-origin: the session cookie is host-only on the Vercel address, the Origin check sees `https://price-intelligence-psi.vercel.app` (the backend's `APP_BASE_URL`), and no CORS is involved. To point the site at a different backend, change that one destination and push. If the backend's address changes (for example the instance gets a new public IP), the hostname, the certificate and this rule must all change together.

**npm warnings seen in the Vercel log.**
- `Unknown project config "cache-dir"` — nothing in this repository sets it (no `.npmrc`, no `cache-dir` anywhere). It comes from Vercel's build environment (or a `NPM_CONFIG_*`/`npm_config_*` variable in the project settings — remove one if you added it). It is a notice that the key will stop working in a future npm major version; it does not affect the build.
- `esbuild … postinstall … not yet covered by allowScripts` — npm 11's notice that a dependency's install script has not been approved. `esbuild` is only an *optional peer* of Vite; Vite 8 builds with Rolldown, and esbuild's script only checks its own binary. The build passes with or without it, so no approval is configured.

**How this was verified** (repeat it after changing dependencies): clone the committed code into an empty folder, then
`cd apps/web && npm ci && npm run build` (the Vercel sequence), also `npm install` from `apps/web`, and a root install followed by `npm run build -w @ci/web`. All three build; the lockfile is unchanged by the install; `npm ci --os=linux --cpu=x64 --libc=glibc` resolves the Linux builds of Rolldown, esbuild and lightningcss from the lockfile. Running the built Linux binaries needs a Linux machine — Vercel's own build is the final proof.

## The backend on AWS EC2 (as deployed on 2026-10-26)

One Amazon Linux 2023 instance (`t3.micro`: 2 vCPU, 913 MB RAM + 2 GB swap, 8 GB disk) runs everything. The repository's own pieces, as described at the top of this guide:

| What | How it runs | Listens on |
| --- | --- | --- |
| API | systemd `shelfwatch-api` — `node apps/api/dist/main.js` as the unprivileged user `shelfwatch` | `127.0.0.1:4000` (private) |
| Worker (jobs, scheduler, retention) | systemd `shelfwatch-worker` — **exactly one instance**: it owns the scheduler | nothing |
| PostgreSQL 18 (Amazon repository) | systemd `postgresql`, password (scram) authentication on loopback; roles `ci_app` (row-level security), `ci_worker` (cross-tenant), `postgres` (admin, migrations only) | `127.0.0.1:5432` (private) |
| nginx | the only public entry point: HTTPS for `18-212-221-70.sslip.io`, `/api/` proxied to the API; plain HTTP only redirects (and answers the certificate challenge); any other name gets no answer | 80, 443 |
| certbot (Amazon repository) | Let's Encrypt certificate for that name; `certbot-renew.timer` renews it and reloads nginx | — |

Code: `/opt/shelfwatch/app` (a clone of `main`; built with `npm ci` and the `@ci/api` / `@ci/worker` build scripts — the web app is hosted on Vercel, so it is not built here). Configuration and secrets: **`/etc/shelfwatch/shelfwatch.env`** (`root:shelfwatch`, mode 0640; generated on the server; never in Git, never in logs). Uploaded/exported files: `/var/lib/shelfwatch/storage`. Logs: the persistent systemd journal (capped at 200 MB). The files in `deploy/ec2/` are the exact unit files, nginx templates and scripts used.

**Hostname and HTTPS.** There is no domain of your own, so the API uses `18-212-221-70.sslip.io`, a free public name that points at the instance's IP; Let's Encrypt issued a real certificate for it (valid to 2027-01-24, renewed automatically). The name is tied to the IP: **if the instance is stopped and started, its public IP changes unless an Elastic IP is attached**, and the hostname, certificate and the Vercel rewrite would have to be redone. A reboot keeps the IP.

**Network.** AWS security group `launch-wizard-2`: SSH (22), HTTP (80) and HTTPS (443) are open to the internet; **4000 and 5432 are not**. The server has no host firewall of its own (the Amazon image ships with it off); the security group is the firewall. Consider limiting SSH (22) to your own IP address in the security group.

**Secrets.** Created on the server with `openssl` (three database passwords, the `TOKEN_ENCRYPTION_KEY`); the email settings (`SMTP_*`, `EMAIL_FROM`) were copied from the owner's local `.env`. The production secrets are different from the development ones. Losing `TOKEN_ENCRYPTION_KEY` makes stored integration tokens unreadable. The Gmail App Password was shared in chat earlier: replace it (new App Password, then `sudoedit /etc/shelfwatch/shelfwatch.env` and `sudo systemctl restart shelfwatch-api shelfwatch-worker`).

**Everyday commands** (on the server, `ssh -i <your-key-file>.pem ec2-user@18.212.221.70`):

| Do | Command |
| --- | --- |
| Overall status, readiness, errors in the last hour | `sudo shelfwatch-status` |
| Follow the logs | `sudo journalctl -u shelfwatch-api -u shelfwatch-worker -f` (add `-p err` for errors only) |
| Restart | `sudo systemctl restart shelfwatch-worker && sleep 5 && sudo systemctl restart shelfwatch-api` |
| Deploy the newest `main` (backup, pull, `npm ci`, build, migrations, restart, wait for ready) | `sudo shelfwatch-update` |
| Back up the database now | `sudo shelfwatch-backup` (also runs daily at 03:30 UTC; 7 days kept in `/var/backups/shelfwatch`) |
| Test the API with real requests (creates a throw-away account on a reserved `.test` address; nothing is emailed) | `bash /opt/shelfwatch/app/deploy/ec2/smoke-test` |
| Reissue/redo HTTPS | `sudo /opt/shelfwatch/app/deploy/ec2/enable-https 18-212-221-70.sslip.io` |

The backups sit on the same disk as the database: they protect against mistakes and bad upgrades, **not** against losing the instance. Copy the newest dump off the server (or to S3, which would be a new billable resource) if the data matters.

**Not covered.** Capacity: a `t3.micro` is enough for a demonstration (about 400 MB in use idle), not for several large catalogue collections at once. The deployment runs the unit-tested code, but no load or soak test was done. Open sign-up means anyone who finds the site can register and add websites that this server will then read: see [consent-and-compliance.md](consent-and-compliance.md).

## Configuration checklist (production)

Copy `.env.example`; every value is validated at start-up and an unsafe production configuration stops the process.

- `NODE_ENV=production`, `APP_BASE_URL=https://your-domain` (cookies are `Secure`; terminate TLS in front of the API). The process **refuses to start** unless `APP_BASE_URL` is a public `https://` address, because verification, password-reset and invitation links in emails are built from it.
- Three database URLs; use a different strong password for each (`DATABASE_URL`, `WORKER_DATABASE_URL`, `DATABASE_ADMIN_URL`).
  `npm run db:setup` creates the roles from the passwords in those URLs.
- `TOKEN_ENCRYPTION_KEY` — required; losing it makes stored integration tokens unreadable. Keys can be rotated by listing the new
  key first: `k2:<base64>,k1:<base64>`.
- There is no setting that allows loopback or private addresses, fakes data or changes the clock: those switches no longer exist.
- `COLLECTOR_USER_AGENT` with a real contact URL.
- **Email is required for anyone to register**: `SMTP_HOST`, `SMTP_PORT` (587 with STARTTLS, or 465 with `SMTP_SECURE=true`), `SMTP_USER`, `SMTP_PASSWORD` (for Gmail, an App Password), `EMAIL_FROM` (empty for Gmail). Check with `npm run email:check -- you@example.com` on the server before opening sign-up. Without it the app answers `503 email_not_configured` to registration and password reset (and `/api/v1/ready` reports `degraded`); nothing is ever reported as sent that was not. A normal Gmail account allows roughly 500 messages a day — use a transactional provider for a real customer base ([integrations.md](integrations.md#email)).
- `STORAGE_DRIVER=local` with a persistent volume, or `s3` with the `S3_*` settings (the S3 driver is tested only against an S3-compatible fake, not a real service).
- Optional: `FX_PROVIDER=open-er-api` (attribution is shown in the app), `YOUTUBE_API_KEY`, Meta and Shopify settings
  ([limitations.md](limitations.md) lists what each needs), `BROWSER_RENDERING_ENABLED=true` only where Chromium is installed.

## Upgrades

1. Back up (below). 2. Deploy the new build. 3. Run `npm run db:migrate`. 4. Restart API and worker.
Migrations are forward-only SQL files in `packages/database/migrations`; after changing `schema.ts` run `npm run db:generate`
and commit the new migration.

## Backups and restore

What must be backed up, and what must not be relied on:

| What | Why | How | Notes |
| --- | --- | --- | --- |
| **PostgreSQL database** (all tables **and** the `pgboss` queue schema) | Every tenant's catalogue, price/stock history, reports (immutable rows), alerts, settings | `pg_dump -Fc --no-owner "$DATABASE_ADMIN_URL" > shelfwatch-$(date +%F).dump`, at least daily, copied off the host. Use your provider's point-in-time recovery if it has one (recommended: it narrows the data-loss window to minutes) | Dump with the **admin** URL, not the application role: the app role is subject to row-level security and would dump nothing. Roles (`ci_app`, `ci_worker`) are cluster objects and are **not** in the dump — recreate them with `npm run db:setup` |
| **Evidence snapshots and export files** | Saved page copies (90 days) and generated PDF/CSV/Excel files | The `STORAGE_LOCAL_DIR` volume, or turn on S3 bucket versioning and a lifecycle rule | Nothing depends on snapshots after the retention window; reports are self-contained JSON and can be re-exported from the database |
| **Secrets** | `TOKEN_ENCRYPTION_KEY`, the three database passwords, SMTP/provider credentials | Your secret manager | **Losing `TOKEN_ENCRYPTION_KEY` makes stored integration tokens unreadable**: every authorised connection (e.g. Shopify) must be re-linked by its owner. Rotation keeps old keys in the ring: `k2:<base64>,k1:<base64>` |
| *(not a backup)* The embedded development PostgreSQL in `.data/postgres` | Convenience for `npm run dev` | — | Never use it for anything you cannot recreate |

Recovery objectives to decide (the app does not impose them): **RPO** (how much data you can lose — daily dumps = up to a day of
collected observations, which re-collection mostly refills; reports and alert history are the part that cannot be rebuilt) and **RTO**.

### Restore drill (do this before you need it)

> **Not yet executed.** `pg_dump`/`pg_restore` are not installed on the development machine (the embedded PostgreSQL ships only the server), so this
> drill has **not been run end to end**. What has been verified: migrations apply to an empty database and the security SQL re-applies idempotently (every
> test run starts from an empty database this way), and `GET /api/v1/ready` reports schema, role and worker state correctly. Run the drill once on a
> scratch database before trusting a backup, and correct this section with what you find.

Run it on a scratch database, never on the live one:

1. Create an empty database and the roles: `DATABASE_ADMIN_URL=<scratch admin url> npm run db:setup` (creates roles, applies migrations).
2. Restore: `pg_restore --no-owner --clean --if-exists -d "<scratch admin url>" shelfwatch-YYYY-MM-DD.dump`.
3. Re-apply the idempotent security SQL (row-level security, append-only and immutability triggers, grants): `DATABASE_ADMIN_URL=<scratch admin url> npm run db:migrate`.
4. Start an API and worker against the scratch database and open `GET /api/v1/ready`: **`database`, `migrations` and `tenant_isolation` must be `ok`**.
5. Sign in and spot-check: the newest report opens, its PDF export regenerates from the stored snapshot, a product's price history is present, the Data quality page shows the expected websites. Compare a few row counts with production (`select count(*) from reports`, `price_observations`).
6. Write down how long it took. That is your measured RTO.

What a restore reproduces: every report exactly as published (immutable snapshots), the full observation history, alerts with their
resolution history, people's match and offer-review decisions. What it does not: queued background jobs in flight at the time of the
dump (the scheduler re-plans the next run; collections resume or restart), browser sessions (everyone signs in again), and raw page
copies if the storage backup is missing (evidence rows keep URL, time and hash).

## Stopping, deploying and restarting

Both processes stop cleanly on `SIGTERM`/`SIGINT` (what an orchestrator or `docker stop` sends):

- **API** stops accepting connections, lets in-flight requests finish, closes its pools. A second signal, or 15 s without finishing, exits immediately.
- **Worker** stops taking new jobs and gives running ones up to 20 s. A collection can run for hours, so any collection still running is **handed back**:
  it is marked as having no heartbeat and the next scheduler pass of any worker (within about a minute) resumes it from its saved cursor. If a worker is
  killed outright (`SIGKILL`, power loss) the same thing happens after 15 minutes of silence, up to 3 times; a collection that keeps dying is closed as
  failed, with an alert, so the website is never stuck "collecting".
- An unhandled rejection or uncaught exception is logged and treated as fatal (clean stop, exit code 1) so the supervisor restarts the process.
- Give containers a stop grace period of **at least 40 s** (`stop_grace_period: 40s` in Compose, `terminationGracePeriodSeconds: 40` in Kubernetes).

Verified by unit tests of the lifecycle helper and an end-to-end test of the hand-back; **not** verified with a real `SIGTERM` (the development machine is Windows,
where Node cannot deliver `SIGTERM` to a child process).

## Health and readiness

| Endpoint | Use it for | Answers |
| --- | --- | --- |
| `GET /api/v1/health` | Liveness (is the process up and can it reach the database) | `200 { ok: true }` |
| `GET /api/v1/ready` | Readiness and the operator's first check | **503 `not_ready`** when it is unsafe to serve: database unreachable, database schema older than this build (run the migrations), or the web tier connecting with a role that bypasses row-level security (production). **200 `degraded`** when pages work but work would not happen: the background worker is silent or its scheduler is failing, the job queue or file storage is unusable, email is not configured in production. **200 `ready`** otherwise. Every check carries a plain-language reason. No secrets, SQL or tenant data are ever included |

Point a load balancer's readiness probe at `/api/v1/ready`, and **alert on `degraded`** as well: a deployment whose worker has stopped still serves
pages but silently collects nothing and builds no report.

## Docker

```bash
cp deploy.env.example deploy.env      # fill every CHANGE_ME
docker compose --env-file deploy.env up -d --build
```

`migrate` runs `db:setup` once and then `api` and `worker` start. Put a reverse proxy with TLS in front of port 4000.

**Status: unverified.** The `Dockerfile`, `docker-compose.yml` and `deploy.env.example` were written but **never built or run** — Docker was not available on
the development machine. Before relying on them, build the image, run `docker compose up`, and check `GET /api/v1/ready` and a sign-in. Known things to
confirm: that the image includes `packages/database/migrations` (the readiness check compares the applied migrations with that folder and says "cannot tell"
if it is missing), that `node_modules` is present for the external packages, and the stop grace period above.

## Operations

- Logs are JSON on stdout with secrets, tokens and URL credentials redacted.
- The dashboard's header bar and Data quality page show collection health per website; Settings → Integrations shows each integration's true state
  ([integrations.md](integrations.md)).
- The daily report time, time zone, retention and alert recipients are per-workspace settings, not environment variables.
- Rendering workers (`BROWSER_RENDERING_ENABLED=true`) should run behind an **egress firewall** that blocks private, link-local and cloud-metadata ranges — the
  application screens every request, but DNS rebinding between the browser's own resolution and ours cannot be closed in application code ([limitations.md](limitations.md)).
- Email: every message is written to `email_outbox` first and moves through `queued → sent | retrying | failed | not_configured` with the provider's Message-ID and final answer; Settings → Notifications shows the latest messages. Watch for `failed` rows (a permanent refusal, usually revoked credentials) and for `retrying` that never clears.
