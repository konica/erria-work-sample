import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { recordIncomingTrigger } from './persist-trigger-tier.js';

describe('recordIncomingTrigger', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 120_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function createAccount(overrides: Partial<{ currentTier: number; icpScore: number }> = {}) {
    return testDb.prisma.account.create({
      data: {
        companyName: 'Song Hong Shipping',
        segment: 'Offshore support vessel operator',
        hub: 'Haiphong',
        icpScore: overrides.icpScore ?? 90,
        icpBand: 'high',
        relationshipSummary: 'New account · first contact 12 Jul 2026',
        currentTier: overrides.currentTier ?? 2,
        tierRationale: 'New account — rollout default',
      },
    });
  }

  it('holds a not-yet-earned account at Tier 2 and writes a hold_at_tier event', async () => {
    const account = await createAccount();

    const result = await recordIncomingTrigger(testDb.prisma, {
      accountId: account.id,
      vesselId: null,
      category: 'life-raft service window',
      description: 'test',
      source: 'public_data',
      confidenceLabel: 'high',
      verifiabilityNote: 'test',
      detectedAt: new Date(),
      hasComplianceDeadlineContent: false,
    });

    expect(result.tier).toBe(2);

    const events = await testDb.prisma.tierHistoryEvent.findMany({
      where: { accountId: account.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('hold_at_tier');

    const refreshedAccount = await testDb.prisma.account.findUniqueOrThrow({
      where: { id: account.id },
    });
    expect(refreshedAccount.currentTier).toBe(2);
  });

  it('persists the trigger as processing, linked to its account and vessel', async () => {
    const account = await createAccount();
    const vessel = await testDb.prisma.vessel.create({
      data: { accountId: account.id, name: 'Song Hong 07', imo: '9123456', flag: 'Vietnam' },
    });
    const detectedAt = new Date('2026-07-12T08:30:00.000Z');

    const result = await recordIncomingTrigger(testDb.prisma, {
      accountId: account.id,
      vesselId: vessel.id,
      category: 'life-raft service window',
      description: 'Life-raft service window opens in 6 weeks',
      source: 'class_records',
      confidenceLabel: 'mid',
      verifiabilityNote: 'Derived from public class records; not confirmed with the operator',
      detectedAt,
      hasComplianceDeadlineContent: false,
    });

    const trigger = await testDb.prisma.trigger.findUniqueOrThrow({
      where: { id: result.triggerId },
    });
    expect(trigger).toMatchObject({
      accountId: account.id,
      vesselId: vessel.id,
      category: 'life-raft service window',
      description: 'Life-raft service window opens in 6 weeks',
      source: 'class_records',
      confidenceLabel: 'mid',
      status: 'processing',
    });
    expect(trigger.detectedAt).toEqual(detectedAt);
    expect(result.tierRationale).not.toBe('');
  });

  it('persists whether the incoming trigger cites a compliance deadline', async () => {
    const account = await createAccount();

    const result = await recordIncomingTrigger(testDb.prisma, {
      accountId: account.id,
      vesselId: null,
      category: 'compliance deadline',
      description: 'test',
      source: 'class_records',
      confidenceLabel: 'mid',
      verifiabilityNote: 'test',
      detectedAt: new Date(),
      hasComplianceDeadlineContent: true,
    });

    const trigger = await testDb.prisma.trigger.findUniqueOrThrow({
      where: { id: result.triggerId },
    });
    expect(trigger.hasComplianceDeadlineContent).toBe(true);
  });

  it('caps a Tier-1-earned account to a message-level Tier 2 without changing Account.currentTier', async () => {
    const account = await createAccount({ currentTier: 1 });

    const result = await recordIncomingTrigger(testDb.prisma, {
      accountId: account.id,
      vesselId: null,
      category: 'compliance deadline',
      description: 'test',
      source: 'class_records',
      confidenceLabel: 'high',
      verifiabilityNote: 'test',
      detectedAt: new Date(),
      hasComplianceDeadlineContent: true,
    });

    expect(result.tier).toBe(2);

    const refreshedAccount = await testDb.prisma.account.findUniqueOrThrow({
      where: { id: account.id },
    });
    expect(refreshedAccount.currentTier).toBe(1);

    const events = await testDb.prisma.tierHistoryEvent.findMany({
      where: { accountId: account.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('current_draft');
  });

  // Guards ADR-0003's invariant from the other direction: a Tier-1-earned account whose trigger
  // simply doesn't score high enough for Tier 1 must not be *demoted* by tiering that trigger.
  // Spec §3 reserves demotion for negative signals (Hard-Trigger Rule 3), not weak triggers.
  it('leaves a Tier-1-earned account at Tier 1 when a weak trigger drafts at Tier 2', async () => {
    const account = await createAccount({ currentTier: 1, icpScore: 50 });

    const result = await recordIncomingTrigger(testDb.prisma, {
      accountId: account.id,
      vesselId: null,
      category: 'unclear signal',
      description: 'test',
      source: 'public_data',
      confidenceLabel: 'low',
      verifiabilityNote: 'test',
      detectedAt: new Date(),
      hasComplianceDeadlineContent: false,
    });

    expect(result.tier).toBe(2);

    const refreshedAccount = await testDb.prisma.account.findUniqueOrThrow({
      where: { id: account.id },
    });
    expect(refreshedAccount.currentTier).toBe(1);

    const events = await testDb.prisma.tierHistoryEvent.findMany({
      where: { accountId: account.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('current_draft');
  });

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
});
