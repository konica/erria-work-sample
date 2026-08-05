import { Module } from '@nestjs/common';
import { WorkerClientModule } from '../worker-client/worker-client.module.js';
import { EscalationsController } from './escalations.controller.js';
import { EscalationsService } from './escalations.service.js';

@Module({
  imports: [WorkerClientModule],
  controllers: [EscalationsController],
  providers: [EscalationsService],
  exports: [EscalationsService],
})
export class EscalationsModule {}
