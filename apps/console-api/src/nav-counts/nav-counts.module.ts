import { Module } from '@nestjs/common';
import { NavCountsController } from './nav-counts.controller.js';
import { NavCountsService } from './nav-counts.service.js';

@Module({ controllers: [NavCountsController], providers: [NavCountsService] })
export class NavCountsModule {}
