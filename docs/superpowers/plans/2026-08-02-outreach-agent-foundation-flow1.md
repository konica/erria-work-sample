# Outreach Agent — Plan 1: Foundation + Flow 1 Walking Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo, database, and both runtime processes, and make Flow 1 — "a
trigger arrives and becomes a Tier 2 draft awaiting approval" — work end to end against a real
Postgres database and the real Claude API, with a minimal console UI showing the result.

**Architecture:** One pnpm workspace monorepo, two runtime processes (a NestJS Console API and a
Fastify orchestration worker) sharing two internal library packages (`@erria/domain` for
framework-free business logic, `@erria/db` for the Prisma client). This is Plan 1 of 4 — later
plans add Flow 2 (approve → send), Flow 3/4 (hard-trigger escalations), and the Settings/Send-Audit
UI. See `docs/architecture/2026-08-02-application-architecture.md` for the full system design this
plan is scoped against.

**Tech Stack:** Node.js 24, TypeScript (strict), pnpm workspaces, NestJS 11 (Express adapter),
Fastify 5, Prisma 7 with `@prisma/adapter-pg`, PostgreSQL, React 19 + Vite 8, Vitest, Testcontainers,
`@anthropic-ai/sdk` with Zod-based structured outputs, GitHub Actions.

## Global Constraints

- **Node.js >=24**, TypeScript `strict: true` everywhere (`docs/architecture/2026-08-02-application-architecture.md` §6).
- **Package manager: pnpm** (workspace protocol `workspace:*` for internal packages).
- **Claude model:** `claude-sonnet-5` for every Claude call in this plan (app doc §4.1 — deliberate
  cost/scale choice, not a placeholder).
- **Claude call resilience:** ~20s timeout, at most one manual retry, retryable only on
  `APIConnectionError`/`InternalServerError` — never on 401/403/429 (app doc §4.4).
- **Prompt caching:** system prompt cached with `cache_control: { type: 'ephemeral', ttl: '1h' }`
  (app doc §4.5).
- **Tiering (spec §3):** every new account starts at Tier 2 minimum regardless of score, until 2
  clean approvals. **Hard-trigger rule 5 (spec §4):** content citing a vessel's compliance/
  recertification deadline caps at Tier 2, always, even for an account that has otherwise earned
  Tier 1.
- **Message tone (spec §5):** first message ≤150 words, hedge unverified specifics, disclose data
  source, no manufactured urgency, signed by a named person at Mermaid Maritime Vietnam.
- **Explicit scope boundary — read before Task 5/7:** this plan implements Flow 1 exactly as
  documented in the app architecture doc's §5 ("a trigger arrives and becomes a Tier 2 draft
  awaiting approval"). It does **not** implement Tier 1 autonomous sending — that flow is never
  fully specified in the architecture doc (its four flows never describe an autonomous-send path
  end to end) and needs its own design pass before it can be built. Where this plan's tiering logic
  would produce Tier 1, it fails loudly (`NotImplementedFlowError`) rather than guessing at
  unbuilt behavior.
- **No placeholder secrets in committed files.** `.env` is git-ignored; `.env.example` documents
  required variables with dummy values.

---

### Task 1: Monorepo + workspace scaffold

**Files:**
- Create: `package.json` (root)
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.mjs`
- Create: `.env.example`
- Create: `.gitignore` additions (append, don't replace the existing file)
- Test: none (this task is pure tooling scaffold — see Step 3 for its verification)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the workspace root that every later task's `pnpm --filter <pkg>` commands and shared
  `tsconfig.base.json` (via `extends`) depend on.

- [ ] **Step 1: Create the root workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

`package.json`:
```json
{
  "name": "erria-outreach-agent",
  "private": true,
  "engines": { "node": ">=24" },
  "packageManager": "pnpm@10.0.0",
  "scripts": {
    "build": "pnpm -r run build",
    "lint": "pnpm -r run lint",
    "typecheck": "pnpm -r run typecheck",
    "test": "pnpm -r run test"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "eslint": "^9.17.0",
    "@typescript-eslint/eslint-plugin": "^8.19.0",
    "@typescript-eslint/parser": "^8.19.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`eslint.config.mjs`:
```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/generated/**', '**/node_modules/**'] },
  ...tseslint.configs.recommended,
);
```

`.env.example`:
```bash
DATABASE_URL=postgresql://erria:erria@localhost:5432/erria_dev
ANTHROPIC_API_KEY=sk-ant-your-key-here
CONSOLE_API_PORT=3000
WORKER_PORT=3100
WORKER_INTERNAL_URL=http://localhost:3100
CONSOLE_WEB_ORIGIN=http://localhost:5173
```

Append to `.gitignore` (create it if it genuinely has nothing relevant yet — check first, this
repo already has one from the mockup-era commits):
```
node_modules/
dist/
packages/*/src/generated/
.env
```

- [ ] **Step 2: Create empty workspace directories**

```bash
mkdir -p apps/console-api/src apps/worker/src apps/console-web/src packages/domain/src packages/db/src
```

- [ ] **Step 3: Verify the workspace installs cleanly**

Run: `pnpm install`
Expected: installs root devDependencies with no errors, and `pnpm -r ls --depth -1` lists zero
packages (none created yet) without erroring — confirms `pnpm-workspace.yaml`'s glob is valid even
though it matches nothing yet.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs .env.example .gitignore
git commit -m "chore: scaffold pnpm workspace monorepo"
```

---

### Task 2: Prisma schema + initial migration

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/prisma/schema.prisma`
- Create: `packages/db/src/client.ts`
- Create: `packages/db/src/index.ts`
- Create: `packages/db/src/test-utils/testcontainers-postgres.ts`
- Test: `packages/db/src/test-utils/testcontainers-postgres.integration.spec.ts`

**Interfaces:**
- Consumes: nothing domain-specific — this is the foundation every later task's persistence
  depends on.
- Produces: `prisma` (a configured `PrismaClient` instance), every generated model type
  (`Account`, `Vessel`, `Contact`, `Trigger`, `Message`, `Escalation`, `Resolution`,
  `TierHistoryEvent`, `AuditSample`, `Setting`, `LlmCall`), and
  `startTestPostgres()` / `stopTestPostgres()` for integration tests in later tasks.

This task defines the **full** data model from the application architecture doc's §2, even though
Plan 1's own logic (Tasks 5-11) only touches `Account`, `Vessel`, `Contact`, `Trigger`, `Message`,
`TierHistoryEvent`, and `LlmCall`. Writing the whole schema now avoids migration churn across Plans
2-4, which only add logic against tables that already exist.

- [ ] **Step 1: `packages/db/package.json`**

```json
{
  "name": "@erria/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "prisma generate && tsc -p tsconfig.json",
    "lint": "eslint .",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@prisma/client": "^7.0.0",
    "@prisma/adapter-pg": "^7.0.0",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "prisma": "^7.0.0",
    "@types/pg": "^8.11.0",
    "@testcontainers/postgresql": "^11.0.0",
    "vitest": "^3.0.0",
    "typescript": "^5.7.0"
  }
}
```

`packages/db/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 2: Write the full Prisma schema**

`packages/db/prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum IcpBand {
  high
  med
  low
}

enum TriggerSource {
  crm
  class_records
  public_data
  buyer_reply
}

enum ConfidenceLabel {
  high
  mid
  low
}

enum TriggerStatus {
  new
  processing
  drafted
  superseded
  needs_triage
}

enum MessageRole {
  agent_draft
  agent_sent
  buyer_inbound
  system_note
  human_reply
}

enum MessageStatus {
  pending_review
  approved
  rejected
  sent
  needs_triage
}

enum MessageChannel {
  email
}

enum HardTriggerRule {
  pricing_question
  technical_compliance_question
  negative_sentiment
  relationship_conflict
  compliance_deadline_content
  non_english_language
  conflicting_signals
  classification_uncertain
}

enum EscalationStatus {
  active
  resolved
}

enum ResolutionActionType {
  mark_resolved
  compose_send
}

enum OutcomeTag {
  closed_won
  re_engaged
  no_response
  churned
  closed_no_action
}

enum TierHistoryEventType {
  create
  clean_approval
  promote
  demote
  escalate
  hold_at_tier
  current_draft
  manual_override
}

enum AuditReviewStatus {
  unreviewed
  fine
  concerning
}

enum SentimentFloor {
  Low
  Medium
  High
}

enum LlmCallPurpose {
  draft_generation
  hard_trigger_classification
}

enum LlmCallOutcome {
  success
  retried_success
  timeout
  error
}

model Account {
  id                  String   @id @default(uuid())
  externalRef         String?  @unique
  companyName         String
  segment             String
  hub                 String
  icpScore            Int
  icpBand             IcpBand
  relationshipSummary String
  currentTier         Int
  tierRationale       String
  cleanApprovalsCount Int      @default(0)
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
  lastActivityAt      DateTime @default(now())

  vessels           Vessel[]
  contacts          Contact[]
  triggers          Trigger[]
  messages          Message[]
  escalations       Escalation[]
  resolutions       Resolution[]
  tierHistoryEvents TierHistoryEvent[]
  auditSamples      AuditSample[]
  llmCalls          LlmCall[]

  @@map("accounts")
}

model Vessel {
  id        String    @id @default(uuid())
  accountId String
  account   Account   @relation(fields: [accountId], references: [id])
  name      String
  imo       String    @unique
  flag      String
  triggers  Trigger[]

  @@map("vessels")
}

model Contact {
  id        String  @id @default(uuid())
  accountId String
  account   Account @relation(fields: [accountId], references: [id])
  name      String
  role      String
  email     String?

  @@map("contacts")
}

model Trigger {
  id                String          @id @default(uuid())
  accountId         String
  account           Account         @relation(fields: [accountId], references: [id])
  vesselId          String?
  vessel            Vessel?         @relation(fields: [vesselId], references: [id])
  category          String
  description       String
  source            TriggerSource
  confidenceLabel   ConfidenceLabel
  verifiabilityNote String
  detectedAt        DateTime
  status            TriggerStatus   @default(new)

  messages Message[]

  @@map("triggers")
}

model Message {
  id                     String         @id @default(uuid())
  accountId              String
  account                Account        @relation(fields: [accountId], references: [id])
  triggerId              String?
  trigger                Trigger?       @relation(fields: [triggerId], references: [id])
  escalationId           String?
  escalation             Escalation?    @relation(fields: [escalationId], references: [id])
  role                   MessageRole
  body                   String
  originalBody           String?
  edited                 Boolean        @default(false)
  status                 MessageStatus
  tierContext            Int
  confidenceMeta         Json?
  hardRuleFlags          Json?
  decidedBy              String?
  decidedAt              DateTime?
  sentAt                 DateTime?
  channel                MessageChannel @default(email)
  isFollowup             Boolean?
  followupSequenceNumber Int?
  createdAt              DateTime       @default(now())

  auditSample         AuditSample?
  tierHistoryEvents   TierHistoryEvent[]
  llmCalls            LlmCall[]
  resolutionFollowups Resolution[]       @relation("ResolutionFollowup")

  @@map("messages")
}

model Escalation {
  id                        String           @id @default(uuid())
  accountId                 String
  account                   Account          @relation(fields: [accountId], references: [id])
  triggerMessageId          String?
  hardTriggerRule           HardTriggerRule
  reasonSummary             String
  detail                    String
  recommendedNextStep       String
  recommendedNextStepEdited String?
  agentSendDisabled         Boolean          @default(true)
  status                    EscalationStatus @default(active)
  repeatOfResolutionId      String?
  repeatOfResolution        Resolution?      @relation("RepeatEscalation", fields: [repeatOfResolutionId], references: [id])
  createdAt                 DateTime         @default(now())
  resolvedAt                DateTime?

  messages          Message[]
  resolution        Resolution?
  tierHistoryEvents TierHistoryEvent[]

  @@map("escalations")
}

model Resolution {
  id                String               @id @default(uuid())
  escalationId      String               @unique
  escalation        Escalation           @relation(fields: [escalationId], references: [id])
  accountId         String
  account           Account              @relation(fields: [accountId], references: [id])
  actionType        ResolutionActionType
  actionTaken       String
  followupMessageId String?
  followupMessage   Message?             @relation("ResolutionFollowup", fields: [followupMessageId], references: [id])
  followupSentAt    DateTime?
  outcomeTag        OutcomeTag
  resolvedBy        String
  createdAt         DateTime             @default(now())

  repeatEscalations Escalation[] @relation("RepeatEscalation")

  @@map("resolutions")
}

model TierHistoryEvent {
  id                  String               @id @default(uuid())
  accountId           String
  account             Account              @relation(fields: [accountId], references: [id])
  eventType           TierHistoryEventType
  fromTier            Int?
  toTier              Int?
  occurredAt          DateTime             @default(now())
  reason              String
  relatedMessageId    String?
  relatedMessage      Message?             @relation(fields: [relatedMessageId], references: [id])
  relatedEscalationId String?
  relatedEscalation   Escalation?          @relation(fields: [relatedEscalationId], references: [id])

  @@map("tier_history_events")
}

model AuditSample {
  id           String            @id @default(uuid())
  messageId    String            @unique
  message      Message           @relation(fields: [messageId], references: [id])
  accountId    String
  account      Account           @relation(fields: [accountId], references: [id])
  sampledAt    DateTime          @default(now())
  reviewStatus AuditReviewStatus @default(unreviewed)
  reviewedBy   String?
  reviewedAt   DateTime?
  notes        String?

  @@map("audit_samples")
}

model Setting {
  id                       Int            @id @default(1)
  tier1PromotionThreshold  Int            @default(2)
  tier1AuditSampleRate     Int            @default(10)
  maxFollowups             Int            @default(2)
  minDaysBetweenFollowups  Int            @default(5)
  sentimentConfidenceFloor SentimentFloor @default(Medium)
  updatedAt                DateTime       @updatedAt

  @@map("settings")
}

model LlmCall {
  id             String         @id @default(uuid())
  purpose        LlmCallPurpose
  accountId      String?
  account        Account?       @relation(fields: [accountId], references: [id])
  messageId      String?
  message        Message?       @relation(fields: [messageId], references: [id])
  modelId        String
  promptVersion  String
  requestTokens  Int
  responseTokens Int
  latencyMs      Int
  outcome        LlmCallOutcome
  errorDetail    String?
  createdAt      DateTime       @default(now())

  @@map("llm_calls")
}
```

- [ ] **Step 2b: Verify the schema is internally consistent**

Run: `pnpm --filter @erria/db exec prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀` — this catches relation-field mismatches
(a common copy-paste mistake with this many models) before touching a real database.

- [ ] **Step 3: Client wrapper**

`packages/db/src/client.ts`:
```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/index.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL as string });

export const prisma = new PrismaClient({ adapter });
```

`packages/db/src/index.ts`:
```ts
export * from './generated/prisma/index.js';
export { prisma } from './client.js';
```

- [ ] **Step 4: Testcontainers helper (used by every integration test from Task 7 onward)**

`packages/db/src/test-utils/testcontainers-postgres.ts`:
```ts
import { execSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/index.js';

export interface TestPostgres {
  prisma: PrismaClient;
  container: StartedPostgreSqlContainer;
}

export async function startTestPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer('postgres:17').start();
  const connectionString = container.getConnectionUri();

  execSync('pnpm --filter @erria/db exec prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: connectionString },
    stdio: 'inherit',
  });

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  return { prisma, container };
}

export async function stopTestPostgres(testPostgres: TestPostgres): Promise<void> {
  await testPostgres.prisma.$disconnect();
  await testPostgres.container.stop();
}
```

- [ ] **Step 5: Write the integration test**

`packages/db/src/test-utils/testcontainers-postgres.integration.spec.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from './testcontainers-postgres.js';

describe('startTestPostgres', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  it('provides a working PrismaClient against a migrated schema', async () => {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Test Shipping Co',
        segment: 'Test segment',
        hub: 'Test hub',
        icpScore: 80,
        icpBand: 'high',
        relationshipSummary: 'New account · first contact today',
        currentTier: 2,
        tierRationale: 'New account — rollout default',
      },
    });

    const found = await testDb.prisma.account.findUnique({ where: { id: account.id } });
    expect(found?.companyName).toBe('Test Shipping Co');
  });
});
```

- [ ] **Step 6: Run it to verify it fails first (no migration exists yet)**

Run: `pnpm --filter @erria/db exec vitest run test-utils/testcontainers-postgres.integration.spec.ts`
Expected: FAIL — `prisma migrate deploy` inside `startTestPostgres()` errors because no migration
files exist in `prisma/migrations/` yet.

- [ ] **Step 7: Generate the initial migration**

Run: `pnpm --filter @erria/db exec prisma migrate dev --name init --create-only`, then inspect the
generated SQL in `packages/db/prisma/migrations/*_init/migration.sql` to confirm every table/enum
from Step 2 is present, then run `pnpm --filter @erria/db exec prisma migrate dev` to apply it to
your local dev database (requires `DATABASE_URL` in `.env` pointing at a real running Postgres —
docker run one locally if you don't have one: `docker run -d -p 5432:5432 -e POSTGRES_USER=erria -e POSTGRES_PASSWORD=erria -e POSTGRES_DB=erria_dev postgres:17`).

- [ ] **Step 8: Run the integration test again to verify it passes**

Run: `pnpm --filter @erria/db exec vitest run test-utils/testcontainers-postgres.integration.spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/db
git commit -m "feat(db): add full Prisma schema, initial migration, and Testcontainers test helper"
```

---

### Task 3: NestJS Console API skeleton

**Files:**
- Create: `apps/console-api/package.json`
- Create: `apps/console-api/tsconfig.json`
- Create: `apps/console-api/vitest.config.ts`
- Create: `apps/console-api/src/main.ts`
- Create: `apps/console-api/src/app.module.ts`
- Create: `apps/console-api/src/prisma/prisma.module.ts`
- Create: `apps/console-api/src/health/health.controller.ts`
- Test: `apps/console-api/src/health/health.controller.e2e-spec.ts`

**Interfaces:**
- Consumes: `prisma` from `@erria/db` (Task 2).
- Produces: `PRISMA` DI token (from `prisma.module.ts`), imported by every later Console API feature
  module (Tasks 9, 10, 11) via `@Inject(PRISMA)`.

- [ ] **Step 1: `apps/console-api/package.json`**

```json
{
  "name": "console-api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/main.js",
    "dev": "tsx watch src/main.ts",
    "lint": "eslint .",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "class-transformer": "^0.5.1",
    "class-validator": "^0.14.1",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "@erria/db": "workspace:*"
  },
  "devDependencies": {
    "@nestjs/testing": "^11.0.0",
    "supertest": "^7.0.0",
    "@types/supertest": "^6.0.0",
    "tsx": "^4.19.0",
    "vitest": "^3.0.0",
    "typescript": "^5.7.0"
  }
}
```

Deliberately no `@erria/domain` dependency here yet — this task's code doesn't import from it, and
`packages/domain` has no `package.json` until Task 5. Task 9 (which does need it, for
`recordIncomingTrigger`) adds it back to this file when it lands.

`apps/console-api/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src"]
}
```

`apps/console-api/vitest.config.ts` (aliases workspace packages straight to source for fast
unbuilt test iteration — see Global Constraints on the build/test split):
```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: { include: ['src/**/*.spec.ts', 'src/**/*.e2e-spec.ts'] },
  resolve: {
    alias: {
      '@erria/db': path.resolve(__dirname, '../../packages/db/src/index.ts'),
      '@erria/domain': path.resolve(__dirname, '../../packages/domain/src/index.ts'),
    },
  },
});
```

- [ ] **Step 2: Write the failing e2e test**

`apps/console-api/src/health/health.controller.e2e-spec.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module.js';

describe('HealthController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns ok', async () => {
    const response = await request(app.getHttpServer()).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter console-api exec vitest run src/health/health.controller.e2e-spec.ts`
Expected: FAIL — `../app.module.js` does not exist yet.

- [ ] **Step 4: Implement the skeleton**

`apps/console-api/src/prisma/prisma.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { prisma } from '@erria/db';

export const PRISMA = Symbol('PRISMA');

@Global()
@Module({
  providers: [{ provide: PRISMA, useValue: prisma }],
  exports: [PRISMA],
})
export class PrismaModule {}
```

`apps/console-api/src/health/health.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}
```

`apps/console-api/src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
})
export class AppModule {}
```

`apps/console-api/src/main.ts`:
```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({ origin: process.env.CONSOLE_WEB_ORIGIN ?? true });
  const port = process.env.CONSOLE_API_PORT ? Number(process.env.CONSOLE_API_PORT) : 3000;
  await app.listen(port);
}

bootstrap();
```

- [ ] **Step 5: Run the test again to verify it passes**

Run: `pnpm --filter console-api exec vitest run src/health/health.controller.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/console-api
git commit -m "feat(console-api): scaffold NestJS app with health check and Prisma DI module"
```

---

### Task 4: Fastify worker skeleton

**Files:**
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/vitest.config.ts`
- Create: `apps/worker/src/server.ts`
- Create: `apps/worker/src/main.ts`
- Create: `apps/worker/src/jobs/run-job.ts`
- Test: `apps/worker/src/server.spec.ts`
- Test: `apps/worker/src/jobs/run-job.spec.ts`

**Interfaces:**
- Consumes: nothing yet (Task 8 adds the real route).
- Produces: `buildServer(): FastifyInstance` — Task 8 imports this and registers the
  process-trigger route onto the instance it returns, rather than duplicating server setup.

- [ ] **Step 1: `apps/worker/package.json`**

```json
{
  "name": "worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/main.js",
    "dev": "tsx watch src/main.ts",
    "lint": "eslint .",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "fastify": "^5.2.0",
    "@anthropic-ai/sdk": "^0.70.0",
    "@erria/db": "workspace:*"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "vitest": "^3.0.0",
    "typescript": "^5.7.0"
  }
}
```

Deliberately no `@erria/domain` dependency here yet, same reasoning as Task 3 — this task's code
(a health check and a job-name stub) doesn't import from it, and `packages/domain` has no
`package.json` until Task 5. Task 8 adds it back to this file when the worker's real
process-trigger route needs `draftMessage`/`TONE_SYSTEM_PROMPT`.

`apps/worker/tsconfig.json`: identical shape to `apps/console-api/tsconfig.json` from Task 3 (no
decorators needed here, so omit `experimentalDecorators`/`emitDecoratorMetadata`):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`apps/worker/vitest.config.ts`: same alias shape as Task 3's, pointing `@erria/db`/`@erria/domain`
at `../../packages/{db,domain}/src/index.ts`.

- [ ] **Step 2: Write the failing tests**

`apps/worker/src/server.spec.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildServer } from './server.js';

describe('worker health', () => {
  it('GET /health returns ok', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
```

`apps/worker/src/jobs/run-job.spec.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { runJob } from './run-job.js';

describe('runJob', () => {
  it('throws on an unknown job name', async () => {
    await expect(runJob('not-a-real-job')).rejects.toThrow('Unknown job');
  });

  it('resolves for each known job name without throwing', async () => {
    await expect(runJob('followup-cadence')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to verify both fail**

Run: `pnpm --filter worker exec vitest run`
Expected: FAIL — `./server.js` and `./jobs/run-job.js` don't exist yet.

- [ ] **Step 4: Implement**

`apps/worker/src/server.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  app.get('/health', async () => ({ status: 'ok' }));
  return app;
}
```

`apps/worker/src/jobs/run-job.ts`:
```ts
const JOB_NAMES = ['followup-cadence', 'audit-sample-maintenance', 'stuck-send-reconciliation'] as const;
export type JobName = (typeof JOB_NAMES)[number];

export async function runJob(name: string): Promise<void> {
  if (!(JOB_NAMES as readonly string[]).includes(name)) {
    throw new Error(`Unknown job: ${name}. Expected one of ${JOB_NAMES.join(', ')}`);
  }
  // Real job bodies (follow-up cadence, audit-sample maintenance, the stuck-send
  // reconciliation sweep) land in Plans 2-3, once their owning flows exist. This task
  // only establishes the `--job=<name>` entrypoint contract Azure Container Apps
  // Jobs will invoke, per the Azure doc's §2 scheduled-jobs sketch.
  console.log(`[stub] job "${name}" invoked — no-op until a later plan implements it`);
}
```

`apps/worker/src/main.ts`:
```ts
import { buildServer } from './server.js';
import { runJob } from './jobs/run-job.js';

const jobArg = process.argv.find((arg) => arg.startsWith('--job='));

async function main() {
  if (jobArg) {
    const jobName = jobArg.split('=')[1];
    await runJob(jobName);
    process.exit(0);
  }

  const server = buildServer();
  const port = process.env.WORKER_PORT ? Number(process.env.WORKER_PORT) : 3100;
  await server.listen({ port, host: '0.0.0.0' });
}

main();
```

- [ ] **Step 5: Run again to verify both pass**

Run: `pnpm --filter worker exec vitest run`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): scaffold Fastify server with health check and scheduled-job entrypoint"
```

---

### Task 5: Tiering module — `recommendTierForTrigger`

**Files:**
- Create: `packages/domain/package.json`
- Create: `packages/domain/tsconfig.json`
- Create: `packages/domain/vitest.config.ts`
- Create: `packages/domain/src/tiering/recommend-tier.ts`
- Create: `packages/domain/src/errors.ts`
- Test: `packages/domain/src/tiering/recommend-tier.spec.ts`

**Interfaces:**
- Consumes: nothing (pure function, no I/O).
- Produces: `recommendTierForTrigger(input: TierInput): TierRecommendation`, `TierInput`,
  `TierRecommendation`, `CapReason` — consumed by Task 7's `recordIncomingTrigger`.
  `NotImplementedFlowError` — consumed by Task 7.

**Design note (read before implementing):** this function only ever returns `1 | 2` — never `3`.
Tier 3 in this system comes from hard-trigger *escalation* (Flow 3, a later plan), not from the
base trigger-arrival scoring this function does. Per the scope boundary in Global Constraints, a
computed base score of "1" for an account that hasn't independently earned Tier 1 yet gets capped
to 2 by the rollout overlay; a genuinely-earned Tier 1 recommendation is the autonomous-send case
this plan explicitly does not implement (Task 7 is where that gets rejected loudly).

- [ ] **Step 1: `packages/domain/package.json`**

```json
{
  "name": "@erria/domain",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint .",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.70.0",
    "zod": "^3.24.0",
    "@erria/db": "workspace:*"
  },
  "devDependencies": {
    "vitest": "^3.0.0",
    "typescript": "^5.7.0"
  }
}
```

`packages/domain/tsconfig.json`: same shape as `packages/db/tsconfig.json` from Task 2.

`packages/domain/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: { include: ['src/**/*.spec.ts'] },
  resolve: {
    alias: { '@erria/db': path.resolve(__dirname, '../db/src/index.ts') },
  },
});
```

`packages/domain/src/errors.ts`:
```ts
export class NotImplementedFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedFlowError';
  }
}
```

- [ ] **Step 2: Write the failing tests**

`packages/domain/src/tiering/recommend-tier.spec.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { recommendTierForTrigger } from './recommend-tier.js';

describe('recommendTierForTrigger', () => {
  it('caps a new account at Tier 2 even with a qualifying score (spec §3 rollout overlay)', () => {
    const result = recommendTierForTrigger({
      accountAlreadyEarnedTier1: false,
      icpScore: 90,
      triggerConfidence: 'high',
      hasComplianceDeadlineContent: false,
    });

    expect(result.tier).toBe(2);
    expect(result.capReasons).toEqual(['new_account_rollout']);
  });

  it('caps an already-earned Tier 1 account at Tier 2 for compliance-deadline content (spec §4 rule 5)', () => {
    const result = recommendTierForTrigger({
      accountAlreadyEarnedTier1: true,
      icpScore: 90,
      triggerConfidence: 'high',
      hasComplianceDeadlineContent: true,
    });

    expect(result.tier).toBe(2);
    expect(result.capReasons).toEqual(['compliance_deadline_content']);
  });

  it('reports both cap reasons when a new account also has compliance-deadline content', () => {
    const result = recommendTierForTrigger({
      accountAlreadyEarnedTier1: false,
      icpScore: 90,
      triggerConfidence: 'high',
      hasComplianceDeadlineContent: true,
    });

    expect(result.tier).toBe(2);
    expect(result.capReasons).toEqual(['new_account_rollout', 'compliance_deadline_content']);
  });

  it('defaults an ambiguous trigger to Tier 2 with no cap reason (base condition, not an overlay)', () => {
    const result = recommendTierForTrigger({
      accountAlreadyEarnedTier1: true,
      icpScore: 90,
      triggerConfidence: 'low',
      hasComplianceDeadlineContent: false,
    });

    expect(result.tier).toBe(2);
    expect(result.capReasons).toEqual([]);
  });

  it('recommends Tier 1 for an already-earned account with a qualifying score and no cap (the documented gap)', () => {
    const result = recommendTierForTrigger({
      accountAlreadyEarnedTier1: true,
      icpScore: 90,
      triggerConfidence: 'high',
      hasComplianceDeadlineContent: false,
    });

    expect(result.tier).toBe(1);
    expect(result.capReasons).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @erria/domain exec vitest run src/tiering/recommend-tier.spec.ts`
Expected: FAIL — `./recommend-tier.js` doesn't exist yet.

- [ ] **Step 4: Implement**

`packages/domain/src/tiering/recommend-tier.ts`:
```ts
export type CapReason = 'new_account_rollout' | 'compliance_deadline_content';

export interface TierInput {
  /** Account.currentTier === 1, read before this trigger's own evaluation. */
  accountAlreadyEarnedTier1: boolean;
  icpScore: number;
  triggerConfidence: 'high' | 'mid' | 'low';
  hasComplianceDeadlineContent: boolean;
}

export interface TierRecommendation {
  tier: 1 | 2;
  rationale: string;
  capReasons: CapReason[];
}

export function recommendTierForTrigger(input: TierInput): TierRecommendation {
  const baseTier: 1 | 2 = input.icpScore >= 70 && input.triggerConfidence === 'high' ? 1 : 2;
  let tier: 1 | 2 = baseTier;
  const capReasons: CapReason[] = [];

  if (!input.accountAlreadyEarnedTier1 && tier === 1) {
    tier = 2;
    capReasons.push('new_account_rollout');
  }
  if (input.hasComplianceDeadlineContent && tier === 1) {
    tier = 2;
    capReasons.push('compliance_deadline_content');
  }

  return { tier, rationale: buildRationale(baseTier, tier, capReasons), capReasons };
}

function buildRationale(baseTier: 1 | 2, finalTier: 1 | 2, capReasons: CapReason[]): string {
  if (capReasons.length === 0) {
    return finalTier === 1
      ? 'High ICP fit and a high-confidence trigger — qualifies for Tier 1 on score alone.'
      : 'Moderate score or an ambiguous trigger — default Tier 2 per spec §3.';
  }

  const reasonText = capReasons
    .map((reason) =>
      reason === 'new_account_rollout'
        ? 'new account, held at Tier 2 minimum until 2 clean approvals (spec §3 rollout overlay)'
        : "message cites a vessel compliance/recertification deadline, capped at Tier 2 (spec §4 rule 5)",
    )
    .join('; and ');

  return `Base score would qualify for Tier ${baseTier}, but capped to Tier ${finalTier}: ${reasonText}.`;
}
```

- [ ] **Step 5: Run again to verify it passes**

Run: `pnpm --filter @erria/domain exec vitest run src/tiering/recommend-tier.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): add recommendTierForTrigger (spec §3 rollout overlay + §4 rule 5 cap)"
```

---

### Task 6: Message Drafting module — Claude Call 1 (draft)

**Files:**
- Create: `packages/domain/src/drafting/draft-output-schema.ts`
- Create: `packages/domain/src/drafting/tone-system-prompt.ts`
- Create: `packages/domain/src/drafting/draft-message.ts`
- Test: `packages/domain/src/drafting/draft-message.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks — this module is a leaf, per the app architecture doc's
  module table ("Message Drafting... nothing else in the domain layer — this is the only place
  `@anthropic-ai/sdk` is imported").
- Produces: `draftMessage(input, deps): Promise<DraftMessageResult>`, `DraftMessageInput`,
  `DraftMessageResult`, `TONE_SYSTEM_PROMPT`, `DRAFT_MODEL_ID` — all consumed by Task 8's worker
  route.

- [ ] **Step 1: The structured-output schema**

`packages/domain/src/drafting/draft-output-schema.ts`:
```ts
import { z } from 'zod';

export const draftOutputSchema = z.object({
  should_draft: z.boolean(),
  draft_text: z.string(),
  confidence_label: z.enum(['high', 'mid', 'low']),
  abstain_reason: z.string().nullable(),
});

export type DraftOutput = z.infer<typeof draftOutputSchema>;
```

`packages/domain/src/drafting/tone-system-prompt.ts` (spec §5's tone rules plus §7's abstain
instruction, verbatim from the design spec, not paraphrased):
```ts
export const TONE_SYSTEM_PROMPT = `You are drafting a first-outreach or follow-up message on behalf of a named
person at Mermaid Maritime Vietnam. Follow these rules exactly:

- Lead with a factual, verifiable observation, not a pitch. State what's true before asking for anything.
- Hedge unverified specifics. Never assert an exact recertification/service date as fact unless the
  dossier confirms it from Erria's own service records. Default phrasing: "may be approaching its next
  scheduled service window," not "is due on [date]."
- Disclose the data source when referencing vessel-specific information — "per our service records" or
  "per publicly available vessel particulars" — never implying you are tracking the recipient without
  their knowledge.
- No manufactured urgency. Where real regulatory urgency exists, state it plainly and factually; never
  use fear-based framing.
- Low-pressure close. Offer information or availability, not a demand for a call.
- First message: at most 150 words, one clear factual hook, one clear low-pressure ask.
- Sign as a named person at Mermaid Maritime Vietnam, never "the Erria AI system."
- If the available dossier information is too thin to draft anything credible and specific, set
  should_draft to false, leave draft_text empty, and explain why in abstain_reason — do not draft a
  generic message to fill the field.`;
```

- [ ] **Step 2: Write the failing test (mocked Anthropic client — no real API key needed)**

`packages/domain/src/drafting/draft-message.spec.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { draftMessage, DRAFT_MODEL_ID } from './draft-message.js';

function buildInput() {
  return {
    toneSystemPrompt: 'test tone prompt',
    account: {
      companyName: 'Song Hong Shipping',
      segment: 'Offshore support vessel operator',
      hub: 'Haiphong',
      relationshipSummary: 'New account · first contact 12 Jul 2026',
    },
    vessel: { name: 'MV Song Hong Pioneer', imo: '9123456', flag: 'Vietnam' },
    trigger: {
      category: 'life-raft service window',
      description: 'Life raft may be approaching its next scheduled service window',
      source: 'public_data' as const,
      confidenceLabel: 'mid' as const,
      verifiabilityNote: 'Partly verifiable — service interval is illustrative',
    },
    tier: 2 as const,
  };
}

describe('draftMessage', () => {
  it('returns a successful draft on the first attempt', async () => {
    const parsedOutput = {
      should_draft: true,
      draft_text: 'Hi Ms. Pham, ...',
      confidence_label: 'high' as const,
      abstain_reason: null,
    };
    const client = {
      messages: {
        parse: vi.fn().mockResolvedValue({
          parsed_output: parsedOutput,
          usage: { input_tokens: 500, output_tokens: 120 },
        }),
      },
    } as unknown as Anthropic;

    const result = await draftMessage(buildInput(), { client });

    expect(result.outcome).toBe('success');
    expect(result.parsed).toEqual(parsedOutput);
    expect(result.requestTokens).toBe(500);
    expect(result.responseTokens).toBe(120);
    expect(client.messages.parse).toHaveBeenCalledTimes(1);
    expect(client.messages.parse).toHaveBeenCalledWith(
      expect.objectContaining({ model: DRAFT_MODEL_ID }),
      expect.objectContaining({ timeout: 20_000, maxRetries: 0 }),
    );
  });

  it('retries once on a connection failure and reports retried_success', async () => {
    const parsedOutput = {
      should_draft: true,
      draft_text: 'Hi Ms. Pham, ...',
      confidence_label: 'high' as const,
      abstain_reason: null,
    };
    const parse = vi
      .fn()
      .mockRejectedValueOnce(new Anthropic.APIConnectionError({ message: 'network blip' }))
      .mockResolvedValueOnce({
        parsed_output: parsedOutput,
        usage: { input_tokens: 500, output_tokens: 120 },
      });
    const client = { messages: { parse } } as unknown as Anthropic;

    const result = await draftMessage(buildInput(), { client });

    expect(result.outcome).toBe('retried_success');
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('does not retry on a 429 and reports error', async () => {
    const parse = vi.fn().mockRejectedValue(
      new Anthropic.RateLimitError(429, { message: 'rate limited' }, 'rate limited', undefined),
    );
    const client = { messages: { parse } } as unknown as Anthropic;

    const result = await draftMessage(buildInput(), { client });

    expect(result.outcome).toBe('error');
    expect(parse).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @erria/domain exec vitest run src/drafting/draft-message.spec.ts`
Expected: FAIL — `./draft-message.js` doesn't exist yet.

- [ ] **Step 4: Implement**

`packages/domain/src/drafting/draft-message.ts`:
```ts
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { draftOutputSchema, type DraftOutput } from './draft-output-schema.js';

export const DRAFT_MODEL_ID = 'claude-sonnet-5';
const DRAFT_TIMEOUT_MS = 20_000;

export interface DraftMessageInput {
  toneSystemPrompt: string;
  account: { companyName: string; segment: string; hub: string; relationshipSummary: string };
  vessel: { name: string; imo: string; flag: string } | null;
  trigger: {
    category: string;
    description: string;
    source: string;
    confidenceLabel: string;
    verifiabilityNote: string;
  };
  tier: 1 | 2 | 3;
}

export interface DraftMessageResult {
  outcome: 'success' | 'retried_success' | 'timeout' | 'error';
  parsed: DraftOutput | null;
  latencyMs: number;
  errorDetail: string | null;
  requestTokens: number;
  responseTokens: number;
}

export async function draftMessage(
  input: DraftMessageInput,
  deps: { client: Anthropic },
): Promise<DraftMessageResult> {
  const startedAt = Date.now();
  const params = {
    model: DRAFT_MODEL_ID,
    max_tokens: 1024,
    system: [
      {
        type: 'text' as const,
        text: input.toneSystemPrompt,
        cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
      },
    ],
    messages: [{ role: 'user' as const, content: buildUserContent(input) }],
    output_config: { format: zodOutputFormat(draftOutputSchema) },
  };
  const requestOptions = { timeout: DRAFT_TIMEOUT_MS, maxRetries: 0 };

  let response;
  let retried = false;
  try {
    response = await deps.client.messages.parse(params, requestOptions);
  } catch (firstError) {
    if (!isRetryable(firstError)) {
      return toErrorResult(firstError, startedAt);
    }
    try {
      response = await deps.client.messages.parse(params, requestOptions);
      retried = true;
    } catch (secondError) {
      return toErrorResult(secondError, startedAt);
    }
  }

  if (!response.parsed_output) {
    return {
      outcome: 'error',
      parsed: null,
      latencyMs: Date.now() - startedAt,
      errorDetail: 'schema_validation_failed',
      requestTokens: response.usage.input_tokens,
      responseTokens: response.usage.output_tokens,
    };
  }

  return {
    outcome: retried ? 'retried_success' : 'success',
    parsed: response.parsed_output,
    latencyMs: Date.now() - startedAt,
    errorDetail: null,
    requestTokens: response.usage.input_tokens,
    responseTokens: response.usage.output_tokens,
  };
}

function isRetryable(error: unknown): boolean {
  return error instanceof Anthropic.APIConnectionError || error instanceof Anthropic.InternalServerError;
}

function toErrorResult(error: unknown, startedAt: number): DraftMessageResult {
  const isConnectionFailure = error instanceof Anthropic.APIConnectionError;
  return {
    outcome: isConnectionFailure ? 'timeout' : 'error',
    parsed: null,
    latencyMs: Date.now() - startedAt,
    errorDetail: error instanceof Error ? error.message : String(error),
    requestTokens: 0,
    responseTokens: 0,
  };
}

function buildUserContent(input: DraftMessageInput): string {
  const vesselLine = input.vessel
    ? `Vessel: ${input.vessel.name} (IMO ${input.vessel.imo}, flag ${input.vessel.flag})`
    : 'Vessel: none specified';

  return [
    `Account: ${input.account.companyName} — ${input.account.segment} · ${input.account.hub}`,
    `Relationship: ${input.account.relationshipSummary}`,
    vesselLine,
    `Trigger: ${input.trigger.category} — ${input.trigger.description}`,
    `Trigger source: ${input.trigger.source} (confidence: ${input.trigger.confidenceLabel})`,
    `Verifiability note: ${input.trigger.verifiabilityNote}`,
    `Account tier: ${input.tier}`,
  ].join('\n');
}
```

Note the resilience wrapper sets `maxRetries: 0` at the SDK request-option level and implements
exactly one retry itself — this is the app doc's §4.4-documented alternative to the SDK's own
retry mechanism, chosen specifically because it lets `LlmCall.outcome` (Task 8) accurately report
`retried_success` vs `success`, which an SDK-internal retry can't distinguish from the caller's side.

- [ ] **Step 5: Run again to verify it passes**

Run: `pnpm --filter @erria/domain exec vitest run src/drafting/draft-message.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/drafting
git commit -m "feat(domain): add draftMessage — Claude Call 1 with structured output and single-retry resilience"
```

---

### Task 7: Domain repository — `recordIncomingTrigger`

**Files:**
- Create: `packages/domain/src/tiering/persist-trigger-tier.ts`
- Test: `packages/domain/src/tiering/persist-trigger-tier.integration.spec.ts`

**Interfaces:**
- Consumes: `recommendTierForTrigger` (Task 5), `prisma`/`PrismaClient` type (Task 2),
  `NotImplementedFlowError` (Task 5), `startTestPostgres`/`stopTestPostgres` (Task 2, test-only).
- Produces: `recordIncomingTrigger(prisma, input): Promise<PersistedTrigger>`, `IncomingTriggerInput`,
  `PersistedTrigger` — consumed by Task 9's `TriggersService`.

- [ ] **Step 1: Write the failing integration test**

`packages/domain/src/tiering/persist-trigger-tier.integration.spec.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db';
import { recordIncomingTrigger } from './persist-trigger-tier.js';
import { NotImplementedFlowError } from '../errors.js';

describe('recordIncomingTrigger', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function createAccount(overrides: Partial<{ currentTier: number; icpScore: number }> = {}) {
    return testDb.prisma.account.create({
      data: {
        companyName: 'Song Hong Shipping',
        segment: 'Offshore support vessel operator',
        hub: 'Haiphong',
        icpScore: overrides.icpScore ?? 90,
        icpBand: 'high',
        relationshipSummary: 'New account · first contact 12 Jul 2026',
        currentTier: overrides.currentTier ?? 2,
        tierRationale: 'New account — rollout default',
      },
    });
  }

  it('holds a not-yet-earned account at Tier 2 and writes a hold_at_tier event', async () => {
    const account = await createAccount();

    const result = await recordIncomingTrigger(testDb.prisma, {
      accountId: account.id,
      vesselId: null,
      category: 'life-raft service window',
      description: 'test',
      source: 'public_data',
      confidenceLabel: 'high',
      verifiabilityNote: 'test',
      detectedAt: new Date(),
      hasComplianceDeadlineContent: false,
    });

    expect(result.tier).toBe(2);

    const events = await testDb.prisma.tierHistoryEvent.findMany({ where: { accountId: account.id } });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('hold_at_tier');

    const refreshedAccount = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshedAccount.currentTier).toBe(2);
  });

  it('caps a Tier-1-earned account to a message-level Tier 2 without changing Account.currentTier', async () => {
    const account = await createAccount({ currentTier: 1 });

    const result = await recordIncomingTrigger(testDb.prisma, {
      accountId: account.id,
      vesselId: null,
      category: 'compliance deadline',
      description: 'test',
      source: 'class_records',
      confidenceLabel: 'high',
      verifiabilityNote: 'test',
      detectedAt: new Date(),
      hasComplianceDeadlineContent: true,
    });

    expect(result.tier).toBe(2);

    const refreshedAccount = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshedAccount.currentTier).toBe(1);

    const events = await testDb.prisma.tierHistoryEvent.findMany({ where: { accountId: account.id } });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('current_draft');
  });

  it('throws NotImplementedFlowError for a fully-qualified Tier 1 recommendation', async () => {
    const account = await createAccount({ currentTier: 1 });

    await expect(
      recordIncomingTrigger(testDb.prisma, {
        accountId: account.id,
        vesselId: null,
        category: 'test',
        description: 'test',
        source: 'public_data',
        confidenceLabel: 'high',
        verifiabilityNote: 'test',
        detectedAt: new Date(),
        hasComplianceDeadlineContent: false,
      }),
    ).rejects.toThrow(NotImplementedFlowError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @erria/domain exec vitest run src/tiering/persist-trigger-tier.integration.spec.ts`
Expected: FAIL — `./persist-trigger-tier.js` doesn't exist yet.

- [ ] **Step 3: Implement**

`packages/domain/src/tiering/persist-trigger-tier.ts`:
```ts
import type { PrismaClient } from '@erria/db';
import { recommendTierForTrigger } from './recommend-tier.js';
import { NotImplementedFlowError } from '../errors.js';

export interface IncomingTriggerInput {
  accountId: string;
  vesselId: string | null;
  category: string;
  description: string;
  source: 'crm' | 'class_records' | 'public_data' | 'buyer_reply';
  confidenceLabel: 'high' | 'mid' | 'low';
  verifiabilityNote: string;
  detectedAt: Date;
  hasComplianceDeadlineContent: boolean;
}

export interface PersistedTrigger {
  triggerId: string;
  tier: 1 | 2;
  tierRationale: string;
}

export async function recordIncomingTrigger(
  prisma: PrismaClient,
  input: IncomingTriggerInput,
): Promise<PersistedTrigger> {
  return prisma.$transaction(async (tx) => {
    const account = await tx.account.findUniqueOrThrow({ where: { id: input.accountId } });
    const accountAlreadyEarnedTier1 = account.currentTier === 1;

    const recommendation = recommendTierForTrigger({
      accountAlreadyEarnedTier1,
      icpScore: account.icpScore,
      triggerConfidence: input.confidenceLabel,
      hasComplianceDeadlineContent: input.hasComplianceDeadlineContent,
    });

    if (recommendation.tier === 1) {
      throw new NotImplementedFlowError(
        'recommendTierForTrigger returned tier 1, but Flow 1 only implements the Tier 2 ' +
          'draft path documented in the application architecture doc §5. Autonomous Tier 1 ' +
          'sending is a documented gap (see Global Constraints) and needs its own design.',
      );
    }

    const trigger = await tx.trigger.create({
      data: {
        accountId: input.accountId,
        vesselId: input.vesselId,
        category: input.category,
        description: input.description,
        source: input.source,
        confidenceLabel: input.confidenceLabel,
        verifiabilityNote: input.verifiabilityNote,
        detectedAt: input.detectedAt,
        status: 'processing',
      },
    });

    const messageLevelCapOnly =
      accountAlreadyEarnedTier1 &&
      recommendation.capReasons.every((reason) => reason === 'compliance_deadline_content');

    if (messageLevelCapOnly) {
      await tx.tierHistoryEvent.create({
        data: {
          accountId: input.accountId,
          eventType: 'current_draft',
          fromTier: account.currentTier,
          toTier: recommendation.tier,
          reason: recommendation.rationale,
        },
      });
    } else {
      if (account.currentTier !== recommendation.tier) {
        await tx.account.update({
          where: { id: input.accountId },
          data: { currentTier: recommendation.tier, tierRationale: recommendation.rationale },
        });
      }
      await tx.tierHistoryEvent.create({
        data: {
          accountId: input.accountId,
          eventType: 'hold_at_tier',
          fromTier: account.currentTier,
          toTier: recommendation.tier,
          reason: recommendation.rationale,
        },
      });
    }

    return { triggerId: trigger.id, tier: recommendation.tier, tierRationale: recommendation.rationale };
  });
}
```

Add the exports to `packages/domain/src/index.ts` (create this file now — Task 9 needs it):
```ts
export { recommendTierForTrigger } from './tiering/recommend-tier.js';
export type { TierInput, TierRecommendation, CapReason } from './tiering/recommend-tier.js';
export { recordIncomingTrigger } from './tiering/persist-trigger-tier.js';
export type { IncomingTriggerInput, PersistedTrigger } from './tiering/persist-trigger-tier.js';
export { NotImplementedFlowError } from './errors.js';
export { draftMessage, DRAFT_MODEL_ID } from './drafting/draft-message.js';
export type { DraftMessageInput, DraftMessageResult } from './drafting/draft-message.js';
export { TONE_SYSTEM_PROMPT } from './drafting/tone-system-prompt.js';
export { draftOutputSchema } from './drafting/draft-output-schema.js';
export type { DraftOutput } from './drafting/draft-output-schema.js';
```

Also add `export { startTestPostgres, stopTestPostgres } from './test-utils/testcontainers-postgres.js'; export type { TestPostgres } from './test-utils/testcontainers-postgres.js';`
to `packages/db/src/index.ts` (it was created in Task 2 without this — this test needed it, so add
it now).

- [ ] **Step 4: Run again to verify it passes**

Run: `pnpm --filter @erria/domain exec vitest run src/tiering/persist-trigger-tier.integration.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/domain packages/db/src/index.ts
git commit -m "feat(domain): add recordIncomingTrigger — transactional trigger + tier persistence"
```

---

### Task 8: Worker route — `POST /internal/process-trigger/:triggerId`

**Files:**
- Create: `apps/worker/src/routes/process-trigger.ts`
- Modify: `apps/worker/src/server.ts` — accept and wire optional deps
- Modify: `apps/worker/src/main.ts` — construct real `prisma`/`Anthropic` deps
- Test: `apps/worker/src/routes/process-trigger.integration.spec.ts`

**Interfaces:**
- Consumes: `draftMessage`, `TONE_SYSTEM_PROMPT`, `DRAFT_MODEL_ID` (Task 6), `PrismaClient` type
  (Task 2), `startTestPostgres`/`stopTestPostgres` (Task 2, test-only), `buildServer` (Task 4).
- Produces: the route itself — Task 9's `WorkerClient` calls it over HTTP; no in-process consumers.

- [ ] **Step 1: Write the failing integration test**

`apps/worker/src/routes/process-trigger.integration.spec.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db';
import { buildServer } from '../server.js';

function fakeAnthropicClient(parsedOutput: Record<string, unknown>): Anthropic {
  return {
    messages: {
      parse: vi.fn().mockResolvedValue({
        parsed_output: parsedOutput,
        usage: { input_tokens: 500, output_tokens: 120 },
      }),
    },
  } as unknown as Anthropic;
}

describe('POST /internal/process-trigger/:triggerId', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  it('creates a pending_review Message from a successful draft', async () => {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Song Hong Shipping',
        segment: 'Offshore support vessel operator',
        hub: 'Haiphong',
        icpScore: 90,
        icpBand: 'high',
        relationshipSummary: 'New account · first contact 12 Jul 2026',
        currentTier: 2,
        tierRationale: 'New account — rollout default',
      },
    });
    const trigger = await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'life-raft service window',
        description: 'test',
        source: 'public_data',
        confidenceLabel: 'mid',
        verifiabilityNote: 'test',
        detectedAt: new Date(),
        status: 'new',
      },
    });

    const anthropic = fakeAnthropicClient({
      should_draft: true,
      draft_text: 'Hi Ms. Pham, ...',
      confidence_label: 'high',
      abstain_reason: null,
    });
    const server = buildServer({ prisma: testDb.prisma, anthropic });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/process-trigger/${trigger.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'drafted' });

    const updatedTrigger = await testDb.prisma.trigger.findUniqueOrThrow({ where: { id: trigger.id } });
    expect(updatedTrigger.status).toBe('drafted');

    const message = await testDb.prisma.message.findFirstOrThrow({ where: { triggerId: trigger.id } });
    expect(message.status).toBe('pending_review');
    expect(message.tierContext).toBe(2);
    expect(message.body).toBe('Hi Ms. Pham, ...');
  });

  it('routes to needs_triage when the model abstains', async () => {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Thin Dossier Co',
        segment: 'Test segment',
        hub: 'Test hub',
        icpScore: 50,
        icpBand: 'low',
        relationshipSummary: 'New account',
        currentTier: 2,
        tierRationale: 'New account — rollout default',
      },
    });
    const trigger = await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'unclear signal',
        description: 'test',
        source: 'public_data',
        confidenceLabel: 'low',
        verifiabilityNote: 'test',
        detectedAt: new Date(),
        status: 'new',
      },
    });

    const anthropic = fakeAnthropicClient({
      should_draft: false,
      draft_text: '',
      confidence_label: 'low',
      abstain_reason: 'Dossier too thin to draft anything specific',
    });
    const server = buildServer({ prisma: testDb.prisma, anthropic });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/process-trigger/${trigger.id}`,
    });

    expect(response.json()).toMatchObject({ status: 'needs_triage' });

    const updatedTrigger = await testDb.prisma.trigger.findUniqueOrThrow({ where: { id: trigger.id } });
    expect(updatedTrigger.status).toBe('needs_triage');

    const messageCount = await testDb.prisma.message.count({ where: { triggerId: trigger.id } });
    expect(messageCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter worker exec vitest run src/routes/process-trigger.integration.spec.ts`
Expected: FAIL — `buildServer` doesn't accept a deps argument yet, and the route doesn't exist.

- [ ] **Step 3: Implement**

`apps/worker/src/routes/process-trigger.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@erria/db';
import type Anthropic from '@anthropic-ai/sdk';
import { draftMessage, TONE_SYSTEM_PROMPT, DRAFT_MODEL_ID } from '@erria/domain';

export function registerProcessTriggerRoute(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; anthropic: Anthropic },
) {
  app.post<{ Params: { triggerId: string } }>(
    '/internal/process-trigger/:triggerId',
    async (request, reply) => {
      const trigger = await deps.prisma.trigger.findUnique({
        where: { id: request.params.triggerId },
        include: { account: true, vessel: true },
      });

      if (!trigger) {
        return reply.code(404).send({ error: 'trigger_not_found' });
      }

      const draft = await draftMessage(
        {
          toneSystemPrompt: TONE_SYSTEM_PROMPT,
          account: {
            companyName: trigger.account.companyName,
            segment: trigger.account.segment,
            hub: trigger.account.hub,
            relationshipSummary: trigger.account.relationshipSummary,
          },
          vessel: trigger.vessel
            ? { name: trigger.vessel.name, imo: trigger.vessel.imo, flag: trigger.vessel.flag }
            : null,
          trigger: {
            category: trigger.category,
            description: trigger.description,
            source: trigger.source,
            confidenceLabel: trigger.confidenceLabel,
            verifiabilityNote: trigger.verifiabilityNote,
          },
          tier: trigger.account.currentTier as 1 | 2 | 3,
        },
        { client: deps.anthropic },
      );

      await deps.prisma.llmCall.create({
        data: {
          purpose: 'draft_generation',
          accountId: trigger.accountId,
          modelId: DRAFT_MODEL_ID,
          promptVersion: 'v1',
          requestTokens: draft.requestTokens,
          responseTokens: draft.responseTokens,
          latencyMs: draft.latencyMs,
          outcome: draft.outcome,
          errorDetail: draft.errorDetail,
        },
      });

      const draftSucceeded = draft.outcome === 'success' || draft.outcome === 'retried_success';

      if (!draftSucceeded || !draft.parsed || draft.parsed.should_draft === false) {
        await deps.prisma.trigger.update({ where: { id: trigger.id }, data: { status: 'needs_triage' } });
        await deps.prisma.tierHistoryEvent.create({
          data: {
            accountId: trigger.accountId,
            eventType: 'hold_at_tier',
            reason: draft.parsed?.abstain_reason ?? `Drafting call ${draft.outcome} — routed to human triage`,
          },
        });
        return reply.send({ status: 'needs_triage' });
      }

      const message = await deps.prisma.message.create({
        data: {
          accountId: trigger.accountId,
          triggerId: trigger.id,
          role: 'agent_draft',
          body: draft.parsed.draft_text,
          status: 'pending_review',
          tierContext: trigger.account.currentTier,
          confidenceMeta: {
            model: DRAFT_MODEL_ID,
            confidenceLabel: draft.parsed.confidence_label,
            latencyMs: draft.latencyMs,
          },
        },
      });

      await deps.prisma.trigger.update({ where: { id: trigger.id }, data: { status: 'drafted' } });

      return reply.send({ status: 'drafted', messageId: message.id });
    },
  );
}
```

Modify `apps/worker/src/server.ts` to accept optional deps and register the route when provided
(keeps the Task 4 no-deps health-check test passing unchanged):
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@erria/db';
import type Anthropic from '@anthropic-ai/sdk';
import { registerProcessTriggerRoute } from './routes/process-trigger.js';

export interface ServerDeps {
  prisma: PrismaClient;
  anthropic: Anthropic;
}

export function buildServer(deps?: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: true });
  app.get('/health', async () => ({ status: 'ok' }));
  if (deps) {
    registerProcessTriggerRoute(app, deps);
  }
  return app;
}
```

Modify `apps/worker/src/main.ts` to construct real deps for the long-lived server mode:
```ts
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@erria/db';
import { buildServer } from './server.js';
import { runJob } from './jobs/run-job.js';

const jobArg = process.argv.find((arg) => arg.startsWith('--job='));

async function main() {
  if (jobArg) {
    const jobName = jobArg.split('=')[1];
    await runJob(jobName);
    process.exit(0);
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const server = buildServer({ prisma, anthropic });
  const port = process.env.WORKER_PORT ? Number(process.env.WORKER_PORT) : 3100;
  await server.listen({ port, host: '0.0.0.0' });
}

main();
```

- [ ] **Step 4: Run the full worker test suite to verify everything passes**

Run: `pnpm --filter worker exec vitest run`
Expected: PASS — the Task 4 health-check test still passes (no-deps `buildServer()` call is
unaffected), and both new process-trigger tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): implement POST /internal/process-trigger/:triggerId (Flow 1 step 3-7)"
```

---

### Task 9: Console API — `POST /internal/triggers`

**Files:**
- Create: `apps/console-api/src/triggers/dto/incoming-trigger.dto.ts`
- Create: `apps/console-api/src/triggers/triggers.service.ts`
- Create: `apps/console-api/src/triggers/triggers.controller.ts`
- Create: `apps/console-api/src/triggers/triggers.module.ts`
- Create: `apps/console-api/src/worker-client/worker-client.service.ts`
- Create: `apps/console-api/src/worker-client/worker-client.module.ts`
- Modify: `apps/console-api/src/app.module.ts` — import `TriggersModule`
- Test: `apps/console-api/src/triggers/triggers.service.integration.spec.ts`

**Interfaces:**
- Consumes: `recordIncomingTrigger` (Task 7), `PRISMA` token (Task 3), the worker's
  `/internal/process-trigger/:triggerId` route (Task 8, called over HTTP — the test starts a real
  worker instance rather than mocking the HTTP boundary).
- Produces: the `POST /internal/triggers` HTTP endpoint (no in-process consumers — this is the
  system's external entry point per the app architecture doc §5 Flow 1 step 1).

- [ ] **Step 1: DTO**

`apps/console-api/src/triggers/dto/incoming-trigger.dto.ts`:
```ts
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsISO8601, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';

export class IncomingAccountDto {
  @IsString() externalRef!: string;
  @IsString() companyName!: string;
  @IsString() segment!: string;
  @IsString() hub!: string;
  @IsInt() @Min(0) @Max(100) icpScore!: number;
  @IsIn(['high', 'med', 'low']) icpBand!: 'high' | 'med' | 'low';
  @IsString() relationshipSummary!: string;
}

export class IncomingVesselDto {
  @IsString() name!: string;
  @IsString() imo!: string;
  @IsString() flag!: string;
}

export class IncomingTriggerDto {
  @ValidateNested() @Type(() => IncomingAccountDto) account!: IncomingAccountDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => IncomingVesselDto)
  vessel?: IncomingVesselDto;

  @IsString() category!: string;
  @IsString() description!: string;
  @IsIn(['crm', 'class_records', 'public_data', 'buyer_reply'])
  source!: 'crm' | 'class_records' | 'public_data' | 'buyer_reply';
  @IsIn(['high', 'mid', 'low']) confidenceLabel!: 'high' | 'mid' | 'low';
  @IsString() verifiabilityNote!: string;
  @IsISO8601() detectedAt!: string;
  @IsBoolean() hasComplianceDeadlineContent!: boolean;
}
```

- [ ] **Step 2: Write the failing integration test**

`apps/console-api/src/triggers/triggers.service.integration.spec.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type Anthropic from '@anthropic-ai/sdk';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db';
import { buildServer } from '../../../worker/src/server.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { WorkerClient } from '../worker-client/worker-client.service.js';
import { TriggersService } from './triggers.service.js';

describe('TriggersService', () => {
  let testDb: TestPostgres;
  let workerUrl: string;

  beforeAll(async () => {
    testDb = await startTestPostgres();

    const anthropic = {
      messages: {
        parse: vi.fn().mockResolvedValue({
          parsed_output: {
            should_draft: true,
            draft_text: 'Hi Ms. Pham, ...',
            confidence_label: 'high',
            abstain_reason: null,
          },
          usage: { input_tokens: 500, output_tokens: 120 },
        }),
      },
    } as unknown as Anthropic;

    const workerServer = buildServer({ prisma: testDb.prisma, anthropic });
    const address = await workerServer.listen({ port: 0, host: '127.0.0.1' });
    workerUrl = typeof address === 'string' ? address : `http://127.0.0.1:${address.port}`;
    process.env.WORKER_INTERNAL_URL = workerUrl;
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  it('upserts a new account at Tier 2, persists the trigger, and drafts via the worker', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        TriggersService,
        WorkerClient,
        { provide: PRISMA, useValue: testDb.prisma },
      ],
    }).compile();
    const service = moduleRef.get(TriggersService);

    const result = await service.receiveTrigger({
      account: {
        externalRef: 'crm-acc-001',
        companyName: 'Song Hong Shipping',
        segment: 'Offshore support vessel operator',
        hub: 'Haiphong',
        icpScore: 90,
        icpBand: 'high',
        relationshipSummary: 'New account · first contact 12 Jul 2026',
      },
      vessel: { name: 'MV Song Hong Pioneer', imo: '9123456', flag: 'Vietnam' },
      category: 'life-raft service window',
      description: 'Life raft may be approaching its next scheduled service window',
      source: 'public_data',
      confidenceLabel: 'mid',
      verifiabilityNote: 'Partly verifiable — service interval is illustrative',
      detectedAt: new Date().toISOString(),
      hasComplianceDeadlineContent: false,
    });

    expect(result.triggerId).toBeDefined();

    const account = await testDb.prisma.account.findUniqueOrThrow({
      where: { externalRef: 'crm-acc-001' },
    });
    expect(account.currentTier).toBe(2);

    const createEvent = await testDb.prisma.tierHistoryEvent.findFirstOrThrow({
      where: { accountId: account.id, eventType: 'create' },
    });
    expect(createEvent.toTier).toBe(2);

    const message = await testDb.prisma.message.findFirstOrThrow({
      where: { accountId: account.id },
    });
    expect(message.status).toBe('pending_review');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter console-api exec vitest run src/triggers/triggers.service.integration.spec.ts`
Expected: FAIL — none of `TriggersService`/`WorkerClient` exist yet.

- [ ] **Step 4: Implement**

`apps/console-api/src/worker-client/worker-client.service.ts`:
```ts
import { Injectable } from '@nestjs/common';

@Injectable()
export class WorkerClient {
  async processTrigger(triggerId: string): Promise<void> {
    const baseUrl = process.env.WORKER_INTERNAL_URL ?? 'http://localhost:3100';
    const response = await fetch(`${baseUrl}/internal/process-trigger/${triggerId}`, { method: 'POST' });
    if (!response.ok) {
      throw new Error(`Worker returned ${response.status} for trigger ${triggerId}`);
    }
  }
}
```

`apps/console-api/src/worker-client/worker-client.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { WorkerClient } from './worker-client.service.js';

@Module({ providers: [WorkerClient], exports: [WorkerClient] })
export class WorkerClientModule {}
```

`apps/console-api/src/triggers/triggers.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@erria/db';
import { recordIncomingTrigger } from '@erria/domain';
import { PRISMA } from '../prisma/prisma.module.js';
import { WorkerClient } from '../worker-client/worker-client.service.js';
import type { IncomingTriggerDto } from './dto/incoming-trigger.dto.js';

@Injectable()
export class TriggersService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly workerClient: WorkerClient,
  ) {}

  async receiveTrigger(dto: IncomingTriggerDto) {
    const account = await this.upsertAccount(dto.account);
    const vessel = dto.vessel ? await this.upsertVessel(account.id, dto.vessel) : null;

    const { triggerId } = await recordIncomingTrigger(this.prisma, {
      accountId: account.id,
      vesselId: vessel?.id ?? null,
      category: dto.category,
      description: dto.description,
      source: dto.source,
      confidenceLabel: dto.confidenceLabel,
      verifiabilityNote: dto.verifiabilityNote,
      detectedAt: new Date(dto.detectedAt),
      hasComplianceDeadlineContent: dto.hasComplianceDeadlineContent,
    });

    await this.workerClient.processTrigger(triggerId);

    return { triggerId };
  }

  private async upsertAccount(input: IncomingTriggerDto['account']) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.account.findUnique({ where: { externalRef: input.externalRef } });

      if (existing) {
        return tx.account.update({
          where: { id: existing.id },
          data: {
            companyName: input.companyName,
            segment: input.segment,
            hub: input.hub,
            icpScore: input.icpScore,
            icpBand: input.icpBand,
            relationshipSummary: input.relationshipSummary,
          },
        });
      }

      const created = await tx.account.create({
        data: {
          externalRef: input.externalRef,
          companyName: input.companyName,
          segment: input.segment,
          hub: input.hub,
          icpScore: input.icpScore,
          icpBand: input.icpBand,
          relationshipSummary: input.relationshipSummary,
          currentTier: 2,
          tierRationale: 'New account — rollout default per spec §3 until 2 clean approvals',
        },
      });

      await tx.tierHistoryEvent.create({
        data: {
          accountId: created.id,
          eventType: 'create',
          toTier: 2,
          reason: 'Account created via incoming trigger — rollout default (spec §3)',
        },
      });

      return created;
    });
  }

  private async upsertVessel(accountId: string, input: NonNullable<IncomingTriggerDto['vessel']>) {
    return this.prisma.vessel.upsert({
      where: { imo: input.imo },
      update: { name: input.name, flag: input.flag, accountId },
      create: { accountId, name: input.name, imo: input.imo, flag: input.flag },
    });
  }
}
```

`apps/console-api/src/triggers/triggers.controller.ts`:
```ts
import { Body, Controller, Post } from '@nestjs/common';
import { TriggersService } from './triggers.service.js';
import { IncomingTriggerDto } from './dto/incoming-trigger.dto.js';

@Controller('internal/triggers')
export class TriggersController {
  constructor(private readonly triggersService: TriggersService) {}

  @Post()
  async receive(@Body() dto: IncomingTriggerDto) {
    return this.triggersService.receiveTrigger(dto);
  }
}
```

`apps/console-api/src/triggers/triggers.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { WorkerClientModule } from '../worker-client/worker-client.module.js';
import { TriggersController } from './triggers.controller.js';
import { TriggersService } from './triggers.service.js';

@Module({
  imports: [WorkerClientModule],
  controllers: [TriggersController],
  providers: [TriggersService],
})
export class TriggersModule {}
```

Modify `apps/console-api/src/app.module.ts` to import it:
```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module.js';
import { HealthController } from './health/health.controller.js';
import { TriggersModule } from './triggers/triggers.module.js';

@Module({
  imports: [PrismaModule, TriggersModule],
  controllers: [HealthController],
})
export class AppModule {}
```

- [ ] **Step 5: Run again to verify it passes**

Run: `pnpm --filter console-api exec vitest run src/triggers/triggers.service.integration.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/console-api
git commit -m "feat(console-api): implement POST /internal/triggers (Flow 1 step 1-3)"
```

---

### Task 10: `GET /api/queue`

**Files:**
- Create: `apps/console-api/src/queue/queue.service.ts`
- Create: `apps/console-api/src/queue/queue.controller.ts`
- Create: `apps/console-api/src/queue/queue.module.ts`
- Modify: `apps/console-api/src/app.module.ts` — import `QueueModule`
- Test: `apps/console-api/src/queue/queue.service.integration.spec.ts`

**Interfaces:**
- Consumes: `PRISMA` token (Task 3).
- Produces: the `GET /api/queue` HTTP endpoint, matching the shape in app doc §3
  (`{ items, total, page, pageSize }`) — consumed by Task 12's frontend `QueuePage`.

- [ ] **Step 1: Write the failing integration test**

`apps/console-api/src/queue/queue.service.integration.spec.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db';
import { QueueService } from './queue.service.js';

describe('QueueService', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  it('lists pending_review messages as queue rows', async () => {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Song Hong Shipping',
        segment: 'Offshore support vessel operator',
        hub: 'Haiphong',
        icpScore: 90,
        icpBand: 'high',
        relationshipSummary: 'New account',
        currentTier: 2,
        tierRationale: 'New account — rollout default',
      },
    });
    const trigger = await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'life-raft service window',
        description: 'Life raft may be approaching its next scheduled service window',
        source: 'public_data',
        confidenceLabel: 'mid',
        verifiabilityNote: 'test',
        detectedAt: new Date(),
        status: 'drafted',
      },
    });
    await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        triggerId: trigger.id,
        role: 'agent_draft',
        body: 'Hi Ms. Pham, ...',
        status: 'pending_review',
        tierContext: 2,
      },
    });

    const service = new QueueService(testDb.prisma);
    const result = await service.list({ page: 1 });

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      accountId: account.id,
      company: 'Song Hong Shipping',
      triggerSummary: 'Life raft may be approaching its next scheduled service window',
      tier: 2,
    });
  });

  it('filters by tier', async () => {
    const service = new QueueService(testDb.prisma);
    const result = await service.list({ tier: 3, page: 1 });
    expect(result.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter console-api exec vitest run src/queue/queue.service.integration.spec.ts`
Expected: FAIL — `./queue.service.js` doesn't exist yet.

- [ ] **Step 3: Implement**

`apps/console-api/src/queue/queue.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@erria/db';
import { PRISMA } from '../prisma/prisma.module.js';

const PAGE_SIZE = 20;

@Injectable()
export class QueueService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(params: { tier?: number; page: number }) {
    const where = {
      status: 'pending_review' as const,
      ...(params.tier ? { tierContext: params.tier } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.message.findMany({
        where,
        include: { account: true, trigger: { include: { vessel: true } } },
        orderBy: { createdAt: 'asc' },
        skip: (params.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this.prisma.message.count({ where }),
    ]);

    return {
      items: items.map((message) => ({
        accountId: message.accountId,
        company: message.account.companyName,
        vessel: message.trigger?.vessel?.name ?? null,
        // Contact enrichment isn't wired into the incoming-trigger payload yet
        // (Task 9's DTO has no contact field) — always null until a later plan
        // adds it. Documented gap, not a bug.
        contact: null as string | null,
        triggerSummary: message.trigger?.description ?? null,
        icpBand: message.account.icpBand,
        tier: message.tierContext,
        tierWhy: message.account.tierRationale,
        lastActionAt: message.createdAt.toISOString(),
      })),
      total,
      page: params.page,
      pageSize: PAGE_SIZE,
    };
  }
}
```

`apps/console-api/src/queue/queue.controller.ts`:
```ts
import { Controller, Get, Query } from '@nestjs/common';
import { QueueService } from './queue.service.js';

@Controller('api/queue')
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  @Get()
  async list(@Query('tier') tier?: string, @Query('page') page?: string) {
    return this.queueService.list({
      tier: tier ? Number(tier) : undefined,
      page: page ? Number(page) : 1,
    });
  }
}
```

`apps/console-api/src/queue/queue.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { QueueController } from './queue.controller.js';
import { QueueService } from './queue.service.js';

@Module({ controllers: [QueueController], providers: [QueueService] })
export class QueueModule {}
```

Modify `apps/console-api/src/app.module.ts` to add `QueueModule` to `imports`.

- [ ] **Step 4: Run again to verify it passes**

Run: `pnpm --filter console-api exec vitest run src/queue/queue.service.integration.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/console-api
git commit -m "feat(console-api): implement GET /api/queue"
```

---

### Task 11: `GET /api/accounts/:id`

**Files:**
- Create: `apps/console-api/src/accounts/accounts.service.ts`
- Create: `apps/console-api/src/accounts/accounts.controller.ts`
- Create: `apps/console-api/src/accounts/accounts.module.ts`
- Modify: `apps/console-api/src/app.module.ts` — import `AccountsModule`
- Test: `apps/console-api/src/accounts/accounts.service.integration.spec.ts`

**Interfaces:**
- Consumes: `PRISMA` token (Task 3).
- Produces: the `GET /api/accounts/:id` HTTP endpoint (app doc §3) — no in-process consumers within
  this plan; the frontend's Account Detail view is out of Plan 1's scope (Task 12 only builds the
  Queue view), so this task's own integration test is the only thing exercising it for now.

- [ ] **Step 1: Write the failing integration test**

`apps/console-api/src/accounts/accounts.service.integration.spec.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db';
import { AccountsService } from './accounts.service.js';

describe('AccountsService', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  it('returns null for a missing account', async () => {
    const service = new AccountsService(testDb.prisma);
    const result = await service.getDetail('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  it('returns the account, its vessels, and its pending message', async () => {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Song Hong Shipping',
        segment: 'Offshore support vessel operator',
        hub: 'Haiphong',
        icpScore: 90,
        icpBand: 'high',
        relationshipSummary: 'New account',
        currentTier: 2,
        tierRationale: 'New account — rollout default',
      },
    });
    await testDb.prisma.vessel.create({
      data: { accountId: account.id, name: 'MV Song Hong Pioneer', imo: '9123456', flag: 'Vietnam' },
    });
    await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'agent_draft',
        body: 'Hi Ms. Pham, ...',
        status: 'pending_review',
        tierContext: 2,
      },
    });

    const service = new AccountsService(testDb.prisma);
    const result = await service.getDetail(account.id);

    expect(result?.account.companyName).toBe('Song Hong Shipping');
    expect(result?.vessels).toHaveLength(1);
    expect(result?.pendingMessage?.body).toBe('Hi Ms. Pham, ...');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter console-api exec vitest run src/accounts/accounts.service.integration.spec.ts`
Expected: FAIL — `./accounts.service.js` doesn't exist yet.

- [ ] **Step 3: Implement**

`apps/console-api/src/accounts/accounts.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@erria/db';
import { PRISMA } from '../prisma/prisma.module.js';

@Injectable()
export class AccountsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async getDetail(accountId: string) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      include: {
        vessels: true,
        contacts: true,
        messages: { where: { status: 'pending_review' }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    if (!account) return null;

    const pendingMessage = account.messages[0] ?? null;

    return {
      account: {
        id: account.id,
        companyName: account.companyName,
        segment: account.segment,
        hub: account.hub,
        icpBand: account.icpBand,
        relationshipSummary: account.relationshipSummary,
        currentTier: account.currentTier,
        tierRationale: account.tierRationale,
      },
      vessels: account.vessels.map((v) => ({ id: v.id, name: v.name, imo: v.imo, flag: v.flag })),
      contacts: account.contacts.map((c) => ({ id: c.id, name: c.name, role: c.role, email: c.email })),
      pendingMessage: pendingMessage
        ? {
            id: pendingMessage.id,
            body: pendingMessage.body,
            edited: pendingMessage.edited,
            tierContext: pendingMessage.tierContext,
          }
        : null,
    };
  }
}
```

`apps/console-api/src/accounts/accounts.controller.ts`:
```ts
import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { AccountsService } from './accounts.service.js';

@Controller('api/accounts')
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Get(':id')
  async detail(@Param('id') id: string) {
    const detail = await this.accountsService.getDetail(id);
    if (!detail) {
      throw new NotFoundException(`Account ${id} not found`);
    }
    return detail;
  }
}
```

`apps/console-api/src/accounts/accounts.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller.js';
import { AccountsService } from './accounts.service.js';

@Module({ controllers: [AccountsController], providers: [AccountsService] })
export class AccountsModule {}
```

Modify `apps/console-api/src/app.module.ts` to add `AccountsModule` to `imports`.

- [ ] **Step 4: Run again to verify it passes**

Run: `pnpm --filter console-api exec vitest run src/accounts/accounts.service.integration.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/console-api
git commit -m "feat(console-api): implement GET /api/accounts/:id"
```

---

### Task 12: Frontend scaffold + Queue view

**Files:**
- Create: `apps/console-web/package.json`
- Create: `apps/console-web/tsconfig.json`
- Create: `apps/console-web/vite.config.ts`
- Create: `apps/console-web/vitest.config.ts`
- Create: `apps/console-web/index.html`
- Create: `apps/console-web/src/main.tsx`
- Create: `apps/console-web/src/App.tsx`
- Create: `apps/console-web/src/QueuePage.tsx`
- Create: `apps/console-web/src/styles/tokens.css` (copied from `design-system/tokens.css`)
- Test: `apps/console-web/src/QueuePage.test.tsx`

**Interfaces:**
- Consumes: `GET /api/queue` (Task 10) over HTTP (proxied in dev via Vite's server proxy).
- Produces: the Queue page itself — the last piece of Plan 1's walking skeleton, no further
  in-plan consumers.

- [ ] **Step 1: Copy the design system CSS**

```bash
mkdir -p apps/console-web/src/styles
cp design-system/tokens.css apps/console-web/src/styles/tokens.css
```
Note in a code comment at the top of the copied file that `design-system/tokens.css` remains the
source of truth — re-copy on changes rather than editing the copy directly, until a later plan
wires up a proper shared-package or build-time symlink for it.

- [ ] **Step 2: `apps/console-web/package.json`**

```json
{
  "name": "console-web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json --noEmit && vite build",
    "lint": "eslint .",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "vite": "^8.0.0",
    "vitest": "^3.0.0",
    "jsdom": "^25.0.0",
    "@testing-library/react": "^16.1.0",
    "@testing-library/jest-dom": "^6.6.0",
    "typescript": "^5.7.0"
  }
}
```

`apps/console-web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM"],
    "noEmit": true
  },
  "include": ["src"]
}
```

`apps/console-web/vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/internal': 'http://localhost:3000',
    },
  },
});
```

`apps/console-web/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'] },
});
```

`apps/console-web/src/test-setup.ts`:
```ts
import '@testing-library/jest-dom/vitest';
```

`apps/console-web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Erria Outreach Agent Console</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/console-web/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/tokens.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`apps/console-web/src/App.tsx`:
```tsx
import { QueuePage } from './QueuePage.js';

export function App() {
  return <QueuePage />;
}
```

- [ ] **Step 3: Write the failing component test**

`apps/console-web/src/QueuePage.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueuePage } from './QueuePage.js';

describe('QueuePage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          items: [
            {
              accountId: 'acc_1',
              company: 'Song Hong Shipping',
              vessel: 'MV Song Hong Pioneer',
              contact: null,
              triggerSummary: 'Life-raft service window',
              icpBand: 'high',
              tier: 2,
              tierWhy: 'New account — rollout default',
              lastActionAt: '2026-08-02T00:00:00.000Z',
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        }),
      }),
    );
  });

  it('renders a queue row from the API', async () => {
    render(<QueuePage />);
    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());
    expect(screen.getByText('MV Song Hong Pioneer')).toBeInTheDocument();
    expect(screen.getByText('Tier 2')).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm --filter console-web exec vitest run`
Expected: FAIL — `./QueuePage.js` doesn't exist yet.

- [ ] **Step 5: Implement**

`apps/console-web/src/QueuePage.tsx` (the `badge t{tier}` class names below match the existing
mockup's convention exactly — see `brainstorm/mockup/Erria-outreach-agent-v06/outreach-console.html`
line 696 — so `tokens.css`'s existing badge styles apply unchanged):
```tsx
import { useEffect, useState } from 'react';

interface QueueRow {
  accountId: string;
  company: string;
  vessel: string | null;
  triggerSummary: string | null;
  icpBand: 'high' | 'med' | 'low';
  tier: number;
  tierWhy: string;
  lastActionAt: string;
}

interface QueueResponse {
  items: QueueRow[];
  total: number;
  page: number;
  pageSize: number;
}

export function QueuePage() {
  const [data, setData] = useState<QueueResponse | null>(null);

  useEffect(() => {
    fetch('/api/queue')
      .then((response) => response.json())
      .then((body: QueueResponse) => setData(body));
  }, []);

  if (!data) return <p>Loading queue…</p>;

  return (
    <table className="queue-table">
      <thead>
        <tr>
          <th>Company</th>
          <th>Vessel</th>
          <th>Trigger</th>
          <th>Tier</th>
        </tr>
      </thead>
      <tbody>
        {data.items.map((row) => (
          <tr key={row.accountId}>
            <td>{row.company}</td>
            <td>{row.vessel ?? '—'}</td>
            <td>{row.triggerSummary ?? '—'}</td>
            <td>
              <span className={`badge t${row.tier}`}>Tier {row.tier}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 6: Run again to verify it passes**

Run: `pnpm --filter console-web exec vitest run`
Expected: PASS.

- [ ] **Step 7: Manually verify in a browser**

Run `pnpm --filter console-api run dev`, `pnpm --filter worker run dev`, and
`pnpm --filter console-web run dev` in three terminals, `POST` a sample trigger to
`http://localhost:3000/internal/triggers` (a real `ANTHROPIC_API_KEY` in `.env` is required for
this manual check — the automated tests above all use a mocked client), then open
`http://localhost:5173` and confirm the row appears with the correct tier badge styling.

- [ ] **Step 8: Commit**

```bash
git add apps/console-web design-system/tokens.css
git commit -m "feat(console-web): scaffold Vite+React app with a Queue view wired to GET /api/queue"
```

---

### Task 13: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: every package/app's `lint`/`typecheck`/`test`/`build` script from Tasks 1-12.
- Produces: nothing consumed in-repo — this is the last task, closing out Plan 1.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - run: pnpm -r run lint

      - run: pnpm -r run typecheck

      - run: pnpm --filter @erria/db run build

      - run: pnpm -r run test
        env:
          ANTHROPIC_API_KEY: sk-test-placeholder-not-a-real-key
```

Integration tests use Testcontainers (Task 2), which needs a Docker daemon — GitHub-hosted
`ubuntu-latest` runners have one available by default, so no extra service configuration is
needed. `packages/db`'s `build` step runs before the test step because `prisma generate` (part of
its `build` script, Task 2 Step 1) must produce `src/generated/prisma` before any other package's
TypeScript can type-check against it.

- [ ] **Step 2: Verify locally as much as possible**

Run `pnpm -r run lint && pnpm -r run typecheck && pnpm --filter @erria/db run build && pnpm -r run test`
locally first — this is exactly what the workflow runs, so a local pass is a strong (though not
complete — GitHub's runner image can differ) signal the workflow will succeed. Then push the
branch and open a PR; watch the Actions tab for the actual run.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add lint/typecheck/build/test workflow"
```

---

## Self-Review Notes (from writing this plan)

- **Spec coverage:** every Flow 1 step in the app architecture doc's §5 has a task —
  steps 1-2 → Task 9, step 3 → Task 9's `WorkerClient` + Task 8, steps 4 → Tasks 5/7, steps 5-6 →
  Task 6/8, step 7 → Task 8's abstain/failure branch, step 8 → Task 10.
- **Documented gap, not silently papered over:** Tier 1 autonomous sending is explicitly rejected
  (`NotImplementedFlowError`) rather than guessed at, since the architecture doc's four flows never
  actually specify it end to end. Flagged in Global Constraints, Task 5, and Task 7.
- **Type consistency check:** `TierRecommendation.tier` is `1 | 2` everywhere it's threaded
  (Task 5 → Task 7 → Task 8's `trigger.account.currentTier as 1 | 2 | 3` cast is the one place it
  widens, because `Account.currentTier` the column is a general `Int` — this is intentional, not a
  mismatch). `DraftMessageResult.outcome` matches `LlmCallOutcome` exactly (`success`,
  `retried_success`, `timeout`, `error`) end to end from Task 6 through Task 8's `llmCall.create`.
- **Known follow-up, not in this plan:** `contact` is always `null` in the `GET /api/queue`
  response (Task 10) because Task 9's incoming-trigger payload has no contact field yet — noted
  inline in the code, not silently dropped.
