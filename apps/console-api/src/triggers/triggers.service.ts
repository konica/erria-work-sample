import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@erria/db';
import { recordIncomingTrigger } from '@erria/domain';
import { PRISMA } from '../prisma/prisma.module.js';
import { WorkerClient } from '../worker-client/worker-client.service.js';
import type { IncomingTriggerDto } from './dto/incoming-trigger.dto.js';

@Injectable()
export class TriggersService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly workerClient: WorkerClient,
  ) {}

  async receiveTrigger(dto: IncomingTriggerDto) {
    const account = await this.upsertAccount(dto.account);
    const vessel = dto.vessel ? await this.upsertVessel(account.id, dto.vessel) : null;

    const { triggerId } = await recordIncomingTrigger(this.prisma, {
      accountId: account.id,
      vesselId: vessel?.id ?? null,
      category: dto.category,
      description: dto.description,
      source: dto.source,
      confidenceLabel: dto.confidenceLabel,
      verifiabilityNote: dto.verifiabilityNote,
      detectedAt: new Date(dto.detectedAt),
      hasComplianceDeadlineContent: dto.hasComplianceDeadlineContent,
    });

    await this.workerClient.processTrigger(triggerId);

    return { triggerId };
  }

  private async upsertAccount(input: IncomingTriggerDto['account']) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.account.findUnique({ where: { externalRef: input.externalRef } });

      if (existing) {
        return tx.account.update({
          where: { id: existing.id },
          data: {
            companyName: input.companyName,
            segment: input.segment,
            hub: input.hub,
            icpScore: input.icpScore,
            icpBand: input.icpBand,
            relationshipSummary: input.relationshipSummary,
          },
        });
      }

      const created = await tx.account.create({
        data: {
          externalRef: input.externalRef,
          companyName: input.companyName,
          segment: input.segment,
          hub: input.hub,
          icpScore: input.icpScore,
          icpBand: input.icpBand,
          relationshipSummary: input.relationshipSummary,
          currentTier: 2,
          tierRationale: 'New account — rollout default per spec §3 until 2 clean approvals',
        },
      });

      await tx.tierHistoryEvent.create({
        data: {
          accountId: created.id,
          eventType: 'create',
          toTier: 2,
          reason: 'Account created via incoming trigger — rollout default (spec §3)',
        },
      });

      return created;
    });
  }

  private async upsertVessel(accountId: string, input: NonNullable<IncomingTriggerDto['vessel']>) {
    return this.prisma.vessel.upsert({
      where: { imo: input.imo },
      update: { name: input.name, flag: input.flag, accountId },
      create: { accountId, name: input.name, imo: input.imo, flag: input.flag },
    });
  }
}
