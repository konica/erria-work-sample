import { Inject, Injectable } from '@nestjs/common';
import { upsertAccount, upsertContact, upsertVessel, type PrismaClient } from '@erria/db';
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
    const { account, vessel } = await this.prisma.$transaction(async (tx) => {
      const account = await upsertAccount(tx, dto.account);
      const vessel = dto.vessel ? await upsertVessel(tx, account.id, dto.vessel) : null;
      if (dto.contact) {
        await upsertContact(tx, account.id, dto.contact);
      }
      return { account, vessel };
    });

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
}
