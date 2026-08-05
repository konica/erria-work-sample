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
    expect(result?.vessels).toHaveLength(1);
    expect(result?.pendingMessage?.body).toBe('Hi Ms. Pham, ...');
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
