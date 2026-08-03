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
        include: { account: true, trigger: { include: { vessel: true } } },
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
        // Contact enrichment isn't wired into the incoming-trigger payload yet
        // (Task 9's DTO has no contact field) — always null until a later plan
        // adds it. Documented gap, not a bug.
        contact: null as string | null,
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
