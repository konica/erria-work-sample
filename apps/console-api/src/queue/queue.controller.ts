import { Controller, Get, Query } from '@nestjs/common';
import { QueueService } from './queue.service.js';

@Controller('api/queue')
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  @Get()
  async list(@Query('tier') tier?: string, @Query('page') page?: string) {
    return this.queueService.list({
      tier: tier ? Number(tier) : undefined,
      page: page ? Number(page) : 1,
    });
  }
}
