import { Injectable } from '@nestjs/common';

@Injectable()
export class WorkerClient {
  async processTrigger(triggerId: string): Promise<void> {
    const baseUrl = process.env.WORKER_INTERNAL_URL ?? 'http://localhost:3100';
    const response = await fetch(`${baseUrl}/internal/process-trigger/${triggerId}`, {
      method: 'POST',
    });
    if (!response.ok) {
      throw new Error(`Worker returned ${response.status} for trigger ${triggerId}`);
    }
  }
}
