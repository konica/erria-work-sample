import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { buildServer } from '../../../worker/src/server.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { WorkerClient } from '../worker-client/worker-client.service.js';
import { MessagesService } from './messages.service.js';
import { MessagesController } from './messages.controller.js';

describe('MessagesController approve → dispatch', () => {
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

  it('approving a draft results in it actually being sent, without the caller waiting for it', async () => {
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
        contacts: { create: { name: 'Ms. Lan Pham', role: 'Tech Super', email: 'lan2@example.com' } },
      },
    });
    const message = await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'agent_draft',
        body: 'Hi Ms. Pham, ...',
        status: 'pending_review',
        tierContext: 2,
      },
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [MessagesController],
      providers: [MessagesService, WorkerClient, { provide: PRISMA, useValue: testDb.prisma }],
    }).compile();
    const controller = moduleRef.get(MessagesController);

    const result = await controller.approve(account.id, message.id, {
      sub: 'minh.tran',
      name: 'Minh Tran',
      roles: ['reviewer'],
    });
    expect(result.message.status).toBe('approved');
    expect(result.message.decidedBy).toBe('Minh Tran');

    // The approve call itself must not have blocked on the send: it returns before dispatch
    // completes, so we assert the message is NOT yet sent immediately after the await resolves,
    // then wait for the asynchronous dispatch to catch up.
    const immediatelyAfter = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(immediatelyAfter.status).toBe('approved');

    await vi.waitFor(async () => {
      const updated = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
      const refreshedAccount = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
      expect(updated.status).toBe('sent');
      expect(refreshedAccount.cleanApprovalsCount).toBe(1);
    });
  });
});
