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

  async function createApprovedMessage(
    overrides: { contactEmail?: string | null; edited?: boolean } = {},
  ) {
    const contactEmail = overrides.contactEmail === undefined ? 'lan.pham@example.com' : overrides.contactEmail;
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
        contacts: contactEmail
          ? { create: { name: 'Ms. Lan Pham', role: 'Technical Superintendent', email: contactEmail } }
          : undefined,
      },
    });

    const message = await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'agent_draft',
        body: 'Hi Ms. Pham, ...',
        status: 'approved',
        tierContext: 2,
        edited: overrides.edited ?? false,
        decidedBy: 'Minh Tran',
        decidedAt: new Date(),
      },
    });
    return { account, message };
  }

  it('marks an approved message sent, stamps sentAt, and counts the clean approval, in sandbox mode', async () => {
    const { account, message } = await createApprovedMessage();

    const result = await dispatchMessage('sandbox', { messageId: message.id }, { prisma: testDb.prisma });

    expect(result).toMatchObject({ status: 'sent', cleanApprovalCounted: true });
    if (result.status !== 'sent') throw new Error('expected status sent');
    expect(result.sentAt).toBeInstanceOf(Date);

    const refreshed = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(refreshed.status).toBe('sent');
    expect(refreshed.role).toBe('agent_sent');
    expect(refreshed.sentAt).not.toBeNull();
    // A sandboxed send must be indistinguishable from a real one to the rest of the domain.
    expect(refreshed.decidedBy).toBe('Minh Tran');

    const refreshedAccount = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshedAccount.cleanApprovalsCount).toBe(1);
  });

  it('derives the subject line from the trigger and vessel and renders it, following spec §6', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
        contacts: { create: { name: 'Ms. Lan Pham', role: 'Technical Superintendent', email: 'lan.pham@example.com' } },
        vessels: { create: { name: 'MV Song Hong Pioneer', imo: `IMO${Date.now()}`, flag: 'Vietnam' } },
      },
      include: { vessels: true },
    });
    const trigger = await testDb.prisma.trigger.create({
      data: {
        accountId: account.id,
        vesselId: account.vessels[0].id,
        category: 'life-raft service window',
        description: 'test',
        source: 'public_data',
        confidenceLabel: 'mid',
        verifiabilityNote: 'test',
        detectedAt: new Date(),
        status: 'drafted',
      },
    });
    const message = await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        triggerId: trigger.id,
        role: 'agent_draft',
        body: 'Hi Ms. Pham, ...',
        status: 'approved',
        tierContext: 2,
        decidedBy: 'Minh Tran',
        decidedAt: new Date(),
      },
    });

    await dispatchMessage('sandbox', { messageId: message.id }, { prisma: testDb.prisma });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Quick note on MV Song Hong Pioneer's life-raft service window"),
    );
  });

  it('makes no outbound network call in sandbox mode', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { message } = await createApprovedMessage();

    await dispatchMessage('sandbox', { messageId: message.id }, { prisma: testDb.prisma });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails with a clear not-implemented error in graph mode, leaving the message untouched', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { message } = await createApprovedMessage();

    await expect(
      dispatchMessage('graph', { messageId: message.id }, { prisma: testDb.prisma }),
    ).rejects.toThrow(NotImplementedFlowError);

    expect(fetchSpy).not.toHaveBeenCalled();

    const refreshed = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(refreshed.status).toBe('approved');
    expect(refreshed.sentAt).toBeNull();
  });

  it('is idempotent — dispatching an already-sent message sends nothing further', async () => {
    const { message } = await createApprovedMessage();
    await dispatchMessage('sandbox', { messageId: message.id }, { prisma: testDb.prisma });
    const firstSend = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });

    const second = await dispatchMessage('sandbox', { messageId: message.id }, { prisma: testDb.prisma });

    expect(second).toEqual({ messageId: message.id, status: 'already_sent' });
    const refreshed = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(refreshed.sentAt).toEqual(firstSend.sentAt);
  });

  it('refuses to dispatch a message that was never approved', async () => {
    const { message } = await createApprovedMessage();
    await testDb.prisma.message.update({ where: { id: message.id }, data: { status: 'pending_review' } });

    const result = await dispatchMessage('sandbox', { messageId: message.id }, { prisma: testDb.prisma });

    expect(result).toEqual({ messageId: message.id, status: 'refused', reason: 'not_approved' });
  });

  it('refuses to dispatch when an escalation opened after approval', async () => {
    const { account, message } = await createApprovedMessage();
    await testDb.prisma.escalation.create({
      data: {
        accountId: account.id,
        hardTriggerRule: 'negative_sentiment',
        reasonSummary: 'Buyer asked to stop',
        detail: 'test',
        recommendedNextStep: 'Human review',
        agentSendDisabled: true,
        status: 'active',
      },
    });

    const result = await dispatchMessage('sandbox', { messageId: message.id }, { prisma: testDb.prisma });

    expect(result).toEqual({ messageId: message.id, status: 'refused', reason: 'escalated' });
    const refreshed = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(refreshed.status).toBe('approved');
    expect(refreshed.sentAt).toBeNull();
  });

  it('reports an account with no contact email as unsendable rather than failing silently', async () => {
    const { message } = await createApprovedMessage({ contactEmail: null });

    const result = await dispatchMessage('sandbox', { messageId: message.id }, { prisma: testDb.prisma });

    expect(result).toEqual({ messageId: message.id, status: 'unsendable', reason: 'no_contact_email' });
    const refreshed = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(refreshed.status).toBe('approved');
    expect(refreshed.sentAt).toBeNull();
  });

  it('does not count an edited send toward Clean Approval', async () => {
    const { account, message } = await createApprovedMessage({ edited: true });

    const result = await dispatchMessage('sandbox', { messageId: message.id }, { prisma: testDb.prisma });

    expect(result).toMatchObject({ status: 'sent', cleanApprovalCounted: false });
    const refreshedAccount = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshedAccount.cleanApprovalsCount).toBe(0);
  });
});
