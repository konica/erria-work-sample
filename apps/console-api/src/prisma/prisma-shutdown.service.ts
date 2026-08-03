import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { prisma } from '@erria/db';

@Injectable()
export class PrismaShutdownService implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await prisma.$disconnect();
  }
}
