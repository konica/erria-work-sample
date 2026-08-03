import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from './testcontainers-postgres.js';

describe('startTestPostgres', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  it('provides a working PrismaClient against a migrated schema', async () => {
    const account = await testDb.prisma.account.create({
      data: {
        companyName: 'Test Shipping Co',
        segment: 'Test segment',
        hub: 'Test hub',
        icpScore: 80,
        icpBand: 'high',
        relationshipSummary: 'New account · first contact today',
        currentTier: 2,
        tierRationale: 'New account — rollout default',
      },
    });

    const found = await testDb.prisma.account.findUnique({ where: { id: account.id } });
    expect(found?.companyName).toBe('Test Shipping Co');
  });
});
