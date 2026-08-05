import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type Anthropic from '@anthropic-ai/sdk';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { buildServer } from '../../../worker/src/server.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { WorkerClient } from '../worker-client/worker-client.service.js';
import { InboundService } from './inbound.service.js';

describe('InboundService', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();

    const anthropic = {
      messages: {
        parse: vi.fn().mockResolvedValue({
          parsed_output: {
            fires: true,
            rule: 'pricing_question',
            confidence: 'high',
            language_detected: 'en',
            rationale: 'Asks about cost.',
          },
          usage: { input_tokens: 400, output_tokens: 60 },
        }),
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Hand to an AE.' }],
          usage: { input_tokens: 200, output_tokens: 30 },
        }),
      },
    } as unknown as Anthropic;

    const workerServer = buildServer({ prisma: testDb.prisma, anthropic });
    const workerUrl = await workerServer.listen({ port: 0, host: '127.0.0.1' });
    process.env.WORKER_INTERNAL_URL = workerUrl;
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  it('persists the reply and escalates the account', async () => {
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

    const moduleRef = await Test.createTestingModule({
      providers: [InboundService, WorkerClient, { provide: PRISMA, useValue: testDb.prisma }],
    }).compile();
    const service = moduleRef.get(InboundService);

    const result = await service.receiveInbound({
      accountId: account.id,
      body: 'What would servicing the life rafts cost us?',
      receivedAt: new Date().toISOString(),
    });

    expect(result.escalated).toBe(true);

    const stored = await testDb.prisma.message.findFirstOrThrow({
      where: { accountId: account.id, role: 'buyer_inbound' },
    });
    expect(stored.body).toBe('What would servicing the life rafts cost us?');
    expect(stored.status).toBe('sent');

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.currentTier).toBe(3);
  });

  it('rejects an inbound message for an unknown account', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [InboundService, WorkerClient, { provide: PRISMA, useValue: testDb.prisma }],
    }).compile();
    const service = moduleRef.get(InboundService);

    await expect(
      service.receiveInbound({
        accountId: '00000000-0000-0000-0000-000000000000',
        body: 'hello',
        receivedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/not found/i);
  });
});
