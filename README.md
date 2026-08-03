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
- `apps/console-api`: a NestJS app that boots, validates `DATABASE_URL` at startup, and exposes
  `GET /health`. Includes a global `PrismaModule` (a `PRISMA` DI token) for later feature modules
  to build on.
- `apps/worker`: a standalone Fastify server that boots, validates `DATABASE_URL`, and exposes
  `GET /health`, plus a `--job=<name>` CLI entrypoint stub (`followup-cadence`,
  `audit-sample-maintenance`, `stuck-send-reconciliation`) that validates the job name and
  currently no-ops — the real job bodies land in later plans.

**Not yet built:**

- `packages/domain` and `apps/console-web` are empty placeholder directories (no source, no
  `package.json`) reserved for the framework-free business-logic package and the console frontend
  respectively.
- No drafting, tiering, or hard-trigger escalation logic exists yet — both services currently do
  nothing but health-check.
- No CI workflow is configured in this checkout.

This corresponds to Tasks 1–4 of Plan 1 (see
[`docs/superpowers/plans/2026-08-02-outreach-agent-foundation-flow1.md`](docs/superpowers/plans/2026-08-02-outreach-agent-foundation-flow1.md)),
the "foundation" slice that precedes Flow 1 ("a trigger arrives and becomes a Tier 2 draft
awaiting approval").

## Architecture

A pnpm workspace monorepo with two runtime processes sharing internal library packages, rather
than separate deployed services — see
[ADR-0001](docs/adr/0001-modular-monolith-not-microservices.md) for why.

```
apps/
  console-api/   NestJS app (Express adapter) — human-facing API, health check today
  worker/        Fastify app — background/orchestration process, health check + job stub today
  console-web/   placeholder — no source yet
packages/
  db/            Prisma schema, generated client, Testcontainers test helper (@erria/db)
  domain/        placeholder — no source yet, reserved for framework-free business logic
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
- A PostgreSQL 17-compatible database reachable via `DATABASE_URL` (for running the apps or the
  `packages/db` integration test outside of Testcontainers)
- Docker, for the Testcontainers-backed `packages/db` integration test (it spins up a disposable
  `postgres:17` container automatically — no manual database needed just to run `pnpm test`)

## Getting started

```bash
pnpm install
cp .env.example .env
# edit .env: set DATABASE_URL to a real Postgres connection string and ANTHROPIC_API_KEY
```

`.env.example` documents the environment variables the apps read:

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `console-api`, `worker`, `packages/db` | Required at boot — both apps throw and exit if unset |
| `ANTHROPIC_API_KEY` | `worker` (`@anthropic-ai/sdk` is a dependency) | Not yet consumed by any code path in this checkout |
| `CONSOLE_API_PORT` | `console-api` | Defaults to `3000` |
| `WORKER_PORT` | `worker` | Defaults to `3100` |
| `WORKER_INTERNAL_URL` | reserved for `console-api` → `worker` calls | Not yet consumed |
| `CONSOLE_WEB_ORIGIN` | `console-api` (CORS) | Unset means CORS is closed by default, not open |

If you don't already have a local Postgres, a disposable one for manual testing looks like:

```bash
docker run -d --name erria-postgres -e POSTGRES_USER=erria -e POSTGRES_PASSWORD=erria \
  -e POSTGRES_DB=erria_dev -p 5432:5432 postgres:17
```

Then apply the schema:

```bash
pnpm --filter @erria/db exec prisma migrate deploy
```

## Running the apps

```bash
pnpm --filter console-api dev   # NestJS app with reload, http://localhost:3000
pnpm --filter worker dev        # Fastify app with reload, http://localhost:3100
```

Each exposes a health check once `DATABASE_URL` is set:

```bash
curl http://localhost:3000/health   # { "status": "ok" }
curl http://localhost:3100/health   # { "status": "ok" }
```

The worker also accepts a one-shot job invocation instead of starting the server:

```bash
pnpm --filter worker exec tsx src/main.ts --job=followup-cadence
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

`packages/domain` and `apps/console-web` have no `package.json` yet, so these currently run
against 3 of the 4 directories under `apps/`/`packages/`.

Running `pnpm test` runs the Testcontainers-backed Prisma integration test in `packages/db`
(spins up and tears down a real `postgres:17` container automatically) alongside the unit/e2e
suites in `apps/console-api` and `apps/worker` — no manual database setup required for `pnpm test`
itself.

## Project layout

```
apps/
  console-api/    NestJS (Express) — src/main.ts, src/app.module.ts, src/health/, src/prisma/
  worker/         Fastify — src/main.ts, src/server.ts, src/jobs/run-job.ts
  console-web/    empty placeholder
packages/
  db/             prisma/schema.prisma, prisma/migrations/, src/client.ts, src/test-utils/
  domain/         empty placeholder
docs/
  adr/            architecture decision records
  architecture/   application- and infra-architecture docs
  superpowers/    specs/ (behavior design) and plans/ (implementation plans)
  agents/         repo agent-skill configuration notes
design-system/    design tokens and design reference doc
CONTEXT.md        domain glossary — read this before naming anything new
```

## Contributing

There is no `CONTRIBUTING.md` yet. Work is tracked as GitHub Issues on
`konica/erria-work-sample`; see [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md) and
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md) for the labeling conventions used on
this repository.

## License

[MIT](LICENSE)
