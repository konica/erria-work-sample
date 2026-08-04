import { Module } from '@nestjs/common';
import { WorkerClientModule } from '../worker-client/worker-client.module.js';
import { TriggersController } from './triggers.controller.js';
import { TriggersService } from './triggers.service.js';

@Module({
  imports: [WorkerClientModule],
  controllers: [TriggersController],
  providers: [TriggersService],
})
export class TriggersModule {}
