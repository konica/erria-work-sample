import type { PrismaClient, Setting } from '@erria/db';

/**
 * Every call site reading `Setting` already treats a missing row as
 * `autonomousSendingEnabled ?? false` (hold for approval) — the one case that was never handled
 * was the read itself throwing (a DB blip, a connection drop), which previously propagated and
 * crashed the caller instead of holding. Issue #62: a kill-switch read failure must fail closed,
 * the same posture the switch itself already takes when it's simply off.
 */
export async function readSettingsFailClosed(prisma: PrismaClient): Promise<Setting | null> {
  try {
    return await prisma.setting.findUnique({ where: { id: 1 } });
  } catch (error) {
    console.error(
      '[settings] failed to read Setting — holding autonomous sending for approval (fail closed)',
      error,
    );
    return null;
  }
}
