import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { SettingsService } from './settings.service.js';
import { SaveBasicSettingsDto } from './dto/save-basic-settings.dto.js';
import { SaveAdvancedSettingsDto } from './dto/save-advanced-settings.dto.js';

@Controller('api/settings')
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
