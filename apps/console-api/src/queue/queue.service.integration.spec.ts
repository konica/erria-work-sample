import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
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
