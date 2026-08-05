import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@erria/db';
import { PRISMA } from '../prisma/prisma.module.js';
import { WorkerClient } from '../worker-client/worker-client.service.js';
import type { ResolveEscalationDto } from './dto/resolve-escalation.dto.js';

@Injectable()
export class EscalationsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly workerClient: WorkerClient,
  ) {}

  async list(params: { status?: 'active' | 'resolved' }) {
    const escalations = await this.prisma.escalation.findMany({
      where: params.status ? { status: params.status } : {},
      include: { account: true },
      orderBy: { createdAt: 'desc' },
    });

    return {
      items: escalations.map((escalation) => ({
        id: escalation.id,
        accountId: escalation.accountId,
        company: escalation.account.companyName,
        rule: escalation.hardTriggerRule,
        reasonSummary: escalation.reasonSummary,
        recommendedNextStep: escalation.recommendedNextStepEdited ?? escalation.recommendedNextStep,
        status: escalation.status,
        repeatOfResolutionId: escalation.repeatOfResolutionId,
        createdAt: escalation.createdAt.toISOString(),
      })),
    };
  }

  async resolve(
    accountId: string,
    escalationId: string,
    dto: ResolveEscalationDto,
    resolvedBy: string,
  ) {
    const escalation = await this.prisma.escalation.findFirst({
      where: { id: escalationId, accountId },
    });
    if (!escalation) {
      throw new NotFoundException(`Escalation ${escalationId} not found on account ${accountId}`);
    }
    if (escalation.status === 'resolved') {
      throw new ConflictException(`Escalation ${escalationId} is already resolved`);
    }
    if (dto.actionType === 'compose_send' && !dto.followupBody?.trim()) {
      throw new BadRequestException('A follow-up body is required when sending a reply');
    }

    const { resolution, updated, followupMessageId } = await this.prisma.$transaction(async (tx) => {
      let followupMessageId: string | null = null;

      if (dto.actionType === 'compose_send') {
        // Written by a human, so it bypasses drafting entirely and is 'approved' on creation —
        // there is no agent output here for anyone to review.
        const account = await tx.account.findUniqueOrThrow({ where: { id: accountId } });
        const followup = await tx.message.create({
          data: {
            accountId,
            escalationId: escalation.id,
            role: 'human_reply',
            body: dto.followupBody!,
            status: 'approved',
            tierContext: account.currentTier,
            decidedBy: resolvedBy,
            decidedAt: new Date(),
          },
        });
        followupMessageId = followup.id;
      }

      const resolution = await tx.resolution.create({
        data: {
          escalationId: escalation.id,
          accountId,
          actionType: dto.actionType,
          actionTaken: dto.actionTaken,
          followupMessageId,
          followupSentAt: followupMessageId ? new Date() : null,
          outcomeTag: dto.outcomeTag,
          resolvedBy,
        },
      });

      // Spec §9: closes this record only. Account.currentTier is deliberately untouched.
      const updated = await tx.escalation.update({
        where: { id: escalation.id },
        data: { status: 'resolved', resolvedAt: new Date() },
      });

      return { resolution, updated, followupMessageId };
    });

    if (followupMessageId) {
      await this.workerClient.dispatchMessage(followupMessageId);
    }

    return {
      resolution: {
        id: resolution.id,
        actionType: resolution.actionType,
        outcomeTag: resolution.outcomeTag,
        followupMessageId: resolution.followupMessageId,
        timeToResolution: formatDuration(updated.resolvedAt!.getTime() - escalation.createdAt.getTime()),
      },
      escalation: { id: updated.id, status: updated.status },
    };
  }
}

/** Informational only — spec §9 notes no response SLA is currently policy-set. */
function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}
