import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { dispatchMessage } from './dispatch-message.js';
import { NotImplementedFlowError } from '../errors.js';

describe('dispatchMessage', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 120_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createApprovedMessage() {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Song Hong Shipping',
        segment: 'Offshore support vessel operator',
        hub: 'Haiphong',
        icpScore: 90,
        icpBand: 'high',
        relationshipSummary: 'New account · first contact 12 Jul 2026',
        currentTier: 2,
        tierRationale: 'New account — rollout default',
      },
    });

    return testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'agent_draft',
        body: 'Hi Ms. Pham, ...',
        status: 'approved',
        tierContext: 2,
        decidedBy: 'Minh Tran',
        decidedAt: new Date(),
      },
    });
  }

  it('marks an approved message sent and stamps sentAt, in sandbox mode', async () => {
    const message = await createApprovedMessage();

    const result = await dispatchMessage('sandbox', { messageId: message.id }, { prisma: testDb.prisma });

    expect(result.status).toBe('sent');
    expect(result.sentAt).toBeInstanceOf(Date);

    const refreshed = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(refreshed.status).toBe('sent');
    expect(refreshed.sentAt).not.toBeNull();
    // A sandboxed send must be indistinguishable from a real one to the rest of the domain.
    expect(refreshed.decidedBy).toBe('Minh Tran');
  });

  it('makes no outbound network call in sandbox mode', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const message = await createApprovedMessage();

    await dispatchMessage('sandbox', { messageId: message.id }, { prisma: testDb.prisma });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails with a clear not-implemented error in graph mode, leaving the message untouched', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const message = await createApprovedMessage();

    await expect(
      dispatchMessage('graph', { messageId: message.id }, { prisma: testDb.prisma }),
    ).rejects.toThrow(NotImplementedFlowError);

    expect(fetchSpy).not.toHaveBeenCalled();

    const refreshed = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(refreshed.status).toBe('approved');
    expect(refreshed.sentAt).toBeNull();
  });
});
