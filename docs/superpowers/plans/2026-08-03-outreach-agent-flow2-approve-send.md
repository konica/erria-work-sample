# Outreach Agent — Plan 2: Flow 2, Approve → Send — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take a Tier 2 draft sitting in `pending_review` and carry it all the way to `sent` — a
human edits it or approves it as-is, the message actually goes out through a channel adapter, the
account's Clean Approval counter moves, and a send that silently fails to dispatch gets picked up
and retried rather than sitting approved-but-unsent forever.

**Architecture:** Continues the modular monolith from Plan 1 — same monorepo, same two processes.
Console API owns the human decision (edit / approve / reject) and returns immediately; the
Orchestration Worker owns the actual send and the state changes that follow it. This is Plan 2 of
4 (Plan 1 = Foundation + Flow 1; Plan 3 = escalations and resolution; Plan 4 = Settings and Send
Audit UI). Grounded in `docs/architecture/2026-08-02-application-architecture.md` §5 Flow 2,
`docs/superpowers/specs/2026-08-01-outreach-agent-design.md` §3/§5/§8, and the v07 mockup's
Account Detail review controls.

**Tech Stack:** Unchanged from Plan 1 — Node.js 24, TypeScript strict, pnpm workspaces, NestJS 11,
Fastify 5, Prisma 7 with `@prisma/adapter-pg`, PostgreSQL, React 19 + Vite 8, Vitest,
Testcontainers.

**Prerequisite:** Plan 1 complete — the monorepo, the full Prisma schema and its migration, both
service skeletons, the Tiering and Message Drafting domain modules, `POST /internal/triggers`,
`GET /api/queue`, and `GET /api/accounts/:id` all exist and pass their tests. This plan adds no new
tables; the entire schema was created in Plan 1 Task 2.

## Global Constraints

- **Node.js >=24**, TypeScript `strict: true`, pnpm workspaces (`workspace:*` internal deps) —
  same as Plan 1.
- **Tier 1 autonomous send does not exist** ([ADR-0002](../../adr/0002-tier-1-autonomous-send-deferred.md)).
  Every message this plan sends has `tierContext === 2` and was approved by a human. Do not add an
  autonomous-send path.
- **Count Clean Approvals; never promote** ([ADR-0005](../../adr/0005-clean-approvals-counted-promotion-action-deferred.md)).
  Increment `Account.cleanApprovalsCount` and write `TierHistoryEvent(clean_approval)`, but **never**
  set `Account.currentTier = 1`, even when the count meets `Setting.tier1PromotionThreshold`. This
  deliberately contradicts the architecture doc's §5 Flow 2 step 5, which predates ADR-0005 — the
  ADR governs.
- **A Clean Approval requires all three** (spec §3, architecture §5 Flow 2 step 5):
  `tierContext === 2`, `edited === false`, and no negative signal on the account since the message
  was created. Missing any one means no increment.
- **`originalBody` records the agent's text, once.** The first edit copies the current `body` into
  `originalBody`; later edits overwrite `body` only. `originalBody` is never overwritten after it is
  set, and is never populated for an unedited message.
- **Approve returns before the send happens.** The human-facing request marks the decision and
  returns; dispatch is invoked asynchronously (architecture §3, "returns immediately after marking
  the decision").
- **Sends are idempotent by message.** A message already `sent` is never sent twice, no matter how
  many times dispatch is invoked — the reconciliation sweep in Task 8 depends on this.
- **Escalated threads never send agent-authored messages** (spec §10). Both the approve path and the
  dispatch path check for an active Escalation with `agentSendDisabled` before proceeding. No
  Escalation rows exist until Plan 3, so these queries return empty today — they are written now
  because retrofitting a safety check after the thing it guards against exists is the wrong order.
- **Stated assumption — email subject line.** Neither the behavior spec nor any mockup defines a
  subject for outbound email; the mockup shows body text only. This plan derives one from the
  vessel and trigger (`"MV Song Hong Pioneer — life-raft service window"`, falling back to the
  account name when there is no vessel). Flagged for confirmation; it is isolated in one function
  (Task 2) so changing it later touches one place.
- **No real mail provider.** The outbound channel is a swappable adapter behind one interface
  (architecture §0 lists the actual SMTP/Graph implementation as a non-goal). This plan ships the
  interface plus a logging adapter used by dev and tests.

---

### Task 1: Prefactor — accept Contact on incoming triggers

**Files:**
- Modify: `apps/console-api/src/triggers/dto/incoming-trigger.dto.ts` — add `IncomingContactDto`
- Modify: `apps/console-api/src/triggers/triggers.service.ts` — upsert the contact
- Test: `apps/console-api/src/triggers/triggers.service.integration.spec.ts` — add a case

**Interfaces:**
- Consumes: everything Plan 1 Task 9 built (`TriggersService`, `IncomingTriggerDto`).
- Produces: `Contact` rows attached to an `Account` — Task 6's dispatch path reads one to get a
  recipient address.

**Why this is first:** Plan 1's self-review flagged that `GET /api/queue` always returns
`contact: null` because the incoming-trigger payload has no contact field. That was cosmetic then.
It is load-bearing now: dispatch cannot send an email without a recipient. Prefactor first, then
the easy change.

- [ ] **Step 1: Write the failing test**

Add to `apps/console-api/src/triggers/triggers.service.integration.spec.ts`:

```ts
it('upserts the contact so the account has a recipient for dispatch', async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [TriggersService, WorkerClient, { provide: PRISMA, useValue: testDb.prisma }],
  }).compile();
  const service = moduleRef.get(TriggersService);

  await service.receiveTrigger({
    account: {
      externalRef: 'crm-acc-contact-001',
      companyName: 'Vinh Long Coastal',
      segment: 'Coastal freight operator',
      hub: 'Haiphong',
      icpScore: 60,
      icpBand: 'med',
      relationshipSummary: 'New account',
    },
    contact: { name: 'Ms. Lan Pham', role: 'Technical Superintendent', email: 'lan.pham@example.com' },
    category: 'life-raft service window',
    description: 'test',
    source: 'public_data',
    confidenceLabel: 'mid',
    verifiabilityNote: 'test',
    detectedAt: new Date().toISOString(),
    hasComplianceDeadlineContent: false,
  });

  const account = await testDb.prisma.account.findUniqueOrThrow({
    where: { externalRef: 'crm-acc-contact-001' },
    include: { contacts: true },
  });
  expect(account.contacts).toHaveLength(1);
  expect(account.contacts[0].email).toBe('lan.pham@example.com');

  // A second trigger for the same contact updates rather than duplicating.
  await service.receiveTrigger({
    account: {
      externalRef: 'crm-acc-contact-001',
      companyName: 'Vinh Long Coastal',
      segment: 'Coastal freight operator',
      hub: 'Haiphong',
      icpScore: 60,
      icpBand: 'med',
      relationshipSummary: 'New account',
    },
    contact: { name: 'Ms. Lan Pham', role: 'Chief Engineer', email: 'lan.pham@example.com' },
    category: 'EPIRB battery expiry',
    description: 'test',
    source: 'public_data',
    confidenceLabel: 'mid',
    verifiabilityNote: 'test',
    detectedAt: new Date().toISOString(),
    hasComplianceDeadlineContent: false,
  });

  const refreshed = await testDb.prisma.account.findUniqueOrThrow({
    where: { externalRef: 'crm-acc-contact-001' },
    include: { contacts: true },
  });
  expect(refreshed.contacts).toHaveLength(1);
  expect(refreshed.contacts[0].role).toBe('Chief Engineer');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter console-api exec vitest run src/triggers/triggers.service.integration.spec.ts`
Expected: FAIL — `contact` is rejected by the validation pipe / no contact row is created.

- [ ] **Step 3: Add the DTO**

In `apps/console-api/src/triggers/dto/incoming-trigger.dto.ts`, add:

```ts
export class IncomingContactDto {
  @IsString() name!: string;
  @IsString() role!: string;
  @IsOptional() @IsString() email?: string;
}
```

and add this property to `IncomingTriggerDto`:

```ts
  @IsOptional()
  @ValidateNested()
  @Type(() => IncomingContactDto)
  contact?: IncomingContactDto;
```

- [ ] **Step 4: Upsert the contact in the service**

In `apps/console-api/src/triggers/triggers.service.ts`, inside `receiveTrigger`, after the vessel
upsert:

```ts
    if (dto.contact) {
      await this.upsertContact(account.id, dto.contact);
    }
```

and add the private method:

```ts
  private async upsertContact(accountId: string, input: NonNullable<IncomingTriggerDto['contact']>) {
    // Contact has no unique constraint to upsert against (a person is identified by their email
    // within an account, but email is nullable), so match explicitly then insert or update.
    const existing = input.email
      ? await this.prisma.contact.findFirst({ where: { accountId, email: input.email } })
      : await this.prisma.contact.findFirst({ where: { accountId, name: input.name } });

    if (existing) {
      return this.prisma.contact.update({
        where: { id: existing.id },
        data: { name: input.name, role: input.role, email: input.email ?? null },
      });
    }

    return this.prisma.contact.create({
      data: { accountId, name: input.name, role: input.role, email: input.email ?? null },
    });
  }
```

- [ ] **Step 5: Surface the contact in the queue**

In `apps/console-api/src/queue/queue.service.ts`, replace the hardcoded `contact: null` line and its
explanatory comment. Include contacts in the query:

```ts
      this.prisma.message.findMany({
        where,
        include: { account: { include: { contacts: true } }, trigger: { include: { vessel: true } } },
        orderBy: { createdAt: 'asc' },
        skip: (params.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
```

and map it:

```ts
        contact: message.account.contacts[0]?.name ?? null,
```

- [ ] **Step 6: Run the console-api suite to verify it passes**

Run: `pnpm --filter console-api exec vitest run`
Expected: PASS — the new contact test passes and Plan 1's queue test still passes (it asserts
specific fields, and an account with no contacts still yields `contact: null`).

- [ ] **Step 7: Commit**

```bash
git add apps/console-api
git commit -m "feat(console-api): accept and surface Contact on incoming triggers"
```

---

### Task 2: Message Dispatch module

**Files:**
- Create: `packages/domain/src/dispatch/channel-adapter.ts`
- Create: `packages/domain/src/dispatch/logging-channel-adapter.ts`
- Create: `packages/domain/src/dispatch/subject-line.ts`
- Modify: `packages/domain/src/index.ts` — export the above
- Test: `packages/domain/src/dispatch/subject-line.spec.ts`
- Test: `packages/domain/src/dispatch/logging-channel-adapter.spec.ts`

**Interfaces:**
- Consumes: nothing — this is a leaf module, deliberately (architecture §1: "Thin channel adapter…
  No business logic… Deliberately isolated so channel changes never touch tiering, drafting, or
  escalation logic").
- Produces: `ChannelAdapter`, `OutboundEmail`, `LoggingChannelAdapter`, `buildSubjectLine` —
  consumed by Task 6's worker dispatch route.

- [ ] **Step 1: Write the failing tests**

`packages/domain/src/dispatch/subject-line.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSubjectLine } from './subject-line.js';

describe('buildSubjectLine', () => {
  it('uses the vessel name and trigger category when a vessel is known', () => {
    expect(
      buildSubjectLine({
        companyName: 'Song Hong Shipping',
        vesselName: 'MV Song Hong Pioneer',
        triggerCategory: 'life-raft service window',
      }),
    ).toBe('MV Song Hong Pioneer — life-raft service window');
  });

  it('falls back to the company name when there is no vessel', () => {
    expect(
      buildSubjectLine({
        companyName: 'Song Hong Shipping',
        vesselName: null,
        triggerCategory: 'life-raft service window',
      }),
    ).toBe('Song Hong Shipping — life-raft service window');
  });

  it('falls back to the company name alone when there is no trigger category either', () => {
    expect(
      buildSubjectLine({ companyName: 'Song Hong Shipping', vesselName: null, triggerCategory: null }),
    ).toBe('Song Hong Shipping');
  });
});
```

`packages/domain/src/dispatch/logging-channel-adapter.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { LoggingChannelAdapter } from './logging-channel-adapter.js';

describe('LoggingChannelAdapter', () => {
  it('records what it was asked to send and returns a provider id', async () => {
    const adapter = new LoggingChannelAdapter();

    const result = await adapter.send({
      to: 'lan.pham@example.com',
      subject: 'MV Song Hong Pioneer — life-raft service window',
      body: 'Hi Ms. Pham, ...',
    });

    expect(result.providerMessageId).toMatch(/^logged-/);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].to).toBe('lan.pham@example.com');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @erria/domain exec vitest run src/dispatch`
Expected: FAIL — neither module exists yet.

- [ ] **Step 3: Implement**

`packages/domain/src/dispatch/channel-adapter.ts`:

```ts
export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
}

/**
 * The only surface the rest of the domain knows about for actually sending a message.
 * Swapping SMTP for Graph (or anything else) means writing one more implementation of this
 * interface and changing which one is constructed at the worker's entrypoint — nothing else.
 */
export interface ChannelAdapter {
  readonly channel: 'email';
  send(email: OutboundEmail): Promise<{ providerMessageId: string }>;
}
```

`packages/domain/src/dispatch/logging-channel-adapter.ts`:

```ts
import type { ChannelAdapter, OutboundEmail } from './channel-adapter.js';

/**
 * Dev/test adapter: records sends in memory and logs them. Used until a real mail provider is
 * chosen (architecture §0 lists the provider implementation as a non-goal).
 */
export class LoggingChannelAdapter implements ChannelAdapter {
  readonly channel = 'email' as const;
  readonly sent: OutboundEmail[] = [];

  async send(email: OutboundEmail): Promise<{ providerMessageId: string }> {
    this.sent.push(email);
    console.log(`[dispatch] to=${email.to} subject=${JSON.stringify(email.subject)}`);
    return { providerMessageId: `logged-${this.sent.length}` };
  }
}
```

`packages/domain/src/dispatch/subject-line.ts`:

```ts
export interface SubjectLineInput {
  companyName: string;
  vesselName: string | null;
  triggerCategory: string | null;
}

/**
 * Neither the behavior spec nor the mockups define an email subject — they show body copy only.
 * This is a stated assumption, deliberately isolated here so revising it touches one function.
 */
export function buildSubjectLine(input: SubjectLineInput): string {
  const lead = input.vesselName ?? input.companyName;
  return input.triggerCategory ? `${lead} — ${input.triggerCategory}` : lead;
}
```

Add to `packages/domain/src/index.ts`:

```ts
export type { ChannelAdapter, OutboundEmail } from './dispatch/channel-adapter.js';
export { LoggingChannelAdapter } from './dispatch/logging-channel-adapter.js';
export { buildSubjectLine } from './dispatch/subject-line.js';
export type { SubjectLineInput } from './dispatch/subject-line.js';
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @erria/domain exec vitest run src/dispatch`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): add Message Dispatch channel adapter and subject-line derivation"
```

---

### Task 3: Edit a pending draft

**Files:**
- Create: `apps/console-api/src/messages/dto/edit-message.dto.ts`
- Create: `apps/console-api/src/messages/messages.service.ts`
- Create: `apps/console-api/src/messages/messages.controller.ts`
- Create: `apps/console-api/src/messages/messages.module.ts`
- Modify: `apps/console-api/src/app.module.ts` — import `MessagesModule`
- Test: `apps/console-api/src/messages/messages.service.integration.spec.ts`

**Interfaces:**
- Consumes: `PRISMA` token (Plan 1 Task 3).
- Produces: `MessagesService` with `editDraft` — Tasks 4, 5, and 7 add `reject`, `approve`, and the
  worker call to this same service and module. `PATCH /api/accounts/:id/messages/:messageId` —
  consumed by Task 9's UI.

- [ ] **Step 1: Write the failing test**

`apps/console-api/src/messages/messages.service.integration.spec.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db';
import { MessagesService } from './messages.service.js';

describe('MessagesService.editDraft', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function seedPendingDraft(body = 'Original agent text') {
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
    const message = await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'agent_draft',
        body,
        status: 'pending_review',
        tierContext: 2,
      },
    });
    return { account, message };
  }

  it('records the agent original on the first edit and marks the message edited', async () => {
    const { account, message } = await seedPendingDraft('Original agent text');
    const service = new MessagesService(testDb.prisma);

    const updated = await service.editDraft(account.id, message.id, 'Human-revised text');

    expect(updated.body).toBe('Human-revised text');
    expect(updated.originalBody).toBe('Original agent text');
    expect(updated.edited).toBe(true);
  });

  it('never overwrites the agent original on a second edit', async () => {
    const { account, message } = await seedPendingDraft('Original agent text');
    const service = new MessagesService(testDb.prisma);

    await service.editDraft(account.id, message.id, 'First revision');
    const updated = await service.editDraft(account.id, message.id, 'Second revision');

    expect(updated.body).toBe('Second revision');
    expect(updated.originalBody).toBe('Original agent text');
  });

  it('refuses to edit a message that is no longer pending review', async () => {
    const { account, message } = await seedPendingDraft();
    await testDb.prisma.message.update({ where: { id: message.id }, data: { status: 'sent' } });
    const service = new MessagesService(testDb.prisma);

    await expect(service.editDraft(account.id, message.id, 'too late')).rejects.toThrow(
      /not pending review/i,
    );
  });

  it('refuses to edit a message belonging to a different account', async () => {
    const { message } = await seedPendingDraft();
    const other = await testDb.prisma.account.create({
      data: {
        companyName: 'Other Co',
        segment: 'x',
        hub: 'y',
        icpScore: 10,
        icpBand: 'low',
        relationshipSummary: 'x',
        currentTier: 2,
        tierRationale: 'x',
      },
    });
    const service = new MessagesService(testDb.prisma);

    await expect(service.editDraft(other.id, message.id, 'wrong account')).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter console-api exec vitest run src/messages/messages.service.integration.spec.ts`
Expected: FAIL — `./messages.service.js` does not exist.

- [ ] **Step 3: Implement**

`apps/console-api/src/messages/dto/edit-message.dto.ts`:

```ts
import { IsString, MinLength } from 'class-validator';

export class EditMessageDto {
  @IsString() @MinLength(1) body!: string;
}
```

`apps/console-api/src/messages/messages.service.ts`:

```ts
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@erria/db';
import { PRISMA } from '../prisma/prisma.module.js';

@Injectable()
export class MessagesService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async editDraft(accountId: string, messageId: string, body: string) {
    const message = await this.prisma.message.findFirst({ where: { id: messageId, accountId } });
    if (!message) {
      throw new NotFoundException(`Message ${messageId} not found on account ${accountId}`);
    }
    if (message.status !== 'pending_review') {
      throw new ConflictException(
        `Message ${messageId} is ${message.status}, not pending review — it can no longer be edited`,
      );
    }

    return this.prisma.message.update({
      where: { id: messageId },
      data: {
        body,
        // Set once, on the first edit: originalBody is the agent's text, and a second human edit
        // must not overwrite it with the first human revision.
        originalBody: message.originalBody ?? message.body,
        edited: true,
      },
    });
  }
}
```

`apps/console-api/src/messages/messages.controller.ts`:

```ts
import { Body, Controller, Param, Patch } from '@nestjs/common';
import { MessagesService } from './messages.service.js';
import { EditMessageDto } from './dto/edit-message.dto.js';

@Controller('api/accounts/:accountId/messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Patch(':messageId')
  async edit(
    @Param('accountId') accountId: string,
    @Param('messageId') messageId: string,
    @Body() dto: EditMessageDto,
  ) {
    const message = await this.messagesService.editDraft(accountId, messageId, dto.body);
    return {
      message: {
        id: message.id,
        body: message.body,
        edited: message.edited,
        originalBody: message.originalBody,
      },
    };
  }
}
```

`apps/console-api/src/messages/messages.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { MessagesController } from './messages.controller.js';
import { MessagesService } from './messages.service.js';

@Module({ controllers: [MessagesController], providers: [MessagesService], exports: [MessagesService] })
export class MessagesModule {}
```

Add `MessagesModule` to `imports` in `apps/console-api/src/app.module.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter console-api exec vitest run src/messages/messages.service.integration.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/console-api
git commit -m "feat(console-api): edit a pending draft, preserving the agent original"
```

---

### Task 4: Reject a draft

**Files:**
- Modify: `apps/console-api/src/messages/messages.service.ts` — add `rejectDraft`
- Modify: `apps/console-api/src/messages/messages.controller.ts` — add the route
- Test: `apps/console-api/src/messages/messages.service.integration.spec.ts` — add a describe block

**Interfaces:**
- Consumes: `MessagesService` (Task 3).
- Produces: `rejectDraft(accountId, messageId, decidedBy)` and
  `POST /api/accounts/:id/messages/:messageId/reject` — consumed by Task 9's UI.

- [ ] **Step 1: Write the failing test**

Add to `apps/console-api/src/messages/messages.service.integration.spec.ts` (reuse the
`seedPendingDraft` helper by lifting it to module scope if it is still inside the first describe):

```ts
describe('MessagesService.rejectDraft', () => {
  it('marks the message rejected and records who decided', async () => {
    const { account, message } = await seedPendingDraft();
    const service = new MessagesService(testDb.prisma);

    const rejected = await service.rejectDraft(account.id, message.id, 'Minh Tran');

    expect(rejected.status).toBe('rejected');
    expect(rejected.decidedBy).toBe('Minh Tran');
    expect(rejected.decidedAt).toBeInstanceOf(Date);
  });

  it('refuses to reject a message that is not pending review', async () => {
    const { account, message } = await seedPendingDraft();
    const service = new MessagesService(testDb.prisma);
    await service.rejectDraft(account.id, message.id, 'Minh Tran');

    await expect(service.rejectDraft(account.id, message.id, 'Minh Tran')).rejects.toThrow(
      /not pending review/i,
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter console-api exec vitest run src/messages/messages.service.integration.spec.ts`
Expected: FAIL — `rejectDraft` is not a function.

- [ ] **Step 3: Implement**

Add to `apps/console-api/src/messages/messages.service.ts`:

```ts
  async rejectDraft(accountId: string, messageId: string, decidedBy: string) {
    const message = await this.requirePendingDraft(accountId, messageId);

    return this.prisma.message.update({
      where: { id: message.id },
      data: { status: 'rejected', decidedBy, decidedAt: new Date() },
    });
  }
```

and extract the guard both `editDraft` and `rejectDraft` now need — replace the lookup block at the
top of `editDraft` with a call to it:

```ts
  private async requirePendingDraft(accountId: string, messageId: string) {
    const message = await this.prisma.message.findFirst({ where: { id: messageId, accountId } });
    if (!message) {
      throw new NotFoundException(`Message ${messageId} not found on account ${accountId}`);
    }
    if (message.status !== 'pending_review') {
      throw new ConflictException(
        `Message ${messageId} is ${message.status}, not pending review — it can no longer be edited or decided`,
      );
    }
    return message;
  }
```

`editDraft` becomes:

```ts
  async editDraft(accountId: string, messageId: string, body: string) {
    const message = await this.requirePendingDraft(accountId, messageId);

    return this.prisma.message.update({
      where: { id: messageId },
      data: { body, originalBody: message.originalBody ?? message.body, edited: true },
    });
  }
```

Add to `apps/console-api/src/messages/messages.controller.ts`:

```ts
  @Post(':messageId/reject')
  async reject(@Param('accountId') accountId: string, @Param('messageId') messageId: string) {
    // decidedBy comes from the OIDC session once auth is wired (architecture §3); until then this
    // is the single hardcoded operator the deployment has.
    const message = await this.messagesService.rejectDraft(accountId, messageId, DECIDED_BY);
    return { message: { id: message.id, status: message.status } };
  }
```

with `Post` added to the `@nestjs/common` import and, at the top of the file:

```ts
// Auth is a stated non-goal for this phase (architecture §0). One operator, named here, until
// Keycloak/OIDC is wired — at which point this is replaced by the authenticated principal.
const DECIDED_BY = 'Minh Tran';
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter console-api exec vitest run src/messages/messages.service.integration.spec.ts`
Expected: PASS (6 tests — the 4 from Task 3 still pass after the guard extraction).

- [ ] **Step 5: Commit**

```bash
git add apps/console-api
git commit -m "feat(console-api): reject a pending draft"
```

---

### Task 5: Approve a draft (decision only)

**Files:**
- Modify: `apps/console-api/src/messages/messages.service.ts` — add `approveDraft`
- Modify: `apps/console-api/src/messages/messages.controller.ts` — add the route
- Test: `apps/console-api/src/messages/messages.service.integration.spec.ts` — add a describe block

**Interfaces:**
- Consumes: `MessagesService` (Tasks 3-4).
- Produces: `approveDraft(accountId, messageId, decidedBy)` — Task 7 wires the async dispatch call
  onto the controller route that calls it.

This task marks the decision only. Task 7 adds the send. Splitting them keeps the "approve returns
immediately" contract testable on its own, before there is a worker call that could mask it.

- [ ] **Step 1: Write the failing test**

Add to `apps/console-api/src/messages/messages.service.integration.spec.ts`:

```ts
describe('MessagesService.approveDraft', () => {
  it('marks the message approved and records who decided, without sending', async () => {
    const { account, message } = await seedPendingDraft();
    const service = new MessagesService(testDb.prisma);

    const approved = await service.approveDraft(account.id, message.id, 'Minh Tran');

    expect(approved.status).toBe('approved');
    expect(approved.decidedBy).toBe('Minh Tran');
    expect(approved.decidedAt).toBeInstanceOf(Date);
    expect(approved.sentAt).toBeNull();
  });

  it('refuses to approve when the account has an active escalation disabling agent send', async () => {
    const { account, message } = await seedPendingDraft();
    await testDb.prisma.escalation.create({
      data: {
        accountId: account.id,
        hardTriggerRule: 'pricing_question',
        reasonSummary: 'Buyer asked for pricing',
        detail: 'test',
        recommendedNextStep: 'Hand to AE',
        agentSendDisabled: true,
        status: 'active',
      },
    });
    const service = new MessagesService(testDb.prisma);

    await expect(service.approveDraft(account.id, message.id, 'Minh Tran')).rejects.toThrow(
      /escalat/i,
    );
  });

  it('allows approval when the only escalation on the account is already resolved', async () => {
    const { account, message } = await seedPendingDraft();
    await testDb.prisma.escalation.create({
      data: {
        accountId: account.id,
        hardTriggerRule: 'pricing_question',
        reasonSummary: 'Buyer asked for pricing',
        detail: 'test',
        recommendedNextStep: 'Hand to AE',
        agentSendDisabled: true,
        status: 'resolved',
        resolvedAt: new Date(),
      },
    });
    const service = new MessagesService(testDb.prisma);

    const approved = await service.approveDraft(account.id, message.id, 'Minh Tran');
    expect(approved.status).toBe('approved');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter console-api exec vitest run src/messages/messages.service.integration.spec.ts`
Expected: FAIL — `approveDraft` is not a function.

- [ ] **Step 3: Implement**

Add to `apps/console-api/src/messages/messages.service.ts`:

```ts
  async approveDraft(accountId: string, messageId: string, decidedBy: string) {
    const message = await this.requirePendingDraft(accountId, messageId);
    await this.requireAgentSendAllowed(accountId);

    return this.prisma.message.update({
      where: { id: message.id },
      data: { status: 'approved', decidedBy, decidedAt: new Date() },
    });
  }

  /**
   * Spec §10: once a thread has escalated, agent-send is permanently disabled for it. No Escalation
   * rows exist until Plan 3, so this returns without objection today — it is written now because a
   * send guard added after the sends exist is a guard that was missing when it mattered.
   */
  private async requireAgentSendAllowed(accountId: string) {
    const blocking = await this.prisma.escalation.findFirst({
      where: { accountId, status: 'active', agentSendDisabled: true },
    });
    if (blocking) {
      throw new ConflictException(
        `Account ${accountId} has an active escalation (${blocking.hardTriggerRule}) — agent-authored sends are disabled for this thread`,
      );
    }
  }
```

Add to `apps/console-api/src/messages/messages.controller.ts`:

```ts
  @Post(':messageId/approve')
  async approve(@Param('accountId') accountId: string, @Param('messageId') messageId: string) {
    const message = await this.messagesService.approveDraft(accountId, messageId, DECIDED_BY);
    return {
      message: {
        id: message.id,
        status: message.status,
        decidedBy: message.decidedBy,
        decidedAt: message.decidedAt,
      },
    };
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter console-api exec vitest run src/messages/messages.service.integration.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/console-api
git commit -m "feat(console-api): approve a pending draft, guarded by escalation state"
```

---

### Task 6: Worker dispatch route and Clean Approval counting

**Files:**
- Create: `packages/domain/src/tiering/record-clean-approval.ts`
- Create: `apps/worker/src/routes/dispatch-message.ts`
- Modify: `apps/worker/src/server.ts` — register the route, accept the adapter in deps
- Modify: `apps/worker/src/main.ts` — construct the `LoggingChannelAdapter`
- Modify: `packages/domain/src/index.ts` — export `recordCleanApproval`
- Test: `packages/domain/src/tiering/record-clean-approval.integration.spec.ts`
- Test: `apps/worker/src/routes/dispatch-message.integration.spec.ts`

**Interfaces:**
- Consumes: `ChannelAdapter`, `LoggingChannelAdapter`, `buildSubjectLine` (Task 2); `buildServer`
  (Plan 1 Task 4, extended here); `PrismaClient` (Plan 1 Task 2).
- Produces: `recordCleanApproval(tx, message)`; the route
  `POST /internal/dispatch-message/:messageId` — called by Task 7 (approve) and Task 8 (sweep);
  `ServerDeps` gains `channelAdapter`.

- [ ] **Step 1: Write the failing domain test**

`packages/domain/src/tiering/record-clean-approval.integration.spec.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db';
import { recordCleanApproval } from './record-clean-approval.js';

describe('recordCleanApproval', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function seedSentMessage(overrides: { edited?: boolean; tierContext?: number } = {}) {
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
        cleanApprovalsCount: 0,
      },
    });
    const message = await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'agent_sent',
        body: 'text',
        status: 'sent',
        tierContext: overrides.tierContext ?? 2,
        edited: overrides.edited ?? false,
        sentAt: new Date(),
      },
    });
    return { account, message };
  }

  it('increments the counter and writes a clean_approval event for an unedited Tier 2 send', async () => {
    const { account, message } = await seedSentMessage();

    await recordCleanApproval(testDb.prisma, message.id);

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.cleanApprovalsCount).toBe(1);

    const events = await testDb.prisma.tierHistoryEvent.findMany({
      where: { accountId: account.id, eventType: 'clean_approval' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].relatedMessageId).toBe(message.id);
  });

  it('does not count an edited message', async () => {
    const { account, message } = await seedSentMessage({ edited: true });

    await recordCleanApproval(testDb.prisma, message.id);

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.cleanApprovalsCount).toBe(0);
  });

  it('does not count a message whose tier context was not 2', async () => {
    const { account, message } = await seedSentMessage({ tierContext: 3 });

    await recordCleanApproval(testDb.prisma, message.id);

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.cleanApprovalsCount).toBe(0);
  });

  it('does not count when a negative signal arrived on the account after the message', async () => {
    const { account, message } = await seedSentMessage();
    await testDb.prisma.escalation.create({
      data: {
        accountId: account.id,
        hardTriggerRule: 'negative_sentiment',
        reasonSummary: 'Buyer asked to stop',
        detail: 'test',
        recommendedNextStep: 'Human review',
        status: 'active',
      },
    });

    await recordCleanApproval(testDb.prisma, message.id);

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.cleanApprovalsCount).toBe(0);
  });

  it('never promotes to Tier 1, even once the threshold is met (ADR-0005)', async () => {
    const { account } = await seedSentMessage();
    await testDb.prisma.account.update({
      where: { id: account.id },
      data: { cleanApprovalsCount: 1 },
    });
    const second = await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'agent_sent',
        body: 'text',
        status: 'sent',
        tierContext: 2,
        edited: false,
        sentAt: new Date(),
      },
    });

    await recordCleanApproval(testDb.prisma, second.id);

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.cleanApprovalsCount).toBe(2);
    expect(refreshed.currentTier).toBe(2);

    const promotions = await testDb.prisma.tierHistoryEvent.findMany({
      where: { accountId: account.id, eventType: 'promote' },
    });
    expect(promotions).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @erria/domain exec vitest run src/tiering/record-clean-approval.integration.spec.ts`
Expected: FAIL — `./record-clean-approval.js` does not exist.

- [ ] **Step 3: Implement the domain function**

`packages/domain/src/tiering/record-clean-approval.ts`:

```ts
import type { PrismaClient } from '@erria/db';

/**
 * Spec §3's promotion counter and spec §8's "core promotion signal": a Tier 2 draft that went out
 * exactly as the agent wrote it, on an account with no negative signal since.
 *
 * Deliberately stops at the counter. Promoting to Tier 1 is ADR-0005's deferred half — Tier 1 means
 * autonomous send, which does not exist (ADR-0002), so an account promoted into it would carry a
 * tier badge describing behavior the system cannot perform and would break its own next trigger.
 */
export async function recordCleanApproval(prisma: PrismaClient, messageId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const message = await tx.message.findUniqueOrThrow({ where: { id: messageId } });

    if (message.tierContext !== 2 || message.edited) {
      return false;
    }

    // "no negative signal has occurred on this account since" — an Escalation is the only way a
    // negative signal is recorded (see CONTEXT.md's escalation invariant).
    const negativeSignalSince = await tx.escalation.findFirst({
      where: { accountId: message.accountId, createdAt: { gte: message.createdAt } },
    });
    if (negativeSignalSince) {
      return false;
    }

    const account = await tx.account.update({
      where: { id: message.accountId },
      data: { cleanApprovalsCount: { increment: 1 } },
    });

    await tx.tierHistoryEvent.create({
      data: {
        accountId: message.accountId,
        eventType: 'clean_approval',
        fromTier: account.currentTier,
        toTier: account.currentTier,
        reason: `Sent without edits — ${account.cleanApprovalsCount} clean approval(s) on this account.`,
        relatedMessageId: message.id,
      },
    });

    return true;
  });
}
```

Export it from `packages/domain/src/index.ts`:

```ts
export { recordCleanApproval } from './tiering/record-clean-approval.js';
```

- [ ] **Step 4: Run to verify the domain test passes**

Run: `pnpm --filter @erria/domain exec vitest run src/tiering/record-clean-approval.integration.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing worker test**

`apps/worker/src/routes/dispatch-message.integration.spec.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LoggingChannelAdapter } from '@erria/domain';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db';
import { buildServer } from '../server.js';

describe('POST /internal/dispatch-message/:messageId', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function seedApprovedMessage() {
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
        contacts: { create: { name: 'Ms. Lan Pham', role: 'Technical Superintendent', email: 'lan@example.com' } },
        vessels: { create: { name: 'MV Song Hong Pioneer', imo: `IMO${Date.now()}`, flag: 'Vietnam' } },
      },
      include: { vessels: true },
    });
    const trigger = await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        vesselId: account.vessels[0].id,
        category: 'life-raft service window',
        description: 'test',
        source: 'public_data',
        confidenceLabel: 'mid',
        verifiabilityNote: 'test',
        detectedAt: new Date(),
        status: 'drafted',
      },
    });
    const message = await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        triggerId: trigger.id,
        role: 'agent_draft',
        body: 'Hi Ms. Pham, ...',
        status: 'approved',
        tierContext: 2,
        decidedBy: 'Minh Tran',
        decidedAt: new Date(),
      },
    });
    return { account, message };
  }

  it('sends the message, marks it sent, and counts the clean approval', async () => {
    const { account, message } = await seedApprovedMessage();
    const adapter = new LoggingChannelAdapter();
    const server = buildServer({ prisma: testDb.prisma, anthropic: {} as never, channelAdapter: adapter });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/dispatch-message/${message.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'sent' });

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].to).toBe('lan@example.com');
    expect(adapter.sent[0].subject).toBe('MV Song Hong Pioneer — life-raft service window');

    const updated = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(updated.status).toBe('sent');
    expect(updated.sentAt).not.toBeNull();

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.cleanApprovalsCount).toBe(1);
  });

  it('is idempotent — dispatching an already-sent message sends nothing further', async () => {
    const { account, message } = await seedApprovedMessage();
    const adapter = new LoggingChannelAdapter();
    const server = buildServer({ prisma: testDb.prisma, anthropic: {} as never, channelAdapter: adapter });

    await server.inject({ method: 'POST', url: `/internal/dispatch-message/${message.id}` });
    const second = await server.inject({ method: 'POST', url: `/internal/dispatch-message/${message.id}` });

    expect(second.json()).toMatchObject({ status: 'already_sent' });
    expect(adapter.sent).toHaveLength(1);

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.cleanApprovalsCount).toBe(1);
  });

  it('refuses to dispatch a message that was never approved', async () => {
    const { message } = await seedApprovedMessage();
    await testDb.prisma.message.update({
      where: { id: message.id },
      data: { status: 'pending_review' },
    });
    const adapter = new LoggingChannelAdapter();
    const server = buildServer({ prisma: testDb.prisma, anthropic: {} as never, channelAdapter: adapter });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/dispatch-message/${message.id}`,
    });

    expect(response.statusCode).toBe(409);
    expect(adapter.sent).toHaveLength(0);
  });

  it('refuses to dispatch when an escalation opened after approval', async () => {
    const { account, message } = await seedApprovedMessage();
    await testDb.prisma.escalation.create({
      data: {
        accountId: account.id,
        hardTriggerRule: 'negative_sentiment',
        reasonSummary: 'Buyer asked to stop',
        detail: 'test',
        recommendedNextStep: 'Human review',
        agentSendDisabled: true,
        status: 'active',
      },
    });
    const adapter = new LoggingChannelAdapter();
    const server = buildServer({ prisma: testDb.prisma, anthropic: {} as never, channelAdapter: adapter });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/dispatch-message/${message.id}`,
    });

    expect(response.statusCode).toBe(409);
    expect(adapter.sent).toHaveLength(0);

    const updated = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(updated.status).toBe('approved');
    expect(updated.sentAt).toBeNull();
  });

  it('returns 422 when the account has no contact email to send to', async () => {
    const { account, message } = await seedApprovedMessage();
    await testDb.prisma.contact.updateMany({ where: { accountId: account.id }, data: { email: null } });
    const adapter = new LoggingChannelAdapter();
    const server = buildServer({ prisma: testDb.prisma, anthropic: {} as never, channelAdapter: adapter });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/dispatch-message/${message.id}`,
    });

    expect(response.statusCode).toBe(422);
    expect(adapter.sent).toHaveLength(0);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter worker exec vitest run src/routes/dispatch-message.integration.spec.ts`
Expected: FAIL — `buildServer` does not accept `channelAdapter` and the route does not exist.

- [ ] **Step 7: Implement the route**

`apps/worker/src/routes/dispatch-message.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@erria/db';
import { type ChannelAdapter, buildSubjectLine, recordCleanApproval } from '@erria/domain';

export function registerDispatchMessageRoute(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; channelAdapter: ChannelAdapter },
) {
  app.post<{ Params: { messageId: string } }>(
    '/internal/dispatch-message/:messageId',
    async (request, reply) => {
      const message = await deps.prisma.message.findUnique({
        where: { id: request.params.messageId },
        include: {
          account: { include: { contacts: true } },
          trigger: { include: { vessel: true } },
        },
      });

      if (!message) {
        return reply.code(404).send({ error: 'message_not_found' });
      }

      // Idempotent by design: the reconciliation sweep (and a retried async call) can invoke this
      // for a message that already went out. Sending twice is worse than doing nothing.
      if (message.status === 'sent') {
        return reply.send({ status: 'already_sent' });
      }

      if (message.status !== 'approved') {
        return reply.code(409).send({ error: 'not_approved', status: message.status });
      }

      // Re-checked here, not just at approval: an escalation can open in the window between a human
      // approving and this dispatch running, and the sweep can re-invoke long after.
      const blocking = await deps.prisma.escalation.findFirst({
        where: { accountId: message.accountId, status: 'active', agentSendDisabled: true },
      });
      if (blocking) {
        return reply.code(409).send({ error: 'agent_send_disabled', rule: blocking.hardTriggerRule });
      }

      const recipient = message.account.contacts.find((contact) => contact.email)?.email;
      if (!recipient) {
        return reply.code(422).send({ error: 'no_contact_email' });
      }

      await deps.channelAdapter.send({
        to: recipient,
        subject: buildSubjectLine({
          companyName: message.account.companyName,
          vesselName: message.trigger?.vessel?.name ?? null,
          triggerCategory: message.trigger?.category ?? null,
        }),
        body: message.body,
      });

      await deps.prisma.message.update({
        where: { id: message.id },
        data: { role: 'agent_sent', status: 'sent', sentAt: new Date() },
      });

      const counted = await recordCleanApproval(deps.prisma, message.id);

      return reply.send({ status: 'sent', cleanApprovalCounted: counted });
    },
  );
}
```

- [ ] **Step 8: Extend the server and entrypoint**

`apps/worker/src/server.ts` — add the adapter to `ServerDeps` and register the route:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@erria/db';
import type Anthropic from '@anthropic-ai/sdk';
import type { ChannelAdapter } from '@erria/domain';
import { registerProcessTriggerRoute } from './routes/process-trigger.js';
import { registerDispatchMessageRoute } from './routes/dispatch-message.js';

export interface ServerDeps {
  prisma: PrismaClient;
  anthropic: Anthropic;
  channelAdapter: ChannelAdapter;
}

export function buildServer(deps?: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: true });
  app.get('/health', async () => ({ status: 'ok' }));
  if (deps) {
    registerProcessTriggerRoute(app, deps);
    registerDispatchMessageRoute(app, deps);
  }
  return app;
}
```

`apps/worker/src/main.ts` — construct the adapter:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { LoggingChannelAdapter } from '@erria/domain';
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
  const channelAdapter = new LoggingChannelAdapter();
  const server = buildServer({ prisma, anthropic, channelAdapter });
  const port = process.env.WORKER_PORT ? Number(process.env.WORKER_PORT) : 3100;
  await server.listen({ port, host: '0.0.0.0' });
}

main();
```

Plan 1's `process-trigger.integration.spec.ts` constructs `buildServer({ prisma, anthropic })`. Add
`channelAdapter: new LoggingChannelAdapter()` to those calls so the widened `ServerDeps` still
type-checks.

- [ ] **Step 9: Run the whole worker suite to verify it passes**

Run: `pnpm --filter worker exec vitest run`
Expected: PASS — the 5 new dispatch tests plus Plan 1's health-check and process-trigger tests.

- [ ] **Step 10: Commit**

```bash
git add packages/domain apps/worker
git commit -m "feat(worker): dispatch approved messages and count clean approvals (no promotion, ADR-0005)"
```

---

### Task 7: Wire approve to asynchronous dispatch

**Files:**
- Modify: `apps/console-api/src/worker-client/worker-client.service.ts` — add `dispatchMessage`
- Modify: `apps/console-api/src/messages/messages.controller.ts` — invoke it after approving
- Modify: `apps/console-api/src/messages/messages.module.ts` — import `WorkerClientModule`
- Test: `apps/console-api/src/messages/messages.controller.integration.spec.ts`

**Interfaces:**
- Consumes: `WorkerClient` (Plan 1 Task 9), `MessagesService.approveDraft` (Task 5), the worker's
  dispatch route (Task 6).
- Produces: the completed `POST .../approve` behavior — consumed by Task 9's UI.

- [ ] **Step 1: Write the failing test**

`apps/console-api/src/messages/messages.controller.integration.spec.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { LoggingChannelAdapter } from '@erria/domain';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db';
import { buildServer } from '../../../worker/src/server.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { WorkerClient } from '../worker-client/worker-client.service.js';
import { MessagesService } from './messages.service.js';
import { MessagesController } from './messages.controller.js';

describe('MessagesController approve → dispatch', () => {
  let testDb: TestPostgres;
  let adapter: LoggingChannelAdapter;

  beforeAll(async () => {
    testDb = await startTestPostgres();
    adapter = new LoggingChannelAdapter();
    const workerServer = buildServer({
      prisma: testDb.prisma,
      anthropic: {} as never,
      channelAdapter: adapter,
    });
    const address = await workerServer.listen({ port: 0, host: '127.0.0.1' });
    process.env.WORKER_INTERNAL_URL =
      typeof address === 'string' ? address : `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  it('approving a draft results in it actually being sent', async () => {
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
        contacts: { create: { name: 'Ms. Lan Pham', role: 'Tech Super', email: 'lan2@example.com' } },
      },
    });
    const message = await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'agent_draft',
        body: 'Hi Ms. Pham, ...',
        status: 'pending_review',
        tierContext: 2,
      },
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [MessagesController],
      providers: [MessagesService, WorkerClient, { provide: PRISMA, useValue: testDb.prisma }],
    }).compile();
    const controller = moduleRef.get(MessagesController);

    const result = await controller.approve(account.id, message.id);
    expect(result.message.status).toBe('approved');

    // Dispatch is fired asynchronously; wait for the message to reach 'sent'.
    await vi.waitFor(async () => {
      const updated = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
      expect(updated.status).toBe('sent');
    });

    expect(adapter.sent.some((email) => email.to === 'lan2@example.com')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter console-api exec vitest run src/messages/messages.controller.integration.spec.ts`
Expected: FAIL — approving does not trigger a dispatch, so the message never reaches `sent`.

- [ ] **Step 3: Implement**

Add to `apps/console-api/src/worker-client/worker-client.service.ts`:

```ts
  async dispatchMessage(messageId: string): Promise<void> {
    const baseUrl = process.env.WORKER_INTERNAL_URL ?? 'http://localhost:3100';
    const response = await fetch(`${baseUrl}/internal/dispatch-message/${messageId}`, {
      method: 'POST',
    });
    if (!response.ok) {
      throw new Error(`Worker returned ${response.status} dispatching message ${messageId}`);
    }
  }
```

In `apps/console-api/src/messages/messages.controller.ts`, inject the client and fire the dispatch
without awaiting it:

```ts
  constructor(
    private readonly messagesService: MessagesService,
    private readonly workerClient: WorkerClient,
  ) {}
```

and in `approve`, after the service call and before returning:

```ts
    // Deliberately not awaited: the human-facing request returns as soon as the decision is
    // recorded (architecture §3). If this call fails, the message sits 'approved' with no sentAt —
    // which is exactly what the reconciliation sweep looks for.
    void this.workerClient.dispatchMessage(message.id).catch((error) => {
      this.logger.error(`Async dispatch failed for message ${message.id}`, error);
    });
```

with a logger on the controller:

```ts
  private readonly logger = new Logger(MessagesController.name);
```

(`Logger` from `@nestjs/common`.)

Add `WorkerClientModule` to `imports` in `apps/console-api/src/messages/messages.module.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter console-api exec vitest run`
Expected: PASS — the new controller test plus everything from Tasks 1, 3, 4, 5 and Plan 1.

- [ ] **Step 5: Commit**

```bash
git add apps/console-api
git commit -m "feat(console-api): fire asynchronous dispatch when a draft is approved"
```

---

### Task 8: Stuck-send reconciliation sweep

**Files:**
- Create: `apps/worker/src/jobs/reconcile-stuck-sends.ts`
- Modify: `apps/worker/src/jobs/run-job.ts` — wire the real job body
- Test: `apps/worker/src/jobs/reconcile-stuck-sends.integration.spec.ts`

**Interfaces:**
- Consumes: the dispatch route's behavior (Task 6) via the same in-process handler.
- Produces: `reconcileStuckSends(prisma, channelAdapter, options)` — invoked by
  `runJob('stuck-send-reconciliation')`, which Azure Container Apps Jobs calls on a schedule.

This closes the durability hole the architecture doc names in §5 Flow 2 step 3: the async dispatch
call can fail after `status` is already `approved`, leaving a message that is never sent and never
flagged.

- [ ] **Step 1: Write the failing test**

`apps/worker/src/jobs/reconcile-stuck-sends.integration.spec.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LoggingChannelAdapter } from '@erria/domain';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db';
import { reconcileStuckSends } from './reconcile-stuck-sends.js';

describe('reconcileStuckSends', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function seedApproved(decidedMinutesAgo: number) {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: `Stuck Co ${decidedMinutesAgo}`,
        segment: 'x',
        hub: 'y',
        icpScore: 50,
        icpBand: 'med',
        relationshipSummary: 'x',
        currentTier: 2,
        tierRationale: 'x',
        contacts: { create: { name: 'Contact', role: 'role', email: `stuck${decidedMinutesAgo}@example.com` } },
      },
    });
    return testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'agent_draft',
        body: 'body',
        status: 'approved',
        tierContext: 2,
        decidedBy: 'Minh Tran',
        decidedAt: new Date(Date.now() - decidedMinutesAgo * 60_000),
      },
    });
  }

  it('sends a message that has been approved but unsent past the threshold', async () => {
    const stuck = await seedApproved(30);
    const adapter = new LoggingChannelAdapter();

    const result = await reconcileStuckSends(testDb.prisma, adapter, { staleAfterMinutes: 5 });

    expect(result.dispatched).toBe(1);
    expect(adapter.sent).toHaveLength(1);

    const updated = await testDb.prisma.message.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(updated.status).toBe('sent');
  });

  it('leaves a recently-approved message alone — its own dispatch may still be in flight', async () => {
    await seedApproved(1);
    const adapter = new LoggingChannelAdapter();

    const result = await reconcileStuckSends(testDb.prisma, adapter, { staleAfterMinutes: 5 });

    expect(result.dispatched).toBe(0);
    expect(adapter.sent).toHaveLength(0);
  });

  it('flags a message for human attention when its reconciled retry also fails', async () => {
    const stuck = await seedApproved(30);
    await testDb.prisma.contact.updateMany({
      where: { accountId: stuck.accountId },
      data: { email: null },
    });
    const adapter = new LoggingChannelAdapter();

    const result = await reconcileStuckSends(testDb.prisma, adapter, { staleAfterMinutes: 5 });

    expect(result.dispatched).toBe(0);
    expect(result.flagged).toBe(1);

    const events = await testDb.prisma.tierHistoryEvent.findMany({
      where: { accountId: stuck.accountId, relatedMessageId: stuck.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].reason).toMatch(/could not be sent/i);

    const updated = await testDb.prisma.message.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(updated.status).toBe('needs_triage');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter worker exec vitest run src/jobs/reconcile-stuck-sends.integration.spec.ts`
Expected: FAIL — `./reconcile-stuck-sends.js` does not exist.

- [ ] **Step 3: Implement**

`apps/worker/src/jobs/reconcile-stuck-sends.ts`:

```ts
import type { PrismaClient } from '@erria/db';
import { type ChannelAdapter, buildSubjectLine, recordCleanApproval } from '@erria/domain';

export interface ReconcileOptions {
  staleAfterMinutes: number;
}

export interface ReconcileResult {
  dispatched: number;
  flagged: number;
}

/**
 * Architecture §5 Flow 2 step 3: approving returns before the send happens, so a failed async
 * dispatch leaves a message 'approved' with no sentAt and nothing watching it. This sweep is that
 * watcher. A message that fails its reconciled retry is flagged for a human rather than retried
 * forever.
 */
export async function reconcileStuckSends(
  prisma: PrismaClient,
  channelAdapter: ChannelAdapter,
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const cutoff = new Date(Date.now() - options.staleAfterMinutes * 60_000);

  const stuck = await prisma.message.findMany({
    where: { status: 'approved', sentAt: null, decidedAt: { lt: cutoff } },
    include: {
      account: { include: { contacts: true } },
      trigger: { include: { vessel: true } },
    },
  });

  const result: ReconcileResult = { dispatched: 0, flagged: 0 };

  for (const message of stuck) {
    const blocking = await prisma.escalation.findFirst({
      where: { accountId: message.accountId, status: 'active', agentSendDisabled: true },
    });
    const recipient = message.account.contacts.find((contact) => contact.email)?.email;

    if (blocking || !recipient) {
      await flagForHuman(
        prisma,
        message,
        blocking
          ? `Approved message could not be sent — the account escalated (${blocking.hardTriggerRule}) before dispatch ran.`
          : 'Approved message could not be sent — no contact email on this account.',
      );
      result.flagged += 1;
      continue;
    }

    try {
      await channelAdapter.send({
        to: recipient,
        subject: buildSubjectLine({
          companyName: message.account.companyName,
          vesselName: message.trigger?.vessel?.name ?? null,
          triggerCategory: message.trigger?.category ?? null,
        }),
        body: message.body,
      });
      await prisma.message.update({
        where: { id: message.id },
        data: { role: 'agent_sent', status: 'sent', sentAt: new Date() },
      });
      await recordCleanApproval(prisma, message.id);
      result.dispatched += 1;
    } catch (error) {
      await flagForHuman(
        prisma,
        message,
        `Approved message could not be sent — the channel rejected it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      result.flagged += 1;
    }
  }

  return result;
}

async function flagForHuman(
  prisma: PrismaClient,
  message: { id: string; accountId: string },
  reason: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.message.update({ where: { id: message.id }, data: { status: 'needs_triage' } }),
    prisma.tierHistoryEvent.create({
      data: {
        accountId: message.accountId,
        eventType: 'hold_at_tier',
        reason,
        relatedMessageId: message.id,
      },
    }),
  ]);
}
```

- [ ] **Step 4: Wire it into the job entrypoint**

Replace the stub body in `apps/worker/src/jobs/run-job.ts`:

```ts
import { LoggingChannelAdapter } from '@erria/domain';
import { prisma } from '@erria/db';
import { reconcileStuckSends } from './reconcile-stuck-sends.js';

const JOB_NAMES = ['followup-cadence', 'audit-sample-maintenance', 'stuck-send-reconciliation'] as const;
export type JobName = (typeof JOB_NAMES)[number];

const STALE_AFTER_MINUTES = 5;

export async function runJob(name: string): Promise<void> {
  if (!(JOB_NAMES as readonly string[]).includes(name)) {
    throw new Error(`Unknown job: ${name}. Expected one of ${JOB_NAMES.join(', ')}`);
  }

  if (name === 'stuck-send-reconciliation') {
    const result = await reconcileStuckSends(prisma, new LoggingChannelAdapter(), {
      staleAfterMinutes: STALE_AFTER_MINUTES,
    });
    console.log(
      `[job] stuck-send-reconciliation: dispatched ${result.dispatched}, flagged ${result.flagged}`,
    );
    return;
  }

  // followup-cadence and audit-sample-maintenance land in later plans, once the flows they serve
  // exist. The entrypoint contract is established; the bodies are not written yet.
  console.log(`[stub] job "${name}" invoked — no-op until a later plan implements it`);
}
```

Plan 1's `run-job.spec.ts` asserts `runJob('followup-cadence')` resolves — that still holds. It does
not assert anything about `stuck-send-reconciliation`, which now touches the real database, so leave
that test as-is rather than broadening it into an integration test.

- [ ] **Step 5: Run the worker suite to verify it passes**

Run: `pnpm --filter worker exec vitest run`
Expected: PASS — 3 new reconciliation tests plus everything from Task 6 and Plan 1.

- [ ] **Step 6: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): add stuck-send reconciliation sweep"
```

---

### Task 9: Console UI — Account Detail draft review

**Files:**
- Create: `apps/console-web/src/AccountDetailPage.tsx`
- Create: `apps/console-web/src/api.ts`
- Modify: `apps/console-web/src/App.tsx` — route between queue and detail
- Modify: `apps/console-web/src/QueuePage.tsx` — make a row open the account
- Test: `apps/console-web/src/AccountDetailPage.test.tsx`

**Interfaces:**
- Consumes: `GET /api/accounts/:id` (Plan 1 Task 11), `PATCH .../messages/:id` (Task 3),
  `POST .../reject` (Task 4), `POST .../approve` (Tasks 5, 7).
- Produces: the Account Detail review screen — the last piece of Flow 2, no further in-plan
  consumers.

Mirror the v07 mockup's review controls: the draft body, **Approve** and **Reject** buttons, an
**Edit** toggle that swaps the body for a textarea with Save/Cancel, and — after a decision — the
"Approved · sending" / "Rejected" state in place of the buttons.

- [ ] **Step 1: Write the failing test**

`apps/console-web/src/AccountDetailPage.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountDetailPage } from './AccountDetailPage.js';

const detail = {
  account: {
    id: 'acc_1',
    companyName: 'Song Hong Shipping',
    segment: 'Offshore support vessel operator',
    hub: 'Haiphong',
    icpBand: 'high',
    relationshipSummary: 'New account · first contact 12 Jul 2026',
    currentTier: 2,
    tierRationale: 'New account — rollout default',
  },
  vessels: [{ id: 'v1', name: 'MV Song Hong Pioneer', imo: '9123456', flag: 'Vietnam' }],
  contacts: [{ id: 'c1', name: 'Ms. Lan Pham', role: 'Technical Superintendent', email: 'lan@example.com' }],
  pendingMessage: { id: 'msg_1', body: 'Hi Ms. Pham, ...', edited: false, tierContext: 2 },
};

function mockFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url.endsWith('/approve')) {
      return { ok: true, json: async () => ({ message: { id: 'msg_1', status: 'approved' } }) };
    }
    if (init?.method === 'POST' && url.endsWith('/reject')) {
      return { ok: true, json: async () => ({ message: { id: 'msg_1', status: 'rejected' } }) };
    }
    if (init?.method === 'PATCH') {
      return {
        ok: true,
        json: async () => ({ message: { id: 'msg_1', body: 'Edited text', edited: true } }),
      };
    }
    return { ok: true, json: async () => ({ ...detail, ...overrides }) };
  });
}

describe('AccountDetailPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch());
  });

  it('renders the dossier and the pending draft', async () => {
    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());
    expect(screen.getByText('MV Song Hong Pioneer')).toBeInTheDocument();
    expect(screen.getByText(/Hi Ms\. Pham/)).toBeInTheDocument();
  });

  it('shows the sending state after approving', async () => {
    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Hi Ms\. Pham/)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => expect(screen.getByText(/approved · sending/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  it('shows the rejected state after rejecting', async () => {
    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Hi Ms\. Pham/)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /reject/i }));

    await waitFor(() => expect(screen.getByText(/rejected/i)).toBeInTheDocument());
  });

  it('edits the draft body and marks it edited', async () => {
    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Hi Ms\. Pham/)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /edit/i }));
    const textarea = screen.getByRole('textbox');
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'Edited text');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(screen.getByText('Edited text')).toBeInTheDocument());
    expect(screen.getByText(/edited by a human/i)).toBeInTheDocument();
  });

  it('shows no review controls when there is no pending draft', async () => {
    vi.stubGlobal('fetch', mockFetch({ pendingMessage: null }));
    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.getByText(/nothing awaiting review/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter console-web exec vitest run`
Expected: FAIL — `./AccountDetailPage.js` does not exist.

- [ ] **Step 3: Add the API helper**

`apps/console-web/src/api.ts`:

```ts
export interface AccountDetail {
  account: {
    id: string;
    companyName: string;
    segment: string;
    hub: string;
    icpBand: 'high' | 'med' | 'low';
    relationshipSummary: string;
    currentTier: number;
    tierRationale: string;
  };
  vessels: { id: string; name: string; imo: string; flag: string }[];
  contacts: { id: string; name: string; role: string; email: string | null }[];
  pendingMessage: { id: string; body: string; edited: boolean; tierContext: number } | null;
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

export const api = {
  getAccount: (accountId: string) => fetch(`/api/accounts/${accountId}`).then(json<AccountDetail>),

  editMessage: (accountId: string, messageId: string, body: string) =>
    fetch(`/api/accounts/${accountId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }).then(json<{ message: { id: string; body: string; edited: boolean } }>),

  approveMessage: (accountId: string, messageId: string) =>
    fetch(`/api/accounts/${accountId}/messages/${messageId}/approve`, { method: 'POST' }).then(
      json<{ message: { id: string; status: string } }>,
    ),

  rejectMessage: (accountId: string, messageId: string) =>
    fetch(`/api/accounts/${accountId}/messages/${messageId}/reject`, { method: 'POST' }).then(
      json<{ message: { id: string; status: string } }>,
    ),
};
```

- [ ] **Step 4: Implement the page**

`apps/console-web/src/AccountDetailPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { api, type AccountDetail } from './api.js';

type Decision = 'approved' | 'rejected' | null;

export function AccountDetailPage({ accountId, onBack }: { accountId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [decision, setDecision] = useState<Decision>(null);
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState('');
  const [edited, setEdited] = useState(false);

  useEffect(() => {
    api.getAccount(accountId).then((data) => {
      setDetail(data);
      setDraftBody(data.pendingMessage?.body ?? '');
      setEdited(data.pendingMessage?.edited ?? false);
    });
  }, [accountId]);

  if (!detail) return <p>Loading account…</p>;

  const { account, vessels, contacts, pendingMessage } = detail;

  async function save() {
    if (!pendingMessage) return;
    const result = await api.editMessage(account.id, pendingMessage.id, draftBody);
    setDraftBody(result.message.body);
    setEdited(result.message.edited);
    setEditing(false);
  }

  async function approve() {
    if (!pendingMessage) return;
    await api.approveMessage(account.id, pendingMessage.id);
    setDecision('approved');
  }

  async function reject() {
    if (!pendingMessage) return;
    await api.rejectMessage(account.id, pendingMessage.id);
    setDecision('rejected');
  }

  return (
    <div className="account-detail">
      <button onClick={onBack}>← Back to queue</button>

      <header>
        <h1>{account.companyName}</h1>
        <p>
          {account.segment} · {account.hub}
        </p>
        <span className={`badge t${account.currentTier}`}>Tier {account.currentTier}</span>
        <p className="tier-why">{account.tierRationale}</p>
      </header>

      <section className="dossier">
        <p>{account.relationshipSummary}</p>
        <ul>
          {vessels.map((vessel) => (
            <li key={vessel.id}>
              {vessel.name} · IMO {vessel.imo} · {vessel.flag}
            </li>
          ))}
        </ul>
        <ul>
          {contacts.map((contact) => (
            <li key={contact.id}>
              {contact.name} — {contact.role}
            </li>
          ))}
        </ul>
      </section>

      <section className="outreach">
        {!pendingMessage ? (
          <p>Nothing awaiting review on this account.</p>
        ) : decision === 'approved' ? (
          <p className="badge ok">Approved · sending</p>
        ) : decision === 'rejected' ? (
          <p className="badge ghost">Rejected — returned to the agent</p>
        ) : editing ? (
          <>
            <textarea value={draftBody} onChange={(event) => setDraftBody(event.target.value)} />
            <button onClick={save}>Save</button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <>
            <p className="draft-body">{draftBody}</p>
            {edited && <p className="edited-note">Edited by a human — this send will not count toward promotion.</p>}
            <button onClick={approve}>Approve</button>
            <button onClick={reject}>Reject</button>
            <button onClick={() => setEditing(true)}>Edit</button>
          </>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Route between the two pages**

`apps/console-web/src/App.tsx`:

```tsx
import { useState } from 'react';
import { QueuePage } from './QueuePage.js';
import { AccountDetailPage } from './AccountDetailPage.js';

export function App() {
  const [openAccountId, setOpenAccountId] = useState<string | null>(null);

  return openAccountId ? (
    <AccountDetailPage accountId={openAccountId} onBack={() => setOpenAccountId(null)} />
  ) : (
    <QueuePage onOpenAccount={setOpenAccountId} />
  );
}
```

In `apps/console-web/src/QueuePage.tsx`, accept the callback and make each row activate it. Change
the signature to `export function QueuePage({ onOpenAccount }: { onOpenAccount: (id: string) => void })`
and make the company cell a button:

```tsx
            <td>
              <button onClick={() => onOpenAccount(row.accountId)}>{row.company}</button>
            </td>
```

Plan 1's `QueuePage.test.tsx` renders `<QueuePage />` with no props — update those renders to
`<QueuePage onOpenAccount={() => {}} />`, and note that `screen.getByText('Song Hong Shipping')`
still passes because the company name is now button text.

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm --filter console-web exec vitest run`
Expected: PASS — 5 new detail tests plus Plan 1's queue test.

- [ ] **Step 7: Verify manually against the real stack**

Start `pnpm --filter console-api run dev`, `pnpm --filter worker run dev`, and
`pnpm --filter console-web run dev`. POST a trigger with a contact to
`http://localhost:3000/internal/triggers` (needs a real `ANTHROPIC_API_KEY`), open
`http://localhost:5173`, click into the account, and confirm: the draft renders, Edit → Save marks
it edited, and Approve flips to "Approved · sending" and produces a `[dispatch] to=…` line in the
worker's console output.

- [ ] **Step 8: Commit**

```bash
git add apps/console-web
git commit -m "feat(console-web): add Account Detail draft review with approve/reject/edit"
```

---

## Self-Review Notes (from writing this plan)

- **Flow 2 coverage:** architecture §5 Flow 2 step 1 → Tasks 3 and 9; step 2 → Tasks 5 and 7;
  step 3 (the reconciliation sweep) → Task 8; step 4 → Tasks 2 and 6; step 5 → Task 6's
  `recordCleanApproval`, minus the promotion action per ADR-0005; step 6 (audit-sampling) →
  deliberately absent, see below; step 7 → Task 9.
- **Deliberate deviation from the architecture doc, flagged:** §5 Flow 2 step 5 says promotion sets
  `Account.current_tier = 1`. This plan does not, per ADR-0005. The ADR is newer and explains why;
  the architecture doc should be amended to match when it is next revised.
- **Audit-sampling is deliberately not here.** §5 Flow 2 step 6 rolls for an audit sample only when
  `tier_context == 1`. Every message in this plan has `tierContext === 2`, and Tier 1 sends do not
  exist (ADR-0002), so the branch would be unreachable code with no test that could exercise it
  end to end. Audit-sample *creation* belongs with autonomous send. This has a knock-on effect worth
  stating: **Plan 4's Send Audit screen has no data source until then** — it can be built and tested
  against seeded `AuditSample` rows, but it cannot be demonstrated end to end.
- **Follow-up cadence is not here either.** Spec §5's max-2-follow-ups rule creates *new* drafts,
  which is Flow-1-shaped work (a new trigger source) rather than part of approve→send. It belongs in
  its own slice.
- **Type consistency check:** `ServerDeps` gains `channelAdapter` in Task 6, which breaks Plan 1's
  two `buildServer({ prisma, anthropic })` call sites in `process-trigger.integration.spec.ts` —
  Task 6 Step 8 names that fix explicitly. `QueuePage`'s signature gains a required prop in Task 9,
  which breaks Plan 1's `QueuePage.test.tsx` renders — Task 9 Step 5 names that fix too.
- **Known gap, stated not hidden:** the email subject line is invented by this plan (Task 2), since
  no spec or mockup defines one. It is isolated in `buildSubjectLine` so revising it is a one-file
  change.
- **`decidedBy` is hardcoded** to one operator name until Keycloak/OIDC is wired, which architecture
  §0 lists as a non-goal for this phase. Named in Task 4 with the reason, rather than left as a
  silent literal.
