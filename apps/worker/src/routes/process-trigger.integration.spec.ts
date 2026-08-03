import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { buildServer } from '../server.js';

function fakeAnthropicClient(parsedOutput: Record<string, unknown>): Anthropic {
  return {
    messages: {
      parse: vi.fn().mockResolvedValue({
        parsed_output: parsedOutput,
        usage: { input_tokens: 500, output_tokens: 120 },
      }),
    },
  } as unknown as Anthropic;
}

function failingAnthropicClient(error: Error): Anthropic {
  return {
    messages: { parse: vi.fn().mockRejectedValue(error) },
  } as unknown as Anthropic;
}

describe('POST /internal/process-trigger/:triggerId', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 120_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function createAccount(companyName: string, overrides: { icpScore?: number } = {}) {
    return testDb.prisma.account.create({
      data: {
        companyName,
        segment: 'Offshore support vessel operator',
        hub: 'Haiphong',
        icpScore: overrides.icpScore ?? 90,
        icpBand: 'high',
        relationshipSummary: 'New account · first contact 12 Jul 2026',
        currentTier: 2,
        tierRationale: 'New account — rollout default',
      },
    });
  }

  async function createTrigger(accountId: string, category: string) {
    return testDb.prisma.trigger.create({
      data: {
        accountId,
        category,
        description: 'test',
        source: 'public_data',
        confidenceLabel: 'mid',
        verifiabilityNote: 'test',
        detectedAt: new Date(),
        status: 'new',
      },
    });
  }

  it('creates a pending_review Message from a successful draft', async () => {
    const account = await createAccount('Song Hong Shipping');
    const trigger = await createTrigger(account.id, 'life-raft service window');

    const anthropic = fakeAnthropicClient({
      should_draft: true,
      draft_text: 'Hi Ms. Pham, ...',
      confidence_label: 'high',
      abstain_reason: null,
    });
    const server = buildServer({ prisma: testDb.prisma, anthropic });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/process-trigger/${trigger.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'drafted' });

    const updatedTrigger = await testDb.prisma.trigger.findUniqueOrThrow({
      where: { id: trigger.id },
    });
    expect(updatedTrigger.status).toBe('drafted');

    const message = await testDb.prisma.message.findFirstOrThrow({
      where: { triggerId: trigger.id },
    });
    expect(message.status).toBe('pending_review');
    expect(message.tierContext).toBe(2);
    expect(message.body).toBe('Hi Ms. Pham, ...');
    expect(message.role).toBe('agent_draft');
  });

  it('records the drafting call in the LlmCall audit trail', async () => {
    const account = await createAccount('Audit Trail Co');
    const trigger = await createTrigger(account.id, 'life-raft service window');

    const anthropic = fakeAnthropicClient({
      should_draft: true,
      draft_text: 'Hi Ms. Pham, ...',
      confidence_label: 'high',
      abstain_reason: null,
    });
    const server = buildServer({ prisma: testDb.prisma, anthropic });

    await server.inject({ method: 'POST', url: `/internal/process-trigger/${trigger.id}` });

    const llmCall = await testDb.prisma.llmCall.findFirstOrThrow({
      where: { accountId: account.id },
    });
    expect(llmCall).toMatchObject({
      purpose: 'draft_generation',
      modelId: 'claude-sonnet-5',
      outcome: 'success',
      requestTokens: 500,
      responseTokens: 120,
      errorDetail: null,
    });
  });

  it('routes to needs_triage when the model abstains', async () => {
    const account = await createAccount('Thin Dossier Co', { icpScore: 50 });
    const trigger = await createTrigger(account.id, 'unclear signal');

    const anthropic = fakeAnthropicClient({
      should_draft: false,
      draft_text: '',
      confidence_label: 'low',
      abstain_reason: 'Dossier too thin to draft anything specific',
    });
    const server = buildServer({ prisma: testDb.prisma, anthropic });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/process-trigger/${trigger.id}`,
    });

    expect(response.json()).toMatchObject({ status: 'needs_triage' });

    const updatedTrigger = await testDb.prisma.trigger.findUniqueOrThrow({
      where: { id: trigger.id },
    });
    expect(updatedTrigger.status).toBe('needs_triage');

    const messageCount = await testDb.prisma.message.count({ where: { triggerId: trigger.id } });
    expect(messageCount).toBe(0);

    // The abstain reason is the only record of *why* a human is being asked to look.
    const event = await testDb.prisma.tierHistoryEvent.findFirstOrThrow({
      where: { accountId: account.id },
    });
    expect(event.reason).toBe('Dossier too thin to draft anything specific');
  });

  it('routes to needs_triage when the drafting call fails outright', async () => {
    const account = await createAccount('Api Failure Co');
    const trigger = await createTrigger(account.id, 'life-raft service window');

    const server = buildServer({
      prisma: testDb.prisma,
      anthropic: failingAnthropicClient(new Error('boom')),
    });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/process-trigger/${trigger.id}`,
    });

    expect(response.json()).toMatchObject({ status: 'needs_triage' });

    const updatedTrigger = await testDb.prisma.trigger.findUniqueOrThrow({
      where: { id: trigger.id },
    });
    expect(updatedTrigger.status).toBe('needs_triage');
    expect(await testDb.prisma.message.count({ where: { triggerId: trigger.id } })).toBe(0);

    // A failure is distinct from an abstention: it must still land in the LlmCall audit trail
    // with a non-success outcome, so the two reasons for triage stay tellable apart.
    const llmCall = await testDb.prisma.llmCall.findFirstOrThrow({
      where: { accountId: account.id },
    });
    expect(llmCall.outcome).toBe('error');
    expect(llmCall.errorDetail).toBe('boom');
  });

  it('returns 404 for an unknown trigger id', async () => {
    const server = buildServer({
      prisma: testDb.prisma,
      anthropic: fakeAnthropicClient({ should_draft: true }),
    });

    const response = await server.inject({
      method: 'POST',
      url: '/internal/process-trigger/8f2b1c4e-0000-4000-8000-000000000000',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'trigger_not_found' });
  });

  it('hands the vessel particulars to the drafting call when the trigger names one', async () => {
    const account = await createAccount('Vessel Dossier Co');
    const vessel = await testDb.prisma.vessel.create({
      data: { accountId: account.id, name: 'Song Hong 09', imo: '9765432', flag: 'Vietnam' },
    });
    const trigger = await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        vesselId: vessel.id,
        category: 'life-raft service window',
        description: 'test',
        source: 'class_records',
        confidenceLabel: 'mid',
        verifiabilityNote: 'test',
        detectedAt: new Date(),
        status: 'new',
      },
    });

    const anthropic = fakeAnthropicClient({
      should_draft: true,
      draft_text: 'Hi Ms. Pham, ...',
      confidence_label: 'high',
      abstain_reason: null,
    });
    const server = buildServer({ prisma: testDb.prisma, anthropic });

    await server.inject({ method: 'POST', url: `/internal/process-trigger/${trigger.id}` });

    const parseMock = vi.mocked(anthropic.messages.parse);
    const userContent = parseMock.mock.calls[0][0].messages[0].content as string;
    expect(userContent).toContain('Song Hong 09');
    expect(userContent).toContain('9765432');
  });
});
