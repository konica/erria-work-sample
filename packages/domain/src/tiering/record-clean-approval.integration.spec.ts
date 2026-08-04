import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { recordCleanApproval } from './record-clean-approval.js';

describe('recordCleanApproval', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 120_000);

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

    const counted = await recordCleanApproval(testDb.prisma, message.id);

    expect(counted).toBe(true);
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

    const counted = await recordCleanApproval(testDb.prisma, message.id);

    expect(counted).toBe(false);
    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.cleanApprovalsCount).toBe(0);
  });

  it('does not count a message whose tier context was not 2', async () => {
    const { account, message } = await seedSentMessage({ tierContext: 3 });

    const counted = await recordCleanApproval(testDb.prisma, message.id);

    expect(counted).toBe(false);
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

    const counted = await recordCleanApproval(testDb.prisma, message.id);

    expect(counted).toBe(false);
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
