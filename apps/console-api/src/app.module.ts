import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module.js';
import { HealthController } from './health/health.controller.js';
import { QueueModule } from './queue/queue.module.js';
import { AccountsModule } from './accounts/accounts.module.js';
import { TriggersModule } from './triggers/triggers.module.js';
import { NavCountsModule } from './nav-counts/nav-counts.module.js';
import { MessagesModule } from './messages/messages.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AuditModule } from './audit/audit.module.js';
import { InboundModule } from './inbound/inbound.module.js';

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    QueueModule,
    AccountsModule,
    TriggersModule,
    NavCountsModule,
    MessagesModule,
    AuditModule,
    InboundModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
