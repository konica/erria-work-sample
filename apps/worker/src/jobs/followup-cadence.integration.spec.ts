import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { runFollowupCadence } from './followup-cadence.js';

function fakeAnthropicClient(confidence: 'high' | 'mid' = 'high'): Anthropic {
  return {
    messages: {
      parse: vi.fn().mockResolvedValue({
        parsed_output: {
          should_draft: true,
          draft_text: 'Following up — we now have slots on 12-14 Aug.',
          confidence_label: confidence,
          abstain_reason: null,
        },
        usage: { input_tokens: 300, output_tokens: 50 },
      }),
    },
  } as unknown as Anthropic;
}

describe('runFollowupCadence', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
    await testDb.prisma.setting.upsert({
      where: { id: 1 },
      update: { autonomousSendingEnabled: true, maxFollowups: 2, minDaysBetweenFollowups: 5 },
      create: { id: 1, autonomousSendingEnabled: true, maxFollowups: 2, minDaysBetweenFollowups: 5 },
    });
  }, 120_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function seedSentTier1(daysAgo: number) {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: `Cadence Co ${daysAgo}-${Math.random().toString(36).slice(2, 7)}`,
        segment: 'Coastal freight',
        hub: 'Haiphong',
        icpScore: 90,
        icpBand: 'high',
        relationshipSummary: 'Earned Tier 1',
        currentTier: 1,
        tierRationale: 'Earned',
        contacts: { create: { name: 'Contact', role: 'role', email: `cad${Math.random()}@example.com` } },
      },
    });
    const trigger = await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'life-raft service window',
        description: 'original reason',
        source: 'public_data',
        confidenceLabel: 'high',
        verifiabilityNote: 'n',
        detectedAt: new Date(Date.now() - daysAgo * 86_400_000),
        status: 'drafted',
      },
    });
    const sentAt = new Date(Date.now() - daysAgo * 86_400_000);
    await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        triggerId: trigger.id,
        role: 'agent_sent',
        body: 'first message',
        status: 'sent',
        tierContext: 1,
        sentAt,
      },
    });
    return { account, trigger, sentAt };
  }

  it('ends the sequence and makes no Claude call when nothing new exists', async () => {
    const { trigger } = await seedSentTier1(10);
    const anthropic = fakeAnthropicClient();

    const result = await runFollowupCadence(testDb.prisma, anthropic, 'sandbox');

    expect(result.sequencesEnded).toBeGreaterThanOrEqual(1);
    expect(result.followupsSent).toBe(0);
    // The point of the design: no news costs no tokens and cannot invent news.
    expect(anthropic.messages.parse).not.toHaveBeenCalled();

    const updated = await testDb.prisma.trigger.findUniqueOrThrow({ where: { id: trigger.id } });
    expect(updated.status).toBe('sequence_ended');
  });

  it('sends a follow-up citing only the new fact', async () => {
    const { account, sentAt } = await seedSentTier1(10);
    await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'station availability',
        description: 'Vung Tau slots opened 12-14 Aug',
        source: 'crm',
        confidenceLabel: 'high',
        verifiabilityNote: 'confirmed internally',
        detectedAt: new Date(sentAt.getTime() + 86_400_000),
        status: 'new',
      },
    });
    const anthropic = fakeAnthropicClient();

    const result = await runFollowupCadence(testDb.prisma, anthropic, 'sandbox');

    expect(result.followupsSent).toBe(1);

    const followup = await testDb.prisma.message.findFirstOrThrow({
      where: { accountId: account.id, isFollowup: true },
    });
    expect(followup.status).toBe('sent');
    expect(followup.followupSequenceNumber).toBe(1);
    expect(followup.decidedBy).toBe('system (autonomous)');
    expect(followup.tierContext).toBe(1);
  });

  it('leaves an account alone before the minimum interval has elapsed', async () => {
    const { account, sentAt } = await seedSentTier1(1);
    await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'station availability',
        description: 'new but too soon',
        source: 'crm',
        confidenceLabel: 'high',
        verifiabilityNote: 'n',
        detectedAt: new Date(sentAt.getTime() + 3600_000),
        status: 'new',
      },
    });
    const anthropic = fakeAnthropicClient();

    const result = await runFollowupCadence(testDb.prisma, anthropic, 'sandbox');

    expect(result.followupsSent).toBe(0);
    expect(result.sequencesEnded).toBe(0);
    expect(anthropic.messages.parse).not.toHaveBeenCalled();
  });

  it('stops at the configured maximum number of follow-ups', async () => {
    const { account, trigger, sentAt } = await seedSentTier1(10);
    for (const n of [1, 2]) {
      await testDb.prisma.message.create({
        data: {
          accountId: account.id,
          triggerId: trigger.id,
          role: 'agent_sent',
          body: `followup ${n}`,
          status: 'sent',
          tierContext: 1,
          isFollowup: true,
          followupSequenceNumber: n,
          sentAt: new Date(sentAt.getTime() + n * 86_400_000),
        },
      });
    }
    await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'station availability',
        description: 'still new',
        source: 'crm',
        confidenceLabel: 'high',
        verifiabilityNote: 'n',
        detectedAt: new Date(),
        status: 'new',
      },
    });
    const anthropic = fakeAnthropicClient();

    const result = await runFollowupCadence(testDb.prisma, anthropic, 'sandbox');

    expect(result.followupsSent).toBe(0);
    expect(anthropic.messages.parse).not.toHaveBeenCalled();
  });

  it('ends the cadence once a buyer has replied', async () => {
    const { account, sentAt } = await seedSentTier1(10);
    await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'buyer_inbound',
        body: 'Thanks, we are all set for now.',
        status: 'sent',
        tierContext: 1,
        sentAt: new Date(sentAt.getTime() + 3600_000),
      },
    });
    await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'station availability',
        description: 'new fact after reply',
        source: 'crm',
        confidenceLabel: 'high',
        verifiabilityNote: 'n',
        detectedAt: new Date(sentAt.getTime() + 7200_000),
        status: 'new',
      },
    });
    const anthropic = fakeAnthropicClient();

    const result = await runFollowupCadence(testDb.prisma, anthropic, 'sandbox');

    expect(result.followupsSent).toBe(0);
    expect(result.sequencesEnded).toBe(0);
    expect(anthropic.messages.parse).not.toHaveBeenCalled();
  });

  it('leaves a Tier 2 account alone even with a sent message and elapsed interval', async () => {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: `Tier2 Co ${Math.random().toString(36).slice(2, 7)}`,
        segment: 'Coastal freight',
        hub: 'Haiphong',
        icpScore: 40,
        icpBand: 'med',
        relationshipSummary: 'Not yet earned',
        currentTier: 2,
        tierRationale: 'Rollout default',
        contacts: { create: { name: 'Contact', role: 'role', email: 'tier2@example.com' } },
      },
    });
    const sentAt = new Date(Date.now() - 10 * 86_400_000);
    const trigger = await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'life-raft service window',
        description: 'original reason',
        source: 'public_data',
        confidenceLabel: 'high',
        verifiabilityNote: 'n',
        detectedAt: sentAt,
        status: 'drafted',
      },
    });
    await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        triggerId: trigger.id,
        role: 'agent_sent',
        body: 'first message',
        status: 'sent',
        tierContext: 2,
        sentAt,
      },
    });
    await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'station availability',
        description: 'new fact',
        source: 'crm',
        confidenceLabel: 'high',
        verifiabilityNote: 'n',
        detectedAt: new Date(sentAt.getTime() + 86_400_000),
        status: 'new',
      },
    });
    const anthropic = fakeAnthropicClient();

    const result = await runFollowupCadence(testDb.prisma, anthropic, 'sandbox');

    expect(result.followupsSent).toBe(0);
    expect(result.followupsHeld).toBe(0);
    expect(result.sequencesEnded).toBe(0);
    expect(anthropic.messages.parse).not.toHaveBeenCalled();
  });

  // Kept last: a held follow-up never advances Message.sentAt, so the account it holds for stays
  // an eligible candidate on every later run — including later tests sharing this same database.
  it('holds a mid-confidence follow-up for approval instead of sending it', async () => {
    const { account, sentAt } = await seedSentTier1(10);
    await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        category: 'station availability',
        description: 'new fact',
        source: 'crm',
        confidenceLabel: 'high',
        verifiabilityNote: 'n',
        detectedAt: new Date(sentAt.getTime() + 86_400_000),
        status: 'new',
      },
    });
    const anthropic = fakeAnthropicClient('mid');

    const result = await runFollowupCadence(testDb.prisma, anthropic, 'sandbox');

    expect(result.followupsSent).toBe(0);
    expect(result.followupsHeld).toBe(1);

    const held = await testDb.prisma.message.findFirstOrThrow({
      where: { accountId: account.id, isFollowup: true },
    });
    expect(held.status).toBe('pending_review');
    expect(held.tierContext).toBe(2);
    expect(held.hardRuleFlags).toContain('low_confidence_hold');
  });
});
