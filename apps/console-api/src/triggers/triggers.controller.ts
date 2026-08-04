import { Body, Controller, Post } from '@nestjs/common';
import { TriggersService } from './triggers.service.js';
import { IncomingTriggerDto } from './dto/incoming-trigger.dto.js';

@Controller('internal/triggers')
export class TriggersController {
  constructor(private readonly triggersService: TriggersService) {}

  @Post()
  async receive(@Body() dto: IncomingTriggerDto) {
    return this.triggersService.receiveTrigger(dto);
  }
}
