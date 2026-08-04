import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@erria/db';
import { PRISMA } from '../prisma/prisma.module.js';

@Injectable()
export class MessagesService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async editDraft(accountId: string, messageId: string, body: string) {
    const message = await this.requirePendingDraft(accountId, messageId);

    return this.prisma.message.update({
      where: { id: messageId },
      data: {
        body,
        // Set once, on the first edit: originalBody is the agent's text, and a second human edit
        // must not overwrite it with the first human revision.
        originalBody: message.originalBody ?? message.body,
        edited: true,
      },
    });
  }

  async rejectDraft(accountId: string, messageId: string, decidedBy: string) {
    const message = await this.requirePendingDraft(accountId, messageId);

    return this.prisma.message.update({
      where: { id: message.id },
      data: { status: 'rejected', decidedBy, decidedAt: new Date() },
    });
  }

  async approveDraft(accountId: string, messageId: string, decidedBy: string) {
    const message = await this.requirePendingDraft(accountId, messageId);
    await this.requireAgentSendAllowed(accountId);

    return this.prisma.message.update({
      where: { id: message.id },
      data: { status: 'approved', decidedBy, decidedAt: new Date() },
    });
  }

  private async requirePendingDraft(accountId: string, messageId: string) {
    const message = await this.prisma.message.findFirst({ where: { id: messageId, accountId } });
    if (!message) {
      throw new NotFoundException(`Message ${messageId} not found on account ${accountId}`);
    }
    if (message.status !== 'pending_review') {
      throw new ConflictException(
        `Message ${messageId} is ${message.status}, not pending review — it can no longer be edited or decided`,
      );
    }
    return message;
  }

  /**
   * Spec §9: once a thread has escalated, agent-send is permanently disabled for it. No Escalation
   * rows exist until Plan 3, so this returns without objection today — it is written now because a
   * send guard added after the sends exist is a guard that was missing when it mattered.
   */
  private async requireAgentSendAllowed(accountId: string) {
    const blocking = await this.prisma.escalation.findFirst({
      where: { accountId, status: 'active', agentSendDisabled: true },
    });
    if (blocking) {
      throw new ConflictException(
        `Account ${accountId} has an active escalation (${blocking.hardTriggerRule}) — agent-authored sends are disabled for this thread`,
      );
    }
  }
}
