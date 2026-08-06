# Erria Outreach Agent

![Node.js >=24](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/typescript-strict-3178C6?logo=typescript&logoColor=white)
![pnpm 10](https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

An AI-assisted sales outreach system for **Mermaid Maritime Vietnam** (an Erria Group business
unit) that will draft, tier, and escalate outbound messages to accounts based on upstream
triggers, with a human in the loop for anything below full autonomy.

This is a job-application work sample. **It is not yet a working product**: Flow 1 (an incoming
trigger becomes a tiered, drafted message awaiting human approval) is wired end to end, but the
console can only read that outcome, not act on it — there is no approve/edit/send path, and
hard-trigger escalation does not exist yet. See [Status](#status) below for exactly what is and
isn't implemented.

## Status

**Built (this checkout):**

- A pnpm workspace monorepo scaffold: TypeScript strict mode, shared ESLint config, root scripts
  that fan out to every package.
- `packages/db`: the full Prisma schema (11 models — `Account`, `Vessel`, `Contact`, `Trigger`,
  `Message`, `Escalation`, `Resolution`, `TierHistoryEvent`, `AuditSample`, `Setting`, `LlmCall`)
  targeting PostgreSQL, with an applied migration and a Testcontainers-backed integration test
  that proves a fresh Postgres can be migrated and queried through the generated client.
- `packages/domain` (`@erria/domain`): framework-free business logic — `recommendTierForTrigger`
  (spec §3/§4 tier recommendations) and message drafting (`draftMessage`, its Zod output schema,
  and the tone system prompt). No framework imports, so it is testable without booting either app.
- `apps/console-api`: a NestJS app that boots, validates `DATABASE_URL` at startup, and exposes
  `GET /health`, `GET /api/queue`, `GET /api/accounts/:id`, `GET /api/nav-counts` (live sidebar
  badge counts), and `POST /internal/triggers` — the Flow 1 entry point (see below). Includes a
  global `PrismaModule` (a `PRISMA` DI token) that feature modules build on.
- `apps/worker`: a standalone Fastify server that boots, validates `DATABASE_URL` and
  `ANTHROPIC_API_KEY`, and exposes `GET /health`, `POST /internal/process-trigger/:triggerId` (the
  drafting half of Flow 1, called by `console-api`), plus a `--job=<name>` CLI entrypoint stub
  (`followup-cadence`, `audit-sample-maintenance`, `stuck-send-reconciliation`) that validates the
  job name and currently no-ops — the real job bodies land in later plans.
- `apps/console-web`: a React 19 + Vite single-page console. There is no router — `App` renders one
  view, `QueuePage`, inside an `AppShell` (sidebar with `Account Queue`/`Review`/`Escalations`/
  `Audit Trail`/`Send Audit`/`Settings` nav items and live counts from `/api/nav-counts`, a header,
  and a dark/light `ThemeToggle`). Only `Account Queue` renders real content today — the other nav
  items are chrome, not routes. `QueuePage` fetches `/api/queue` on mount and renders the queue as a
  table (company, vessel, trigger summary, and a tier badge), with explicit loading and error
  states. Styling is design tokens plus badge rules, not a UI framework. Covered by a Testing
  Library/Vitest test. The dev server proxies `/api` and `/internal` to `console-api` on port 3000,
  so the browser talks to one origin.
- **Flow 1, end to end**: `POST /internal/triggers` on `console-api` upserts the account/vessel,
  tiers and persists the trigger via `@erria/domain`'s `recordIncomingTrigger` (Tier 2 only —
  autonomous Tier 1 sending throws `NotImplementedFlowError`, see ADR-0002), then calls `worker`'s
  `POST /internal/process-trigger/:triggerId`, which drafts a message with `@erria/domain`'s
  `draftMessage` (a real call to the Claude API via `@anthropic-ai/sdk`) and persists the outcome:
  a `pending_review` `Message` row on success, or `Trigger.status = 'needs_triage'` if the model
  abstains or the call fails. Every attempt is logged to `LlmCall` regardless of outcome. With the
  placeholder `ANTHROPIC_API_KEY` from `.env.example`, the Claude call fails with a 401 and the
  trigger is correctly routed to `needs_triage` — set a real key to see a draft actually get
  created.
- `compose.yaml`: the local runtime dependencies (today just PostgreSQL 17, on a named volume with
  a TCP healthcheck), driven by the `compose:up` / `compose:down` / `compose:reset` root scripts.
  See [Local dependencies](#local-dependencies).
- `packages/db`'s seed script (`pnpm --filter @erria/db run seed`) and CSV import path
  (`pnpm --filter @erria/db run import:triggers <file>`) — the stand-in for the out-of-scope
  trigger pipeline. See [Seed data & CSV import](#seed-data--csv-import) and
  [`docs/csv-import.md`](docs/csv-import.md).

**Not yet built:**

- Hard-trigger escalation does not exist: `nav-counts` counts `Escalation` rows with
  `status: 'active'` for the sidebar badge, but nothing ever creates one — no code path opens an
  escalation from an inbound reply or a hard trigger.
- The console is read-only: `Account Queue` lists the queue, but there is no UI for triggering
  Flow 1, and no approve/edit/send actions or write endpoints exist behind the `Review`,
  `Escalations`, `Audit Trail`, or `Send Audit` nav items — they render as static chrome with a live
  count, not a page.
- Autonomous Tier 1 sending is a documented gap (ADR-0002): `recordIncomingTrigger` throws
  `NotImplementedFlowError` if tiering ever recommends Tier 1.
- No CI workflow is configured in this checkout.

This covers Plan 1 (see
[`docs/superpowers/plans/2026-08-02-outreach-agent-foundation-flow1.md`](docs/superpowers/plans/2026-08-02-outreach-agent-foundation-flow1.md))
through Flow 1 itself ("a trigger arrives and becomes a Tier 2 draft awaiting approval" — see the
`POST /internal/triggers` walkthrough under [Running the apps](#running-the-apps)). What's left is
everything downstream of a draft existing: a human acting on it (approve/edit/send), hard-trigger
escalation, and the app-chrome nav items becoming real pages.

## Architecture

A pnpm workspace monorepo with three runtime processes sharing internal library packages, rather
than separate deployed services — see
[ADR-0001](docs/adr/0001-modular-monolith-not-microservices.md) for why.

```
apps/
  console-api/   NestJS app (Express adapter) — human-facing API: health + queue/account reads
  worker/        Fastify app — background/orchestration process, health check + job stub today
  console-web/   React + Vite SPA — the console UI, proxies /api to console-api in dev
packages/
  db/            Prisma schema, generated client, Testcontainers test helper (@erria/db)
  domain/        framework-free business logic — tiering and drafting (@erria/domain)
```

For the full system design, data model rationale, and planned flows, see:

- [`CONTEXT.md`](CONTEXT.md) — domain glossary (entities, tiering, escalation concepts, and the
  invariants they must satisfy)
- [`docs/adr/`](docs/adr) — architecture decision records
- [`docs/architecture/2026-08-02-application-architecture.md`](docs/architecture/2026-08-02-application-architecture.md) —
  module boundaries, data model, API contracts, Claude API integration
- [`docs/architecture/2026-08-02-azure-solution-architecture.md`](docs/architecture/2026-08-02-azure-solution-architecture.md) —
  cloud/infra design
- [`docs/superpowers/specs/2026-08-01-outreach-agent-design.md`](docs/superpowers/specs/2026-08-01-outreach-agent-design.md) —
  the behavior spec this system implements

## Prerequisites

- Node.js **>=24**
- pnpm **10** (`packageManager` is pinned to `pnpm@10.0.0`)
- Docker, for two independent things:
  - `pnpm compose:up`, which starts the local dependencies (PostgreSQL 17) the apps need — see
    [Local dependencies](#local-dependencies)
  - the Testcontainers-backed `packages/db` integration test, which spins up its own disposable
    `postgres:17` container (no manual database needed just to run `pnpm test`)

Any PostgreSQL 17-compatible database reachable via `DATABASE_URL` works if you would rather not
use `compose.yaml`.

## Getting started

One command takes a fresh checkout to a ready local environment — it checks prerequisites,
creates `.env` from `.env.example` if missing, installs dependencies, starts Postgres and applies
migrations, and builds the workspace packages:

```bash
pnpm bootstrap            # get to "ready"
pnpm bootstrap --start    # ...and also run all three apps (console-api, worker, console-web)
```

`pnpm bootstrap` is plain Node (no dependencies) and runs the same on Windows, macOS, and Linux. It is
idempotent, so re-running it is safe. If Docker is not running it stops early and tells you how to
start it; if `node_modules` is a broken cross-platform install (no `.bin`), it reinstalls cleanly.
See [`scripts/setup.mjs`](scripts/setup.mjs); the pure helpers are covered by `pnpm test:setup`.

<details>
<summary>Prefer to run the steps by hand?</summary>

```bash
pnpm install
cp .env.example .env
# edit .env: set DATABASE_URL to a real Postgres connection string and ANTHROPIC_API_KEY
```

Either order works. `pnpm install` runs `prisma generate` through `packages/db`'s `postinstall`,
and that step deliberately does **not** require `DATABASE_URL` — `generate` never connects to a
database, so a fresh clone installs cleanly before any `.env` exists (see the comment in
`packages/db/prisma.config.ts`). The commands that do connect need it: `pnpm compose:up` (whose
migration step reads it) and running either app.

</details>

`.env.example` documents the environment variables the apps read:

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `console-api`, `worker`, `packages/db` | Required at boot — both apps throw and exit if unset |
| `ANTHROPIC_API_KEY` | `worker` | Required at boot like `DATABASE_URL`. Used to construct the `Anthropic` client passed to `draftMessage` when `POST /internal/process-trigger/:id` runs. The placeholder value in `.env.example` boots fine but makes every draft call fail with a 401 — the trigger is then routed to `needs_triage` rather than crashing |
| `CONSOLE_API_PORT` | `console-api` | Defaults to `3000` |
| `WORKER_PORT` | `worker` | Defaults to `3100` |
| `WORKER_INTERNAL_URL` | `console-api` | Base URL `WorkerClient` calls to reach `worker`'s `POST /internal/process-trigger/:id`. Defaults to `http://localhost:3100` if unset |
| `CONSOLE_WEB_ORIGIN` | `console-api` (CORS) | Unset means CORS is closed by default, not open |
| `KEYCLOAK_PORT` | `compose.yaml` | Defaults to `8080`. Set if something already owns that port |
| `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD` | `compose.yaml` | Bootstrap credentials for the Keycloak admin console, not an application login. Defaults (`admin`/`admin`) are throwaway dev values, not secrets |
| `KEYCLOAK_SEED_PASSWORD` | `compose.yaml` (`keycloak/dev-entrypoint.sh`) | Password set on the seeded `console-web` login users after the realm imports — see [`keycloak/README.md`](keycloak/README.md) |

## Local dependencies

`compose.yaml` holds the runtime dependencies the apps need locally — PostgreSQL and Keycloak.
One command starts them and applies the schema:

```bash
pnpm compose:up      # docker compose up -d --wait, then prisma migrate deploy
pnpm compose:down    # stop the stack, keep the data
pnpm compose:reset   # wipe the volume and come back up migrated
```

`compose:up` applies migrations as well as starting the containers, which its name doesn't
advertise — it is deliberate, so that bringing the stack up leaves you with a database you can
actually query. It needs `.env` to exist first, because the migration reads `DATABASE_URL`
through `packages/db/prisma.config.ts`.

Data lives in a named volume (`erria-pgdata`) and survives `compose:down`; only `compose:reset`
discards it. If something already owns port 5432, set `POSTGRES_PORT` in `.env` — Compose reads
that file automatically — and update `DATABASE_URL` to match.

`pnpm test` does not use this stack: `packages/db`'s integration test starts its own disposable
`postgres:17` through Testcontainers, so tests pass whether or not the compose stack is running.

### Keycloak

`compose:up` also starts Keycloak (`http://localhost:8080`) and imports the realm committed at
[`keycloak/realm-export.json`](keycloak/realm-export.json) — the `console-web`/`console-api`
clients, the `reviewer`/`admin` realm roles, and two seeded users. See
[`keycloak/README.md`](keycloak/README.md) for the seeded logins and how to fetch and decode a
token by hand. Login/session wiring into the apps themselves is a later ticket (#77); today this
only provisions the realm.

## Running the apps

Two things the `dev` scripts do not do for you.

**Build the workspace packages first.** `dev` is a watcher, not a build, so it does not build dependencies,
and `@erria/db` resolves through its `main` field to `dist/index.js`. Until that is compiled,
`console-api` dies at boot with `ERR_MODULE_NOT_FOUND` for `@erria/db/dist/index.js`:

```bash
pnpm build   # or, minimally: pnpm --filter @erria/db build
```

Only `console-api` imports `@erria/db` today, so the worker starts without this — but it declares
the dependency, so build both.

**Export the variables from `.env` yourself.** Neither app loads `.env`: both read `process.env`
directly and throw `Missing required environment variable DATABASE_URL` at boot without it (only
`prisma.config.ts` calls `dotenv`). Export the file into your shell first:

```bash
set -a && . ./.env && set +a
pnpm --filter console-api dev   # NestJS app with reload, http://localhost:3000
pnpm --filter worker dev        # Fastify app with reload, http://localhost:3100
```

Each then exposes a health check:

```bash
curl http://localhost:3000/health   # { "status": "ok" }
curl http://localhost:3100/health   # { "status": "ok" }
```

`console-api` also serves the read endpoints the console uses:

```bash
curl http://localhost:3000/api/queue          # { "items": [], "total": 0, "page": 1, "pageSize": 20 }
curl http://localhost:3000/api/accounts/<id>  # 404 when the account does not exist
curl http://localhost:3000/api/nav-counts     # { "review": 0, "escalation": 0 }
```

...and one write endpoint, the Flow 1 entry point. It tiers and persists the trigger, then calls
`worker` to draft a message (a real Claude API call — see [Status](#status)):

```bash
curl -X POST http://localhost:3000/internal/triggers -H 'Content-Type: application/json' -d '{
  "account": { "externalRef": "acct-1", "companyName": "Acme Shipping", "segment": "Bulk carrier",
    "hub": "Ho Chi Minh City", "icpScore": 72, "icpBand": "high", "relationshipSummary": "Quiet 3 months" },
  "vessel": { "name": "MV Acme Star", "imo": "IMO1234567", "flag": "Vietnam" },
  "category": "class_survey_due", "description": "Survey window opens in 30 days",
  "source": "class_records", "confidenceLabel": "high",
  "verifiabilityNote": "Confirmed via class society register",
  "detectedAt": "2026-08-04T00:00:00.000Z", "hasComplianceDeadlineContent": false
}'
# { "triggerId": "<uuid>" }
```

Both `dev` scripts run `node --watch --import @swc-node/register/esm-register`. SWC rather than
esbuild is deliberate and load-bearing, not a preference: NestJS resolves implicit constructor
parameters (`private readonly x: XService`, with no `@Inject` token) from `design:paramtypes`
metadata, and esbuild cannot emit it regardless of `emitDecoratorMetadata` in `tsconfig.json`. Under
an esbuild-based runner every injected dependency silently arrives as `undefined`: the app boots,
logs its mapped routes, and then 500s on the first request to any endpoint with a dependency. That
was [#35](https://github.com/konica/erria-work-sample/issues/35). `apps/console-api`'s Vitest config
uses `unplugin-swc` for the same reason, and `src/controller-injection.spec.ts` guards against a
regression.

`worker` also serves `POST /internal/process-trigger/:triggerId` — the drafting half of Flow 1.
`console-api` calls it after persisting a trigger; call it directly to re-run drafting for an
existing trigger id without going through `console-api`:

```bash
curl -X POST http://localhost:3100/internal/process-trigger/<triggerId>
# { "status": "drafted", "messageId": "<uuid>" } or { "status": "needs_triage" }
```

The worker also accepts a one-shot job invocation instead of starting the server. This path runs
before the `DATABASE_URL` check, so it needs neither the database nor the exported environment:

```bash
pnpm --filter worker exec node --import @swc-node/register/esm-register src/main.ts --job=followup-cadence
# [stub] job "followup-cadence" invoked — no-op until a later plan implements it
```

Valid job names today are `followup-cadence`, `audit-sample-maintenance`, and
`stuck-send-reconciliation`; any other name throws.

## Deployment

`compose.deploy.yaml` is a deployment overlay, applied on top of (never instead of)
`compose.yaml`:

```bash
docker compose -f compose.yaml -f compose.deploy.yaml up -d
```

It adds Caddy (TLS termination, the only service publishing host ports), Keycloak (its own
database on the same Postgres server, heap capped, realm imported from
[`keycloak/realm-export.deploy.json.template`](keycloak/realm-export.deploy.json.template)), and
the `console-api` and `worker` app images pinned by commit SHA — and removes Postgres's published
port, so the database this file starts is not reachable from the internet. See
[`deploy/README.md`](deploy/README.md) for the full runbook (bring-up, port-scan verification,
memory recording, cron installation) and
[ADR-0007](docs/adr/0007-mvp-deploys-to-one-vm-with-docker-compose.md) /
[the deployment design doc](docs/superpowers/specs/2026-08-04-mvp-deployment-design.md) for why.

Merging to `main` runs this automatically:
[`publish.yml`](.github/workflows/publish.yml) builds and pushes `console-api`/`worker` to GHCR
tagged with the commit SHA (never `latest`), then [`deploy.yml`](.github/workflows/deploy.yml)
SSHes to the VM and runs [`deploy/deploy.sh`](deploy/deploy.sh) — pull, migrate (aborting before
`up -d` if the migration fails, per [ADR-0008](docs/adr/0008-migrations-must-be-expand-contract.md)),
`up -d`, then a health check of the public URL. See [`deploy/README.md`](deploy/README.md#ci-driven-deploy-issue-58)
for the repo variables this needs and the honest rollback story.

## Seed data & CSV import

The trigger-detection/ICP-scoring pipeline is out of scope (see [Status](#status)), so there is no
automatic way for anything to land in the queue. Two `@erria/db` scripts fill that gap — both load
`DATABASE_URL` from the workspace-root `.env` themselves, so no `set -a && . ./.env` step needed:

```bash
pnpm --filter @erria/db run seed
```

Seeds four fictional accounts from the approved mockup (Song Hong Shipping, Truong Phat Marine,
Dai Duong Shipping, Vina Offshore Supply — never a real company, vessel, person, or email) that
together exercise the console: a Tier 2 pending draft, a Tier 3 active escalation, a resolved
escalation, and a trigger too thin to draft (the abstain path). Idempotent — re-running it against
an already-seeded database is a no-op, not a duplicate.

```bash
pnpm --filter @erria/db run import:triggers <path/to/file.csv>
```

Bulk-loads real Account/Vessel/Contact/Trigger data from a spreadsheet — the documented column
contract is [`docs/csv-import.md`](docs/csv-import.md). Every row is validated before anything is
written (a bad row is rejected with its row number and column name, and nothing is written), and
re-importing the same file updates rows in place by natural key rather than duplicating them. It
does not invoke drafting — see the doc for why and what to do instead.

## Root scripts

Defined in the root `package.json`, each fans out to every workspace package via `pnpm -r`:

```bash
pnpm build       # pnpm -r run build      — prisma generate + tsc across all packages
pnpm lint        # pnpm -r run lint       — eslint . in each package
pnpm typecheck   # pnpm -r run typecheck  — tsc --noEmit in each package
pnpm test        # pnpm -r run test       — vitest run in each package
```

Running `pnpm test` runs the Testcontainers-backed integration tests in `packages/db` and
`apps/console-api` (each spins up and tears down a real `postgres:17` container automatically)
alongside the unit suites in `packages/domain`, `apps/worker`, and `apps/console-web` — no manual
database setup required for `pnpm test` itself.

## Project layout

```
apps/
  console-api/    NestJS (Express) — src/main.ts, src/app.module.ts, src/health/, src/prisma/,
                  src/queue/, src/accounts/, src/triggers/, src/nav-counts/, src/worker-client/
  worker/         Fastify — src/main.ts, src/server.ts, src/routes/process-trigger.ts,
                  src/jobs/run-job.ts
  console-web/    React + Vite — index.html, vite.config.ts, src/App.tsx, src/QueuePage.tsx,
                  src/shell/ (AppShell, Sidebar, Header, ThemeToggle, useNavCounts), src/styles/
packages/
  db/             prisma/schema.prisma, prisma/migrations/, src/client.ts, src/test-utils/,
                  src/seed/ (seed.ts, import-triggers.ts, csv.ts, upsert-entities.ts)
  domain/         src/index.ts, src/tiering/, src/drafting/, src/errors.ts (@erria/domain)
docs/
  adr/            architecture decision records
  architecture/   application- and infra-architecture docs
  superpowers/    specs/ (behavior design) and plans/ (implementation plans)
  agents/         repo agent-skill configuration notes
design-system/    design tokens and design reference doc
deploy/           deployment-overlay host config (Caddyfile, crontab, postgres-init/) — see Deployment
keycloak/         Keycloak realm fixtures — dev (#75) and deploy (#57) — see Deployment
compose.yaml      local runtime dependencies (PostgreSQL) — see Local dependencies
compose.deploy.yaml  deployment overlay (Caddy, Keycloak, console-api, worker) — see Deployment
CONTEXT.md        domain glossary — read this before naming anything new
```

## Contributing

There is no `CONTRIBUTING.md` yet. Work is tracked as GitHub Issues on
`konica/erria-work-sample`; see [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md) and
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md) for the labeling conventions used on
this repository.

## License

[MIT](LICENSE)
