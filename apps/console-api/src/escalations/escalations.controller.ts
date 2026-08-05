import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { EscalationsService } from './escalations.service.js';
import { ResolveEscalationDto } from './dto/resolve-escalation.dto.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';

@Controller()
export class EscalationsController {
  constructor(private readonly escalationsService: EscalationsService) {}

  @Get('api/escalations')
  async list(@Query('status') status?: 'active' | 'resolved') {
    return this.escalationsService.list({ status });
  }

  @Post('api/accounts/:accountId/escalations/:escId/resolve')
  async resolve(
    @Param('accountId') accountId: string,
    @Param('escId') escId: string,
    @Body() dto: ResolveEscalationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.escalationsService.resolve(accountId, escId, dto, user.name);
  }
}
