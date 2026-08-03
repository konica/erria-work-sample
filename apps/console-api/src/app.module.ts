import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module.js';
import { HealthController } from './health/health.controller.js';
import { QueueModule } from './queue/queue.module.js';
import { AccountsModule } from './accounts/accounts.module.js';

@Module({
  imports: [PrismaModule, QueueModule, AccountsModule],
  controllers: [HealthController],
})
export class AppModule {}
