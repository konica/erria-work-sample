import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { NavCountsService } from './nav-counts.service.js';

describe('NavCountsService', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function makeAccount() {
    return testDb.prisma.account.create({
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
  }

  it('counts zero when nothing is pending or escalated', async () => {
    const service = new NavCountsService(testDb.prisma);
    const result = await service.get();
    expect(result).toEqual({ review: 0, escalation: 0 });
  });

  it('counts distinct accounts with a pending-review message, ignoring other statuses', async () => {
    const pendingAccount = await makeAccount();
    await testDb.prisma.message.create({
      data: {
        accountId: pendingAccount.id,
        role: 'agent_draft',
        body: 'Hi Ms. Pham, ...',
        status: 'pending_review',
        tierContext: 2,
      },
    });
    // A second pending message on the SAME account must not double-count it.
    await testDb.prisma.message.create({
      data: {
        accountId: pendingAccount.id,
        role: 'agent_draft',
        body: 'Second draft',
        status: 'pending_review',
        tierContext: 2,
      },
    });
    const sentAccount = await makeAccount();
    await testDb.prisma.message.create({
      data: {
        accountId: sentAccount.id,
        role: 'agent_sent',
        body: 'Already sent',
        status: 'sent',
        tierContext: 1,
      },
    });

    const service = new NavCountsService(testDb.prisma);
    const result = await service.get();
    expect(result.review).toBe(1);
  });

  it('counts distinct accounts with an active escalation, ignoring resolved ones', async () => {
    const activeAccount = await makeAccount();
    await testDb.prisma.escalation.create({
      data: {
        accountId: activeAccount.id,
        hardTriggerRule: 'pricing_question',
        reasonSummary: 'Buyer asked for pricing',
        detail: 'Buyer replied asking for pricing on the life-raft service.',
        recommendedNextStep: 'Loop in a human to quote pricing.',
        status: 'active',
      },
    });
    const resolvedAccount = await makeAccount();
    await testDb.prisma.escalation.create({
      data: {
        accountId: resolvedAccount.id,
        hardTriggerRule: 'negative_sentiment',
        reasonSummary: 'Negative sentiment',
        detail: 'Buyer expressed frustration.',
        recommendedNextStep: 'Acknowledge and de-escalate.',
        status: 'resolved',
        resolvedAt: new Date(),
      },
    });

    const service = new NavCountsService(testDb.prisma);
    const result = await service.get();
    expect(result.escalation).toBe(1);
  });
});
