import { Module } from '@nestjs/common';
import { WorkerClientModule } from '../worker-client/worker-client.module.js';
import { MessagesController } from './messages.controller.js';
import { MessagesService } from './messages.service.js';

@Module({
  imports: [WorkerClientModule],
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
