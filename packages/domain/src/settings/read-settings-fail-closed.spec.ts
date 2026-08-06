import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@erria/db';
import { readSettingsFailClosed } from './read-settings-fail-closed.js';

function fakePrisma(behavior: 'resolve' | 'reject', value?: unknown): PrismaClient {
  return {
    setting: {
      findUnique:
        behavior === 'resolve'
          ? vi.fn().mockResolvedValue(value)
          : vi.fn().mockRejectedValue(value),
    },
  } as unknown as PrismaClient;
}

describe('readSettingsFailClosed', () => {
  it('returns the row on a successful read', async () => {
    const settings = { id: 1, autonomousSendingEnabled: true };
    const prisma = fakePrisma('resolve', settings);

    await expect(readSettingsFailClosed(prisma)).resolves.toBe(settings);
  });

  it('returns null, without throwing, when the read fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prisma = fakePrisma('reject', new Error('connection reset'));

    await expect(readSettingsFailClosed(prisma)).resolves.toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
