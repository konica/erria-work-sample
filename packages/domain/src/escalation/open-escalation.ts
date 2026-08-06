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
 * Rules that indicate damaged trust, and therefore cost the account its earned progress toward
 * Tier 1. Everything else is healthy or neutral — §9 makes the point that a pricing question is a
 * buying signal, and zeroing an account's progress for asking about price would punish exactly the
 * behavior Erria wants from a prospect.
 */
const TRUST_DAMAGING_RULES: ReadonlySet<string> = new Set([
  'negative_sentiment',
  'relationship_conflict',
]);

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

    const resetsProgress = TRUST_DAMAGING_RULES.has(input.rule) && account.cleanApprovalsCount > 0;
    if (resetsProgress) {
      await tx.account.update({
        where: { id: account.id },
        data: { cleanApprovalsCount: 0 },
      });
    }

    const progressNote = TRUST_DAMAGING_RULES.has(input.rule)
      ? ` Clean-approval progress reset to 0 — Tier 1 must be re-earned from scratch.`
      : ` Clean-approval progress kept (${account.cleanApprovalsCount}) — this rule is not a trust failure.`;

    // Written even when the tier did not move, so the timeline shows every escalation, not only
    // the ones that happened to change a number.
    await tx.tierHistoryEvent.create({
      data: {
        accountId: account.id,
        eventType: 'escalate',
        fromTier: account.currentTier,
        toTier: 3,
        reason: `${input.reasonSummary}.${progressNote}`,
        relatedMessageId: input.triggerMessageId,
        relatedEscalationId: escalation.id,
      },
    });

    return escalation;
  });
}
