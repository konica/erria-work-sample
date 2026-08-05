import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { buildServer } from '../../../worker/src/server.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { WorkerClient } from '../worker-client/worker-client.service.js';
import { EscalationsService } from './escalations.service.js';
import { EscalationsController } from './escalations.controller.js';

describe('EscalationsController resolve → dispatch', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();

    const workerServer = buildServer({
      prisma: testDb.prisma,
      anthropic: {} as never,
      dispatchMode: 'sandbox',
    });
    const address = await workerServer.listen({ port: 0, host: '127.0.0.1' });
    process.env.WORKER_INTERNAL_URL =
      typeof address === 'string' ? address : `http://127.0.0.1:${address}`;
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function seedActiveEscalation() {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Song Hong Shipping',
        segment: 'Offshore support vessel operator',
        hub: 'Haiphong',
        icpScore: 90,
        icpBand: 'high',
        relationshipSummary: 'New account',
        currentTier: 3,
        tierRationale: 'Escalated',
        contacts: { create: { name: 'Ms. Lan Pham', role: 'Tech Super', email: 'lan@example.com' } },
      },
    });
    const escalation = await testDb.prisma.escalation.create({
      data: {
        accountId: account.id,
        hardTriggerRule: 'pricing_question',
        reasonSummary: 'Buyer asked about pricing',
        detail: 'test',
        recommendedNextStep: 'Hand to an AE.',
        agentSendDisabled: true,
        status: 'active',
      },
    });
    return { account, escalation };
  }

  it('records the real authenticated principal as resolvedBy, not a hardcoded name', async () => {
    const { account, escalation } = await seedActiveEscalation();

    const moduleRef = await Test.createTestingModule({
      controllers: [EscalationsController],
      providers: [EscalationsService, WorkerClient, { provide: PRISMA, useValue: testDb.prisma }],
    }).compile();
    const controller = moduleRef.get(EscalationsController);

    await controller.resolve(
      account.id,
      escalation.id,
      { actionType: 'mark_resolved', actionTaken: 'Handled by phone', outcomeTag: 'closed_no_action' },
      { sub: 'lan.nguyen', name: 'Lan Nguyen', roles: ['reviewer'] },
    );

    const resolution = await testDb.prisma.resolution.findFirstOrThrow({
      where: { escalationId: escalation.id },
    });
    expect(resolution.resolvedBy).toBe('Lan Nguyen');
  });

  it('resolving with compose_send results in the reply actually being sent, without the caller waiting for it', async () => {
    const { account, escalation } = await seedActiveEscalation();

    const moduleRef = await Test.createTestingModule({
      controllers: [EscalationsController],
      providers: [EscalationsService, WorkerClient, { provide: PRISMA, useValue: testDb.prisma }],
    }).compile();
    const controller = moduleRef.get(EscalationsController);

    const result = await controller.resolve(
      account.id,
      escalation.id,
      {
        actionType: 'compose_send',
        actionTaken: 'Sent an indicative quote',
        followupBody: 'Thanks for asking — here is an indicative range...',
        outcomeTag: 're_engaged',
      },
      { sub: 'lan.nguyen', name: 'Lan Nguyen', roles: ['reviewer'] },
    );

    await vi.waitFor(async () => {
      const followup = await testDb.prisma.message.findUniqueOrThrow({
        where: { id: result.resolution.followupMessageId! },
      });
      expect(followup.status).toBe('sent');
      expect(followup.role).toBe('human_reply');
    });
  });
});
