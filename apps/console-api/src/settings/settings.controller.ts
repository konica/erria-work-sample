import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { SettingsService } from './settings.service.js';
import { SaveBasicSettingsDto } from './dto/save-basic-settings.dto.js';
import { SaveAdvancedSettingsDto } from './dto/save-advanced-settings.dto.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';

// Issue #79: the settings screen and its data are admin-only (#20's "no settings change log"
// decision stands unchanged — this only adds the access gate on top of it).
@Controller('api/settings')
@UseGuards(RolesGuard)
@Roles('admin')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  async read() {
    return this.settingsService.read();
  }

  @Put('basic')
  async saveBasic(@Body() dto: SaveBasicSettingsDto) {
    return this.settingsService.saveBasic(dto);
  }

  @Put('advanced')
  async proposeAdvanced(@Body() dto: SaveAdvancedSettingsDto) {
    return this.settingsService.proposeAdvanced(dto);
  }

  @Post('advanced/confirm')
  async confirmAdvanced(@Body() dto: SaveAdvancedSettingsDto) {
    return this.settingsService.confirmAdvanced(dto);
  }
}
