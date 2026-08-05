# Migrations must be expand/contract, never a single destructive step

**Status:** accepted
**Scope:** every migration under `packages/db/prisma/migrations` from this point on, for as long
as deploys run `docker compose up -d` (ADR-0007). Not a style preference — a correctness
constraint the deploy mechanism imposes.

## The constraint

`docker compose up -d` replaces containers without draining connections first (issue #58,
deployment design §7). During that handoff window, the **old** `console-api`/`worker` revision is
still serving traffic against the **new** schema — `deploy/deploy.sh` runs `prisma migrate deploy`
before `up -d` precisely so the schema is already at its final state when the swap happens, which
means the old code, not just the new code, has to survive running against it.

Every migration therefore has to be one of two things:

- **Expand** — purely additive. Nullable columns, new tables, new enum values, new indexes. Old
  code ignores what it doesn't know about; new code can already read/write it.
- **Contract** — purely subtractive, and only shipped in a **later** release, once the release that
  stopped depending on the old shape has fully replaced every container. Dropping a column,
  tightening a nullable column to `NOT NULL`, narrowing an enum, removing a table.

A migration that does both in one step — or a contract step in the *same* release as the code
that stops needing the old shape — has no safe window: for however long the old and new revisions
overlap, one of them is wrong.

## What this looks like against this schema

Suppose a future requirement adds a required classification field to `Account`, say
`industrySegment`, feeding some later ICP-scoring work.

**Wrong — contract with no expand phase:**

```sql
ALTER TABLE "Account" ADD COLUMN "industrySegment" TEXT NOT NULL;
```

The still-running old `console-api` revision inserts/updates `Account` rows through code that
predates this column and never populates it. Every one of those writes now violates the `NOT NULL`
constraint until the last old container is gone — an outage caused by the migration itself, not by
new code.

**Right — expand this release:**

```sql
ALTER TABLE "Account" ADD COLUMN "industrySegment" TEXT;
```

Nullable, no default requirement. Old code ignores the column it doesn't know about; new code
populates it when it writes. Both revisions work against this schema for the entire handoff window.

**Right — contract a later release**, once the deploy that shipped the column above has fully
replaced every old container (verified the same way any deploy is: `docker compose ps` showing only
the new `DEPLOY_IMAGE_TAG`, per deploy/README.md):

```sql
-- Backfill first, in the same migration or the one before it:
-- UPDATE "Account" SET "industrySegment" = 'unknown' WHERE "industrySegment" IS NULL;
ALTER TABLE "Account" ALTER COLUMN "industrySegment" SET NOT NULL;
```

Safe now, because no running container's code path can produce a write that skips the column.

This repo already has one real expand migration for reference —
[`20260805071327_add_handoff_llm_purpose`](../../packages/db/prisma/migrations/20260805071327_add_handoff_llm_purpose/migration.sql)
adds an enum value (`ALTER TYPE "LlmCallPurpose" ADD VALUE 'handoff_generation'`), which is
additive for exactly this reason: old code that never emits the new value keeps working, and new
code can start emitting it immediately.

## Why this isn't the pipeline's job to enforce

`deploy.sh` can (and does) abort a deploy when a migration *fails* — that catches a broken
migration, not a *dangerous but successful* one. Postgres has no way to know that a `DROP COLUMN`
is unsafe this release and fine next release; that judgment call belongs to whoever writes the
migration, at review time, which is why this is written down as a rule with an example rather than
left implicit.

## Consequences

A column or table scheduled for removal lives through at least two releases: one where it becomes
unused, one where it's dropped. That's the cost of the safety property, and it's a fixed cost
regardless of how small the destructive change looks — "we'll just drop this one column" is exactly
the case this ADR exists to catch.
