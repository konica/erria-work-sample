import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { PrismaClient } from '@erria/db';
import { PRISMA } from './prisma.tokens.js';

@Injectable()
export class PrismaShutdownService implements OnModuleDestroy {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
