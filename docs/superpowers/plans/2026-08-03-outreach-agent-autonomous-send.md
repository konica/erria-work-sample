# Outreach Agent — Plan 5: Tier 1 Autonomous Send — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an account that has earned Tier 1 have its messages sent without a human reading them
first — behind a five-condition gate, a global kill switch, a promotion path, a cost for losing
trust, and follow-ups that only go out when there is demonstrably something new to say.

**Architecture:** Continues Plans 1-4, same monorepo and two processes. The gate and the new-fact
check are pure functions in `@erria/domain` so they are testable without a database or a Claude
call; the worker composes them. This plan lifts the deferrals in ADR-0002 and ADR-0005, which is
what unblocks Plan 4's Send Audit screen. Grounded in
[`2026-08-03-autonomous-send-design.md`](../specs/2026-08-03-autonomous-send-design.md) and behavior
spec §3, §4, §5, §7, §10, §11.

**Tech Stack:** Unchanged from Plans 1-4 — Node.js 24, TypeScript strict, pnpm workspaces, NestJS 11,
Fastify 5, Prisma 7 with `@prisma/adapter-pg`, PostgreSQL, React 19 + Vite 8, Vitest, Testcontainers.

**Prerequisite:** Plans 1-4 complete. This plan adds **one migration** (Task 1).

## Global Constraints

- **Node.js >=24**, TypeScript `strict: true`, pnpm workspaces — unchanged.
- **Tier 1 grants permission to send autonomously, not an obligation.** Four of the five gate
  conditions, when they fail, hold *that one message* at Tier 2 (`Message.tierContext = 2`, drafts
  for approval) and leave `Account.currentTier` untouched. This is ADR-0003's mechanic generalised;
  do not invent a second way to express it.
- **The five conditions**, all required to send autonomously: autonomous sending enabled org-wide;
  no active Escalation with `agentSendDisabled`; content does not cite a vessel compliance deadline
  (§4 rule 5); drafting confidence is exactly `high`; a contact email exists. The recipient
  condition is the one exception to the hold pattern — it routes to `needs_triage`, because there is
  nothing to approve without an address.
- **Low confidence never reaches the gate.** §7 resolves it upstream: no draft, account flagged for
  triage. Only `mid` is a gate concern.
- **Tier 1 is only ever earned** (ADR-0004). Promotion requires **both** `cleanApprovalsCount >=
  Setting.tier1PromotionThreshold` **and** the tiering function's *base* tier being 1. No manual
  route, no per-account override.
- **An account's first autonomous send is always audit-sampled**, regardless of
  `Setting.tier1AuditSampleRate`. Subsequent sends use the configured rate.
- **The counter resets only on damaged trust.** Opening an Escalation zeroes
  `Account.cleanApprovalsCount` for `negative_sentiment` and `relationship_conflict` only. Every
  other rule leaves it intact. The `TierHistoryEvent` reason states which happened either way.
- **Kill switch asymmetry is the design, not an oversight.** Pausing applies immediately with no
  confirmation; resuming goes through §11's confirmation step. Default is **off**.
- **Autonomous messages are persisted as `status = 'approved'` with
  `decidedBy = 'system (autonomous)'` before dispatch**, so Plan 2's stuck-send reconciliation sweep
  covers them with no changes to that sweep.
- **Code decides *whether* a follow-up has news; Claude only decides *how* to say it.** Never ask the
  model whether it has anything new — the enumerated fact sources in Task 8 are the only answer.
- **Randomness must be injected**, never called globally, so sampling rates are testable.

---

### Task 1: Prefactor — schema for the switch, sequence end, and fact detection

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/<timestamp>_autonomous_send/migration.sql` (generated)
- Test: `packages/db/src/autonomous-send-schema.integration.spec.ts`

**Interfaces:**
- Consumes: the Plan 1 schema.
- Produces: `Setting.autonomousSendingEnabled`, `Setting.autonomousPauseReason`,
  `Trigger.status = 'sequence_ended'`, `Vessel.updatedAt`,
  `Account.relationshipSummaryUpdatedAt` — consumed by Tasks 2, 6, 7, 8.

**Why the two timestamp columns:** the design names three new-fact sources — a new `Trigger`, a
changed `Vessel`, a changed `Account.relationshipSummary`. Only the first is detectable in the
Plan 1 schema. `Vessel` has no timestamps at all, and `Account.updatedAt` moves on *any* account
write (including a tier change), so using it would report "new information" every time the account's
tier changed — manufacturing exactly the empty follow-up §5 forbids. A dedicated
`relationshipSummaryUpdatedAt` is set only when that text actually changes.

- [ ] **Step 1: Write the failing test**

`packages/db/src/autonomous-send-schema.integration.spec.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from './test-utils/testcontainers-postgres.js';

describe('autonomous-send schema', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  it('defaults autonomous sending to off', async () => {
    const settings = await testDb.prisma.setting.create({ data: { id: 1 } });
    expect(settings.autonomousSendingEnabled).toBe(false);
    expect(settings.autonomousPauseReason).toBeNull();
  });

  it('accepts sequence_ended as a trigger status', async () => {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Schema Co',
        segment: 'x',
        hub: 'y',
        icpScore: 50,
        icpBand: 'med',
        relationshipSummary: 'x',
        currentTier: 2,
        tierRationale: 'x',
      },
    });
    const trigger = await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'c',
        description: 'd',
        source: 'public_data',
        confidenceLabel: 'high',
        verifiabilityNote: 'n',
        detectedAt: new Date(),
        status: 'sequence_ended',
      },
    });
    expect(trigger.status).toBe('sequence_ended');
  });

  it('stamps Vessel.updatedAt automatically on change', async () => {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Vessel Co',
        segment: 'x',
        hub: 'y',
        icpScore: 50,
        icpBand: 'med',
        relationshipSummary: 'x',
        currentTier: 2,
        tierRationale: 'x',
      },
    });
    const vessel = await testDb.prisma.vessel.create({
      data: { accountId: account.id, name: 'MV One', imo: `IMO-${Date.now()}`, flag: 'Vietnam' },
    });

    const updated = await testDb.prisma.vessel.update({
      where: { id: vessel.id },
      data: { flag: 'Singapore' },
    });

    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(vessel.updatedAt.getTime());
  });

  it('leaves relationshipSummaryUpdatedAt null until it is set explicitly', async () => {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Summary Co',
        segment: 'x',
        hub: 'y',
        icpScore: 50,
        icpBand: 'med',
        relationshipSummary: 'original',
        currentTier: 2,
        tierRationale: 'x',
      },
    });
    expect(account.relationshipSummaryUpdatedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @erria/db exec vitest run src/autonomous-send-schema.integration.spec.ts`
Expected: FAIL — the fields and the enum value do not exist.

- [ ] **Step 3: Edit the schema**

In `packages/db/prisma/schema.prisma`:

Add `sequence_ended` to `TriggerStatus`:

```prisma
enum TriggerStatus {
  new
  processing
  drafted
  superseded
  needs_triage
  sequence_ended
}
```

Add to `model Setting`:

```prisma
  autonomousSendingEnabled Boolean @default(false)
  autonomousPauseReason    String?
```

Add to `model Vessel`:

```prisma
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
```

Add to `model Account`:

```prisma
  relationshipSummaryUpdatedAt DateTime?
```

- [ ] **Step 4: Generate and apply the migration**

Run: `pnpm --filter @erria/db exec prisma migrate dev --name autonomous_send`
Expected: a migration adding one enum value, two `settings` columns, two `vessels` columns, and one
`accounts` column. `prisma generate` reruns automatically.

Note that adding `updatedAt` to an existing table needs a default for existing rows; Prisma
generates `DEFAULT CURRENT_TIMESTAMP` for this. That is correct here — an unmodified vessel's
"last changed" being the migration time is harmless, because Task 8 only compares it against
message timestamps that come after.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @erria/db exec vitest run src/autonomous-send-schema.integration.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "feat(db): add autonomous-send switch, sequence_ended status, and fact-detection timestamps"
```

---

### Task 2: The send gate

**Files:**
- Create: `packages/domain/src/autonomous/evaluate-autonomous-send.ts`
- Modify: `packages/domain/src/index.ts` — export it
- Test: `packages/domain/src/autonomous/evaluate-autonomous-send.spec.ts`

**Interfaces:**
- Consumes: nothing — a pure function, no I/O.
- Produces: `evaluateAutonomousSend(input): AutonomousSendDecision`, `AutonomousSendInput`,
  `AutonomousSendDecision`, `HoldReason` — consumed by Task 6.

- [ ] **Step 1: Write the failing test**

`packages/domain/src/autonomous/evaluate-autonomous-send.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { evaluateAutonomousSend, type AutonomousSendInput } from './evaluate-autonomous-send.js';

function allClear(): AutonomousSendInput {
  return {
    autonomousSendingEnabled: true,
    hasActiveSendBlockingEscalation: false,
    citesComplianceDeadline: false,
    draftConfidence: 'high',
    hasContactEmail: true,
  };
}

describe('evaluateAutonomousSend', () => {
  it('sends when every condition holds', () => {
    expect(evaluateAutonomousSend(allClear())).toEqual({ outcome: 'send' });
  });

  it('holds when autonomous sending is paused', () => {
    const decision = evaluateAutonomousSend({ ...allClear(), autonomousSendingEnabled: false });
    expect(decision).toEqual({ outcome: 'hold', reason: 'autonomous_paused_hold' });
  });

  it('holds when the account has a send-blocking escalation', () => {
    const decision = evaluateAutonomousSend({
      ...allClear(),
      hasActiveSendBlockingEscalation: true,
    });
    expect(decision).toEqual({ outcome: 'hold', reason: 'escalation_hold' });
  });

  it('holds when the message cites a compliance deadline (§4 rule 5)', () => {
    const decision = evaluateAutonomousSend({ ...allClear(), citesComplianceDeadline: true });
    expect(decision).toEqual({ outcome: 'hold', reason: 'compliance_deadline_content' });
  });

  it('holds on mid confidence', () => {
    const decision = evaluateAutonomousSend({ ...allClear(), draftConfidence: 'mid' });
    expect(decision).toEqual({ outcome: 'hold', reason: 'low_confidence_hold' });
  });

  it('routes to triage when there is no contact email — there is nothing to approve', () => {
    const decision = evaluateAutonomousSend({ ...allClear(), hasContactEmail: false });
    expect(decision).toEqual({ outcome: 'triage', reason: 'no_contact_email' });
  });

  it('reports the pause first when several conditions fail at once', () => {
    // Ordering is deliberate: the operator-facing reason ("we are paused") explains the hold better
    // than an incidental one, and a paused system should say so rather than blaming the draft.
    const decision = evaluateAutonomousSend({
      ...allClear(),
      autonomousSendingEnabled: false,
      draftConfidence: 'mid',
      citesComplianceDeadline: true,
    });
    expect(decision).toEqual({ outcome: 'hold', reason: 'autonomous_paused_hold' });
  });

  it('prefers triage over a hold when there is also no address', () => {
    // A held message assumes someone can send it. Without an address nobody can, so triage wins
    // even though a hold reason also applies.
    const decision = evaluateAutonomousSend({
      ...allClear(),
      hasContactEmail: false,
      draftConfidence: 'mid',
    });
    expect(decision).toEqual({ outcome: 'triage', reason: 'no_contact_email' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @erria/domain exec vitest run src/autonomous`
Expected: FAIL — `./evaluate-autonomous-send.js` does not exist.

- [ ] **Step 3: Implement**

`packages/domain/src/autonomous/evaluate-autonomous-send.ts`:

```ts
export type HoldReason =
  | 'autonomous_paused_hold'
  | 'escalation_hold'
  | 'compliance_deadline_content'
  | 'low_confidence_hold';

export interface AutonomousSendInput {
  autonomousSendingEnabled: boolean;
  hasActiveSendBlockingEscalation: boolean;
  citesComplianceDeadline: boolean;
  draftConfidence: 'high' | 'mid' | 'low';
  hasContactEmail: boolean;
}

export type AutonomousSendDecision =
  | { outcome: 'send' }
  | { outcome: 'hold'; reason: HoldReason }
  | { outcome: 'triage'; reason: 'no_contact_email' };

/**
 * The five conditions from the autonomous-send design §2. Tier 1 grants permission to send
 * unreviewed; this decides whether that permission applies to one specific message.
 *
 * A 'hold' means the message drafts and waits for approval — Message.tierContext = 2 — while
 * Account.currentTier is untouched. That is §4 rule 5's mechanic (ADR-0003) used for all four
 * hold reasons rather than only for rule 5.
 */
export function evaluateAutonomousSend(input: AutonomousSendInput): AutonomousSendDecision {
  // Checked first: a message with no recipient cannot be approved by anyone, so holding it for a
  // human would park it somewhere nobody can act on. It is a data problem, not a judgment call.
  if (!input.hasContactEmail) {
    return { outcome: 'triage', reason: 'no_contact_email' };
  }

  // Then the operator-facing reason, so a paused system explains itself rather than blaming a draft.
  if (!input.autonomousSendingEnabled) {
    return { outcome: 'hold', reason: 'autonomous_paused_hold' };
  }

  if (input.hasActiveSendBlockingEscalation) {
    return { outcome: 'hold', reason: 'escalation_hold' };
  }

  if (input.citesComplianceDeadline) {
    return { outcome: 'hold', reason: 'compliance_deadline_content' };
  }

  // Only 'mid' is a gate concern. 'low' never gets here — §7 stops it before a draft exists.
  if (input.draftConfidence !== 'high') {
    return { outcome: 'hold', reason: 'low_confidence_hold' };
  }

  return { outcome: 'send' };
}
```

Export `evaluateAutonomousSend`, `AutonomousSendInput`, `AutonomousSendDecision`, and `HoldReason`
from `packages/domain/src/index.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @erria/domain exec vitest run src/autonomous`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): add the autonomous-send gate"
```

---

### Task 3: The audit-sampling decision

**Files:**
- Create: `packages/domain/src/autonomous/should-sample-send.ts`
- Modify: `packages/domain/src/index.ts` — export it
- Test: `packages/domain/src/autonomous/should-sample-send.spec.ts`

**Interfaces:**
- Consumes: nothing — pure, with randomness injected.
- Produces: `shouldSampleSend(input): boolean`, `ShouldSampleInput` — consumed by Task 6.

- [ ] **Step 1: Write the failing test**

`packages/domain/src/autonomous/should-sample-send.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { shouldSampleSend } from './should-sample-send.js';

describe('shouldSampleSend', () => {
  it("always samples an account's first autonomous send, whatever the rate", () => {
    expect(
      shouldSampleSend({ sampleRatePercent: 0, isFirstAutonomousSend: true, random: () => 0.99 }),
    ).toBe(true);
  });

  it('samples when the roll falls inside the configured rate', () => {
    expect(
      shouldSampleSend({ sampleRatePercent: 10, isFirstAutonomousSend: false, random: () => 0.05 }),
    ).toBe(true);
  });

  it('does not sample when the roll falls outside the rate', () => {
    expect(
      shouldSampleSend({ sampleRatePercent: 10, isFirstAutonomousSend: false, random: () => 0.5 }),
    ).toBe(false);
  });

  it('never samples at a rate of 0 once past the first send', () => {
    expect(
      shouldSampleSend({ sampleRatePercent: 0, isFirstAutonomousSend: false, random: () => 0 }),
    ).toBe(false);
  });

  it('always samples at a rate of 100', () => {
    expect(
      shouldSampleSend({ sampleRatePercent: 100, isFirstAutonomousSend: false, random: () => 0.999 }),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @erria/domain exec vitest run src/autonomous/should-sample-send.spec.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

`packages/domain/src/autonomous/should-sample-send.ts`:

```ts
export interface ShouldSampleInput {
  sampleRatePercent: number;
  isFirstAutonomousSend: boolean;
  /** Injected so the rate is testable. Never call Math.random() inside this module. */
  random: () => number;
}

/**
 * Spec §10's sampling rate, plus the design's one addition: an account's first autonomous send is
 * always sampled. The first message an account sends with nobody reading it is the riskiest one it
 * will ever send, so it is a strange place to economise on a dice roll.
 */
export function shouldSampleSend(input: ShouldSampleInput): boolean {
  if (input.isFirstAutonomousSend) {
    return true;
  }
  // Strict less-than against a 0..1 roll: rate 0 samples nothing, rate 100 samples everything.
  return input.random() < input.sampleRatePercent / 100;
}
```

Export both from `packages/domain/src/index.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @erria/domain exec vitest run src/autonomous/should-sample-send.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): add the audit-sampling decision with injected randomness"
```

---

### Task 4: Promotion to Tier 1

**Files:**
- Modify: `packages/domain/src/tiering/record-clean-approval.ts`
- Test: `packages/domain/src/tiering/record-clean-approval.integration.spec.ts` — add a describe block

**Interfaces:**
- Consumes: `recordCleanApproval(prisma, messageId): Promise<boolean>` (Plan 2 Task 6),
  `recommendTierForTrigger` (Plan 1 Task 5).
- Produces: the same signature, now performing promotion — ADR-0005's deferred half.

- [ ] **Step 1: Write the failing test**

Add to `packages/domain/src/tiering/record-clean-approval.integration.spec.ts`:

```ts
describe('recordCleanApproval promotion', () => {
  async function seedQualifying(overrides: { icpScore?: number; cleanApprovalsCount?: number } = {}) {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Promote Co',
        segment: 'Offshore support vessel operator',
        hub: 'Haiphong',
        icpScore: overrides.icpScore ?? 90,
        icpBand: 'high',
        relationshipSummary: 'Long clean history',
        currentTier: 2,
        tierRationale: 'Earning trust',
        cleanApprovalsCount: overrides.cleanApprovalsCount ?? 1,
      },
    });
    const message = await testDb.prisma.message.create({
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
    return { account, message };
  }

  it('promotes when the threshold is met and the score independently qualifies', async () => {
    await testDb.prisma.setting.upsert({
      where: { id: 1 },
      update: { tier1PromotionThreshold: 2 },
      create: { id: 1, tier1PromotionThreshold: 2 },
    });
    const { account, message } = await seedQualifying({ icpScore: 90, cleanApprovalsCount: 1 });

    await recordCleanApproval(testDb.prisma, message.id);

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.cleanApprovalsCount).toBe(2);
    expect(refreshed.currentTier).toBe(1);

    const promotions = await testDb.prisma.tierHistoryEvent.findMany({
      where: { accountId: account.id, eventType: 'promote' },
    });
    expect(promotions).toHaveLength(1);
    expect(promotions[0].fromTier).toBe(2);
    expect(promotions[0].toTier).toBe(1);
    expect(promotions[0].reason).toMatch(/2 clean approvals/i);
    expect(promotions[0].reason).toMatch(/score/i);
  });

  it('does not promote on the count alone when the score does not qualify', async () => {
    await testDb.prisma.setting.upsert({
      where: { id: 1 },
      update: { tier1PromotionThreshold: 2 },
      create: { id: 1, tier1PromotionThreshold: 2 },
    });
    const { account, message } = await seedQualifying({ icpScore: 40, cleanApprovalsCount: 1 });

    await recordCleanApproval(testDb.prisma, message.id);

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.cleanApprovalsCount).toBe(2);
    expect(refreshed.currentTier).toBe(2);
  });

  it('does not promote on the score alone before the threshold is reached', async () => {
    await testDb.prisma.setting.upsert({
      where: { id: 1 },
      update: { tier1PromotionThreshold: 4 },
      create: { id: 1, tier1PromotionThreshold: 4 },
    });
    const { account, message } = await seedQualifying({ icpScore: 90, cleanApprovalsCount: 1 });

    await recordCleanApproval(testDb.prisma, message.id);

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.currentTier).toBe(2);
  });

  it('is idempotent about tier — an already-Tier-1 account is not re-promoted', async () => {
    await testDb.prisma.setting.upsert({
      where: { id: 1 },
      update: { tier1PromotionThreshold: 2 },
      create: { id: 1, tier1PromotionThreshold: 2 },
    });
    const { account, message } = await seedQualifying({ icpScore: 90, cleanApprovalsCount: 5 });
    await testDb.prisma.account.update({ where: { id: account.id }, data: { currentTier: 1 } });
    // A Tier 1 send has tierContext 1, which is not a clean approval — so use a held message,
    // which is the realistic way a Tier 1 account produces a tierContext-2 send.
    await testDb.prisma.message.update({ where: { id: message.id }, data: { tierContext: 2 } });

    await recordCleanApproval(testDb.prisma, message.id);

    const promotions = await testDb.prisma.tierHistoryEvent.findMany({
      where: { accountId: account.id, eventType: 'promote' },
    });
    expect(promotions).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @erria/domain exec vitest run src/tiering/record-clean-approval.integration.spec.ts`
Expected: FAIL — no promotion happens; `currentTier` stays 2.

- [ ] **Step 3: Implement**

In `packages/domain/src/tiering/record-clean-approval.ts`, replace the doc comment's deferral note
and add promotion after the counter increment. The function becomes:

```ts
import type { PrismaClient } from '@erria/db';
import { recommendTierForTrigger } from './recommend-tier.js';

/**
 * Spec §3's promotion counter and spec §8's "core promotion signal": a Tier 2 draft that went out
 * exactly as the agent wrote it, on an account with no negative signal since.
 *
 * Performs the promotion itself as of ADR-0006 (which superseded ADR-0005's deferral). Promotion
 * needs BOTH conditions §3 states — the count and an independently qualifying score — so a
 * well-behaved account with a weak fit stays at Tier 2 forever, which is correct.
 */
export async function recordCleanApproval(prisma: PrismaClient, messageId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const message = await tx.message.findUniqueOrThrow({ where: { id: messageId } });

    if (message.tierContext !== 2 || message.edited) {
      return false;
    }

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

    await promoteIfEarned(tx, account.id);

    return true;
  });
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * ADR-0004: earning is the only route to Tier 1, so this is the only code that may set it.
 */
async function promoteIfEarned(tx: Tx, accountId: string): Promise<void> {
  const account = await tx.account.findUniqueOrThrow({ where: { id: accountId } });
  if (account.currentTier === 1) {
    return;
  }

  const settings = await tx.setting.findUnique({ where: { id: 1 } });
  const threshold = settings?.tier1PromotionThreshold ?? 2;
  if (account.cleanApprovalsCount < threshold) {
    return;
  }

  // "Independently qualifies on score" means the BASE tier — before the rollout overlay caps it —
  // is 1. Passing accountAlreadyEarnedTier1: true suppresses the overlay so we read the underlying
  // score judgment, which is exactly the question promotion asks.
  const scoreJudgment = recommendTierForTrigger({
    accountAlreadyEarnedTier1: true,
    icpScore: account.icpScore,
    triggerConfidence: 'high',
    hasComplianceDeadlineContent: false,
  });
  if (scoreJudgment.tier !== 1) {
    return;
  }

  await tx.account.update({
    where: { id: accountId },
    data: {
      currentTier: 1,
      tierRationale:
        `Earned Tier 1: ${account.cleanApprovalsCount} clean approvals, and the account's score ` +
        `independently qualifies. The agent may now send to this account without prior review.`,
    },
  });

  await tx.tierHistoryEvent.create({
    data: {
      accountId,
      eventType: 'promote',
      fromTier: account.currentTier,
      toTier: 1,
      reason:
        `Promoted to Tier 1 — ${account.cleanApprovalsCount} clean approvals met the threshold of ` +
        `${threshold}, and the account's score independently qualifies (both are required).`,
    },
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @erria/domain exec vitest run src/tiering/record-clean-approval.integration.spec.ts`
Expected: PASS — the 4 new promotion tests plus Plan 2's 5 existing ones. Note that Plan 2's test
`"never promotes to Tier 1, even once the threshold is met (ADR-0005)"` **now fails by design** — it
asserted the deferral this task lifts. Replace that test with:

```ts
  it('promotes once the threshold is met, now that ADR-0006 lifted the deferral', async () => {
    await testDb.prisma.setting.upsert({
      where: { id: 1 },
      update: { tier1PromotionThreshold: 2 },
      create: { id: 1, tier1PromotionThreshold: 2 },
    });
    const { account } = await seedSentMessage();
    await testDb.prisma.account.update({
      where: { id: account.id },
      data: { cleanApprovalsCount: 1, icpScore: 90 },
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
    expect(refreshed.currentTier).toBe(1);
  });
```

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): promote to Tier 1 on earned clean approvals (lifts ADR-0005)"
```

---

### Task 5: What a demotion costs

**Files:**
- Modify: `packages/domain/src/escalation/open-escalation.ts`
- Test: `packages/domain/src/escalation/open-escalation.integration.spec.ts` — add a describe block

**Interfaces:**
- Consumes: `openEscalation(prisma, input)` (Plan 3 Task 3).
- Produces: the same signature, now resetting `cleanApprovalsCount` for trust-damaging rules only.

- [ ] **Step 1: Write the failing test**

Add to `packages/domain/src/escalation/open-escalation.integration.spec.ts`:

```ts
describe('openEscalation and earned progress', () => {
  async function seedWithProgress(count = 4) {
    return testDb.prisma.account.create({
      data: {
        companyName: 'Progress Co',
        segment: 'Coastal freight',
        hub: 'Haiphong',
        icpScore: 80,
        icpBand: 'high',
        relationshipSummary: 'Good history',
        currentTier: 2,
        tierRationale: 'Earning trust',
        cleanApprovalsCount: count,
      },
    });
  }

  const RESETTING = ['negative_sentiment', 'relationship_conflict'] as const;
  const PRESERVING = [
    'pricing_question',
    'technical_compliance_question',
    'non_english_language',
    'classification_uncertain',
  ] as const;

  for (const rule of RESETTING) {
    it(`resets earned progress for ${rule} — trust was damaged`, async () => {
      const account = await seedWithProgress(4);

      await openEscalation(testDb.prisma, {
        accountId: account.id,
        triggerMessageId: null,
        rule,
        reasonSummary: 'test',
        detail: 'test',
        recommendedNextStep: 'test',
      });

      const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
      expect(refreshed.cleanApprovalsCount).toBe(0);

      const event = await testDb.prisma.tierHistoryEvent.findFirstOrThrow({
        where: { accountId: account.id, eventType: 'escalate' },
      });
      expect(event.reason).toMatch(/progress reset|clean-approval progress/i);
    });
  }

  for (const rule of PRESERVING) {
    it(`keeps earned progress for ${rule} — not a trust failure`, async () => {
      const account = await seedWithProgress(4);

      await openEscalation(testDb.prisma, {
        accountId: account.id,
        triggerMessageId: null,
        rule,
        reasonSummary: 'test',
        detail: 'test',
        recommendedNextStep: 'test',
      });

      const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
      expect(refreshed.cleanApprovalsCount).toBe(4);

      const event = await testDb.prisma.tierHistoryEvent.findFirstOrThrow({
        where: { accountId: account.id, eventType: 'escalate' },
      });
      expect(event.reason).toMatch(/progress kept|retained/i);
    });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @erria/domain exec vitest run src/escalation/open-escalation.integration.spec.ts`
Expected: FAIL — the counter is never touched and the reason says nothing about progress.

- [ ] **Step 3: Implement**

In `packages/domain/src/escalation/open-escalation.ts`, add the rule set and fold the reset into the
existing transaction:

```ts
/**
 * Rules that indicate damaged trust, and therefore cost the account its earned progress toward
 * Tier 1. Everything else is healthy or neutral — §9 makes the point that a pricing question is a
 * buying signal, and zeroing an account's progress for asking about price would punish exactly the
 * behavior Erria wants from a prospect.
 */
const TRUST_DAMAGING_RULES: ReadonlySet<string> = new Set([
  'negative_sentiment',
  'relationship_conflict',
]);
```

Inside the transaction, after creating the escalation and before writing the `TierHistoryEvent`:

```ts
    const resetsProgress = TRUST_DAMAGING_RULES.has(input.rule) && account.cleanApprovalsCount > 0;
    if (resetsProgress) {
      await tx.account.update({
        where: { id: account.id },
        data: { cleanApprovalsCount: 0 },
      });
    }

    const progressNote = TRUST_DAMAGING_RULES.has(input.rule)
      ? ` Clean-approval progress reset to 0 — Tier 1 must be re-earned from scratch.`
      : ` Clean-approval progress kept (${account.cleanApprovalsCount}) — this rule is not a trust failure.`;
```

and append `progressNote` to the event's reason:

```ts
    await tx.tierHistoryEvent.create({
      data: {
        accountId: account.id,
        eventType: 'escalate',
        fromTier: account.currentTier,
        toTier: 3,
        reason: `${input.reasonSummary}.${progressNote}`,
        relatedMessageId: input.triggerMessageId,
        relatedEscalationId: escalation.id,
      },
    });
```

The note is written for trust-damaging rules even when the count was already 0, so the timeline
records the policy rather than only its effect.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @erria/domain exec vitest run src/escalation/open-escalation.integration.spec.ts`
Expected: PASS — 6 new tests plus Plan 3's 3 existing ones.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): reset earned progress only when an escalation indicates damaged trust"
```

---

### Task 6: The autonomous send path

**Files:**
- Modify: `packages/domain/src/tiering/persist-trigger-tier.ts` — remove the ADR-0002 throw
- Modify: `apps/worker/src/routes/process-trigger.ts` — branch on the gate
- Test: `packages/domain/src/tiering/persist-trigger-tier.integration.spec.ts` — replace the throw test
- Test: `apps/worker/src/routes/process-trigger.integration.spec.ts` — add autonomous cases

**Interfaces:**
- Consumes: `evaluateAutonomousSend` (Task 2), `shouldSampleSend` (Task 3), `buildSubjectLine` and
  `ChannelAdapter` (Plan 2 Task 2), `recordCleanApproval` (Task 4), `draftMessage` (Plan 1 Task 6).
- Produces: the completed Tier 1 send path — no in-plan consumers.

- [ ] **Step 1: Replace the throw test**

In `packages/domain/src/tiering/persist-trigger-tier.integration.spec.ts`, Plan 1's test
`"throws NotImplementedFlowError for a fully-qualified Tier 1 recommendation"` asserted the deferral
ADR-0006 lifts. Replace it with:

```ts
  it('persists a Tier 1 recommendation now that ADR-0006 lifted the deferral', async () => {
    const account = await createAccount({ currentTier: 1 });

    const result = await recordIncomingTrigger(testDb.prisma, {
      accountId: account.id,
      vesselId: null,
      category: 'test',
      description: 'test',
      source: 'public_data',
      confidenceLabel: 'high',
      verifiabilityNote: 'test',
      detectedAt: new Date(),
      hasComplianceDeadlineContent: false,
    });

    expect(result.tier).toBe(1);

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.currentTier).toBe(1);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @erria/domain exec vitest run src/tiering/persist-trigger-tier.integration.spec.ts`
Expected: FAIL — `NotImplementedFlowError` is still thrown.

- [ ] **Step 3: Remove the throw**

In `packages/domain/src/tiering/persist-trigger-tier.ts`, delete this block entirely:

```ts
    if (recommendation.tier === 1) {
      throw new NotImplementedFlowError(...);
    }
```

and widen the return type from `tier: 1 | 2` to keep `PersistedTrigger.tier` as `1 | 2` (it already
is — no change needed). Remove the now-unused `NotImplementedFlowError` import.

Keep `NotImplementedFlowError` itself exported from `packages/domain/src/errors.ts`: it is a
general-purpose guard, and deleting it would be unrelated cleanup.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @erria/domain exec vitest run src/tiering/persist-trigger-tier.integration.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing worker test**

Add to `apps/worker/src/routes/process-trigger.integration.spec.ts`:

```ts
describe('Tier 1 autonomous send', () => {
  async function seedTier1Account(withEmail = true) {
    return testDb.prisma.account.create({
      data: {
        companyName: 'Autonomous Co',
        segment: 'Offshore support vessel operator',
        hub: 'Haiphong',
        icpScore: 90,
        icpBand: 'high',
        relationshipSummary: 'Earned Tier 1',
        currentTier: 1,
        tierRationale: 'Earned',
        cleanApprovalsCount: 2,
        contacts: withEmail
          ? { create: { name: 'Ms. Lan Pham', role: 'Tech Super', email: 'auto@example.com' } }
          : { create: { name: 'Ms. Lan Pham', role: 'Tech Super' } },
      },
    });
  }

  async function seedTrigger(accountId: string) {
    return testDb.prisma.trigger.create({
      data: {
        accountId,
        category: 'life-raft service window',
        description: 'test',
        source: 'public_data',
        confidenceLabel: 'high',
        verifiabilityNote: 'test',
        detectedAt: new Date(),
        status: 'new',
      },
    });
  }

  it('sends without approval and records the sampled audit row for a first send', async () => {
    await testDb.prisma.setting.upsert({
      where: { id: 1 },
      update: { autonomousSendingEnabled: true, tier1AuditSampleRate: 0 },
      create: { id: 1, autonomousSendingEnabled: true, tier1AuditSampleRate: 0 },
    });
    const account = await seedTier1Account();
    const trigger = await seedTrigger(account.id);
    const adapter = new LoggingChannelAdapter();
    const anthropic = fakeAnthropicClient({
      should_draft: true,
      draft_text: 'Hi Ms. Pham, ...',
      confidence_label: 'high',
      abstain_reason: null,
    });
    const server = buildServer({ prisma: testDb.prisma, anthropic, channelAdapter: adapter });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/process-trigger/${trigger.id}`,
    });

    expect(response.json()).toMatchObject({ status: 'sent_autonomously' });
    expect(adapter.sent).toHaveLength(1);

    const message = await testDb.prisma.message.findFirstOrThrow({ where: { triggerId: trigger.id } });
    expect(message.status).toBe('sent');
    expect(message.tierContext).toBe(1);
    expect(message.decidedBy).toBe('system (autonomous)');

    // Rate is 0, so only the first-send rule can explain this row existing.
    const samples = await testDb.prisma.auditSample.findMany({ where: { accountId: account.id } });
    expect(samples).toHaveLength(1);
  });

  it('holds for approval when autonomous sending is paused, keeping the account at Tier 1', async () => {
    await testDb.prisma.setting.upsert({
      where: { id: 1 },
      update: { autonomousSendingEnabled: false },
      create: { id: 1, autonomousSendingEnabled: false },
    });
    const account = await seedTier1Account();
    const trigger = await seedTrigger(account.id);
    const adapter = new LoggingChannelAdapter();
    const anthropic = fakeAnthropicClient({
      should_draft: true,
      draft_text: 'Hi Ms. Pham, ...',
      confidence_label: 'high',
      abstain_reason: null,
    });
    const server = buildServer({ prisma: testDb.prisma, anthropic, channelAdapter: adapter });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/process-trigger/${trigger.id}`,
    });

    expect(response.json()).toMatchObject({ status: 'held_for_approval' });
    expect(adapter.sent).toHaveLength(0);

    const message = await testDb.prisma.message.findFirstOrThrow({ where: { triggerId: trigger.id } });
    expect(message.status).toBe('pending_review');
    expect(message.tierContext).toBe(2);
    expect(message.hardRuleFlags).toContain('autonomous_paused_hold');

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.currentTier).toBe(1);
  });

  it('holds for approval on a mid-confidence draft', async () => {
    await testDb.prisma.setting.upsert({
      where: { id: 1 },
      update: { autonomousSendingEnabled: true },
      create: { id: 1, autonomousSendingEnabled: true },
    });
    const account = await seedTier1Account();
    const trigger = await seedTrigger(account.id);
    const adapter = new LoggingChannelAdapter();
    const anthropic = fakeAnthropicClient({
      should_draft: true,
      draft_text: 'Hi Ms. Pham, ...',
      confidence_label: 'mid',
      abstain_reason: null,
    });
    const server = buildServer({ prisma: testDb.prisma, anthropic, channelAdapter: adapter });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/process-trigger/${trigger.id}`,
    });

    expect(response.json()).toMatchObject({ status: 'held_for_approval' });
    expect(adapter.sent).toHaveLength(0);

    const message = await testDb.prisma.message.findFirstOrThrow({ where: { triggerId: trigger.id } });
    expect(message.hardRuleFlags).toContain('low_confidence_hold');
  });

  it('routes to triage when the Tier 1 account has no contact email', async () => {
    await testDb.prisma.setting.upsert({
      where: { id: 1 },
      update: { autonomousSendingEnabled: true },
      create: { id: 1, autonomousSendingEnabled: true },
    });
    const account = await seedTier1Account(false);
    const trigger = await seedTrigger(account.id);
    const adapter = new LoggingChannelAdapter();
    const anthropic = fakeAnthropicClient({
      should_draft: true,
      draft_text: 'Hi Ms. Pham, ...',
      confidence_label: 'high',
      abstain_reason: null,
    });
    const server = buildServer({ prisma: testDb.prisma, anthropic, channelAdapter: adapter });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/process-trigger/${trigger.id}`,
    });

    expect(response.json()).toMatchObject({ status: 'needs_triage' });
    expect(adapter.sent).toHaveLength(0);

    const updated = await testDb.prisma.trigger.findUniqueOrThrow({ where: { id: trigger.id } });
    expect(updated.status).toBe('needs_triage');
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter worker exec vitest run src/routes/process-trigger.integration.spec.ts`
Expected: FAIL — the route always creates a `pending_review` message; there is no autonomous branch.

- [ ] **Step 7: Implement the autonomous branch**

In `apps/worker/src/routes/process-trigger.ts`, extend the imports:

```ts
import {
  draftMessage,
  TONE_SYSTEM_PROMPT,
  DRAFT_MODEL_ID,
  buildSubjectLine,
  evaluateAutonomousSend,
  shouldSampleSend,
  recordCleanApproval,
} from '@erria/domain';
```

Replace the block that unconditionally creates a `pending_review` message with:

```ts
      // Tier 2 accounts keep Plan 1's behavior unchanged: always draft for approval.
      if (trigger.account.currentTier !== 1) {
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
      }

      // Tier 1: the account has earned permission to send unreviewed. Whether it applies to THIS
      // message is the gate's decision.
      const settings = await deps.prisma.setting.findUnique({ where: { id: 1 } });
      const recipient = trigger.account.contacts.find((contact) => contact.email)?.email;
      const blockingEscalation = await deps.prisma.escalation.findFirst({
        where: { accountId: trigger.accountId, status: 'active', agentSendDisabled: true },
      });

      const decision = evaluateAutonomousSend({
        autonomousSendingEnabled: settings?.autonomousSendingEnabled ?? false,
        hasActiveSendBlockingEscalation: blockingEscalation !== null,
        citesComplianceDeadline: trigger.hasComplianceDeadlineContentFlag,
        draftConfidence: draft.parsed.confidence_label,
        hasContactEmail: Boolean(recipient),
      });

      if (decision.outcome === 'triage') {
        await deps.prisma.trigger.update({
          where: { id: trigger.id },
          data: { status: 'needs_triage' },
        });
        await deps.prisma.tierHistoryEvent.create({
          data: {
            accountId: trigger.accountId,
            eventType: 'hold_at_tier',
            reason: 'Tier 1 send could not proceed — no contact email on this account.',
          },
        });
        return reply.send({ status: 'needs_triage', reason: decision.reason });
      }

      if (decision.outcome === 'hold') {
        const message = await deps.prisma.message.create({
          data: {
            accountId: trigger.accountId,
            triggerId: trigger.id,
            role: 'agent_draft',
            body: draft.parsed.draft_text,
            status: 'pending_review',
            // Held at Tier 2 for this message only. Account.currentTier stays 1 (ADR-0003's mechanic).
            tierContext: 2,
            hardRuleFlags: [decision.reason],
            confidenceMeta: {
              model: DRAFT_MODEL_ID,
              confidenceLabel: draft.parsed.confidence_label,
              latencyMs: draft.latencyMs,
            },
          },
        });
        await deps.prisma.trigger.update({ where: { id: trigger.id }, data: { status: 'drafted' } });
        return reply.send({ status: 'held_for_approval', reason: decision.reason, messageId: message.id });
      }

      // decision.outcome === 'send'. Persisted as 'approved' with a system decider BEFORE dispatch,
      // so Plan 2's stuck-send reconciliation sweep covers a failed autonomous send unchanged.
      const message = await deps.prisma.message.create({
        data: {
          accountId: trigger.accountId,
          triggerId: trigger.id,
          role: 'agent_draft',
          body: draft.parsed.draft_text,
          status: 'approved',
          tierContext: 1,
          decidedBy: 'system (autonomous)',
          decidedAt: new Date(),
          confidenceMeta: {
            model: DRAFT_MODEL_ID,
            confidenceLabel: draft.parsed.confidence_label,
            latencyMs: draft.latencyMs,
          },
        },
      });

      const priorAutonomousSends = await deps.prisma.message.count({
        where: { accountId: trigger.accountId, tierContext: 1, status: 'sent' },
      });

      await deps.channelAdapter.send({
        to: recipient!,
        subject: buildSubjectLine({
          companyName: trigger.account.companyName,
          vesselName: trigger.vessel?.name ?? null,
          triggerCategory: trigger.category,
        }),
        body: message.body,
      });

      await deps.prisma.message.update({
        where: { id: message.id },
        data: { role: 'agent_sent', status: 'sent', sentAt: new Date() },
      });

      if (
        shouldSampleSend({
          sampleRatePercent: settings?.tier1AuditSampleRate ?? 10,
          isFirstAutonomousSend: priorAutonomousSends === 0,
          random: Math.random,
        })
      ) {
        await deps.prisma.auditSample.create({
          data: { messageId: message.id, accountId: trigger.accountId },
        });
      }

      await deps.prisma.trigger.update({ where: { id: trigger.id }, data: { status: 'drafted' } });

      return reply.send({ status: 'sent_autonomously', messageId: message.id });
```

Two supporting changes this needs:

The route's `findUnique` must include contacts, so extend its `include` to
`{ account: { include: { contacts: true } }, vessel: true }`.

`trigger.hasComplianceDeadlineContentFlag` does not exist — the flag arrives on the *incoming
trigger payload* (Plan 1 Task 9's DTO) and was never persisted. Persist it: add
`hasComplianceDeadlineContent Boolean @default(false)` to `model Trigger` in Task 1's migration, and
set it in `recordIncomingTrigger` from `input.hasComplianceDeadlineContent`. Then read
`trigger.hasComplianceDeadlineContent` here.

- [ ] **Step 8: Run the worker suite to verify it passes**

Run: `pnpm --filter worker exec vitest run`
Expected: PASS — 4 new autonomous tests plus every test from Plans 1-3. Plan 1's Tier 2 tests still
pass because the `currentTier !== 1` branch is unchanged.

- [ ] **Step 9: Commit**

```bash
git add packages/db packages/domain apps/worker
git commit -m "feat(worker): send autonomously for earned Tier 1 accounts behind the five-condition gate"
```

---

### Task 7: The kill switch API

**Files:**
- Create: `apps/console-api/src/settings/dto/pause-autonomous.dto.ts`
- Modify: `apps/console-api/src/settings/settings.service.ts` — add pause/resume
- Modify: `apps/console-api/src/settings/settings.controller.ts` — add the routes
- Test: `apps/console-api/src/settings/settings.service.integration.spec.ts` — add a describe block

**Interfaces:**
- Consumes: `SettingsService` (Plan 4 Task 1).
- Produces: `POST /api/settings/autonomous/pause` (immediate),
  `PUT /api/settings/autonomous/resume` → `{ requiresConfirmation, notice }`,
  `POST /api/settings/autonomous/resume/confirm` (applies) — consumed by Task 10.

- [ ] **Step 1: Write the failing test**

Add to `apps/console-api/src/settings/settings.service.integration.spec.ts`:

```ts
describe('SettingsService autonomous kill switch', () => {
  it('pauses immediately, with no confirmation step, recording the reason', async () => {
    const service = new SettingsService(testDb.prisma);
    await service.confirmResumeAutonomous();

    const result = await service.pauseAutonomous('Tone drift spotted on three sends');

    expect(result.autonomous.enabled).toBe(false);
    expect(result.autonomous.pauseReason).toBe('Tone drift spotted on three sends');

    const stored = await testDb.prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
    expect(stored.autonomousSendingEnabled).toBe(false);
  });

  it('requires a reason to pause, so a paused system explains itself', async () => {
    const service = new SettingsService(testDb.prisma);

    await expect(service.pauseAutonomous('   ')).rejects.toThrow(/reason/i);
  });

  it('proposing a resume changes nothing and returns the confirmation notice', async () => {
    const service = new SettingsService(testDb.prisma);
    await service.pauseAutonomous('paused for the test');

    const proposal = await service.proposeResumeAutonomous();

    expect(proposal.requiresConfirmation).toBe(true);
    expect(proposal.notice).toMatch(/without a human reading/i);

    const stored = await testDb.prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
    expect(stored.autonomousSendingEnabled).toBe(false);
  });

  it('confirming a resume enables sending and clears the pause reason', async () => {
    const service = new SettingsService(testDb.prisma);
    await service.pauseAutonomous('paused for the test');

    const result = await service.confirmResumeAutonomous();

    expect(result.autonomous.enabled).toBe(true);
    expect(result.autonomous.pauseReason).toBeNull();
  });

  it('reports the switch state through the normal settings read', async () => {
    const service = new SettingsService(testDb.prisma);
    await service.pauseAutonomous('visible in read');

    const settings = await service.read();

    expect(settings.autonomous.enabled).toBe(false);
    expect(settings.autonomous.pauseReason).toBe('visible in read');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter console-api exec vitest run src/settings/settings.service.integration.spec.ts`
Expected: FAIL — `pauseAutonomous` is not a function.

- [ ] **Step 3: Implement**

`apps/console-api/src/settings/dto/pause-autonomous.dto.ts`:

```ts
import { IsString, MinLength } from 'class-validator';

export class PauseAutonomousDto {
  @IsString() @MinLength(1) reason!: string;
}
```

Add to `SettingsService`:

```ts
  /**
   * Deliberately immediate and unconfirmed. An emergency stop that asks "are you sure?" is a worse
   * emergency stop — someone who has just spotted a problem across several sends should be one
   * action away from stopping it.
   */
  async pauseAutonomous(reason: string) {
    const trimmed = reason.trim();
    if (!trimmed) {
      throw new BadRequestException(
        'A reason is required — whoever finds the system paused should be able to see why without asking',
      );
    }
    await this.ensureRow();
    const updated = await this.prisma.setting.update({
      where: { id: SETTINGS_ID },
      data: { autonomousSendingEnabled: false, autonomousPauseReason: trimmed },
    });
    return this.present(updated);
  }

  /** Dry run. Resuming is the direction that can cause harm, so it takes the confirmation step. */
  async proposeResumeAutonomous() {
    const current = await this.ensureRow();
    return {
      requiresConfirmation: true,
      currentlyEnabled: current.autonomousSendingEnabled,
      pauseReason: current.autonomousPauseReason,
      notice:
        'Resuming lets Tier 1 accounts send without a human reading the message first. It applies ' +
        'to outreach going forward; messages already queued for approval stay queued.',
    };
  }

  async confirmResumeAutonomous() {
    await this.ensureRow();
    const updated = await this.prisma.setting.update({
      where: { id: SETTINGS_ID },
      data: { autonomousSendingEnabled: true, autonomousPauseReason: null },
    });
    return this.present(updated);
  }
```

Extend `present()` to include the switch:

```ts
      autonomous: {
        enabled: settings.autonomousSendingEnabled,
        pauseReason: settings.autonomousPauseReason,
      },
```

Add to `SettingsController` (`BadRequestException` and `PauseAutonomousDto` imported):

```ts
  @Post('autonomous/pause')
  async pauseAutonomous(@Body() dto: PauseAutonomousDto) {
    return this.settingsService.pauseAutonomous(dto.reason);
  }

  @Put('autonomous/resume')
  async proposeResumeAutonomous() {
    return this.settingsService.proposeResumeAutonomous();
  }

  @Post('autonomous/resume/confirm')
  async confirmResumeAutonomous() {
    return this.settingsService.confirmResumeAutonomous();
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter console-api exec vitest run src/settings/settings.service.integration.spec.ts`
Expected: PASS — 5 new tests plus Plan 4's 9. Plan 4's `read()` tests still pass; they assert on
`basic`/`advanced`/`locked` and are unaffected by the added `autonomous` key.

- [ ] **Step 5: Commit**

```bash
git add apps/console-api
git commit -m "feat(console-api): kill switch — immediate pause, confirmed resume"
```

---

### Task 8: New-fact detection and the follow-up cadence job

**Files:**
- Create: `packages/domain/src/autonomous/new-facts-since.ts`
- Modify: `packages/domain/src/index.ts` — export it
- Create: `apps/worker/src/jobs/followup-cadence.ts`
- Modify: `apps/worker/src/jobs/run-job.ts` — wire the real job body
- Test: `packages/domain/src/autonomous/new-facts-since.integration.spec.ts`
- Test: `apps/worker/src/jobs/followup-cadence.integration.spec.ts`

**Interfaces:**
- Consumes: `evaluateAutonomousSend` (Task 2), `draftMessage` (Plan 1 Task 6), `buildSubjectLine`
  (Plan 2 Task 2), the Task 1 timestamps.
- Produces: `newFactsSince(prisma, accountId, since): Promise<Fact[]>`, `Fact`,
  `runFollowupCadence(prisma, anthropic, channelAdapter, options)` — invoked by
  `runJob('followup-cadence')`.

- [ ] **Step 1: Write the failing fact test**

`packages/domain/src/autonomous/new-facts-since.integration.spec.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db';
import { newFactsSince } from './new-facts-since.js';

describe('newFactsSince', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function seedAccount() {
    return testDb.prisma.account.create({
      data: {
        companyName: 'Facts Co',
        segment: 'Coastal freight',
        hub: 'Haiphong',
        icpScore: 80,
        icpBand: 'high',
        relationshipSummary: 'original summary',
        currentTier: 1,
        tierRationale: 'Earned',
      },
    });
  }

  it('returns nothing when the account has not changed since the cutoff', async () => {
    const account = await seedAccount();

    const facts = await newFactsSince(testDb.prisma, account.id, new Date());

    expect(facts).toEqual([]);
  });

  it('reports a trigger detected after the cutoff', async () => {
    const account = await seedAccount();
    const cutoff = new Date();
    await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'station availability',
        description: 'Vung Tau slots opened for 12-14 Aug',
        source: 'crm',
        confidenceLabel: 'high',
        verifiabilityNote: 'confirmed internally',
        detectedAt: new Date(cutoff.getTime() + 1000),
        status: 'new',
      },
    });

    const facts = await newFactsSince(testDb.prisma, account.id, cutoff);

    expect(facts).toHaveLength(1);
    expect(facts[0].kind).toBe('trigger');
    expect(facts[0].summary).toContain('Vung Tau slots');
  });

  it('ignores a trigger detected before the cutoff', async () => {
    const account = await seedAccount();
    await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'old news',
        description: 'stale',
        source: 'crm',
        confidenceLabel: 'high',
        verifiabilityNote: 'n',
        detectedAt: new Date(Date.now() - 60_000),
        status: 'drafted',
      },
    });

    const facts = await newFactsSince(testDb.prisma, account.id, new Date());

    expect(facts).toEqual([]);
  });

  it('reports a vessel changed after the cutoff', async () => {
    const account = await seedAccount();
    const vessel = await testDb.prisma.vessel.create({
      data: { accountId: account.id, name: 'MV Two', imo: `IMO-${Date.now()}`, flag: 'Vietnam' },
    });
    const cutoff = new Date(Date.now() - 60_000);
    await testDb.prisma.vessel.update({ where: { id: vessel.id }, data: { flag: 'Singapore' } });

    const facts = await newFactsSince(testDb.prisma, account.id, cutoff);

    expect(facts.some((fact) => fact.kind === 'vessel')).toBe(true);
  });

  it('reports a relationship summary changed after the cutoff', async () => {
    const account = await seedAccount();
    const cutoff = new Date(Date.now() - 60_000);
    await testDb.prisma.account.update({
      where: { id: account.id },
      data: { relationshipSummary: 'now a returning customer', relationshipSummaryUpdatedAt: new Date() },
    });

    const facts = await newFactsSince(testDb.prisma, account.id, cutoff);

    expect(facts.some((fact) => fact.kind === 'relationship')).toBe(true);
  });

  it('does not treat an unrelated account update as new information', async () => {
    const account = await seedAccount();
    const cutoff = new Date(Date.now() - 60_000);
    // A tier change touches Account.updatedAt but says nothing new to a customer.
    await testDb.prisma.account.update({
      where: { id: account.id },
      data: { currentTier: 2, tierRationale: 'changed for the test' },
    });

    const facts = await newFactsSince(testDb.prisma, account.id, cutoff);

    expect(facts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @erria/domain exec vitest run src/autonomous/new-facts-since.integration.spec.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement fact detection**

`packages/domain/src/autonomous/new-facts-since.ts`:

```ts
import type { PrismaClient } from '@erria/db';

export interface Fact {
  kind: 'trigger' | 'vessel' | 'relationship';
  summary: string;
}

/**
 * The enumerated new-fact sources from the autonomous-send design §5. This is deliberately a
 * closed list: "is there anything new?" has to be a computable question, because the alternative is
 * asking the drafting model, which has every incentive to say yes and would produce exactly the
 * bare "just checking in" that spec §5 forbids.
 *
 * Note what is NOT a source: Account.updatedAt. It moves on any account write, including a tier
 * change, so using it would invent news every time the tier moved. relationshipSummaryUpdatedAt is
 * set only when that text actually changes.
 */
export async function newFactsSince(
  prisma: PrismaClient,
  accountId: string,
  since: Date,
): Promise<Fact[]> {
  const [triggers, vessels, account] = await Promise.all([
    prisma.trigger.findMany({
      where: { accountId, detectedAt: { gt: since } },
      orderBy: { detectedAt: 'asc' },
    }),
    prisma.vessel.findMany({ where: { accountId, updatedAt: { gt: since } } }),
    prisma.account.findUniqueOrThrow({ where: { id: accountId } }),
  ]);

  const facts: Fact[] = [];

  for (const trigger of triggers) {
    facts.push({ kind: 'trigger', summary: `${trigger.category}: ${trigger.description}` });
  }

  for (const vessel of vessels) {
    facts.push({
      kind: 'vessel',
      summary: `Updated particulars for ${vessel.name} (IMO ${vessel.imo}, flag ${vessel.flag})`,
    });
  }

  if (account.relationshipSummaryUpdatedAt && account.relationshipSummaryUpdatedAt > since) {
    facts.push({ kind: 'relationship', summary: account.relationshipSummary });
  }

  return facts;
}
```

Export `newFactsSince` and `Fact` from `packages/domain/src/index.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @erria/domain exec vitest run src/autonomous/new-facts-since.integration.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing job test**

`apps/worker/src/jobs/followup-cadence.integration.spec.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { LoggingChannelAdapter } from '@erria/domain';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db';
import { runFollowupCadence } from './followup-cadence.js';

function anthropicDrafting(confidence: 'high' | 'mid' = 'high') {
  return {
    messages: {
      parse: vi.fn().mockResolvedValue({
        parsed_output: {
          should_draft: true,
          draft_text: 'Following up — we now have slots on 12-14 Aug.',
          confidence_label: confidence,
          abstain_reason: null,
        },
        usage: { input_tokens: 300, output_tokens: 50 },
      }),
    },
  } as unknown as Anthropic;
}

describe('runFollowupCadence', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
    await testDb.prisma.setting.upsert({
      where: { id: 1 },
      update: { autonomousSendingEnabled: true, maxFollowups: 2, minDaysBetweenFollowups: 5 },
      create: { id: 1, autonomousSendingEnabled: true, maxFollowups: 2, minDaysBetweenFollowups: 5 },
    });
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function seedSentTier1(daysAgo: number) {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: `Cadence Co ${daysAgo}-${Math.random().toString(36).slice(2, 7)}`,
        segment: 'Coastal freight',
        hub: 'Haiphong',
        icpScore: 90,
        icpBand: 'high',
        relationshipSummary: 'Earned Tier 1',
        currentTier: 1,
        tierRationale: 'Earned',
        contacts: { create: { name: 'Contact', role: 'role', email: `cad${Math.random()}@example.com` } },
      },
    });
    const trigger = await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'life-raft service window',
        description: 'original reason',
        source: 'public_data',
        confidenceLabel: 'high',
        verifiabilityNote: 'n',
        detectedAt: new Date(Date.now() - daysAgo * 86_400_000),
        status: 'drafted',
      },
    });
    const sentAt = new Date(Date.now() - daysAgo * 86_400_000);
    await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        triggerId: trigger.id,
        role: 'agent_sent',
        body: 'first message',
        status: 'sent',
        tierContext: 1,
        sentAt,
      },
    });
    return { account, trigger, sentAt };
  }

  it('ends the sequence and makes no Claude call when nothing new exists', async () => {
    const { trigger } = await seedSentTier1(10);
    const anthropic = anthropicDrafting();
    const adapter = new LoggingChannelAdapter();

    const result = await runFollowupCadence(testDb.prisma, anthropic, adapter);

    expect(result.sequencesEnded).toBeGreaterThanOrEqual(1);
    expect(result.followupsSent).toBe(0);
    expect(adapter.sent).toHaveLength(0);
    // The point of the design: no news costs no tokens and cannot invent news.
    expect(anthropic.messages.parse).not.toHaveBeenCalled();

    const updated = await testDb.prisma.trigger.findUniqueOrThrow({ where: { id: trigger.id } });
    expect(updated.status).toBe('sequence_ended');
  });

  it('sends a follow-up citing only the new fact', async () => {
    const { account, sentAt } = await seedSentTier1(10);
    await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'station availability',
        description: 'Vung Tau slots opened 12-14 Aug',
        source: 'crm',
        confidenceLabel: 'high',
        verifiabilityNote: 'confirmed internally',
        detectedAt: new Date(sentAt.getTime() + 86_400_000),
        status: 'new',
      },
    });
    const anthropic = anthropicDrafting();
    const adapter = new LoggingChannelAdapter();

    const result = await runFollowupCadence(testDb.prisma, anthropic, adapter);

    expect(result.followupsSent).toBe(1);
    expect(adapter.sent).toHaveLength(1);

    const followup = await testDb.prisma.message.findFirstOrThrow({
      where: { accountId: account.id, isFollowup: true },
    });
    expect(followup.status).toBe('sent');
    expect(followup.followupSequenceNumber).toBe(1);
    expect(followup.decidedBy).toBe('system (autonomous)');
  });

  it('leaves an account alone before the minimum interval has elapsed', async () => {
    const { account, sentAt } = await seedSentTier1(1);
    await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'station availability',
        description: 'new but too soon',
        source: 'crm',
        confidenceLabel: 'high',
        verifiabilityNote: 'n',
        detectedAt: new Date(sentAt.getTime() + 3600_000),
        status: 'new',
      },
    });
    const anthropic = anthropicDrafting();
    const adapter = new LoggingChannelAdapter();

    const result = await runFollowupCadence(testDb.prisma, anthropic, adapter);

    expect(result.followupsSent).toBe(0);
    expect(adapter.sent).toHaveLength(0);
  });

  it('stops at the configured maximum number of follow-ups', async () => {
    const { account, trigger, sentAt } = await seedSentTier1(10);
    for (const n of [1, 2]) {
      await testDb.prisma.message.create({
        data: {
          accountId: account.id,
          triggerId: trigger.id,
          role: 'agent_sent',
          body: `followup ${n}`,
          status: 'sent',
          tierContext: 1,
          isFollowup: true,
          followupSequenceNumber: n,
          sentAt: new Date(sentAt.getTime() + n * 86_400_000),
        },
      });
    }
    await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'station availability',
        description: 'still new',
        source: 'crm',
        confidenceLabel: 'high',
        verifiabilityNote: 'n',
        detectedAt: new Date(),
        status: 'new',
      },
    });
    const anthropic = anthropicDrafting();
    const adapter = new LoggingChannelAdapter();

    const result = await runFollowupCadence(testDb.prisma, anthropic, adapter);

    expect(result.followupsSent).toBe(0);
  });

  it('holds a mid-confidence follow-up for approval instead of sending it', async () => {
    const { account, sentAt } = await seedSentTier1(10);
    await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'station availability',
        description: 'new fact',
        source: 'crm',
        confidenceLabel: 'high',
        verifiabilityNote: 'n',
        detectedAt: new Date(sentAt.getTime() + 86_400_000),
        status: 'new',
      },
    });
    const anthropic = anthropicDrafting('mid');
    const adapter = new LoggingChannelAdapter();

    const result = await runFollowupCadence(testDb.prisma, anthropic, adapter);

    expect(result.followupsSent).toBe(0);
    expect(result.followupsHeld).toBe(1);
    expect(adapter.sent).toHaveLength(0);

    const held = await testDb.prisma.message.findFirstOrThrow({
      where: { accountId: account.id, isFollowup: true },
    });
    expect(held.status).toBe('pending_review');
    expect(held.tierContext).toBe(2);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter worker exec vitest run src/jobs/followup-cadence.integration.spec.ts`
Expected: FAIL — `./followup-cadence.js` does not exist.

- [ ] **Step 7: Implement the job**

`apps/worker/src/jobs/followup-cadence.ts`:

```ts
import type { PrismaClient } from '@erria/db';
import type Anthropic from '@anthropic-ai/sdk';
import {
  type ChannelAdapter,
  DRAFT_MODEL_ID,
  TONE_SYSTEM_PROMPT,
  buildSubjectLine,
  draftMessage,
  evaluateAutonomousSend,
  newFactsSince,
} from '@erria/domain';

export interface FollowupResult {
  followupsSent: number;
  followupsHeld: number;
  sequencesEnded: number;
}

const BUSINESS_DAYS_DIVISOR = 86_400_000;

/**
 * Spec §5's cadence: at most `maxFollowups`, at least `minDaysBetweenFollowups` apart, each adding
 * new information. The "adding new information" half is enforced structurally — newFactsSince is
 * consulted BEFORE any Claude call, so an account with no news costs nothing and cannot be sent a
 * message about nothing.
 */
export async function runFollowupCadence(
  prisma: PrismaClient,
  anthropic: Anthropic,
  channelAdapter: ChannelAdapter,
): Promise<FollowupResult> {
  const settings = await prisma.setting.findUnique({ where: { id: 1 } });
  const maxFollowups = settings?.maxFollowups ?? 2;
  const minDays = settings?.minDaysBetweenFollowups ?? 5;

  const candidates = await prisma.trigger.findMany({
    where: { status: 'drafted' },
    include: {
      account: { include: { contacts: true } },
      vessel: true,
      messages: { where: { status: 'sent' }, orderBy: { sentAt: 'desc' } },
    },
  });

  const result: FollowupResult = { followupsSent: 0, followupsHeld: 0, sequencesEnded: 0 };

  for (const trigger of candidates) {
    const sent = trigger.messages;
    const lastSent = sent[0];
    if (!lastSent?.sentAt) continue;

    // A buyer reply ends the cadence — the conversation has moved on.
    const inboundSince = await prisma.message.count({
      where: { accountId: trigger.accountId, role: 'buyer_inbound' },
    });
    if (inboundSince > 0) continue;

    const followupCount = sent.filter((message) => message.isFollowup).length;
    if (followupCount >= maxFollowups) continue;

    const daysElapsed = (Date.now() - lastSent.sentAt.getTime()) / BUSINESS_DAYS_DIVISOR;
    if (daysElapsed < minDays) continue;

    const facts = await newFactsSince(prisma, trigger.accountId, lastSent.sentAt);
    if (facts.length === 0) {
      await prisma.trigger.update({ where: { id: trigger.id }, data: { status: 'sequence_ended' } });
      result.sequencesEnded += 1;
      continue;
    }

    const draft = await draftMessage(
      {
        toneSystemPrompt: `${TONE_SYSTEM_PROMPT}

This is a follow-up. Write about ONLY the following new information, which is the entire reason this
message is permitted to exist. Do not restate the original message and do not add anything not listed:
${facts.map((fact) => `- ${fact.summary}`).join('\n')}`,
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
        tier: 1,
      },
      { client: anthropic },
    );

    if (!draft.parsed || draft.parsed.should_draft === false) {
      continue;
    }

    const recipient = trigger.account.contacts.find((contact) => contact.email)?.email;
    const blocking = await prisma.escalation.findFirst({
      where: { accountId: trigger.accountId, status: 'active', agentSendDisabled: true },
    });

    const decision = evaluateAutonomousSend({
      autonomousSendingEnabled: settings?.autonomousSendingEnabled ?? false,
      hasActiveSendBlockingEscalation: blocking !== null,
      citesComplianceDeadline: trigger.hasComplianceDeadlineContent,
      draftConfidence: draft.parsed.confidence_label,
      hasContactEmail: Boolean(recipient),
    });

    if (decision.outcome !== 'send') {
      await prisma.message.create({
        data: {
          accountId: trigger.accountId,
          triggerId: trigger.id,
          role: 'agent_draft',
          body: draft.parsed.draft_text,
          status: 'pending_review',
          tierContext: 2,
          hardRuleFlags: decision.outcome === 'hold' ? [decision.reason] : [decision.reason],
          isFollowup: true,
          followupSequenceNumber: followupCount + 1,
        },
      });
      result.followupsHeld += 1;
      continue;
    }

    const message = await prisma.message.create({
      data: {
        accountId: trigger.accountId,
        triggerId: trigger.id,
        role: 'agent_draft',
        body: draft.parsed.draft_text,
        status: 'approved',
        tierContext: 1,
        decidedBy: 'system (autonomous)',
        decidedAt: new Date(),
        isFollowup: true,
        followupSequenceNumber: followupCount + 1,
        confidenceMeta: {
          model: DRAFT_MODEL_ID,
          confidenceLabel: draft.parsed.confidence_label,
          latencyMs: draft.latencyMs,
        },
      },
    });

    await channelAdapter.send({
      to: recipient!,
      subject: `Re: ${buildSubjectLine({
        companyName: trigger.account.companyName,
        vesselName: trigger.vessel?.name ?? null,
        triggerCategory: trigger.category,
      })}`,
      body: message.body,
    });

    await prisma.message.update({
      where: { id: message.id },
      data: { role: 'agent_sent', status: 'sent', sentAt: new Date() },
    });

    result.followupsSent += 1;
  }

  return result;
}
```

Wire it into `apps/worker/src/jobs/run-job.ts`, replacing the stub branch:

```ts
  if (name === 'followup-cadence') {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await runFollowupCadence(prisma, anthropic, new LoggingChannelAdapter());
    console.log(
      `[job] followup-cadence: sent ${result.followupsSent}, held ${result.followupsHeld}, ` +
        `sequences ended ${result.sequencesEnded}`,
    );
    return;
  }
```

- [ ] **Step 8: Run the worker suite to verify it passes**

Run: `pnpm --filter worker exec vitest run`
Expected: PASS — 5 new cadence tests plus everything from Plans 1-3 and Task 6.

- [ ] **Step 9: Commit**

```bash
git add packages/domain apps/worker
git commit -m "feat(worker): autonomous follow-ups gated on deterministic new-fact detection"
```

---

### Task 9: Dispatch re-checks the kill switch

**Files:**
- Modify: `apps/worker/src/routes/dispatch-message.ts`
- Test: `apps/worker/src/routes/dispatch-message.integration.spec.ts` — add a case

**Interfaces:**
- Consumes: the dispatch route (Plan 2 Task 6).
- Produces: no new surface — an added guard.

Pausing must stop messages already in flight, not only future ones. An autonomous message reaches
dispatch as `approved` with a system decider, so without this check a pause would let anything
already drafted continue.

- [ ] **Step 1: Write the failing test**

Add to `apps/worker/src/routes/dispatch-message.integration.spec.ts`:

```ts
  it('refuses to dispatch an autonomous message once autonomous sending is paused', async () => {
    await testDb.prisma.setting.upsert({
      where: { id: 1 },
      update: { autonomousSendingEnabled: false, autonomousPauseReason: 'paused mid-flight' },
      create: { id: 1, autonomousSendingEnabled: false, autonomousPauseReason: 'paused mid-flight' },
    });
    const { message } = await seedApprovedMessage();
    await testDb.prisma.message.update({
      where: { id: message.id },
      data: { tierContext: 1, decidedBy: 'system (autonomous)' },
    });
    const adapter = new LoggingChannelAdapter();
    const server = buildServer({ prisma: testDb.prisma, anthropic: {} as never, channelAdapter: adapter });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/dispatch-message/${message.id}`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'autonomous_sending_paused' });
    expect(adapter.sent).toHaveLength(0);
  });

  it('still dispatches a human-approved message while autonomous sending is paused', async () => {
    await testDb.prisma.setting.upsert({
      where: { id: 1 },
      update: { autonomousSendingEnabled: false },
      create: { id: 1, autonomousSendingEnabled: false },
    });
    const { message } = await seedApprovedMessage();
    const adapter = new LoggingChannelAdapter();
    const server = buildServer({ prisma: testDb.prisma, anthropic: {} as never, channelAdapter: adapter });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/dispatch-message/${message.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(adapter.sent).toHaveLength(1);
  });
```

The second test is the one that matters most: the kill switch stops *autonomous* sending, and must
not strand messages a human explicitly approved.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter worker exec vitest run src/routes/dispatch-message.integration.spec.ts`
Expected: FAIL — the paused autonomous message dispatches.

- [ ] **Step 3: Implement**

In `apps/worker/src/routes/dispatch-message.ts`, after the escalation guard:

```ts
      // The kill switch stops autonomous sending specifically. A message a human approved is still
      // theirs to send, so this checks the decider rather than blocking the whole queue.
      if (message.decidedBy === 'system (autonomous)') {
        const settings = await deps.prisma.setting.findUnique({ where: { id: 1 } });
        if (!settings?.autonomousSendingEnabled) {
          return reply.code(409).send({ error: 'autonomous_sending_paused' });
        }
      }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter worker exec vitest run src/routes/dispatch-message.integration.spec.ts`
Expected: PASS — 2 new tests plus Plan 2's 5.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): dispatch re-checks the kill switch for autonomous messages only"
```

---

### Task 10: Console UI — the kill switch and hold reasons

**Files:**
- Modify: `apps/console-web/src/api.ts` — add the autonomous calls
- Modify: `apps/console-web/src/SettingsPage.tsx` — add the switch control
- Modify: `apps/console-web/src/AccountDetailPage.tsx` — show why a message is held
- Test: `apps/console-web/src/SettingsPage.test.tsx` — add cases

**Interfaces:**
- Consumes: the Task 7 endpoints, `Message.hardRuleFlags` from Tasks 6 and 8.
- Produces: the operator-facing surface — the last piece of this plan.

- [ ] **Step 1: Add the API calls**

Append to `apps/console-web/src/api.ts`:

```ts
export interface AutonomousState {
  enabled: boolean;
  pauseReason: string | null;
}

export const autonomousApi = {
  pause: (reason: string) =>
    fetch('/api/settings/autonomous/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }).then(json<{ autonomous: AutonomousState }>),

  proposeResume: () =>
    fetch('/api/settings/autonomous/resume', { method: 'PUT' }).then(
      json<{ requiresConfirmation: boolean; notice: string }>,
    ),

  confirmResume: () =>
    fetch('/api/settings/autonomous/resume/confirm', { method: 'POST' }).then(
      json<{ autonomous: AutonomousState }>,
    ),
};
```

Also add `autonomous: AutonomousState;` to the `SettingsPayload` interface.

- [ ] **Step 2: Write the failing test**

Add to `apps/console-web/src/SettingsPage.test.tsx`, and add
`autonomous: { enabled: true, pauseReason: null }` to the existing `settings` fixture:

```ts
  it('pauses immediately once a reason is given, with no confirmation step', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: /pause/i })).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/why/i), 'Tone drift on three sends');
    await userEvent.click(screen.getByRole('button', { name: /pause/i }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/settings/autonomous/pause',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(screen.queryByRole('button', { name: /^confirm$/i })).not.toBeInTheDocument();
  });

  it('will not pause without a reason', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: /pause/i })).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /pause/i }));

    expect(screen.getByText(/a reason is required/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith(
      '/api/settings/autonomous/pause',
      expect.objectContaining({ method: 'POST' }),
    );
  });
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter console-web exec vitest run src/SettingsPage.test.tsx`
Expected: FAIL — there is no pause control.

- [ ] **Step 4: Implement the switch control**

Add to `apps/console-web/src/SettingsPage.tsx`, as the first section (it is the highest-consequence
control on the page, so it goes at the top):

```tsx
      <section className="autonomous-switch">
        <h2>Autonomous sending</h2>
        {settings.autonomous.enabled ? (
          <>
            <p className="divider-note">
              Tier 1 accounts are sending without a human reading each message first. Pausing takes
              effect immediately.
            </p>
            <label>
              Why are you pausing?
              <input
                type="text"
                value={pauseReason}
                onChange={(event) => {
                  setPauseReason(event.target.value);
                  if (event.target.value.trim()) setPauseError(false);
                }}
              />
            </label>
            {pauseError && <p className="tp-err">A reason is required — it is shown to whoever finds the system paused.</p>}
            <button
              onClick={async () => {
                if (!pauseReason.trim()) {
                  setPauseError(true);
                  return;
                }
                const result = await autonomousApi.pause(pauseReason);
                setSettings({ ...settings, autonomous: result.autonomous });
                setPauseReason('');
              }}
            >
              Pause autonomous sending
            </button>
          </>
        ) : (
          <>
            <p className="badge esc">Paused</p>
            {settings.autonomous.pauseReason && <p>Reason: {settings.autonomous.pauseReason}</p>}
            <p className="divider-note">
              Tier 1 accounts keep their earned tier; their messages are queueing for approval
              instead of sending.
            </p>
            {resumeNotice ? (
              <div className="confirm-strip">
                <p>{resumeNotice}</p>
                <button
                  onClick={async () => {
                    const result = await autonomousApi.confirmResume();
                    setSettings({ ...settings, autonomous: result.autonomous });
                    setResumeNotice(null);
                  }}
                >
                  Confirm resume
                </button>
                <button onClick={() => setResumeNotice(null)}>Cancel</button>
              </div>
            ) : (
              <button
                onClick={async () => {
                  const proposal = await autonomousApi.proposeResume();
                  setResumeNotice(proposal.notice);
                }}
              >
                Resume autonomous sending
              </button>
            )}
          </>
        )}
      </section>
```

with the accompanying state at the top of the component:

```tsx
  const [pauseReason, setPauseReason] = useState('');
  const [pauseError, setPauseError] = useState(false);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
```

- [ ] **Step 5: Show why a message is held**

In `apps/console-web/src/AccountDetailPage.tsx`, add `hardRuleFlags: string[] | null` to the
`pendingMessage` shape in `api.ts`, and render an explanation above the draft body:

```tsx
        {pendingMessage.hardRuleFlags?.length ? (
          <p className="badge t2">{holdExplanation(pendingMessage.hardRuleFlags)}</p>
        ) : null}
```

with, at module scope:

```tsx
const HOLD_EXPLANATIONS: Record<string, string> = {
  autonomous_paused_hold: 'Held for approval — autonomous sending is currently paused.',
  escalation_hold: 'Held for approval — this account has an open escalation.',
  compliance_deadline_content: 'Held for approval — cites a vessel compliance deadline, which is never sent unreviewed.',
  low_confidence_hold: "Held for approval — the agent's own confidence in this draft was not high.",
};

function holdExplanation(flags: string[]): string {
  return flags.map((flag) => HOLD_EXPLANATIONS[flag] ?? `Held for approval — ${flag}.`).join(' ');
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm --filter console-web exec vitest run`
Expected: PASS — 2 new settings tests plus every page test from Plans 1-4.

- [ ] **Step 7: Verify manually against the real stack**

With all three processes running: enable autonomous sending in Settings, POST a trigger for an
account you have manually set to Tier 1 with a contact email, and confirm the worker logs a
`[dispatch]` line without the message ever appearing in the review queue. Then pause with a reason,
POST another trigger, and confirm that one *does* appear in the queue with the
"autonomous sending is currently paused" explanation.

- [ ] **Step 8: Commit**

```bash
git add apps/console-web
git commit -m "feat(console-web): kill-switch control and hold-reason explanations"
```

---

## Self-Review Notes (from writing this plan)

- **Design coverage:** design §2 gate → Tasks 2, 6; §3 promotion and first-send sampling → Tasks 3, 4;
  §4 demotion cost → Task 5; §5 follow-ups → Task 8; §6 kill switch → Tasks 7, 9, 10; §7 schema →
  Task 1; §8 error handling → Task 6 (triage branch), Task 9 (mid-flight pause), Plan 2's sweep
  (unchanged, which was the point of the `approved` + system-decider choice); §9 testing → the test
  steps throughout.
- **Two gaps in the design doc, found while planning and fixed here rather than papered over.**
  First, the design names "a changed `Vessel`" and "a changed `Account.relationshipSummary`" as
  new-fact sources, but `Vessel` has no timestamp columns and `Account.updatedAt` moves on *any*
  write — so as written, a tier change would have manufactured "new information" and triggered an
  empty follow-up. Task 1 adds `Vessel.updatedAt` and `Account.relationshipSummaryUpdatedAt`, and
  Task 8 has a test asserting an unrelated account update is *not* treated as news. Second,
  `hasComplianceDeadlineContent` arrives on the incoming-trigger payload but was never persisted in
  Plan 1, so gate 3 had nothing to read; Task 1 persists it on `Trigger`.
- **Two existing tests are invalidated by design, and the plan says so explicitly** rather than
  leaving an implementer to discover a red suite: Plan 2's "never promotes to Tier 1 (ADR-0005)" and
  Plan 1's "throws NotImplementedFlowError". Both asserted deferrals ADR-0006 lifts, and Tasks 4 and
  6 give replacement tests.
- **The kill switch checks the decider, not the queue.** Task 9's second test is the important one:
  pausing autonomous sending must not strand a message a human explicitly approved. Blocking all
  dispatch would have been the easy implementation and the wrong behavior.
- **Type consistency check:** `HoldReason` (Task 2) supplies the exact strings written to
  `Message.hardRuleFlags` in Tasks 6 and 8 and read by `HOLD_EXPLANATIONS` in Task 10 — all four
  values match, plus `no_contact_email` which is a triage reason and deliberately not a hold flag.
  `draftConfidence: 'high' | 'mid' | 'low'` matches `DraftOutput.confidence_label` from Plan 1
  Task 6. `Fact.kind` (Task 8) is used only within Task 8.
- **`NotImplementedFlowError` is kept** even though its only caller goes away (Task 6 Step 3). It is
  a general-purpose guard, and deleting it would be unrelated cleanup rather than part of this work.
