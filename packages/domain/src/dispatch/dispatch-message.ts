import type { PrismaClient } from '@erria/db';
import type { DispatchMode } from './dispatch-mode.js';
import { NotImplementedFlowError } from '../errors.js';

export interface DispatchMessageInput {
  messageId: string;
}

export interface DispatchMessageResult {
  messageId: string;
  status: 'sent';
  sentAt: Date;
}

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

  const message = await deps.prisma.message.update({
    where: { id: input.messageId },
    data: { status: 'sent', sentAt: new Date() },
  });

  return { messageId: message.id, status: 'sent', sentAt: message.sentAt as Date };
}
