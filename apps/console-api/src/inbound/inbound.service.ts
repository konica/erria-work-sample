import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@erria/db';
import { PRISMA } from '../prisma/prisma.module.js';
import { WorkerClient } from '../worker-client/worker-client.service.js';
import type { InboundMessageDto } from './dto/inbound-message.dto.js';

@Injectable()
export class InboundService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly workerClient: WorkerClient,
  ) {}

  async receiveInbound(dto: InboundMessageDto) {
    const account = await this.prisma.account.findUnique({ where: { id: dto.accountId } });
    if (!account) {
      throw new NotFoundException(`Account ${dto.accountId} not found`);
    }

    const message = await this.prisma.message.create({
      data: {
        accountId: dto.accountId,
        role: 'buyer_inbound',
        body: dto.body,
        // An inbound message is a fact, not a draft awaiting a decision — 'sent' is its terminal
        // state from this system's point of view.
        status: 'sent',
        tierContext: account.currentTier,
        sentAt: new Date(dto.receivedAt),
      },
    });

    // Awaited, unlike the approve→dispatch call in Plan 2: classification decides whether the
    // account is now escalated, and the caller needs that answer before it can do anything sensible.
    const classification = await this.workerClient.classifyInbound(message.id);

    return { messageId: message.id, ...classification };
  }
}
