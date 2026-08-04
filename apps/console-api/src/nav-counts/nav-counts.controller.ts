import { Controller, Get } from '@nestjs/common';
import { NavCountsService } from './nav-counts.service.js';

@Controller('api/nav-counts')
export class NavCountsController {
  constructor(private readonly navCountsService: NavCountsService) {}

  @Get()
  async get() {
    return this.navCountsService.get();
  }
}
