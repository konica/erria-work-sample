import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '../test-utils/testcontainers-postgres.js';
import { seedDemoData } from './seed.js';

describe('seedDemoData', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  it('populates a working queue from a clean database', async () => {
    const result = await seedDemoData(testDb.prisma);
    expect(result.seeded).toBe(true);

    // Only the mockup's fictional entities — never a real company, vessel, person, or email.
    const accounts = await testDb.prisma.account.findMany({ orderBy: { companyName: 'asc' } });
    expect(accounts.map((a) => a.companyName)).toEqual([
      'Dai Duong Shipping',
      'Song Hong Shipping',
      'Truong Phat Marine',
      'Vina Offshore Supply',
    ]);

    // Tier 2 account with a pending draft — the queue row.
    const queueMessages = await testDb.prisma.message.findMany({ where: { status: 'pending_review' } });
    expect(queueMessages).toHaveLength(1);
    const songHong = await testDb.prisma.account.findUniqueOrThrow({
      where: { externalRef: 'seed-song-hong-shipping' },
    });
    expect(queueMessages[0].accountId).toBe(songHong.id);
    expect(songHong.currentTier).toBe(2);

    // A Tier 3 account with an active escalation.
    const truongPhat = await testDb.prisma.account.findUniqueOrThrow({
      where: { externalRef: 'seed-truong-phat-marine' },
      include: { escalations: true },
    });
    expect(truongPhat.currentTier).toBe(3);
    expect(truongPhat.escalations).toHaveLength(1);
    expect(truongPhat.escalations[0].status).toBe('active');

    // An account with a resolved escalation — tier stays 3 (spec §7: resolving never restores it).
    const daiDuong = await testDb.prisma.account.findUniqueOrThrow({
      where: { externalRef: 'seed-dai-duong-shipping' },
      include: { escalations: { include: { resolution: true } } },
    });
    expect(daiDuong.currentTier).toBe(3);
    expect(daiDuong.escalations[0].status).toBe('resolved');
    expect(daiDuong.escalations[0].resolution?.outcomeTag).toBe('no_response');

    // A trigger thin enough that drafting legitimately abstains: needs_triage, no Message row.
    const vinaOffshore = await testDb.prisma.account.findUniqueOrThrow({
      where: { externalRef: 'seed-vina-offshore-supply' },
      include: { triggers: true, messages: true },
    });
    expect(vinaOffshore.triggers).toHaveLength(1);
    expect(vinaOffshore.triggers[0].status).toBe('needs_triage');
    expect(vinaOffshore.messages).toHaveLength(0);
  });

  it('does not duplicate data when run again against an already-seeded database', async () => {
    const first = await testDb.prisma.account.count();
    const result = await seedDemoData(testDb.prisma);
    const second = await testDb.prisma.account.count();

    expect(result.seeded).toBe(false);
    expect(second).toBe(first);
  });
});
