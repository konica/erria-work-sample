# Outreach Agent — Plan 4: Settings, Send Audit, and Tier History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the console. Make the admin-configurable settings real — split by risk, so
low-stakes values save immediately and customer-facing ones require an explicit confirmation
showing exactly what will change — expose the locked policy rules as read-only reference, build the
Send Audit review queue, and render the Tier History timeline that every earlier plan has been
writing events into.

**Architecture:** Continues Plans 1-3. This plan is almost entirely Console API and console
frontend — it adds no Claude calls, no worker routes, and no scheduled jobs. This is Plan 4 of 4.
Grounded in `docs/superpowers/specs/2026-08-01-outreach-agent-design.md` §10 and §11,
`docs/architecture/2026-08-02-application-architecture.md` §2-§3, and the v07 mockup's Settings,
Send Audit, and Tier History screens.

**Tech Stack:** Unchanged from Plans 1-3.

**Prerequisite:** Plans 1-3 complete. This plan adds no migrations — `Setting`, `AuditSample`, and
`TierHistoryEvent` were all created in Plan 1 Task 2.

## Global Constraints

- **Node.js >=24**, TypeScript `strict: true`, pnpm workspaces — unchanged.
- **Settings are split into three risk classes** (spec §11), and the split is the point — do not
  collapse them into one undifferentiated form:
  - **Freely adjustable, saves immediately:** `tier1PromotionThreshold` (integer 1-4, default 2),
    `tier1AuditSampleRate` (percent, default 10).
  - **Adjustable with a confirmation step:** `maxFollowups` (1-5, default 2),
    `minDaysBetweenFollowups` (3-14, default 5), `sentimentConfidenceFloor`
    (`Low`/`Medium`/`High`, default `Medium`).
  - **Locked, engineer-only:** the five hard escalation rules, and whether the rollout overlay
    applies at all.
- **Locked settings are constants in code, never rows in the `Setting` table** (architecture §2:
  "Making them DB rows would imply they're editable, which contradicts the spec's explicit
  'engineer-only' classification"). They are served read-only so the UI can display them.
- **The confirmation copy must state that a change applies going forward, not retroactively**
  (spec §11).
- **The confirmation must show the actual diff** — each changed field with its old and new value.
  A confirmation step that does not say what is changing is a speed bump, not a safeguard.
- **There is no settings change log** (spec §12). It was deliberately cut together with access
  control: "Logging changes without that distinction gives an appearance of accountability the
  system can't actually back up." Do not add one, and do not add a `changedBy` field.
- **A "concerning" audit verdict never demotes the account** (spec §10). It records a pattern for
  humans to spot; only a real negative signal changes tier, and that path is Plan 3's.
- **Audit review is retrospective and non-blocking** (spec §10) — the message has already sent by
  the time anyone reviews it. Nothing in this plan gates a send.
- **Known and stated: `AuditSample` rows have no producer yet.** Sampling fires only on Tier 1
  autonomous sends (spec §10), which do not exist ([ADR-0002](../../adr/0002-tier-1-autonomous-send-deferred.md),
  [ADR-0005](../../adr/0005-clean-approvals-counted-promotion-action-deferred.md)). The Send Audit
  screen is therefore built and tested against **seeded** rows and cannot be demonstrated end to
  end until autonomous send ships. This is a known consequence, not an oversight — see the
  self-review note.

---

### Task 1: Read settings, and save the freely-adjustable ones

**Files:**
- Create: `packages/domain/src/settings/locked-policy.ts`
- Modify: `packages/domain/src/index.ts` — export it
- Create: `apps/console-api/src/settings/dto/save-basic-settings.dto.ts`
- Create: `apps/console-api/src/settings/settings.service.ts`
- Create: `apps/console-api/src/settings/settings.controller.ts`
- Create: `apps/console-api/src/settings/settings.module.ts`
- Modify: `apps/console-api/src/app.module.ts` — import `SettingsModule`
- Test: `apps/console-api/src/settings/settings.service.integration.spec.ts`

**Interfaces:**
- Consumes: `PRISMA` (Plan 1 Task 3).
- Produces: `SettingsService.read()` / `.saveBasic()`, `LOCKED_POLICY`,
  `GET /api/settings`, `PUT /api/settings/basic` — consumed by Tasks 2 and 5.

- [ ] **Step 1: The locked policy reference**

`packages/domain/src/settings/locked-policy.ts`:

```ts
/**
 * Spec §11's "locked, engineer-only" tier. Deliberately constants, not `Setting` columns: storing
 * them in the database would imply an admin can change them, which is exactly the implication the
 * spec rules out. Served read-only so the Settings screen can show what the policy is.
 */
export const LOCKED_POLICY = {
  hardTriggerRules: [
    {
      key: 'pricing_question',
      label: 'Pricing or commercial terms',
      description: 'The agent has no authority to quote, so any commercial question routes to a human.',
    },
    {
      key: 'technical_compliance_question',
      label: 'Technical or compliance question beyond verified knowledge',
      description: 'Questions whose answers depend on specifics the dossier does not cover.',
    },
    {
      key: 'negative_sentiment',
      label: 'Negative sentiment, complaint, or opt-out',
      description: 'Escalates and stops all further outreach to that account until a human reviews.',
    },
    {
      key: 'relationship_conflict',
      label: 'Sign of an existing Erria relationship not on record',
      description: 'An unknown relationship is a reason to stop, not to guess.',
    },
    {
      key: 'compliance_deadline_content',
      label: "Message citing a vessel's compliance deadline",
      description:
        'Capped at Tier 2 minimum — never sent fully autonomously — because referencing a ' +
        "recipient's own compliance data reads as helpful or as surveillance depending entirely on framing.",
    },
  ],
  rolloutOverlayEnabled: true,
  rolloutOverlayDescription:
    'Every new account starts at Tier 2 minimum regardless of score, until it has earned promotion. ' +
    'This is a risk-appetite decision, not a tuning knob.',
} as const;
```

Export `LOCKED_POLICY` from `packages/domain/src/index.ts`.

- [ ] **Step 2: Write the failing test**

`apps/console-api/src/settings/settings.service.integration.spec.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db';
import { SettingsService } from './settings.service.js';

describe('SettingsService', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  it('creates the single settings row with spec defaults on first read', async () => {
    const service = new SettingsService(testDb.prisma);

    const result = await service.read();

    expect(result.basic.tier1PromotionThreshold).toBe(2);
    expect(result.basic.tier1AuditSampleRate).toBe(10);
    expect(result.advanced.maxFollowups).toBe(2);
    expect(result.advanced.minDaysBetweenFollowups).toBe(5);
    expect(result.advanced.sentimentConfidenceFloor).toBe('Medium');
  });

  it('serves the locked policy as read-only reference', async () => {
    const service = new SettingsService(testDb.prisma);

    const result = await service.read();

    expect(result.locked.hardTriggerRules).toHaveLength(5);
    expect(result.locked.rolloutOverlayEnabled).toBe(true);
  });

  it('saves freely-adjustable values immediately', async () => {
    const service = new SettingsService(testDb.prisma);

    const result = await service.saveBasic({ tier1PromotionThreshold: 3, tier1AuditSampleRate: 25 });

    expect(result.basic.tier1PromotionThreshold).toBe(3);
    expect(result.basic.tier1AuditSampleRate).toBe(25);

    const stored = await testDb.prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
    expect(stored.tier1PromotionThreshold).toBe(3);
  });

  it('does not touch the confirm-required values when saving basic ones', async () => {
    const service = new SettingsService(testDb.prisma);
    await service.saveBasic({ tier1PromotionThreshold: 4, tier1AuditSampleRate: 5 });

    const stored = await testDb.prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
    expect(stored.maxFollowups).toBe(2);
    expect(stored.sentimentConfidenceFloor).toBe('Medium');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter console-api exec vitest run src/settings/settings.service.integration.spec.ts`
Expected: FAIL — `./settings.service.js` does not exist.

- [ ] **Step 4: Implement**

`apps/console-api/src/settings/dto/save-basic-settings.dto.ts`:

```ts
import { IsInt, Max, Min } from 'class-validator';

export class SaveBasicSettingsDto {
  @IsInt() @Min(1) @Max(4) tier1PromotionThreshold!: number;
  @IsInt() @Min(0) @Max(100) tier1AuditSampleRate!: number;
}
```

`apps/console-api/src/settings/settings.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@erria/db';
import { LOCKED_POLICY } from '@erria/domain';
import { PRISMA } from '../prisma/prisma.module.js';
import type { SaveBasicSettingsDto } from './dto/save-basic-settings.dto.js';

/** Single-row table (architecture §2) — one business unit, no per-user scoping. */
const SETTINGS_ID = 1;

@Injectable()
export class SettingsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async read() {
    const settings = await this.ensureRow();
    return this.present(settings);
  }

  async saveBasic(dto: SaveBasicSettingsDto) {
    await this.ensureRow();
    const updated = await this.prisma.setting.update({
      where: { id: SETTINGS_ID },
      data: {
        tier1PromotionThreshold: dto.tier1PromotionThreshold,
        tier1AuditSampleRate: dto.tier1AuditSampleRate,
      },
    });
    return this.present(updated);
  }

  /** Defaults live here and in the Prisma schema's @default — spec §11's stated values. */
  private async ensureRow() {
    return this.prisma.setting.upsert({
      where: { id: SETTINGS_ID },
      update: {},
      create: { id: SETTINGS_ID },
    });
  }

  private present(settings: Awaited<ReturnType<SettingsService['ensureRow']>>) {
    return {
      basic: {
        tier1PromotionThreshold: settings.tier1PromotionThreshold,
        tier1AuditSampleRate: settings.tier1AuditSampleRate,
      },
      advanced: {
        maxFollowups: settings.maxFollowups,
        minDaysBetweenFollowups: settings.minDaysBetweenFollowups,
        sentimentConfidenceFloor: settings.sentimentConfidenceFloor,
      },
      locked: LOCKED_POLICY,
    };
  }
}
```

`apps/console-api/src/settings/settings.controller.ts`:

```ts
import { Body, Controller, Get, Put } from '@nestjs/common';
import { SettingsService } from './settings.service.js';
import { SaveBasicSettingsDto } from './dto/save-basic-settings.dto.js';

@Controller('api/settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  async read() {
    return this.settingsService.read();
  }

  @Put('basic')
  async saveBasic(@Body() dto: SaveBasicSettingsDto) {
    return this.settingsService.saveBasic(dto);
  }
}
```

`apps/console-api/src/settings/settings.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';

@Module({ controllers: [SettingsController], providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
```

Add `SettingsModule` to `imports` in `apps/console-api/src/app.module.ts`.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter console-api exec vitest run src/settings/settings.service.integration.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/domain apps/console-api
git commit -m "feat(console-api): read settings with locked policy, save freely-adjustable values"
```

---

### Task 2: Advanced settings — propose, then confirm

**Files:**
- Create: `apps/console-api/src/settings/dto/save-advanced-settings.dto.ts`
- Modify: `apps/console-api/src/settings/settings.service.ts` — add `proposeAdvanced` / `confirmAdvanced`
- Modify: `apps/console-api/src/settings/settings.controller.ts` — add the routes
- Test: `apps/console-api/src/settings/settings.service.integration.spec.ts` — add a describe block

**Interfaces:**
- Consumes: `SettingsService` (Task 1).
- Produces: `PUT /api/settings/advanced` (returns `{ requiresConfirmation, diff }` and changes
  nothing), `POST /api/settings/advanced/confirm` (applies) — consumed by Task 5's UI.

The two-step shape comes from the mockup's `saveAdvanced` → `confirmB` → `confirmAdvanced` flow.
The first call is deliberately a **dry run**: it computes the diff and writes nothing.

- [ ] **Step 1: Write the failing test**

Add to `apps/console-api/src/settings/settings.service.integration.spec.ts`:

```ts
describe('SettingsService advanced (two-step)', () => {
  it('proposing returns a diff and changes nothing', async () => {
    const service = new SettingsService(testDb.prisma);
    await service.read();

    const proposal = await service.proposeAdvanced({
      maxFollowups: 4,
      minDaysBetweenFollowups: 10,
      sentimentConfidenceFloor: 'High',
    });

    expect(proposal.requiresConfirmation).toBe(true);
    expect(proposal.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'maxFollowups', from: 2, to: 4 }),
        expect.objectContaining({ field: 'minDaysBetweenFollowups', from: 5, to: 10 }),
        expect.objectContaining({ field: 'sentimentConfidenceFloor', from: 'Medium', to: 'High' }),
      ]),
    );

    const stored = await testDb.prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
    expect(stored.maxFollowups).toBe(2);
  });

  it('lists only the fields that actually changed', async () => {
    const service = new SettingsService(testDb.prisma);
    await service.read();

    const proposal = await service.proposeAdvanced({
      maxFollowups: 2,
      minDaysBetweenFollowups: 5,
      sentimentConfidenceFloor: 'High',
    });

    expect(proposal.diff).toHaveLength(1);
    expect(proposal.diff[0].field).toBe('sentimentConfidenceFloor');
  });

  it('reports no confirmation needed when nothing changed', async () => {
    const service = new SettingsService(testDb.prisma);
    await service.read();

    const proposal = await service.proposeAdvanced({
      maxFollowups: 2,
      minDaysBetweenFollowups: 5,
      sentimentConfidenceFloor: 'Medium',
    });

    expect(proposal.requiresConfirmation).toBe(false);
    expect(proposal.diff).toHaveLength(0);
  });

  it('confirming applies the values', async () => {
    const service = new SettingsService(testDb.prisma);
    await service.read();

    const result = await service.confirmAdvanced({
      maxFollowups: 3,
      minDaysBetweenFollowups: 7,
      sentimentConfidenceFloor: 'Low',
    });

    expect(result.advanced.maxFollowups).toBe(3);

    const stored = await testDb.prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
    expect(stored.maxFollowups).toBe(3);
    expect(stored.minDaysBetweenFollowups).toBe(7);
    expect(stored.sentimentConfidenceFloor).toBe('Low');
  });

  it('does not touch the freely-adjustable values when confirming advanced ones', async () => {
    const service = new SettingsService(testDb.prisma);
    await service.saveBasic({ tier1PromotionThreshold: 4, tier1AuditSampleRate: 30 });

    await service.confirmAdvanced({
      maxFollowups: 5,
      minDaysBetweenFollowups: 14,
      sentimentConfidenceFloor: 'High',
    });

    const stored = await testDb.prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
    expect(stored.tier1PromotionThreshold).toBe(4);
    expect(stored.tier1AuditSampleRate).toBe(30);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter console-api exec vitest run src/settings/settings.service.integration.spec.ts`
Expected: FAIL — `proposeAdvanced` is not a function.

- [ ] **Step 3: Implement**

`apps/console-api/src/settings/dto/save-advanced-settings.dto.ts`:

```ts
import { IsIn, IsInt, Max, Min } from 'class-validator';

export class SaveAdvancedSettingsDto {
  @IsInt() @Min(1) @Max(5) maxFollowups!: number;
  @IsInt() @Min(3) @Max(14) minDaysBetweenFollowups!: number;
  @IsIn(['Low', 'Medium', 'High']) sentimentConfidenceFloor!: 'Low' | 'Medium' | 'High';
}
```

Add to `SettingsService`:

```ts
  /**
   * Dry run by design: computes what would change and writes nothing. The write happens only in
   * confirmAdvanced, after a human has seen this diff — a confirmation step that does not say what
   * is changing is a speed bump, not a safeguard.
   */
  async proposeAdvanced(dto: SaveAdvancedSettingsDto) {
    const current = await this.ensureRow();

    const diff = [
      { field: 'maxFollowups' as const, from: current.maxFollowups, to: dto.maxFollowups },
      {
        field: 'minDaysBetweenFollowups' as const,
        from: current.minDaysBetweenFollowups,
        to: dto.minDaysBetweenFollowups,
      },
      {
        field: 'sentimentConfidenceFloor' as const,
        from: current.sentimentConfidenceFloor,
        to: dto.sentimentConfidenceFloor,
      },
    ].filter((entry) => entry.from !== entry.to);

    return {
      requiresConfirmation: diff.length > 0,
      diff,
      // Spec §11: the confirmation copy must say a change is not retroactive.
      notice: 'These changes apply to outreach going forward. Messages already sent are unaffected.',
    };
  }

  async confirmAdvanced(dto: SaveAdvancedSettingsDto) {
    await this.ensureRow();
    const updated = await this.prisma.setting.update({
      where: { id: SETTINGS_ID },
      data: {
        maxFollowups: dto.maxFollowups,
        minDaysBetweenFollowups: dto.minDaysBetweenFollowups,
        sentimentConfidenceFloor: dto.sentimentConfidenceFloor,
      },
    });
    return this.present(updated);
  }
```

Add to `SettingsController`:

```ts
  @Put('advanced')
  async proposeAdvanced(@Body() dto: SaveAdvancedSettingsDto) {
    return this.settingsService.proposeAdvanced(dto);
  }

  @Post('advanced/confirm')
  async confirmAdvanced(@Body() dto: SaveAdvancedSettingsDto) {
    return this.settingsService.confirmAdvanced(dto);
  }
```

(`Post` added to the `@nestjs/common` import.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter console-api exec vitest run src/settings/settings.service.integration.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/console-api
git commit -m "feat(console-api): two-step confirm for customer-facing settings"
```

---

### Task 3: Audit samples — list and mark

**Files:**
- Create: `apps/console-api/src/audit/dto/mark-audit-sample.dto.ts`
- Create: `apps/console-api/src/audit/audit.service.ts`
- Create: `apps/console-api/src/audit/audit.controller.ts`
- Create: `apps/console-api/src/audit/audit.module.ts`
- Modify: `apps/console-api/src/app.module.ts` — import `AuditModule`
- Test: `apps/console-api/src/audit/audit.service.integration.spec.ts`

**Interfaces:**
- Consumes: `PRISMA`.
- Produces: `GET /api/audit-samples?status=&page=`, `POST /api/audit-samples/:id/mark` —
  consumed by Task 6's UI.

**Read the Global Constraints note first:** nothing creates `AuditSample` rows yet. These tests seed
them directly, which is the only way to exercise this surface until autonomous send exists.

- [ ] **Step 1: Write the failing test**

`apps/console-api/src/audit/audit.service.integration.spec.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db';
import { AuditService } from './audit.service.js';

describe('AuditService', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  /**
   * Seeded directly: sampling fires only on Tier 1 autonomous sends, which do not exist yet
   * (ADR-0002/ADR-0005). This is the documented gap, not a shortcut.
   */
  async function seedAuditSample(reviewStatus: 'unreviewed' | 'fine' | 'concerning' = 'unreviewed') {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: `Audited Co ${Math.random().toString(36).slice(2, 8)}`,
        segment: 'Coastal freight',
        hub: 'Haiphong',
        icpScore: 85,
        icpBand: 'high',
        relationshipSummary: 'Long clean history',
        currentTier: 2,
        tierRationale: 'test',
      },
    });
    const message = await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'agent_sent',
        body: 'Autonomously sent copy under review.',
        status: 'sent',
        tierContext: 1,
        sentAt: new Date(),
      },
    });
    const sample = await testDb.prisma.auditSample.create({
      data: { messageId: message.id, accountId: account.id, reviewStatus },
    });
    return { account, message, sample };
  }

  it('lists unreviewed samples with their message body', async () => {
    const { sample } = await seedAuditSample('unreviewed');
    const service = new AuditService(testDb.prisma);

    const result = await service.list({ status: 'unreviewed', page: 1 });

    const found = result.items.find((item) => item.id === sample.id);
    expect(found).toBeDefined();
    expect(found?.body).toContain('Autonomously sent copy');
    expect(found?.reviewStatus).toBe('unreviewed');
  });

  it('filters by review status', async () => {
    await seedAuditSample('fine');
    const service = new AuditService(testDb.prisma);

    const result = await service.list({ status: 'fine', page: 1 });

    expect(result.items.every((item) => item.reviewStatus === 'fine')).toBe(true);
  });

  it('marks a sample concerning without changing the account tier (spec §10)', async () => {
    const { account, sample } = await seedAuditSample();
    const service = new AuditService(testDb.prisma);

    const result = await service.mark(sample.id, 'concerning');

    expect(result.auditSample.reviewStatus).toBe('concerning');
    expect(result.auditSample.reviewedAt).not.toBeNull();

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.currentTier).toBe(2);

    const events = await testDb.prisma.tierHistoryEvent.findMany({ where: { accountId: account.id } });
    expect(events).toHaveLength(0);
  });

  it('keeps a concerning sample in the list for pattern-spotting', async () => {
    const { sample } = await seedAuditSample();
    const service = new AuditService(testDb.prisma);
    await service.mark(sample.id, 'concerning');

    const result = await service.list({ status: 'concerning', page: 1 });

    expect(result.items.some((item) => item.id === sample.id)).toBe(true);
  });

  it('allows a verdict to be corrected', async () => {
    const { sample } = await seedAuditSample();
    const service = new AuditService(testDb.prisma);

    await service.mark(sample.id, 'concerning');
    const corrected = await service.mark(sample.id, 'fine');

    expect(corrected.auditSample.reviewStatus).toBe('fine');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter console-api exec vitest run src/audit/audit.service.integration.spec.ts`
Expected: FAIL — `./audit.service.js` does not exist.

- [ ] **Step 3: Implement**

`apps/console-api/src/audit/dto/mark-audit-sample.dto.ts`:

```ts
import { IsIn } from 'class-validator';

export class MarkAuditSampleDto {
  @IsIn(['fine', 'concerning']) verdict!: 'fine' | 'concerning';
}
```

`apps/console-api/src/audit/audit.service.ts`:

```ts
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@erria/db';
import { PRISMA } from '../prisma/prisma.module.js';

const PAGE_SIZE = 20;
const REVIEWED_BY = 'Minh Tran'; // One operator until OIDC is wired — see MessagesController.

@Injectable()
export class AuditService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(params: { status?: 'unreviewed' | 'fine' | 'concerning'; page: number }) {
    const where = params.status ? { reviewStatus: params.status } : {};

    const [samples, total] = await Promise.all([
      this.prisma.auditSample.findMany({
        where,
        include: { account: true, message: true },
        orderBy: { sampledAt: 'desc' },
        skip: (params.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this.prisma.auditSample.count({ where }),
    ]);

    return {
      items: samples.map((sample) => ({
        id: sample.id,
        accountId: sample.accountId,
        company: sample.account.companyName,
        body: sample.message.body,
        sentAt: sample.message.sentAt?.toISOString() ?? null,
        sampledAt: sample.sampledAt.toISOString(),
        reviewStatus: sample.reviewStatus,
        reviewedBy: sample.reviewedBy,
      })),
      total,
      page: params.page,
      pageSize: PAGE_SIZE,
    };
  }

  /**
   * Spec §10: a concerning flag records a pattern; it never demotes the account on its own. Only a
   * real negative signal changes tier, and that path runs through Escalation (Plan 3).
   */
  async mark(auditSampleId: string, verdict: 'fine' | 'concerning') {
    const sample = await this.prisma.auditSample.findUnique({ where: { id: auditSampleId } });
    if (!sample) {
      throw new NotFoundException(`Audit sample ${auditSampleId} not found`);
    }

    const updated = await this.prisma.auditSample.update({
      where: { id: auditSampleId },
      data: { reviewStatus: verdict, reviewedBy: REVIEWED_BY, reviewedAt: new Date() },
    });

    return {
      auditSample: {
        id: updated.id,
        reviewStatus: updated.reviewStatus,
        reviewedBy: updated.reviewedBy,
        reviewedAt: updated.reviewedAt,
      },
    };
  }
}
```

`apps/console-api/src/audit/audit.controller.ts`:

```ts
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { MarkAuditSampleDto } from './dto/mark-audit-sample.dto.js';

@Controller('api/audit-samples')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  async list(
    @Query('status') status?: 'unreviewed' | 'fine' | 'concerning',
    @Query('page') page?: string,
  ) {
    return this.auditService.list({ status, page: page ? Number(page) : 1 });
  }

  @Post(':id/mark')
  async mark(@Param('id') id: string, @Body() dto: MarkAuditSampleDto) {
    return this.auditService.mark(id, dto.verdict);
  }
}
```

`apps/console-api/src/audit/audit.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';

@Module({ controllers: [AuditController], providers: [AuditService] })
export class AuditModule {}
```

Add `AuditModule` to `imports` in `apps/console-api/src/app.module.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter console-api exec vitest run src/audit/audit.service.integration.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/console-api
git commit -m "feat(console-api): list and mark Tier 1 audit samples"
```

---

### Task 4: Tier history endpoint

**Files:**
- Modify: `apps/console-api/src/accounts/accounts.service.ts` — add `tierHistory`
- Modify: `apps/console-api/src/accounts/accounts.controller.ts` — add the route
- Test: `apps/console-api/src/accounts/accounts.service.integration.spec.ts` — add a describe block

**Interfaces:**
- Consumes: `AccountsService` (Plan 1 Task 11, extended in Plan 3 Task 8).
- Produces: `GET /api/accounts/:id/tier-history` — consumed by Task 7's UI.

- [ ] **Step 1: Write the failing test**

Add to `apps/console-api/src/accounts/accounts.service.integration.spec.ts`:

```ts
describe('AccountsService.tierHistory', () => {
  it('returns events newest first, flagging which were human overrides', async () => {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'History Co',
        segment: 'Coastal freight',
        hub: 'Haiphong',
        icpScore: 60,
        icpBand: 'med',
        relationshipSummary: 'test',
        currentTier: 2,
        tierRationale: 'test',
      },
    });

    await testDb.prisma.tierHistoryEvent.create({
      data: {
        accountId: account.id,
        eventType: 'create',
        toTier: 2,
        reason: 'Account created',
        occurredAt: new Date('2026-07-01T00:00:00Z'),
      },
    });
    await testDb.prisma.tierHistoryEvent.create({
      data: {
        accountId: account.id,
        eventType: 'manual_override',
        fromTier: 3,
        toTier: 2,
        reason: 'Pricing question resolved',
        occurredAt: new Date('2026-08-01T00:00:00Z'),
      },
    });

    const service = new AccountsService(testDb.prisma);
    const result = await service.tierHistory(account.id);

    expect(result.items).toHaveLength(2);
    expect(result.items[0].eventType).toBe('manual_override');
    expect(result.items[0].isManual).toBe(true);
    expect(result.items[1].eventType).toBe('create');
    expect(result.items[1].isManual).toBe(false);
  });

  it('returns an empty list for an account with no events', async () => {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Fresh Co',
        segment: 'x',
        hub: 'y',
        icpScore: 10,
        icpBand: 'low',
        relationshipSummary: 'x',
        currentTier: 2,
        tierRationale: 'x',
      },
    });

    const service = new AccountsService(testDb.prisma);
    const result = await service.tierHistory(account.id);

    expect(result.items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter console-api exec vitest run src/accounts/accounts.service.integration.spec.ts`
Expected: FAIL — `tierHistory` is not a function.

- [ ] **Step 3: Implement**

Add to `AccountsService`:

```ts
  async tierHistory(accountId: string) {
    const events = await this.prisma.tierHistoryEvent.findMany({
      where: { accountId },
      orderBy: { occurredAt: 'desc' },
    });

    return {
      items: events.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        fromTier: event.fromTier,
        toTier: event.toTier,
        reason: event.reason,
        occurredAt: event.occurredAt.toISOString(),
        // The mockup tags human overrides distinctly so a reviewer scanning the timeline can tell
        // system-driven from human-driven at a glance.
        isManual: event.eventType === 'manual_override',
      })),
    };
  }
```

Add to `AccountsController`:

```ts
  @Get(':id/tier-history')
  async tierHistory(@Param('id') id: string) {
    return this.accountsService.tierHistory(id);
  }
```

Register this route **before** the existing `@Get(':id')` handler if your Nest version resolves in
declaration order, so `/tier-history` is not swallowed as an account id.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter console-api exec vitest run src/accounts`
Expected: PASS — 2 new tests plus everything from Plans 1 and 3.

- [ ] **Step 5: Commit**

```bash
git add apps/console-api
git commit -m "feat(console-api): expose per-account tier history"
```

---

### Task 5: Settings UI

**Files:**
- Modify: `apps/console-web/src/api.ts` — add settings calls
- Create: `apps/console-web/src/SettingsPage.tsx`
- Modify: `apps/console-web/src/App.tsx` — add navigation to Settings
- Test: `apps/console-web/src/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: `GET /api/settings`, `PUT /api/settings/basic`, `PUT /api/settings/advanced`,
  `POST /api/settings/advanced/confirm` (Tasks 1-2).
- Produces: the Settings screen.

The screen must make the three risk classes visually distinct: basic saves on click, advanced shows
an inline confirm strip listing the diff plus the not-retroactive notice, and locked renders as
read-only reference with no controls at all.

- [ ] **Step 1: Add the API calls**

Append to `apps/console-web/src/api.ts`:

```ts
export interface SettingsPayload {
  basic: { tier1PromotionThreshold: number; tier1AuditSampleRate: number };
  advanced: {
    maxFollowups: number;
    minDaysBetweenFollowups: number;
    sentimentConfidenceFloor: 'Low' | 'Medium' | 'High';
  };
  locked: {
    hardTriggerRules: { key: string; label: string; description: string }[];
    rolloutOverlayEnabled: boolean;
    rolloutOverlayDescription: string;
  };
}

export interface AdvancedProposal {
  requiresConfirmation: boolean;
  diff: { field: string; from: string | number; to: string | number }[];
  notice: string;
}

export const settingsApi = {
  read: () => fetch('/api/settings').then(json<SettingsPayload>),

  saveBasic: (basic: SettingsPayload['basic']) =>
    fetch('/api/settings/basic', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(basic),
    }).then(json<SettingsPayload>),

  proposeAdvanced: (advanced: SettingsPayload['advanced']) =>
    fetch('/api/settings/advanced', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(advanced),
    }).then(json<AdvancedProposal>),

  confirmAdvanced: (advanced: SettingsPayload['advanced']) =>
    fetch('/api/settings/advanced/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(advanced),
    }).then(json<SettingsPayload>),
};
```

- [ ] **Step 2: Write the failing test**

`apps/console-web/src/SettingsPage.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsPage } from './SettingsPage.js';

const settings = {
  basic: { tier1PromotionThreshold: 2, tier1AuditSampleRate: 10 },
  advanced: { maxFollowups: 2, minDaysBetweenFollowups: 5, sentimentConfidenceFloor: 'Medium' },
  locked: {
    hardTriggerRules: [
      { key: 'pricing_question', label: 'Pricing or commercial terms', description: 'No authority to quote.' },
    ],
    rolloutOverlayEnabled: true,
    rolloutOverlayDescription: 'Every new account starts at Tier 2 minimum.',
  },
};

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/advanced') && init?.method === 'PUT') {
          return {
            ok: true,
            json: async () => ({
              requiresConfirmation: true,
              diff: [{ field: 'maxFollowups', from: 2, to: 4 }],
              notice: 'These changes apply to outreach going forward.',
            }),
          };
        }
        return { ok: true, json: async () => settings };
      }),
    );
  });

  it('renders locked policy as read-only reference with no controls', async () => {
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByText(/pricing or commercial terms/i)).toBeInTheDocument());
    const lockedSection = screen.getByTestId('locked-settings');
    expect(lockedSection.querySelectorAll('input, select, button')).toHaveLength(0);
  });

  it('saves freely-adjustable values without a confirmation step', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText(/promotion threshold/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/api/settings/basic', expect.objectContaining({ method: 'PUT' })),
    );
    expect(screen.queryByText(/applies to outreach going forward/i)).not.toBeInTheDocument();
  });

  it('shows the diff and the not-retroactive notice before applying advanced changes', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText(/max follow-ups/i)).toBeInTheDocument());

    await userEvent.clear(screen.getByLabelText(/max follow-ups/i));
    await userEvent.type(screen.getByLabelText(/max follow-ups/i), '4');
    await userEvent.click(screen.getByRole('button', { name: /save \(requires confirm\)/i }));

    await waitFor(() => expect(screen.getByText(/maxFollowups/i)).toBeInTheDocument());
    expect(screen.getByText(/2 → 4/)).toBeInTheDocument();
    expect(screen.getByText(/applies to outreach going forward/i)).toBeInTheDocument();
    // Nothing is applied until Confirm is clicked.
    expect(fetch).not.toHaveBeenCalledWith(
      '/api/settings/advanced/confirm',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('applies advanced changes only after confirming', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText(/max follow-ups/i)).toBeInTheDocument());

    await userEvent.clear(screen.getByLabelText(/max follow-ups/i));
    await userEvent.type(screen.getByLabelText(/max follow-ups/i), '4');
    await userEvent.click(screen.getByRole('button', { name: /save \(requires confirm\)/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /confirm/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/settings/advanced/confirm',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter console-web exec vitest run src/SettingsPage.test.tsx`
Expected: FAIL — `./SettingsPage.js` does not exist.

- [ ] **Step 4: Implement**

`apps/console-web/src/SettingsPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { settingsApi, type AdvancedProposal, type SettingsPayload } from './api.js';

export function SettingsPage() {
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [basic, setBasic] = useState<SettingsPayload['basic'] | null>(null);
  const [advanced, setAdvanced] = useState<SettingsPayload['advanced'] | null>(null);
  const [proposal, setProposal] = useState<AdvancedProposal | null>(null);

  useEffect(() => {
    settingsApi.read().then((data) => {
      setSettings(data);
      setBasic(data.basic);
      setAdvanced(data.advanced);
    });
  }, []);

  if (!settings || !basic || !advanced) return <p>Loading settings…</p>;

  return (
    <div className="settings">
      <section>
        <h2>Freely adjustable</h2>
        <p className="divider-note">Saved immediately. These tune the system without changing what a buyer sees.</p>

        <label>
          Promotion threshold (clean approvals)
          <input
            type="number"
            value={basic.tier1PromotionThreshold}
            onChange={(event) =>
              setBasic({ ...basic, tier1PromotionThreshold: Number(event.target.value) })
            }
          />
        </label>

        <label>
          Audit sample rate (%)
          <input
            type="number"
            value={basic.tier1AuditSampleRate}
            onChange={(event) => setBasic({ ...basic, tier1AuditSampleRate: Number(event.target.value) })}
          />
        </label>

        <button onClick={() => settingsApi.saveBasic(basic).then(setSettings)}>Save</button>
      </section>

      <section>
        <h2>Requires confirmation</h2>
        <p className="divider-note">These change what buyers receive, so they take an explicit second step.</p>

        <label>
          Max follow-ups
          <input
            type="number"
            value={advanced.maxFollowups}
            onChange={(event) => setAdvanced({ ...advanced, maxFollowups: Number(event.target.value) })}
          />
        </label>

        <label>
          Minimum days between follow-ups
          <input
            type="number"
            value={advanced.minDaysBetweenFollowups}
            onChange={(event) =>
              setAdvanced({ ...advanced, minDaysBetweenFollowups: Number(event.target.value) })
            }
          />
        </label>

        <label>
          Negative-sentiment confidence floor
          <select
            value={advanced.sentimentConfidenceFloor}
            onChange={(event) =>
              setAdvanced({
                ...advanced,
                sentimentConfidenceFloor: event.target.value as 'Low' | 'Medium' | 'High',
              })
            }
          >
            <option value="Low">Low</option>
            <option value="Medium">Medium</option>
            <option value="High">High</option>
          </select>
        </label>

        <button onClick={() => settingsApi.proposeAdvanced(advanced).then(setProposal)}>
          Save (requires confirm)
        </button>

        {proposal?.requiresConfirmation && (
          <div className="confirm-strip">
            <ul>
              {proposal.diff.map((entry) => (
                <li key={entry.field}>
                  {entry.field}: {entry.from} → {entry.to}
                </li>
              ))}
            </ul>
            <p>{proposal.notice}</p>
            <button
              onClick={() =>
                settingsApi.confirmAdvanced(advanced).then((data) => {
                  setSettings(data);
                  setProposal(null);
                })
              }
            >
              Confirm
            </button>
            <button onClick={() => setProposal(null)}>Cancel</button>
          </div>
        )}
      </section>

      <section data-testid="locked-settings">
        <h2>Locked — engineer-only</h2>
        <p className="divider-note">
          Policy decisions with real commercial and reputational consequences, shown here for
          reference. Changing one is a code change and a deliberate decision, not a setting.
        </p>
        <ul>
          {settings.locked.hardTriggerRules.map((rule) => (
            <li key={rule.key}>
              <b>{rule.label}</b> — {rule.description}
            </li>
          ))}
        </ul>
        <p>{settings.locked.rolloutOverlayDescription}</p>
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter console-web exec vitest run src/SettingsPage.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/console-web
git commit -m "feat(console-web): settings screen with risk-split controls"
```

---

### Task 6: Send Audit UI

**Files:**
- Modify: `apps/console-web/src/api.ts` — add audit calls
- Create: `apps/console-web/src/SendAuditPage.tsx`
- Modify: `apps/console-web/src/App.tsx` — add navigation
- Test: `apps/console-web/src/SendAuditPage.test.tsx`

**Interfaces:**
- Consumes: `GET /api/audit-samples`, `POST /api/audit-samples/:id/mark` (Task 3).
- Produces: the Send Audit screen.

- [ ] **Step 1: Add the API calls**

Append to `apps/console-web/src/api.ts`:

```ts
export interface AuditSampleRow {
  id: string;
  accountId: string;
  company: string;
  body: string;
  sentAt: string | null;
  sampledAt: string;
  reviewStatus: 'unreviewed' | 'fine' | 'concerning';
  reviewedBy: string | null;
}

export const auditApi = {
  list: (status: 'unreviewed' | 'fine' | 'concerning' = 'unreviewed') =>
    fetch(`/api/audit-samples?status=${status}`).then(
      json<{ items: AuditSampleRow[]; total: number; page: number; pageSize: number }>,
    ),

  mark: (id: string, verdict: 'fine' | 'concerning') =>
    fetch(`/api/audit-samples/${id}/mark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict }),
    }).then(json<{ auditSample: { id: string; reviewStatus: string } }>),
};
```

- [ ] **Step 2: Write the failing test**

`apps/console-web/src/SendAuditPage.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SendAuditPage } from './SendAuditPage.js';

const sample = {
  id: 'aud_1',
  accountId: 'acc_1',
  company: 'Audited Co',
  body: 'Autonomously sent copy under review.',
  sentAt: '2026-08-01T00:00:00.000Z',
  sampledAt: '2026-08-01T00:00:00.000Z',
  reviewStatus: 'unreviewed' as const,
  reviewedBy: null,
};

describe('SendAuditPage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return { ok: true, json: async () => ({ auditSample: { id: 'aud_1', reviewStatus: 'concerning' } }) };
        }
        return { ok: true, json: async () => ({ items: [sample], total: 1, page: 1, pageSize: 20 }) };
      }),
    );
  });

  it('renders a sampled send with its copy', async () => {
    render(<SendAuditPage />);

    await waitFor(() => expect(screen.getByText('Audited Co')).toBeInTheDocument());
    expect(screen.getByText(/autonomously sent copy/i)).toBeInTheDocument();
  });

  it('states that review is retrospective and does not gate sending', async () => {
    render(<SendAuditPage />);

    await waitFor(() => expect(screen.getByText(/already been sent/i)).toBeInTheDocument());
  });

  it('marks a sample concerning', async () => {
    render(<SendAuditPage />);
    await waitFor(() => expect(screen.getByText('Audited Co')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /concerning/i }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/audit-samples/aud_1/mark',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('explains the empty state rather than looking broken', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }),
      }),
    );

    render(<SendAuditPage />);

    await waitFor(() => expect(screen.getByText(/no sampled sends yet/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter console-web exec vitest run src/SendAuditPage.test.tsx`
Expected: FAIL — `./SendAuditPage.js` does not exist.

- [ ] **Step 4: Implement**

`apps/console-web/src/SendAuditPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { auditApi, type AuditSampleRow } from './api.js';

type StatusFilter = 'unreviewed' | 'fine' | 'concerning';

export function SendAuditPage() {
  const [status, setStatus] = useState<StatusFilter>('unreviewed');
  const [rows, setRows] = useState<AuditSampleRow[] | null>(null);

  useEffect(() => {
    auditApi.list(status).then((data) => setRows(data.items));
  }, [status]);

  async function mark(id: string, verdict: 'fine' | 'concerning') {
    await auditApi.mark(id, verdict);
    const refreshed = await auditApi.list(status);
    setRows(refreshed.items);
  }

  if (!rows) return <p>Loading sampled sends…</p>;

  return (
    <div className="send-audit">
      <p className="divider-note">
        A sample of autonomous sends, logged for retrospective spot-checking. These have already been
        sent — reviewing them catches tone drift across many messages, and never gates an individual
        send. Marking one concerning records a pattern; it does not change the account&apos;s tier.
      </p>

      <div className="audit-filters">
        {(['unreviewed', 'fine', 'concerning'] as StatusFilter[]).map((option) => (
          <button
            key={option}
            className={status === option ? 'sel' : ''}
            onClick={() => setStatus(option)}
          >
            {option}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <p>
          No sampled sends yet. Sampling starts once accounts are sending autonomously — until then
          this queue stays empty.
        </p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.id}>
              <b>{row.company}</b>
              <p className="draft-body">{row.body}</p>
              <button onClick={() => mark(row.id, 'fine')}>Fine</button>
              <button onClick={() => mark(row.id, 'concerning')}>Concerning</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter console-web exec vitest run src/SendAuditPage.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/console-web
git commit -m "feat(console-web): send audit review queue"
```

---

### Task 7: Tier History tab

**Files:**
- Modify: `apps/console-web/src/api.ts` — add the tier-history call
- Create: `apps/console-web/src/TierHistoryTab.tsx`
- Modify: `apps/console-web/src/AccountDetailPage.tsx` — render it
- Test: `apps/console-web/src/TierHistoryTab.test.tsx`

**Interfaces:**
- Consumes: `GET /api/accounts/:id/tier-history` (Task 4).
- Produces: the Tier History timeline — the last screen, closing out all four plans.

- [ ] **Step 1: Add the API call**

Append to `apps/console-web/src/api.ts`:

```ts
export interface TierHistoryItem {
  id: string;
  eventType: string;
  fromTier: number | null;
  toTier: number | null;
  reason: string;
  occurredAt: string;
  isManual: boolean;
}

export const tierHistoryApi = {
  list: (accountId: string) =>
    fetch(`/api/accounts/${accountId}/tier-history`).then(json<{ items: TierHistoryItem[] }>),
};
```

- [ ] **Step 2: Write the failing test**

`apps/console-web/src/TierHistoryTab.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TierHistoryTab } from './TierHistoryTab.js';

const items = [
  {
    id: 'ev_2',
    eventType: 'manual_override',
    fromTier: 3,
    toTier: 2,
    reason: 'Tier 3 → Tier 2. "Pricing question resolved" — manual override.',
    occurredAt: '2026-08-01T00:00:00.000Z',
    isManual: true,
  },
  {
    id: 'ev_1',
    eventType: 'escalate',
    fromTier: 2,
    toTier: 3,
    reason: 'Buyer asked about pricing or commercial terms',
    occurredAt: '2026-07-20T00:00:00.000Z',
    isManual: false,
  },
];

describe('TierHistoryTab', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items }) }));
  });

  it('renders every event newest first', async () => {
    render(<TierHistoryTab accountId="acc_1" />);

    await waitFor(() => expect(screen.getByText(/pricing question resolved/i)).toBeInTheDocument());
    expect(screen.getByText(/buyer asked about pricing/i)).toBeInTheDocument();
  });

  it('tags human overrides distinctly from system-driven entries', async () => {
    render(<TierHistoryTab accountId="acc_1" />);

    await waitFor(() => expect(screen.getByText('Manual')).toBeInTheDocument());
    expect(screen.getAllByText('Manual')).toHaveLength(1);
  });

  it('explains the empty state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) }));

    render(<TierHistoryTab accountId="acc_1" />);

    await waitFor(() => expect(screen.getByText(/no tier changes recorded/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter console-web exec vitest run src/TierHistoryTab.test.tsx`
Expected: FAIL — `./TierHistoryTab.js` does not exist.

- [ ] **Step 4: Implement**

`apps/console-web/src/TierHistoryTab.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { tierHistoryApi, type TierHistoryItem } from './api.js';

export function TierHistoryTab({ accountId }: { accountId: string }) {
  const [items, setItems] = useState<TierHistoryItem[] | null>(null);

  useEffect(() => {
    tierHistoryApi.list(accountId).then((data) => setItems(data.items));
  }, [accountId]);

  if (!items) return <p>Loading history…</p>;

  if (items.length === 0) {
    return <p>No tier changes recorded for this account yet.</p>;
  }

  return (
    <div className="tier-history">
      <p className="divider-note">
        Every tier is earned or justified — this log shows why this account sits where it does.
        <b> Manual</b>-tagged entries are human overrides; the rest are system-driven.
      </p>
      <ul>
        {items.map((item) => (
          <li key={item.id} className={item.isManual ? 'tl-item manual' : 'tl-item'}>
            <div className="tl-title">
              <span className="tt">{labelFor(item)}</span>
              {item.isManual && <span className="tl-manual">Manual</span>}
              {item.toTier !== null && <span className={`badge t${item.toTier}`}>Tier {item.toTier}</span>}
            </div>
            <p>{item.reason}</p>
            <time dateTime={item.occurredAt}>{new Date(item.occurredAt).toLocaleString()}</time>
          </li>
        ))}
      </ul>
    </div>
  );
}

function labelFor(item: TierHistoryItem): string {
  switch (item.eventType) {
    case 'create':
      return 'Account created';
    case 'clean_approval':
      return 'Clean approval';
    case 'promote':
      return 'Promoted';
    case 'demote':
      return 'Demoted';
    case 'escalate':
      return 'Escalated';
    case 'hold_at_tier':
      return 'Held at tier';
    case 'current_draft':
      return 'Current draft capped';
    case 'manual_override':
      return `Manually changed to Tier ${item.toTier}`;
    default:
      return item.eventType;
  }
}
```

- [ ] **Step 5: Run the whole frontend suite to verify it passes**

Run: `pnpm --filter console-web exec vitest run`
Expected: PASS — 3 new tests plus every page test from Plans 1-3 and Tasks 5-6.

- [ ] **Step 6: Verify the whole console manually**

With all three processes running, walk the full path: POST a trigger → see it in the queue → open
the account → approve it → POST an inbound pricing reply → see the escalation and Tier 3 → resolve
it with an outcome → use Change tier to move it back to Tier 2 → open Tier History and confirm the
manual entry is tagged and the automatic ones are not → open Settings and confirm basic saves
immediately while advanced shows a diff before applying.

- [ ] **Step 7: Commit**

```bash
git add apps/console-web
git commit -m "feat(console-web): tier history timeline with manual-override tagging"
```

---

## Self-Review Notes (from writing this plan)

- **Spec coverage:** §10's sampling mechanic → Task 3 (review side) with creation deliberately
  absent, see below; §10's "concerning does not demote" → Task 3's third test; §11's three risk
  classes → Tasks 1, 2, and 5; §11's "applies going forward, not retroactively" → Task 2's `notice`
  and Task 5's test; §12's deferred change log → deliberately not built, stated in Global
  Constraints.
- **The Send Audit screen has no live data source, and this plan does not pretend otherwise.**
  Sampling fires only on Tier 1 autonomous sends (ADR-0002/ADR-0005), so Task 3 tests against
  seeded rows and Task 6's empty state says so in plain language to the user rather than rendering
  a blank panel. **This is the strongest argument in the four plans for designing autonomous send
  next** — it is now the only thing gating a screen that is otherwise complete.
- **Locked settings are constants, not rows** — following architecture §2 exactly. Task 5's first
  test asserts the locked section contains zero interactive elements, so a future well-meaning
  change that adds an input there fails a test rather than quietly shipping.
- **No settings change log, deliberately.** Spec §12 cut it together with access control. Task 1's
  `present()` returns no `changedBy`, and no task adds one.
- **Type consistency check:** `SettingsPayload.advanced.sentimentConfidenceFloor` matches Plan 3's
  `DecisionSettings.sentimentConfidenceFloor` (`'Low' | 'Medium' | 'High'`) and the Prisma
  `SentimentFloor` enum. `AuditSampleRow.reviewStatus` matches the Prisma `AuditReviewStatus` enum.
  `TierHistoryItem.eventType` is the full Prisma `TierHistoryEventType` enum, and `labelFor` handles
  all eight values.
- **Route-ordering hazard flagged, not left to chance:** Task 4 adds `GET /api/accounts/:id/tier-history`
  alongside Plan 1's `GET /api/accounts/:id`, and names the ordering requirement in its step rather
  than letting a subtle 404 surface later.
- **`REVIEWED_BY` remains hardcoded** to one operator, consistent with Plans 2-3, until OIDC is
  wired (architecture §0 non-goal).
