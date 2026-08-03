import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { AccountsService } from './accounts.service.js';

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
}
