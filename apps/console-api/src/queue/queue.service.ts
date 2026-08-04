import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@erria/db';
import { PRISMA } from '../prisma/prisma.module.js';

const PAGE_SIZE = 20;

@Injectable()
export class QueueService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(params: { tier?: number; page: number }) {
    const where = {
      status: 'pending_review' as const,
      ...(params.tier ? { tierContext: params.tier } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.message.findMany({
        where,
        include: { account: { include: { contacts: true } }, trigger: { include: { vessel: true } } },
        orderBy: { createdAt: 'asc' },
        skip: (params.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this.prisma.message.count({ where }),
    ]);

    return {
      items: items.map((message) => ({
        accountId: message.accountId,
        company: message.account.companyName,
        vessel: message.trigger?.vessel?.name ?? null,
        contact: message.account.contacts[0]?.name ?? null,
        triggerSummary: message.trigger?.description ?? null,
        icpBand: message.account.icpBand,
        tier: message.tierContext,
        tierWhy: message.account.tierRationale,
        lastActionAt: message.createdAt.toISOString(),
      })),
      total,
      page: params.page,
      pageSize: PAGE_SIZE,
    };
  }
}
