# Deployment

Nothing here has been deployed. The steps describe how the pieces fit; the Docker files are **untested** because Docker was not
available where they were written. Deploying to production, and any paid hosting or provider cost, is your decision.

## Pieces

| Process | Command | Needs |
| --- | --- | --- |
| API (also serves the built web app when `SERVE_WEB=true`) | `node apps/api/dist/main.js` | `DATABASE_URL` (role `ci_app`, row-level security enforced) |
| Worker (jobs, scheduler, retention, syncs) | `node apps/worker/dist/main.js` | `WORKER_DATABASE_URL` (role `ci_worker`, `BYPASSRLS`), outbound internet |
| Database job (run once, and after every upgrade) | `npm run db:setup` (roles + migrations) or `npm run db:migrate` | `DATABASE_ADMIN_URL` |
| PostgreSQL 15+ | — | Developed and tested on 18 |

Build everything with `npm ci && npm run build`. The API and worker bundles contain the workspace packages; third-party packages
(pdfkit, pg-boss, …) are loaded from `node_modules`, so deploy `node_modules` with them. Both bundles and the single-origin
build (API serving the web app, sign-in through cookies and the CSRF header) were started and exercised once locally.

Run one API and one worker to begin with. Jobs go through PostgreSQL (pg-boss) with de-duplication keys, so more workers are
safe, but each website is limited to one request at a time by the per-host limiter inside a process; do not scale workers
up to hit a competitor harder.

## Configuration checklist (production)

Copy `.env.example`; every value is validated at start-up and an unsafe production configuration stops the process.

- `NODE_ENV=production`, `APP_BASE_URL=https://your-domain` (cookies are `Secure`; terminate TLS in front of the API).
- Three database URLs; use a different strong password for each (`DATABASE_URL`, `WORKER_DATABASE_URL`, `DATABASE_ADMIN_URL`).
  `npm run db:setup` creates the roles from the passwords in those URLs.
- `TOKEN_ENCRYPTION_KEY` — required; losing it makes stored integration tokens unreadable. Keys can be rotated by listing the new
  key first: `k2:<base64>,k1:<base64>`.
- `ALLOW_LOCAL_FIXTURES=false`, `SCHEDULER_MODE=normal`, `DEMO_AUTO_CONSENT=false` (the process refuses to start otherwise).
- `COLLECTOR_USER_AGENT` with a real contact URL.
- `SMTP_URL` + `EMAIL_FROM` for real email; without them messages stay in the database outbox.
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
- Email: until `SMTP_URL` is set, new accounts stay visibly unverified and messages stay in the outbox (never reported as delivered).
