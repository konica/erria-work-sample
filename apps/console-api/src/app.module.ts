import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module.js';
import { HealthController } from './health/health.controller.js';
import { QueueModule } from './queue/queue.module.js';
import { AccountsModule } from './accounts/accounts.module.js';
import { TriggersModule } from './triggers/triggers.module.js';

@Module({
  imports: [PrismaModule, QueueModule, AccountsModule, TriggersModule],
  controllers: [HealthController],
})
export class AppModule {}
