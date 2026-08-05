import { Body, Controller, Get, NotFoundException, Param, Patch } from '@nestjs/common';
import { AccountsService } from './accounts.service.js';
import { ChangeTierDto } from './dto/change-tier.dto.js';

@Controller('api/accounts')
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Get(':id')
  async detail(@Param('id') id: string) {
    const detail = await this.accountsService.getDetail(id);
    if (!detail) {
      throw new NotFoundException(`Account ${id} not found`);
    }
    return detail;
  }

  @Patch(':id/tier')
  async changeTier(@Param('id') id: string, @Body() dto: ChangeTierDto) {
    return this.accountsService.changeTier(id, dto.tier, dto.reason);
  }
}
