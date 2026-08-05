import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@erria/db';
import { PRISMA } from '../prisma/prisma.module.js';

const PAGE_SIZE = 20;

type ReviewStatus = 'unreviewed' | 'fine' | 'concerning';

@Injectable()
export class AuditService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(params: { status?: ReviewStatus; page: number }) {
    const where = params.status ? { reviewStatus: params.status } : {};

    const [samples, total] = await Promise.all([
      this.prisma.auditSample.findMany({
        where,
        include: { account: true, message: true },
        orderBy: { sampledAt: 'desc' },
        skip: (params.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this.prisma.auditSample.count({ where }),
    ]);

    return {
      items: samples.map((sample) => ({
        id: sample.id,
        accountId: sample.accountId,
        company: sample.account.companyName,
        body: sample.message.body,
        sentAt: sample.message.sentAt?.toISOString() ?? null,
        sampledAt: sample.sampledAt.toISOString(),
        reviewStatus: sample.reviewStatus,
        reviewedBy: sample.reviewedBy,
      })),
      total,
      page: params.page,
      pageSize: PAGE_SIZE,
    };
  }

  /**
   * Spec §10: a concerning flag records a pattern; it never demotes the account on its own. Only a
   * real negative signal changes tier, and that path runs through Escalation (Plan 3) — this method
   * touches only the AuditSample row.
   */
  async mark(auditSampleId: string, verdict: 'fine' | 'concerning', reviewedBy: string) {
    const sample = await this.prisma.auditSample.findUnique({ where: { id: auditSampleId } });
    if (!sample) {
      throw new NotFoundException(`Audit sample ${auditSampleId} not found`);
    }

    const updated = await this.prisma.auditSample.update({
      where: { id: auditSampleId },
      data: { reviewStatus: verdict, reviewedBy, reviewedAt: new Date() },
    });

    return {
      auditSample: {
        id: updated.id,
        reviewStatus: updated.reviewStatus,
        reviewedBy: updated.reviewedBy,
        reviewedAt: updated.reviewedAt,
      },
    };
  }
}
