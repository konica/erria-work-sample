import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { EscalationsService } from './escalations.service.js';

describe('EscalationsService', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  async function seedActiveEscalation() {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Vinh Long Coastal',
        segment: 'Coastal freight',
        hub: 'Haiphong',
        icpScore: 60,
        icpBand: 'med',
        relationshipSummary: 'Active',
        currentTier: 3,
        tierRationale: 'Escalated',
      },
    });
    const escalation = await testDb.prisma.escalation.create({
      data: {
        accountId: account.id,
        hardTriggerRule: 'pricing_question',
        reasonSummary: 'Buyer asked about pricing or commercial terms',
        detail: 'Asks what servicing would cost.',
        recommendedNextStep: 'Hand to an AE.',
        agentSendDisabled: true,
        status: 'active',
      },
    });
    return { account, escalation };
  }

  it('lists active escalations', async () => {
    const { account } = await seedActiveEscalation();
    const service = new EscalationsService(testDb.prisma, { dispatchMessage: async () => {} } as never);

    const result = await service.list({ status: 'active' });

    expect(result.items.some((item) => item.accountId === account.id)).toBe(true);
  });

  it('does not list a resolved escalation under the active filter', async () => {
    const { account, escalation } = await seedActiveEscalation();
    const service = new EscalationsService(testDb.prisma, { dispatchMessage: async () => {} } as never);
    await service.resolve(
      account.id,
      escalation.id,
      { actionType: 'mark_resolved', actionTaken: 'Handled', outcomeTag: 'closed_no_action' },
      'Minh Tran',
    );

    const result = await service.list({ status: 'active' });

    expect(result.items.some((item) => item.accountId === account.id)).toBe(false);
  });

  it('records a Resolution on mark_resolved and closes the escalation', async () => {
    const { account, escalation } = await seedActiveEscalation();
    const service = new EscalationsService(testDb.prisma, { dispatchMessage: async () => {} } as never);

    const result = await service.resolve(
      account.id,
      escalation.id,
      {
        actionType: 'mark_resolved',
        actionTaken: 'Resolved by phone — quote sent separately',
        outcomeTag: 'closed_no_action',
      },
      'Minh Tran',
    );

    expect(result.escalation.status).toBe('resolved');
    expect(result.resolution.actionType).toBe('mark_resolved');

    const stored = await testDb.prisma.resolution.findFirstOrThrow({
      where: { escalationId: escalation.id },
    });
    expect(stored.outcomeTag).toBe('closed_no_action');
    expect(stored.followupMessageId).toBeNull();
    expect(stored.resolvedBy).toBe('Minh Tran');
  });

  it('never changes the account tier when resolving (spec §9)', async () => {
    const { account, escalation } = await seedActiveEscalation();
    const service = new EscalationsService(testDb.prisma, { dispatchMessage: async () => {} } as never);

    await service.resolve(
      account.id,
      escalation.id,
      { actionType: 'mark_resolved', actionTaken: 'Handled', outcomeTag: 're_engaged' },
      'Minh Tran',
    );

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(refreshed.currentTier).toBe(3);
  });

  it('creates and links a human-authored reply on compose_send, and dispatches it', async () => {
    const { account, escalation } = await seedActiveEscalation();
    const dispatched: string[] = [];
    const service = new EscalationsService(testDb.prisma, {
      dispatchMessage: async (id: string) => {
        dispatched.push(id);
      },
    } as never);

    const result = await service.resolve(
      account.id,
      escalation.id,
      {
        actionType: 'compose_send',
        actionTaken: 'Sent an indicative quote',
        followupBody: 'Thanks for asking — here is an indicative range...',
        outcomeTag: 're_engaged',
      },
      'Minh Tran',
    );

    const followup = await testDb.prisma.message.findFirstOrThrow({
      where: { accountId: account.id, role: 'human_reply' },
    });
    expect(followup.body).toContain('indicative range');
    expect(followup.status).toBe('approved');
    expect(followup.escalationId).toBe(escalation.id);
    expect(result.resolution.followupMessageId).toBe(followup.id);
    expect(dispatched).toContain(followup.id);
  });

  it('refuses to resolve an escalation twice', async () => {
    const { account, escalation } = await seedActiveEscalation();
    const service = new EscalationsService(testDb.prisma, { dispatchMessage: async () => {} } as never);

    await service.resolve(
      account.id,
      escalation.id,
      { actionType: 'mark_resolved', actionTaken: 'Handled', outcomeTag: 'closed_no_action' },
      'Minh Tran',
    );

    await expect(
      service.resolve(
        account.id,
        escalation.id,
        { actionType: 'mark_resolved', actionTaken: 'Again', outcomeTag: 'closed_no_action' },
        'Minh Tran',
      ),
    ).rejects.toThrow(/already resolved/i);
  });

  it('requires a follow-up body for compose_send', async () => {
    const { account, escalation } = await seedActiveEscalation();
    const service = new EscalationsService(testDb.prisma, { dispatchMessage: async () => {} } as never);

    await expect(
      service.resolve(
        account.id,
        escalation.id,
        { actionType: 'compose_send', actionTaken: 'Sent a reply', outcomeTag: 're_engaged' },
        'Minh Tran',
      ),
    ).rejects.toThrow(/follow-?up body/i);
  });

  it('links a new escalation to a prior resolution on the same account, and unlinks it again', async () => {
    const { account, escalation } = await seedActiveEscalation();
    const service = new EscalationsService(testDb.prisma, { dispatchMessage: async () => {} } as never);
    await service.resolve(
      account.id,
      escalation.id,
      { actionType: 'mark_resolved', actionTaken: 'Handled', outcomeTag: 'closed_no_action' },
      'Minh Tran',
    );
    const prior = await testDb.prisma.resolution.findFirstOrThrow({
      where: { escalationId: escalation.id },
    });

    const second = await testDb.prisma.escalation.create({
      data: {
        accountId: account.id,
        hardTriggerRule: 'pricing_question',
        reasonSummary: 'Same dispute resurfaced',
        detail: 'test',
        recommendedNextStep: 'Check the earlier handoff.',
        status: 'active',
      },
    });

    const linked = await service.link(account.id, second.id, prior.id);
    expect(linked.escalation.repeatOfResolutionId).toBe(prior.id);

    const unlinked = await service.unlink(account.id, second.id);
    expect(unlinked.escalation.repeatOfResolutionId).toBeNull();
  });

  it('refuses to link a resolution belonging to a different account', async () => {
    const first = await seedActiveEscalation();
    const service = new EscalationsService(testDb.prisma, { dispatchMessage: async () => {} } as never);
    await service.resolve(
      first.account.id,
      first.escalation.id,
      { actionType: 'mark_resolved', actionTaken: 'Handled', outcomeTag: 'closed_no_action' },
      'Minh Tran',
    );
    const prior = await testDb.prisma.resolution.findFirstOrThrow({
      where: { escalationId: first.escalation.id },
    });

    const other = await seedActiveEscalation();

    await expect(service.link(other.account.id, other.escalation.id, prior.id)).rejects.toThrow(
      /different account/i,
    );
  });

  it('lists prior resolutions on an account as link candidates', async () => {
    const { account, escalation } = await seedActiveEscalation();
    const service = new EscalationsService(testDb.prisma, { dispatchMessage: async () => {} } as never);
    await service.resolve(
      account.id,
      escalation.id,
      { actionType: 'mark_resolved', actionTaken: 'Handled by phone', outcomeTag: 'closed_no_action' },
      'Minh Tran',
    );

    const result = await service.priorResolutions(account.id);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      actionTaken: 'Handled by phone',
      outcomeTag: 'closed_no_action',
      rule: 'pricing_question',
      timeToResolution: '1m',
      followupSentAt: null,
    });
  });

  it('reports followupSentAt on a prior resolution that sent a follow-up', async () => {
    const { account, escalation } = await seedActiveEscalation();
    const service = new EscalationsService(testDb.prisma, { dispatchMessage: async () => {} } as never);
    await service.resolve(
      account.id,
      escalation.id,
      {
        actionType: 'compose_send',
        actionTaken: 'Sent an indicative quote',
        followupBody: 'Thanks for asking — here is an indicative range...',
        outcomeTag: 're_engaged',
      },
      'Minh Tran',
    );

    const result = await service.priorResolutions(account.id);

    expect(result.items).toHaveLength(1);
    expect(typeof result.items[0].followupSentAt).toBe('string');
  });

  it('returns an empty list for an account with no resolved escalations', async () => {
    const { account } = await seedActiveEscalation();
    const service = new EscalationsService(testDb.prisma, { dispatchMessage: async () => {} } as never);

    const result = await service.priorResolutions(account.id);

    expect(result.items).toEqual([]);
  });
});
