import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
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
   * (ADR-0002/ADR-0006, ticket #25). This is the documented gap, not a shortcut.
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

  it('marks a sample concerning, recording the reviewer, without changing the account tier (spec §10)', async () => {
    const { account, sample } = await seedAuditSample();
    const service = new AuditService(testDb.prisma);

    const result = await service.mark(sample.id, 'concerning', 'Minh Tran');

    expect(result.auditSample.reviewStatus).toBe('concerning');
    expect(result.auditSample.reviewedBy).toBe('Minh Tran');
    expect(result.auditSample.reviewedAt).not.toBeNull();

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.currentTier).toBe(2);

    const events = await testDb.prisma.tierHistoryEvent.findMany({ where: { accountId: account.id } });
    expect(events).toHaveLength(0);
  });

  it('keeps a concerning sample in the list for pattern-spotting', async () => {
    const { sample } = await seedAuditSample();
    const service = new AuditService(testDb.prisma);
    await service.mark(sample.id, 'concerning', 'Minh Tran');

    const result = await service.list({ status: 'concerning', page: 1 });

    expect(result.items.some((item) => item.id === sample.id)).toBe(true);
  });

  it('allows a verdict to be corrected', async () => {
    const { sample } = await seedAuditSample();
    const service = new AuditService(testDb.prisma);

    await service.mark(sample.id, 'concerning', 'Minh Tran');
    const corrected = await service.mark(sample.id, 'fine', 'Minh Tran');

    expect(corrected.auditSample.reviewStatus).toBe('fine');
  });
});
