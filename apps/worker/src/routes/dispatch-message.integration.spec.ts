import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { buildServer } from '../server.js';

describe('POST /internal/dispatch-message/:messageId', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 120_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function seedApprovedMessage(contactEmail: string | null = 'lan@example.com') {
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
        decidedBy: 'Minh Tran',
        decidedAt: new Date(),
      },
    });
    return { account, message };
  }

  it('sends the message and marks it sent', async () => {
    const { message } = await seedApprovedMessage();
    const server = buildServer({ prisma: testDb.prisma, anthropic: {} as never, dispatchMode: 'sandbox' });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/dispatch-message/${message.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'sent' });

    const updated = await testDb.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(updated.status).toBe('sent');
    expect(updated.sentAt).not.toBeNull();
  });

  it('is idempotent — dispatching an already-sent message reports it was already sent', async () => {
    const { message } = await seedApprovedMessage();
    const server = buildServer({ prisma: testDb.prisma, anthropic: {} as never, dispatchMode: 'sandbox' });

    await server.inject({ method: 'POST', url: `/internal/dispatch-message/${message.id}` });
    const second = await server.inject({ method: 'POST', url: `/internal/dispatch-message/${message.id}` });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: 'already_sent' });
  });

  it('refuses to dispatch a message that was never approved', async () => {
    const { message } = await seedApprovedMessage();
    await testDb.prisma.message.update({ where: { id: message.id }, data: { status: 'pending_review' } });
    const server = buildServer({ prisma: testDb.prisma, anthropic: {} as never, dispatchMode: 'sandbox' });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/dispatch-message/${message.id}`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ status: 'refused', reason: 'not_approved' });
  });

  it('refuses to dispatch when an escalation opened after approval', async () => {
    const { account, message } = await seedApprovedMessage();
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
    const server = buildServer({ prisma: testDb.prisma, anthropic: {} as never, dispatchMode: 'sandbox' });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/dispatch-message/${message.id}`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ status: 'refused', reason: 'escalated' });
  });

  it('refuses to dispatch an autonomous message once autonomous sending is paused', async () => {
    await testDb.prisma.setting.upsert({
      where: { id: 1 },
      update: { autonomousSendingEnabled: false, autonomousPauseReason: 'paused mid-flight' },
      create: { id: 1, autonomousSendingEnabled: false, autonomousPauseReason: 'paused mid-flight' },
    });
    const { message } = await seedApprovedMessage();
    await testDb.prisma.message.update({
      where: { id: message.id },
      data: { tierContext: 1, decidedBy: 'system (autonomous)' },
    });
    const server = buildServer({ prisma: testDb.prisma, anthropic: {} as never, dispatchMode: 'sandbox' });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/dispatch-message/${message.id}`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ status: 'refused', reason: 'autonomous_sending_paused' });
  });

  it('still dispatches a human-approved message while autonomous sending is paused', async () => {
    await testDb.prisma.setting.upsert({
      where: { id: 1 },
      update: { autonomousSendingEnabled: false },
      create: { id: 1, autonomousSendingEnabled: false },
    });
    const { message } = await seedApprovedMessage();
    const server = buildServer({ prisma: testDb.prisma, anthropic: {} as never, dispatchMode: 'sandbox' });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/dispatch-message/${message.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'sent' });
  });

  it('returns 422 when the account has no contact email to send to', async () => {
    const { message } = await seedApprovedMessage(null);
    const server = buildServer({ prisma: testDb.prisma, anthropic: {} as never, dispatchMode: 'sandbox' });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/dispatch-message/${message.id}`,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ status: 'unsendable', reason: 'no_contact_email' });
  });

  it('returns 404 for a message that does not exist', async () => {
    const server = buildServer({ prisma: testDb.prisma, anthropic: {} as never, dispatchMode: 'sandbox' });

    const response = await server.inject({
      method: 'POST',
      url: '/internal/dispatch-message/00000000-0000-0000-0000-000000000000',
    });

    expect(response.statusCode).toBe(404);
  });

  it('defaults to sandbox mode and never reaches graph when dispatchMode is omitted', async () => {
    const { message } = await seedApprovedMessage();
    const server = buildServer({ prisma: testDb.prisma, anthropic: {} as never });

    const response = await server.inject({
      method: 'POST',
      url: `/internal/dispatch-message/${message.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'sent' });
  });
});
