import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
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
    expect(result?.account.icpScore).toBe(90);
    expect(result?.vessels).toHaveLength(1);
    expect(result?.pendingMessage?.body).toBe('Hi Ms. Pham, ...');
    expect(result?.pendingMessage?.hardRuleFlags).toBeNull();
  });

  it('includes the pending message trigger trust signals when the message is trigger-backed', async () => {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Cat Ba Logistics',
        segment: 'Coastal freight',
        hub: 'Haiphong',
        icpScore: 75,
        icpBand: 'high',
        relationshipSummary: 'Active',
        currentTier: 2,
        tierRationale: 'Active',
      },
    });
    const trigger = await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'compliance_deadline',
        description: 'Life-raft service window approaching',
        source: 'class_records',
        confidenceLabel: 'high',
        verifiabilityNote: 'Confirmed against class society records',
        detectedAt: new Date('2026-08-01T00:00:00Z'),
      },
    });
    await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        triggerId: trigger.id,
        role: 'agent_draft',
        body: 'Hi, your life-raft service window is approaching...',
        status: 'pending_review',
        tierContext: 2,
      },
    });

    const service = new AccountsService(testDb.prisma);
    const result = await service.getDetail(account.id);

    expect(result?.pendingMessage?.confidenceLabel).toBe('high');
    expect(result?.pendingMessage?.verifiabilityNote).toBe(
      'Confirmed against class society records',
    );
  });

  it('omits the trust fields when there is no pending message', async () => {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Da Nang Shipping',
        segment: 'Coastal freight',
        hub: 'Da Nang',
        icpScore: 40,
        icpBand: 'low',
        relationshipSummary: 'No open thread',
        currentTier: 3,
        tierRationale: 'No open thread',
      },
    });

    const service = new AccountsService(testDb.prisma);
    const result = await service.getDetail(account.id);

    expect(result?.pendingMessage).toBeNull();
  });

  it('surfaces the hold reason on a message the autonomous-send gate held for approval', async () => {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Vung Tau Marine',
        segment: 'Coastal freight',
        hub: 'Haiphong',
        icpScore: 90,
        icpBand: 'high',
        relationshipSummary: 'Earned Tier 1',
        currentTier: 1,
        tierRationale: 'Earned',
      },
    });
    await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'agent_draft',
        body: 'Hi, ...',
        status: 'pending_review',
        tierContext: 2,
        hardRuleFlags: ['autonomous_paused_hold'],
      },
    });

    const service = new AccountsService(testDb.prisma);
    const result = await service.getDetail(account.id);

    expect(result?.pendingMessage?.hardRuleFlags).toEqual(['autonomous_paused_hold']);
  });

  describe('changeTier', () => {
    async function seedAccount(currentTier = 3) {
      return testDb.prisma.account.create({
        data: {
          companyName: 'Vinh Long Coastal',
          segment: 'Coastal freight',
          hub: 'Haiphong',
          icpScore: 60,
          icpBand: 'med',
          relationshipSummary: 'Active',
          currentTier,
          tierRationale: 'Escalated',
        },
      });
    }

    it('moves the account and writes a manual_override event with the reason', async () => {
      const account = await seedAccount(3);
      const service = new AccountsService(testDb.prisma);

      const result = await service.changeTier(account.id, 2, 'Pricing question resolved by AE');

      expect(result.account.currentTier).toBe(2);
      expect(result.tierHistoryEvent.eventType).toBe('manual_override');
      expect(result.tierHistoryEvent.fromTier).toBe(3);
      expect(result.tierHistoryEvent.toTier).toBe(2);
      expect(result.tierHistoryEvent.reason).toContain('Pricing question resolved');

      const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
      expect(refreshed.currentTier).toBe(2);
    });

    it('rejects a manual move to Tier 1 (ADR-0004)', async () => {
      const account = await seedAccount(2);
      const service = new AccountsService(testDb.prisma);

      await expect(service.changeTier(account.id, 1, 'They have been great')).rejects.toThrow(
        /earned/i,
      );

      const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
      expect(refreshed.currentTier).toBe(2);
    });

    it('requires a reason', async () => {
      const account = await seedAccount(3);
      const service = new AccountsService(testDb.prisma);

      await expect(service.changeTier(account.id, 2, '   ')).rejects.toThrow(/reason/i);
    });

    it('rejects a no-op change', async () => {
      const account = await seedAccount(2);
      const service = new AccountsService(testDb.prisma);

      await expect(service.changeTier(account.id, 2, 'No change')).rejects.toThrow(/already/i);
    });

    it('rejects a change on an unknown account', async () => {
      const service = new AccountsService(testDb.prisma);

      await expect(
        service.changeTier('00000000-0000-0000-0000-000000000000', 2, 'Any reason'),
      ).rejects.toThrow(/not found/i);
    });
  });
});

describe('AccountsService.tierHistory', () => {
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
  }

  it('returns events newest first, flagging which were human overrides', async () => {
    const account = await makeAccount();

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
    const account = await makeAccount();

    const service = new AccountsService(testDb.prisma);
    const result = await service.tierHistory(account.id);

    expect(result.items).toEqual([]);
  });
});
