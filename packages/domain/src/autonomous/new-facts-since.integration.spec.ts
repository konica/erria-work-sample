import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { newFactsSince } from './new-facts-since.js';

describe('newFactsSince', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 120_000);

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
      data: {
        relationshipSummary: 'now a returning customer',
        relationshipSummaryUpdatedAt: new Date(),
      },
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
