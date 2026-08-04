import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { MessagesService } from './messages.service.js';

describe('MessagesService', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function seedPendingDraft(body = 'Original agent text') {
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
      },
    });
    const message = await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'agent_draft',
        body,
        status: 'pending_review',
        tierContext: 2,
      },
    });
    return { account, message };
  }

  describe('editDraft', () => {
    it('records the agent original on the first edit and marks the message edited', async () => {
      const { account, message } = await seedPendingDraft('Original agent text');
      const service = new MessagesService(testDb.prisma);

      const updated = await service.editDraft(account.id, message.id, 'Human-revised text');

      expect(updated.body).toBe('Human-revised text');
      expect(updated.originalBody).toBe('Original agent text');
      expect(updated.edited).toBe(true);
    });

    it('never overwrites the agent original on a second edit', async () => {
      const { account, message } = await seedPendingDraft('Original agent text');
      const service = new MessagesService(testDb.prisma);

      await service.editDraft(account.id, message.id, 'First revision');
      const updated = await service.editDraft(account.id, message.id, 'Second revision');

      expect(updated.body).toBe('Second revision');
      expect(updated.originalBody).toBe('Original agent text');
    });

    it('refuses to edit a message that is no longer pending review', async () => {
      const { account, message } = await seedPendingDraft();
      await testDb.prisma.message.update({ where: { id: message.id }, data: { status: 'sent' } });
      const service = new MessagesService(testDb.prisma);

      await expect(service.editDraft(account.id, message.id, 'too late')).rejects.toThrow(
        /not pending review/i,
      );
    });

    it('refuses to edit a message belonging to a different account', async () => {
      const { message } = await seedPendingDraft();
      const other = await testDb.prisma.account.create({
        data: {
          companyName: 'Other Co',
          segment: 'x',
          hub: 'y',
          icpScore: 10,
          icpBand: 'low',
          relationshipSummary: 'x',
          currentTier: 2,
          tierRationale: 'x',
        },
      });
      const service = new MessagesService(testDb.prisma);

      await expect(service.editDraft(other.id, message.id, 'wrong account')).rejects.toThrow(
        /not found/i,
      );
    });
  });

  describe('rejectDraft', () => {
    it('marks the message rejected and records who decided', async () => {
      const { account, message } = await seedPendingDraft();
      const service = new MessagesService(testDb.prisma);

      const rejected = await service.rejectDraft(account.id, message.id, 'Minh Tran');

      expect(rejected.status).toBe('rejected');
      expect(rejected.decidedBy).toBe('Minh Tran');
      expect(rejected.decidedAt).toBeInstanceOf(Date);
    });

    it('refuses to reject a message that is not pending review', async () => {
      const { account, message } = await seedPendingDraft();
      const service = new MessagesService(testDb.prisma);
      await service.rejectDraft(account.id, message.id, 'Minh Tran');

      await expect(service.rejectDraft(account.id, message.id, 'Minh Tran')).rejects.toThrow(
        /not pending review/i,
      );
    });
  });

  describe('approveDraft', () => {
    it('marks the message approved and records who decided, without sending', async () => {
      const { account, message } = await seedPendingDraft();
      const service = new MessagesService(testDb.prisma);

      const approved = await service.approveDraft(account.id, message.id, 'Minh Tran');

      expect(approved.status).toBe('approved');
      expect(approved.decidedBy).toBe('Minh Tran');
      expect(approved.decidedAt).toBeInstanceOf(Date);
      expect(approved.sentAt).toBeNull();
    });

    it('refuses to approve when the account has an active escalation disabling agent send', async () => {
      const { account, message } = await seedPendingDraft();
      await testDb.prisma.escalation.create({
        data: {
          accountId: account.id,
          hardTriggerRule: 'pricing_question',
          reasonSummary: 'Buyer asked for pricing',
          detail: 'test',
          recommendedNextStep: 'Hand to AE',
          agentSendDisabled: true,
          status: 'active',
        },
      });
      const service = new MessagesService(testDb.prisma);

      await expect(service.approveDraft(account.id, message.id, 'Minh Tran')).rejects.toThrow(
        /escalat/i,
      );
    });

    it('allows approval when the only escalation on the account is already resolved', async () => {
      const { account, message } = await seedPendingDraft();
      await testDb.prisma.escalation.create({
        data: {
          accountId: account.id,
          hardTriggerRule: 'pricing_question',
          reasonSummary: 'Buyer asked for pricing',
          detail: 'test',
          recommendedNextStep: 'Hand to AE',
          agentSendDisabled: true,
          status: 'resolved',
          resolvedAt: new Date(),
        },
      });
      const service = new MessagesService(testDb.prisma);

      const approved = await service.approveDraft(account.id, message.id, 'Minh Tran');
      expect(approved.status).toBe('approved');
    });
  });
});
