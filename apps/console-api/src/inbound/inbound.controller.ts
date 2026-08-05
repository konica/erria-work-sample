import { Body, Controller, Post } from '@nestjs/common';
import { InboundService } from './inbound.service.js';
import { InboundMessageDto } from './dto/inbound-message.dto.js';

@Controller('internal/inbound-messages')
export class InboundController {
  constructor(private readonly inboundService: InboundService) {}

  @Post()
  async receive(@Body() dto: InboundMessageDto) {
    return this.inboundService.receiveInbound(dto);
  }
}
