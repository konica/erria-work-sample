import { Module } from '@nestjs/common';
import { WorkerClient } from './worker-client.service.js';

@Module({ providers: [WorkerClient], exports: [WorkerClient] })
export class WorkerClientModule {}
