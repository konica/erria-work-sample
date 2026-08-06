import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { reconcileStuckSends } from './reconcile-stuck-sends.js';

describe('reconcileStuckSends', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 120_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function seedApproved(
    decidedMinutesAgo: number,
    overrides: { contactEmail?: string | null } = {},
  ) {
    const contactEmail =
      'contactEmail' in overrides ? overrides.contactEmail : `stuck${decidedMinutesAgo}@example.com`;
    const account = await testDb.prisma.account.create({
      data: {
        companyName: `Stuck Co ${decidedMinutesAgo}`,
        segment: 'Offshore support vessel operator',
        hub: 'Haiphong',
        icpScore: 50,
        icpBand: 'med',
        relationshipSummary: 'New account',
        currentTier: 2,
        tierRationale: 'New account — rollout default',
        contacts: contactEmail
          ? { create: { name: 'Contact', role: 'role', email: contactEmail } }
          : undefined,
      },
    });
    const message = await testDb.prisma.message.create({
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
    return { account, message };
  }

  it('sends a message that has been approved but unsent past the staleness threshold', async () => {
    const { message } = await seedApproved(30);

    const result = await reconcileStuckSends(testDb.prisma, 'sandbox', { staleAfterMinutes: 5 });

    expect(result.dispatched).toBe(1);
    expect(result.flagged).toBe(0);

    const updated = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(updated.status).toBe('sent');
    expect(updated.sentAt).not.toBeNull();
  });

  it('leaves a recently-approved message alone — its own dispatch may still be in flight', async () => {
    const { message } = await seedApproved(1);

    const result = await reconcileStuckSends(testDb.prisma, 'sandbox', { staleAfterMinutes: 5 });

    expect(result.dispatched).toBe(0);
    expect(result.flagged).toBe(0);

    const untouched = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(untouched.status).toBe('approved');
  });

  it('flags a message for human attention when the account has no contact email, without retrying', async () => {
    const { account, message } = await seedApproved(30, { contactEmail: null });

    const result = await reconcileStuckSends(testDb.prisma, 'sandbox', { staleAfterMinutes: 5 });

    expect(result.dispatched).toBe(0);
    expect(result.flagged).toBe(1);

    const updated = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(updated.status).toBe('needs_triage');

    const events = await testDb.prisma.tierHistoryEvent.findMany({
      where: { accountId: account.id, relatedMessageId: message.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].reason).toMatch(/could not be sent/i);
  });

  it('flags a message for human attention when the account escalated after approval, without retrying', async () => {
    const { account, message } = await seedApproved(30);
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

    const result = await reconcileStuckSends(testDb.prisma, 'sandbox', { staleAfterMinutes: 5 });

    expect(result.dispatched).toBe(0);
    expect(result.flagged).toBe(1);

    const updated = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(updated.status).toBe('needs_triage');

    const events = await testDb.prisma.tierHistoryEvent.findMany({
      where: { accountId: account.id, relatedMessageId: message.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].reason).toMatch(/could not be sent/i);
  });

  it('flags a stuck autonomous message for human attention when paused mid-flight, without retrying', async () => {
    const { account, message } = await seedApproved(30);
    await testDb.prisma.message.update({
      where: { id: message.id },
      data: { tierContext: 1, decidedBy: 'system (autonomous)' },
    });
    await testDb.prisma.setting.upsert({
      where: { id: 1 },
      update: { autonomousSendingEnabled: false },
      create: { id: 1, autonomousSendingEnabled: false },
    });

    const result = await reconcileStuckSends(testDb.prisma, 'sandbox', { staleAfterMinutes: 5 });

    expect(result.dispatched).toBe(0);
    expect(result.flagged).toBe(1);

    const updated = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(updated.status).toBe('needs_triage');

    const events = await testDb.prisma.tierHistoryEvent.findMany({
      where: { accountId: account.id, relatedMessageId: message.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].reason).toMatch(/paused/i);
  });
});
