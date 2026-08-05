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

  it('defaults a trigger to not citing a compliance deadline, and persists it when true', async () => {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Deadline Co',
        segment: 'x',
        hub: 'y',
        icpScore: 50,
        icpBand: 'med',
        relationshipSummary: 'x',
        currentTier: 2,
        tierRationale: 'x',
      },
    });

    const defaulted = await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'c',
        description: 'd',
        source: 'public_data',
        confidenceLabel: 'high',
        verifiabilityNote: 'n',
        detectedAt: new Date(),
      },
    });
    expect(defaulted.hasComplianceDeadlineContent).toBe(false);

    const flagged = await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'c',
        description: 'd',
        source: 'public_data',
        confidenceLabel: 'high',
        verifiabilityNote: 'n',
        detectedAt: new Date(),
        hasComplianceDeadlineContent: true,
      },
    });
    expect(flagged.hasComplianceDeadlineContent).toBe(true);
  });
});
