import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { openEscalation } from './open-escalation.js';

describe('openEscalation', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 120_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function seedAccount(currentTier = 2) {
    return testDb.prisma.account.create({
      data: {
        companyName: 'Dai Duong Shipping',
        segment: 'Coastal freight',
        hub: 'Haiphong',
        icpScore: 70,
        icpBand: 'med',
        relationshipSummary: 'Active conversation',
        currentTier,
        tierRationale: 'test',
      },
    });
  }

  it('creates the escalation, drops the account to Tier 3, and records the event', async () => {
    const account = await seedAccount(2);

    const escalation = await openEscalation(testDb.prisma, {
      accountId: account.id,
      triggerMessageId: null,
      rule: 'pricing_question',
      reasonSummary: 'Buyer asked about pricing or commercial terms',
      detail: 'Asks what servicing would cost.',
      recommendedNextStep: 'Hand to an AE for an indicative quote.',
    });

    expect(escalation.status).toBe('active');
    expect(escalation.agentSendDisabled).toBe(true);

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.currentTier).toBe(3);

    const events = await testDb.prisma.tierHistoryEvent.findMany({
      where: { accountId: account.id, eventType: 'escalate' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].fromTier).toBe(2);
    expect(events[0].toTier).toBe(3);
    expect(events[0].relatedEscalationId).toBe(escalation.id);
  });

  it('overrides tier from Tier 1 too — a hard trigger beats any earned standing', async () => {
    const account = await seedAccount(1);

    await openEscalation(testDb.prisma, {
      accountId: account.id,
      triggerMessageId: null,
      rule: 'negative_sentiment',
      reasonSummary: 'Buyer replied with a complaint, correction, or opt-out',
      detail: 'Asked to stop contacting them.',
      recommendedNextStep: 'Suppress outreach and confirm removal.',
    });

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.currentTier).toBe(3);
  });

  it('records the tier event even when the account is already at Tier 3', async () => {
    const account = await seedAccount(3);

    await openEscalation(testDb.prisma, {
      accountId: account.id,
      triggerMessageId: null,
      rule: 'classification_uncertain',
      reasonSummary: 'Could not confirm whether a hard trigger fired',
      detail: 'The classification call timed out.',
      recommendedNextStep: 'Read the reply and decide manually.',
    });

    const events = await testDb.prisma.tierHistoryEvent.findMany({
      where: { accountId: account.id, eventType: 'escalate' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].fromTier).toBe(3);
    expect(events[0].toTier).toBe(3);
  });
});

describe('openEscalation and earned progress', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 120_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function seedWithProgress(count = 4) {
    return testDb.prisma.account.create({
      data: {
        companyName: 'Progress Co',
        segment: 'Coastal freight',
        hub: 'Haiphong',
        icpScore: 80,
        icpBand: 'high',
        relationshipSummary: 'Good history',
        currentTier: 2,
        tierRationale: 'Earning trust',
        cleanApprovalsCount: count,
      },
    });
  }

  const RESETTING = ['negative_sentiment', 'relationship_conflict'] as const;
  const PRESERVING = [
    'pricing_question',
    'technical_compliance_question',
    'non_english_language',
    'classification_uncertain',
  ] as const;

  for (const rule of RESETTING) {
    it(`resets earned progress for ${rule} — trust was damaged`, async () => {
      const account = await seedWithProgress(4);

      await openEscalation(testDb.prisma, {
        accountId: account.id,
        triggerMessageId: null,
        rule,
        reasonSummary: 'test',
        detail: 'test',
        recommendedNextStep: 'test',
      });

      const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
      expect(refreshed.cleanApprovalsCount).toBe(0);

      const event = await testDb.prisma.tierHistoryEvent.findFirstOrThrow({
        where: { accountId: account.id, eventType: 'escalate' },
      });
      expect(event.reason).toMatch(/progress reset|clean-approval progress/i);
    });
  }

  for (const rule of PRESERVING) {
    it(`keeps earned progress for ${rule} — not a trust failure`, async () => {
      const account = await seedWithProgress(4);

      await openEscalation(testDb.prisma, {
        accountId: account.id,
        triggerMessageId: null,
        rule,
        reasonSummary: 'test',
        detail: 'test',
        recommendedNextStep: 'test',
      });

      const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
      expect(refreshed.cleanApprovalsCount).toBe(4);

      const event = await testDb.prisma.tierHistoryEvent.findFirstOrThrow({
        where: { accountId: account.id, eventType: 'escalate' },
      });
      expect(event.reason).toMatch(/progress kept|retained/i);
    });
  }
});
