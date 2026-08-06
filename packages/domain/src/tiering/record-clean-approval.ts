import type { PrismaClient } from '@erria/db';
import { recommendTierForTrigger } from './recommend-tier.js';

/**
 * Spec §3's promotion counter and spec §8's "core promotion signal": a Tier 2 draft that went out
 * exactly as the agent wrote it, on an account with no negative signal since.
 *
 * Performs the promotion itself as of ADR-0006 (which superseded ADR-0005's deferral). Promotion
 * needs BOTH conditions §3 states — the count and an independently qualifying score — so a
 * well-behaved account with a weak fit stays at Tier 2 forever, which is correct.
 */
export async function recordCleanApproval(prisma: PrismaClient, messageId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const message = await tx.message.findUniqueOrThrow({ where: { id: messageId } });

    if (message.tierContext !== 2 || message.edited) {
      return false;
    }

    // "no negative signal has occurred on this account since" — an Escalation is the only way a
    // negative signal is recorded (see CONTEXT.md's escalation invariant).
    const negativeSignalSince = await tx.escalation.findFirst({
      where: { accountId: message.accountId, createdAt: { gte: message.createdAt } },
    });
    if (negativeSignalSince) {
      return false;
    }

    const account = await tx.account.update({
      where: { id: message.accountId },
      data: { cleanApprovalsCount: { increment: 1 } },
    });

    await tx.tierHistoryEvent.create({
      data: {
        accountId: message.accountId,
        eventType: 'clean_approval',
        fromTier: account.currentTier,
        toTier: account.currentTier,
        reason: `Sent without edits — ${account.cleanApprovalsCount} clean approval(s) on this account.`,
        relatedMessageId: message.id,
      },
    });

    await promoteIfEarned(tx, account.id);

    return true;
  });
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * ADR-0004: earning is the only route to Tier 1, so this is the only code that may set it.
 */
async function promoteIfEarned(tx: Tx, accountId: string): Promise<void> {
  const account = await tx.account.findUniqueOrThrow({ where: { id: accountId } });
  if (account.currentTier === 1) {
    return;
  }

  const settings = await tx.setting.findUnique({ where: { id: 1 } });
  const threshold = settings?.tier1PromotionThreshold ?? 2;
  if (account.cleanApprovalsCount < threshold) {
    return;
  }

  // "Independently qualifies on score" means the BASE tier — before the rollout overlay caps it —
  // is 1. Passing accountAlreadyEarnedTier1: true suppresses the overlay so we read the underlying
  // score judgment, which is exactly the question promotion asks.
  const scoreJudgment = recommendTierForTrigger({
    accountAlreadyEarnedTier1: true,
    icpScore: account.icpScore,
    triggerConfidence: 'high',
    hasComplianceDeadlineContent: false,
  });
  if (scoreJudgment.tier !== 1) {
    return;
  }

  await tx.account.update({
    where: { id: accountId },
    data: {
      currentTier: 1,
      tierRationale:
        `Earned Tier 1: ${account.cleanApprovalsCount} clean approvals, and the account's score ` +
        `independently qualifies. The agent may now send to this account without prior review.`,
    },
  });

  await tx.tierHistoryEvent.create({
    data: {
      accountId,
      eventType: 'promote',
      fromTier: account.currentTier,
      toTier: 1,
      reason:
        `Promoted to Tier 1 — ${account.cleanApprovalsCount} clean approvals met the threshold of ` +
        `${threshold}, and the account's score independently qualifies (both are required).`,
    },
  });
}
