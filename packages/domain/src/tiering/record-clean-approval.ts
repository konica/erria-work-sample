import type { PrismaClient } from '@erria/db';

/**
 * Spec §3's promotion counter and spec §8's "core promotion signal": a Tier 2 draft that went out
 * exactly as the agent wrote it, on an account with no negative signal since.
 *
 * Deliberately stops at the counter. Promoting to Tier 1 is ADR-0005's deferred half — Tier 1 means
 * autonomous send, which does not exist (ADR-0002), so an account promoted into it would carry a
 * tier badge describing behavior the system cannot perform and would break its own next trigger.
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

    return true;
  });
}
