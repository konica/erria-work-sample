import type { PrismaClient } from '@erria/db';
import type { HardTriggerRuleName } from '../classification/decide-hard-trigger.js';

export interface OpenEscalationInput {
  accountId: string;
  triggerMessageId: string | null;
  rule: HardTriggerRuleName;
  reasonSummary: string;
  detail: string;
  recommendedNextStep: string;
}

/**
 * Spec §4: hard triggers "override tier, always". The account goes to Tier 3 whatever it was
 * before — including Tier 1, which is the whole point of calling them hard.
 */
export async function openEscalation(prisma: PrismaClient, input: OpenEscalationInput) {
  return prisma.$transaction(async (tx) => {
    const account = await tx.account.findUniqueOrThrow({ where: { id: input.accountId } });

    const escalation = await tx.escalation.create({
      data: {
        accountId: input.accountId,
        triggerMessageId: input.triggerMessageId,
        hardTriggerRule: input.rule,
        reasonSummary: input.reasonSummary,
        detail: input.detail,
        recommendedNextStep: input.recommendedNextStep,
        agentSendDisabled: true,
        status: 'active',
      },
    });

    if (account.currentTier !== 3) {
      await tx.account.update({
        where: { id: account.id },
        data: {
          currentTier: 3,
          tierRationale: `Escalated — ${input.reasonSummary}. Human handling required for this thread.`,
        },
      });
    }

    // Written even when the tier did not move, so the timeline shows every escalation, not only
    // the ones that happened to change a number.
    await tx.tierHistoryEvent.create({
      data: {
        accountId: account.id,
        eventType: 'escalate',
        fromTier: account.currentTier,
        toTier: 3,
        reason: input.reasonSummary,
        relatedMessageId: input.triggerMessageId,
        relatedEscalationId: escalation.id,
      },
    });

    return escalation;
  });
}
