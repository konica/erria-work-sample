import type { PrismaClient } from '@erria/db';
import type { DispatchMode } from './dispatch-mode.js';
import { buildSubjectLine } from './subject-line.js';
import { recordCleanApproval } from '../tiering/record-clean-approval.js';
import { NotImplementedFlowError } from '../errors.js';

export interface DispatchMessageInput {
  messageId: string;
}

export type DispatchMessageResult =
  | { messageId: string; status: 'sent'; sentAt: Date; cleanApprovalCounted: boolean }
  | { messageId: string; status: 'already_sent' }
  | { messageId: string; status: 'refused'; reason: 'not_approved' | 'escalated' }
  | { messageId: string; status: 'unsendable'; reason: 'no_contact_email' }
  | { messageId: string; status: 'not_found' };

/**
 * The one place in the domain that reads a dispatch mode and branches on it (application
 * architecture §1, §2 — Message Dispatch is "deliberately isolated"). `sandbox` performs the
 * exact persistence and state transition a real send would, so the rest of the domain — tiering,
 * Clean Approval accounting, the audit trail — cannot tell the two apart (ADR-0007). `graph` is
 * declared but not implemented: it must fail loudly rather than silently no-op, since a silent
 * no-op would look identical to a successful send to anything watching `Message.status`.
 */
export async function dispatchMessage(
  mode: DispatchMode,
  input: DispatchMessageInput,
  deps: { prisma: PrismaClient },
): Promise<DispatchMessageResult> {
  if (mode === 'graph') {
    throw new NotImplementedFlowError(
      "Message dispatch mode 'graph' is declared but not implemented yet — real sending has no " +
        "channel adapter. Select 'sandbox' until a later ticket implements it.",
    );
  }

  const message = await deps.prisma.message.findUnique({
    where: { id: input.messageId },
    include: {
      account: { include: { contacts: true } },
      trigger: { include: { vessel: true } },
    },
  });

  if (!message) {
    return { messageId: input.messageId, status: 'not_found' };
  }

  // Idempotent by design: the reconciliation sweep (and a retried async call) can invoke this for
  // a message that already went out. Sending twice is worse than doing nothing.
  if (message.status === 'sent') {
    return { messageId: message.id, status: 'already_sent' };
  }

  if (message.status !== 'approved') {
    return { messageId: message.id, status: 'refused', reason: 'not_approved' };
  }

  // Re-checked here, not just at approval time: an escalation can open in the window between a
  // human approving and this dispatch running.
  const blocking = await deps.prisma.escalation.findFirst({
    where: { accountId: message.accountId, status: 'active', agentSendDisabled: true },
  });
  if (blocking) {
    return { messageId: message.id, status: 'refused', reason: 'escalated' };
  }

  const recipient = message.account.contacts.find((contact) => contact.email)?.email;
  if (!recipient) {
    return { messageId: message.id, status: 'unsendable', reason: 'no_contact_email' };
  }

  const subject = buildSubjectLine({
    companyName: message.account.companyName,
    vesselName: message.trigger?.vessel?.name ?? null,
    triggerCategory: message.trigger?.category ?? null,
  });

  // No real mail provider (a stated non-goal) — `sandbox` renders what would have been sent and
  // calls nothing external, while performing the exact same persistence a real send would.
  console.log(`[dispatch:sandbox] to=${recipient} subject=${JSON.stringify(subject)}`);

  // Only an agent draft's role changes on send — a human-authored reply is already correctly
  // labeled and must stay that way, or its permanent record misattributes who wrote it.
  const sent = await deps.prisma.message.update({
    where: { id: message.id },
    data: {
      role: message.role === 'agent_draft' ? 'agent_sent' : message.role,
      status: 'sent',
      sentAt: new Date(),
    },
  });

  const cleanApprovalCounted = await recordCleanApproval(deps.prisma, message.id);

  return {
    messageId: sent.id,
    status: 'sent',
    sentAt: sent.sentAt as Date,
    cleanApprovalCounted,
  };
}
