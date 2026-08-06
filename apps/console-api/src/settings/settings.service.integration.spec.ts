import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { SettingsService } from './settings.service.js';

describe('SettingsService', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  it('creates the single settings row with spec defaults on first read', async () => {
    const service = new SettingsService(testDb.prisma);

    const result = await service.read();

    expect(result.basic.tier1PromotionThreshold).toBe(2);
    expect(result.basic.tier1AuditSampleRate).toBe(10);
    expect(result.advanced.maxFollowups).toBe(2);
    expect(result.advanced.minDaysBetweenFollowups).toBe(5);
    expect(result.advanced.sentimentConfidenceFloor).toBe('Medium');
  });

  it('serves the locked policy as read-only reference', async () => {
    const service = new SettingsService(testDb.prisma);

    const result = await service.read();

    expect(result.locked.hardTriggerRules).toHaveLength(5);
    expect(result.locked.rolloutOverlayEnabled).toBe(true);
  });

  it('saves freely-adjustable values immediately', async () => {
    const service = new SettingsService(testDb.prisma);

    const result = await service.saveBasic({ tier1PromotionThreshold: 3, tier1AuditSampleRate: 25 });

    expect(result.basic.tier1PromotionThreshold).toBe(3);
    expect(result.basic.tier1AuditSampleRate).toBe(25);

    const stored = await testDb.prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
    expect(stored.tier1PromotionThreshold).toBe(3);
  });

  it('does not touch the confirm-required values when saving basic ones', async () => {
    const service = new SettingsService(testDb.prisma);
    await service.saveBasic({ tier1PromotionThreshold: 4, tier1AuditSampleRate: 5 });

    const stored = await testDb.prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
    expect(stored.maxFollowups).toBe(2);
    expect(stored.sentimentConfidenceFloor).toBe('Medium');
  });

  describe('advanced settings (two-step)', () => {
    it('proposing returns a diff and changes nothing', async () => {
      const service = new SettingsService(testDb.prisma);
      await service.read();

      const proposal = await service.proposeAdvanced({
        maxFollowups: 4,
        minDaysBetweenFollowups: 10,
        sentimentConfidenceFloor: 'High',
      });

      expect(proposal.requiresConfirmation).toBe(true);
      expect(proposal.diff).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'maxFollowups', from: 2, to: 4 }),
          expect.objectContaining({ field: 'minDaysBetweenFollowups', from: 5, to: 10 }),
          expect.objectContaining({ field: 'sentimentConfidenceFloor', from: 'Medium', to: 'High' }),
        ]),
      );

      const stored = await testDb.prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
      expect(stored.maxFollowups).toBe(2);
    });

    it('lists only the fields that actually changed', async () => {
      const service = new SettingsService(testDb.prisma);
      await service.read();

      const proposal = await service.proposeAdvanced({
        maxFollowups: 2,
        minDaysBetweenFollowups: 5,
        sentimentConfidenceFloor: 'High',
      });

      expect(proposal.diff).toHaveLength(1);
      expect(proposal.diff[0].field).toBe('sentimentConfidenceFloor');
    });

    it('reports no confirmation needed when nothing changed', async () => {
      const service = new SettingsService(testDb.prisma);
      await service.read();

      const proposal = await service.proposeAdvanced({
        maxFollowups: 2,
        minDaysBetweenFollowups: 5,
        sentimentConfidenceFloor: 'Medium',
      });

      expect(proposal.requiresConfirmation).toBe(false);
      expect(proposal.diff).toHaveLength(0);
    });

    it('confirming applies the values', async () => {
      const service = new SettingsService(testDb.prisma);
      await service.read();

      const result = await service.confirmAdvanced({
        maxFollowups: 3,
        minDaysBetweenFollowups: 7,
        sentimentConfidenceFloor: 'Low',
      });

      expect(result.advanced.maxFollowups).toBe(3);

      const stored = await testDb.prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
      expect(stored.maxFollowups).toBe(3);
      expect(stored.minDaysBetweenFollowups).toBe(7);
      expect(stored.sentimentConfidenceFloor).toBe('Low');
    });

    it('does not touch the freely-adjustable values when confirming advanced ones', async () => {
      const service = new SettingsService(testDb.prisma);
      await service.saveBasic({ tier1PromotionThreshold: 4, tier1AuditSampleRate: 30 });

      await service.confirmAdvanced({
        maxFollowups: 5,
        minDaysBetweenFollowups: 14,
        sentimentConfidenceFloor: 'High',
      });

      const stored = await testDb.prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
      expect(stored.tier1PromotionThreshold).toBe(4);
      expect(stored.tier1AuditSampleRate).toBe(30);
    });
  });

  describe('autonomous kill switch', () => {
    it('defaults to paused (off), with no reason, on first read', async () => {
      const service = new SettingsService(testDb.prisma);

      const result = await service.read();

      expect(result.autonomous.enabled).toBe(false);
      expect(result.autonomous.pauseReason).toBeNull();
    });

    it('pauses immediately, with no confirmation step, recording the reason', async () => {
      const service = new SettingsService(testDb.prisma);
      await service.confirmResumeAutonomous();

      const result = await service.pauseAutonomous('Tone drift spotted on three sends');

      expect(result.autonomous.enabled).toBe(false);
      expect(result.autonomous.pauseReason).toBe('Tone drift spotted on three sends');

      const stored = await testDb.prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
      expect(stored.autonomousSendingEnabled).toBe(false);
    });

    it('requires a reason to pause, so a paused system explains itself', async () => {
      const service = new SettingsService(testDb.prisma);

      await expect(service.pauseAutonomous('   ')).rejects.toThrow(/reason/i);
    });

    it('proposing a resume changes nothing and returns the confirmation notice', async () => {
      const service = new SettingsService(testDb.prisma);
      await service.pauseAutonomous('paused for the test');

      const proposal = await service.proposeResumeAutonomous();

      expect(proposal.requiresConfirmation).toBe(true);
      expect(proposal.notice).toMatch(/without a human reading/i);

      const stored = await testDb.prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
      expect(stored.autonomousSendingEnabled).toBe(false);
    });

    it('confirming a resume enables sending and clears the pause reason', async () => {
      const service = new SettingsService(testDb.prisma);
      await service.pauseAutonomous('paused for the test');

      const result = await service.confirmResumeAutonomous();

      expect(result.autonomous.enabled).toBe(true);
      expect(result.autonomous.pauseReason).toBeNull();
    });

    it('reports the switch state through the normal settings read', async () => {
      const service = new SettingsService(testDb.prisma);
      await service.pauseAutonomous('visible in read');

      const settings = await service.read();

      expect(settings.autonomous.enabled).toBe(false);
      expect(settings.autonomous.pauseReason).toBe('visible in read');
    });
  });
});
