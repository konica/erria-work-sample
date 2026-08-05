import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { buildServer } from '../server.js';

function anthropicReturning(classification: Record<string, unknown> | Error) {
  return {
    messages: {
      parse:
        classification instanceof Error
          ? vi.fn().mockRejectedValue(classification)
          : vi.fn().mockResolvedValue({
              parsed_output: classification,
              usage: { input_tokens: 400, output_tokens: 60 },
            }),
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Hand this to an AE for a quote.' }],
        usage: { input_tokens: 200, output_tokens: 30 },
      }),
    },
  } as unknown as Anthropic;
}

describe('POST /internal/classify-inbound/:messageId', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 120_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function seedInboundReply(body = 'What would servicing cost?') {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Dai Duong Shipping',
        segment: 'Coastal freight',
        hub: 'Haiphong',
        icpScore: 70,
        icpBand: 'med',
        relationshipSummary: 'Active conversation',
        currentTier: 2,
        tierRationale: 'test',
      },
    });
    const message = await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'buyer_inbound',
        body,
        status: 'sent',
        tierContext: 2,
      },
    });
    return { account, message };
  }

  function serverWith(anthropic: Anthropic) {
    return buildServer({ prisma: testDb.prisma, anthropic });
  }

  it('opens an escalation when a rule fires', async () => {
    const { account, message } = await seedInboundReply();
    const server = serverWith(
      anthropicReturning({
        fires: true,
        rule: 'pricing_question',
        confidence: 'high',
        language_detected: 'en',
        rationale: 'Asks what servicing would cost.',
      }),
    );

    const response = await server.inject({
      method: 'POST',
      url: `/internal/classify-inbound/${message.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ escalated: true, rule: 'pricing_question' });

    const escalation = await testDb.prisma.escalation.findFirstOrThrow({
      where: { accountId: account.id },
    });
    expect(escalation.triggerMessageId).toBe(message.id);
    expect(escalation.recommendedNextStep).toContain('AE');

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.currentTier).toBe(3);
  });

  it('escalates as classification_uncertain when the call fails (fail closed)', async () => {
    const { account, message } = await seedInboundReply();
    const server = serverWith(anthropicReturning(new Error('boom')));

    const response = await server.inject({
      method: 'POST',
      url: `/internal/classify-inbound/${message.id}`,
    });

    expect(response.json()).toMatchObject({ escalated: true, rule: 'classification_uncertain' });

    const escalation = await testDb.prisma.escalation.findFirstOrThrow({
      where: { accountId: account.id },
    });
    expect(escalation.hardTriggerRule).toBe('classification_uncertain');
  });

  it('does not escalate a confident, benign reply', async () => {
    const { account, message } = await seedInboundReply('Thanks, noted — I will come back to you.');
    const server = serverWith(
      anthropicReturning({
        fires: false,
        rule: null,
        confidence: 'high',
        language_detected: 'en',
        rationale: 'Acknowledgement only.',
      }),
    );

    const response = await server.inject({
      method: 'POST',
      url: `/internal/classify-inbound/${message.id}`,
    });

    expect(response.json()).toMatchObject({ escalated: false });

    const count = await testDb.prisma.escalation.count({ where: { accountId: account.id } });
    expect(count).toBe(0);

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.currentTier).toBe(2);
  });

  it('records an LlmCall row for the classification', async () => {
    const { account, message } = await seedInboundReply();
    const server = serverWith(
      anthropicReturning({
        fires: true,
        rule: 'pricing_question',
        confidence: 'high',
        language_detected: 'en',
        rationale: 'test',
      }),
    );

    await server.inject({ method: 'POST', url: `/internal/classify-inbound/${message.id}` });

    const calls = await testDb.prisma.llmCall.findMany({
      where: { accountId: account.id, purpose: 'hard_trigger_classification' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].outcome).toBe('success');
  });

  it('rejects a message that is not an inbound reply', async () => {
    const { message } = await seedInboundReply();
    await testDb.prisma.message.update({ where: { id: message.id }, data: { role: 'agent_sent' } });
    const server = serverWith(anthropicReturning({ fires: false, rule: null, confidence: 'high', language_detected: 'en', rationale: 'test' }));

    const response = await server.inject({
      method: 'POST',
      url: `/internal/classify-inbound/${message.id}`,
    });

    expect(response.statusCode).toBe(409);
  });

  it('returns 404 for an unknown message id', async () => {
    const server = serverWith(anthropicReturning({ fires: false, rule: null, confidence: 'high', language_detected: 'en', rationale: 'test' }));

    const response = await server.inject({
      method: 'POST',
      url: '/internal/classify-inbound/8f2b1c4e-0000-4000-8000-000000000000',
    });

    expect(response.statusCode).toBe(404);
  });
});
