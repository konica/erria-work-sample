import { Global, Module } from '@nestjs/common';
import { prisma } from '@erria/db';
import { PrismaShutdownService } from './prisma-shutdown.service.js';
import { PRISMA } from './prisma.tokens.js';

export { PRISMA } from './prisma.tokens.js';

@Global()
@Module({
  providers: [{ provide: PRISMA, useValue: prisma }, PrismaShutdownService],
  exports: [PRISMA],
})
export class PrismaModule {}
