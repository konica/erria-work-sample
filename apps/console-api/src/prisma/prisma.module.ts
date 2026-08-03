import { Global, Module } from '@nestjs/common';
import { prisma } from '@erria/db';
import { PrismaShutdownService } from './prisma-shutdown.service.js';

export const PRISMA = Symbol('PRISMA');

@Global()
@Module({
  providers: [{ provide: PRISMA, useValue: prisma }, PrismaShutdownService],
  exports: [PRISMA],
})
export class PrismaModule {}
