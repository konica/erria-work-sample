import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { MarkAuditSampleDto } from './dto/mark-audit-sample.dto.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';

@Controller('api/audit-samples')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  async list(
    @Query('status') status?: 'unreviewed' | 'fine' | 'concerning',
    @Query('page') page?: string,
  ) {
    return this.auditService.list({ status, page: page ? Number(page) : 1 });
  }

  @Post(':id/mark')
  async mark(
    @Param('id') id: string,
    @Body() dto: MarkAuditSampleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.auditService.mark(id, dto.verdict, user.name);
  }
}
