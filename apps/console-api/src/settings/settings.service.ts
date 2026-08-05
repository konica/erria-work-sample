import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@erria/db';
import { LOCKED_POLICY } from '@erria/domain';
import { PRISMA } from '../prisma/prisma.module.js';
import type { SaveBasicSettingsDto } from './dto/save-basic-settings.dto.js';
import type { SaveAdvancedSettingsDto } from './dto/save-advanced-settings.dto.js';

/** Single-row table (architecture §2) — one business unit, no per-user scoping. */
const SETTINGS_ID = 1;

@Injectable()
export class SettingsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async read() {
    const settings = await this.ensureRow();
    return this.present(settings);
  }

  async saveBasic(dto: SaveBasicSettingsDto) {
    await this.ensureRow();
    const updated = await this.prisma.setting.update({
      where: { id: SETTINGS_ID },
      data: {
        tier1PromotionThreshold: dto.tier1PromotionThreshold,
        tier1AuditSampleRate: dto.tier1AuditSampleRate,
      },
    });
    return this.present(updated);
  }

  /**
   * Dry run by design: computes what would change and writes nothing. The write happens only in
   * confirmAdvanced, after a human has seen this diff — a confirmation step that does not say what
   * is changing is a speed bump, not a safeguard.
   */
  async proposeAdvanced(dto: SaveAdvancedSettingsDto) {
    const current = await this.ensureRow();

    const diff = [
      { field: 'maxFollowups' as const, from: current.maxFollowups, to: dto.maxFollowups },
      {
        field: 'minDaysBetweenFollowups' as const,
        from: current.minDaysBetweenFollowups,
        to: dto.minDaysBetweenFollowups,
      },
      {
        field: 'sentimentConfidenceFloor' as const,
        from: current.sentimentConfidenceFloor,
        to: dto.sentimentConfidenceFloor,
      },
    ].filter((entry) => entry.from !== entry.to);

    return {
      requiresConfirmation: diff.length > 0,
      diff,
      // Spec §11: the confirmation copy must say a change is not retroactive.
      notice: 'These changes apply to outreach going forward. Messages already sent are unaffected.',
    };
  }

  async confirmAdvanced(dto: SaveAdvancedSettingsDto) {
    await this.ensureRow();
    const updated = await this.prisma.setting.update({
      where: { id: SETTINGS_ID },
      data: {
        maxFollowups: dto.maxFollowups,
        minDaysBetweenFollowups: dto.minDaysBetweenFollowups,
        sentimentConfidenceFloor: dto.sentimentConfidenceFloor,
      },
    });
    return this.present(updated);
  }

  /** Defaults live here and in the Prisma schema's @default — spec §11's stated values. */
  private async ensureRow() {
    return this.prisma.setting.upsert({
      where: { id: SETTINGS_ID },
      update: {},
      create: { id: SETTINGS_ID },
    });
  }

  private present(settings: Awaited<ReturnType<SettingsService['ensureRow']>>) {
    return {
      basic: {
        tier1PromotionThreshold: settings.tier1PromotionThreshold,
        tier1AuditSampleRate: settings.tier1AuditSampleRate,
      },
      advanced: {
        maxFollowups: settings.maxFollowups,
        minDaysBetweenFollowups: settings.minDaysBetweenFollowups,
        sentimentConfidenceFloor: settings.sentimentConfidenceFloor,
      },
      locked: LOCKED_POLICY,
    };
  }
}
