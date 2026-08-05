import { Module } from '@nestjs/common';
import { WorkerClientModule } from '../worker-client/worker-client.module.js';
import { InboundController } from './inbound.controller.js';
import { InboundService } from './inbound.service.js';

@Module({
  imports: [WorkerClientModule],
  controllers: [InboundController],
  providers: [InboundService],
})
export class InboundModule {}
