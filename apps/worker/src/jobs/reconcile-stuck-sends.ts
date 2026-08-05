import type { PrismaClient } from '@erria/db';
import { dispatchMessage, type DispatchMode } from '@erria/domain';

export interface ReconcileOptions {
  staleAfterMinutes: number;
}

export interface ReconcileResult {
  dispatched: number;
  flagged: number;
}

/**
 * Architecture §5 Flow 2 step 3: approving returns before the send happens, so a failed async
 * dispatch leaves a message 'approved' with no sentAt and nothing watching it. This sweep is that
 * watcher — it retries each stuck message exactly once through the same dispatchMessage path the
 * approve flow uses, so idempotency and the escalation/contact checks are never duplicated here.
 * A retry that also fails is flagged for a human rather than retried forever.
 */
export async function reconcileStuckSends(
  prisma: PrismaClient,
  dispatchMode: DispatchMode,
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const cutoff = new Date(Date.now() - options.staleAfterMinutes * 60_000);

  const stuck = await prisma.message.findMany({
    where: { status: 'approved', sentAt: null, decidedAt: { lt: cutoff } },
  });

  const result: ReconcileResult = { dispatched: 0, flagged: 0 };

  for (const message of stuck) {
    const outcome = await dispatchMessage(dispatchMode, { messageId: message.id }, { prisma });

    if (outcome.status === 'sent') {
      result.dispatched += 1;
      continue;
    }

    if (outcome.status === 'already_sent') {
      continue;
    }

    await flagForHuman(prisma, message.id, message.accountId, reasonFor(outcome));
    result.flagged += 1;
  }

  return result;
}

function reasonFor(
  outcome:
    | { status: 'refused'; reason: 'not_approved' | 'escalated' }
    | { status: 'unsendable'; reason: 'no_contact_email' }
    | { status: 'not_found' },
): string {
  switch (outcome.status) {
    case 'refused':
      return outcome.reason === 'escalated'
        ? 'Approved message could not be sent — the account escalated before the retry ran.'
        : 'Approved message could not be sent — it is no longer in approved status.';
    case 'unsendable':
      return 'Approved message could not be sent — no contact email on this account.';
    case 'not_found':
      return 'Approved message could not be sent — it could not be found.';
  }
}

async function flagForHuman(
  prisma: PrismaClient,
  messageId: string,
  accountId: string,
  reason: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.message.update({ where: { id: messageId }, data: { status: 'needs_triage' } }),
    prisma.tierHistoryEvent.create({
      data: { accountId, eventType: 'hold_at_tier', reason, relatedMessageId: messageId },
    }),
  ]);
}
