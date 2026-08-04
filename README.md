# Erria Outreach Agent

![Node.js >=24](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/typescript-strict-3178C6?logo=typescript&logoColor=white)
![pnpm 10](https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

An AI-assisted sales outreach system for **Mermaid Maritime Vietnam** (an Erria Group business
unit) that will draft, tier, and escalate outbound messages to accounts based on upstream
triggers, with a human in the loop for anything below full autonomy.

This is a job-application work sample. **It is currently a walking skeleton, not a working
product**: the monorepo, database schema, and both runtime processes exist and are wired
together, but the actual outreach logic (drafting, tiering, hard-trigger escalation) has not been
built yet. See [Status](#status) below for exactly what is and isn't implemented.

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
  `GET /health`, `GET /api/queue` and `GET /api/accounts/:id`. Includes a global `PrismaModule`
  (a `PRISMA` DI token) that feature modules build on.
- `apps/worker`: a standalone Fastify server that boots, validates `DATABASE_URL`, and exposes
  `GET /health`, plus a `--job=<name>` CLI entrypoint stub (`followup-cadence`,
  `audit-sample-maintenance`, `stuck-send-reconciliation`) that validates the job name and
  currently no-ops — the real job bodies land in later plans.

**Not yet built:**

- `apps/console-web` is an empty placeholder directory (no source, no `package.json`) reserved for
  the console frontend.
- Nothing orchestrates the domain modules yet: no end-to-end flow turns an incoming trigger into a
  tiered, drafted message, and no hard-trigger escalation exists. The worker never calls
  `@erria/domain`.
- No CI workflow is configured in this checkout.

This covers the "foundation" slice of Plan 1 (see
[`docs/superpowers/plans/2026-08-02-outreach-agent-foundation-flow1.md`](docs/superpowers/plans/2026-08-02-outreach-agent-foundation-flow1.md))
plus the tiering, drafting, and read-endpoint tickets, on the way to Flow 1 ("a trigger arrives and
becomes a Tier 2 draft awaiting approval").

## Architecture

A pnpm workspace monorepo with two runtime processes sharing internal library packages, rather
than separate deployed services — see
[ADR-0001](docs/adr/0001-modular-monolith-not-microservices.md) for why.

```
apps/
  console-api/   NestJS app (Express adapter) — human-facing API: health + queue/account reads
  worker/        Fastify app — background/orchestration process, health check + job stub today
  console-web/   placeholder — no source yet
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
| `ANTHROPIC_API_KEY` | nothing yet (`@anthropic-ai/sdk` is a dependency of `packages/domain` and `apps/worker`) | Still unconsumed: `draftMessage` takes an already-constructed client (`deps: { client }`), and nothing in this checkout constructs one, so the SDK never reads this |
| `CONSOLE_API_PORT` | `console-api` | Defaults to `3000` |
| `WORKER_PORT` | `worker` | Defaults to `3100` |
| `WORKER_INTERNAL_URL` | reserved for `console-api` → `worker` calls | Not yet consumed |
| `CONSOLE_WEB_ORIGIN` | `console-api` (CORS) | Unset means CORS is closed by default, not open |

## Local dependencies

`compose.yaml` holds the runtime dependencies the apps need locally — today just PostgreSQL.
One command starts them and applies the schema:

```bash
pnpm compose:up      # docker compose up -d --wait, then prisma migrate deploy
pnpm compose:down    # stop the stack, keep the data
pnpm compose:reset   # wipe the volume and come back up migrated
```

`compose:up` applies migrations as well as starting the container, which its name doesn't
advertise — it is deliberate, so that bringing the stack up leaves you with a database you can
actually query. It needs `.env` to exist first, because the migration reads `DATABASE_URL`
through `packages/db/prisma.config.ts`.

Data lives in a named volume (`erria-pgdata`) and survives `compose:down`; only `compose:reset`
discards it. If something already owns port 5432, set `POSTGRES_PORT` in `.env` — Compose reads
that file automatically — and update `DATABASE_URL` to match.

`pnpm test` does not use this stack: `packages/db`'s integration test starts its own disposable
`postgres:17` through Testcontainers, so tests pass whether or not the compose stack is running.

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

`console-api` also serves two read endpoints:

```bash
curl http://localhost:3000/api/queue          # { "items": [], "total": 0, "page": 1, "pageSize": 20 }
curl http://localhost:3000/api/accounts/<id>  # 404 when the account does not exist
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

The worker also accepts a one-shot job invocation instead of starting the server. This path runs
before the `DATABASE_URL` check, so it needs neither the database nor the exported environment:

```bash
pnpm --filter worker exec node --import @swc-node/register/esm-register src/main.ts --job=followup-cadence
# [stub] job "followup-cadence" invoked — no-op until a later plan implements it
```

Valid job names today are `followup-cadence`, `audit-sample-maintenance`, and
`stuck-send-reconciliation`; any other name throws.

## Root scripts

Defined in the root `package.json`, each fans out to every workspace package via `pnpm -r`:

```bash
pnpm build       # pnpm -r run build      — prisma generate + tsc across all packages
pnpm lint        # pnpm -r run lint       — eslint . in each package
pnpm typecheck   # pnpm -r run typecheck  — tsc --noEmit in each package
pnpm test        # pnpm -r run test       — vitest run in each package
```

`apps/console-web` has no `package.json` yet, so these currently run against 4 of the 5 directories
under `apps/`/`packages/`.

Running `pnpm test` runs the Testcontainers-backed integration tests in `packages/db` and
`apps/console-api` (each spins up and tears down a real `postgres:17` container automatically)
alongside the unit suites in `packages/domain` and `apps/worker` — no manual database setup
required for `pnpm test` itself.

## Project layout

```
apps/
  console-api/    NestJS (Express) — src/main.ts, src/app.module.ts, src/health/, src/prisma/,
                  src/queue/, src/accounts/
  worker/         Fastify — src/main.ts, src/server.ts, src/jobs/run-job.ts
  console-web/    empty placeholder
packages/
  db/             prisma/schema.prisma, prisma/migrations/, src/client.ts, src/test-utils/
  domain/         src/tiering/, src/drafting/, src/errors.ts (@erria/domain)
docs/
  adr/            architecture decision records
  architecture/   application- and infra-architecture docs
  superpowers/    specs/ (behavior design) and plans/ (implementation plans)
  agents/         repo agent-skill configuration notes
design-system/    design tokens and design reference doc
compose.yaml      local runtime dependencies (PostgreSQL) — see Local dependencies
CONTEXT.md        domain glossary — read this before naming anything new
```

## Contributing

There is no `CONTRIBUTING.md` yet. Work is tracked as GitHub Issues on
`konica/erria-work-sample`; see [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md) and
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md) for the labeling conventions used on
this repository.

## License

[MIT](LICENSE)
