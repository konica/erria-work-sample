import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@erria/db';
import { PRISMA } from '../prisma/prisma.module.js';

@Injectable()
export class NavCountsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async get() {
    const [review, escalation] = await Promise.all([
      this.prisma.account.count({ where: { messages: { some: { status: 'pending_review' } } } }),
      this.prisma.account.count({ where: { escalations: { some: { status: 'active' } } } }),
    ]);

    return { review, escalation };
  }
}
