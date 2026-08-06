import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { collectAlertingMetrics, formatAlertingMetrics } from './report-alerting-metrics.js';

describe('collectAlertingMetrics', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 120_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createAccount() {
    return testDb.prisma.account.create({
      data: {
        companyName: 'Song Hong Shipping',
        segment: 'Offshore support vessel operator',
        hub: 'Haiphong',
        icpScore: 90,
        icpBand: 'high',
        relationshipSummary: 'Tier 1 account',
        currentTier: 1,
        tierRationale: 'Earned via clean approvals',
      },
    });
  }

  it("reports the kill switch's current state", async () => {
    await testDb.prisma.setting.upsert({
      where: { id: 1 },
      update: { autonomousSendingEnabled: true },
      create: { id: 1, autonomousSendingEnabled: true },
    });

    const metrics = await collectAlertingMetrics(testDb.prisma);

    expect(metrics.autonomousSendingEnabled).toBe(1);
  });

  it('counts only autonomous sends inside the volume window, excluding human-approved and stale sends', async () => {
    await testDb.prisma.setting.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
    });
    const account = await createAccount();
    const now = new Date('2026-08-06T12:00:00Z');

    await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'agent_sent',
        body: 'Autonomous send inside the window',
        status: 'sent',
        tierContext: 1,
        decidedBy: 'system (autonomous)',
        decidedAt: now,
        sentAt: new Date(now.getTime() - 2 * 60_000),
      },
    });
    await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'agent_sent',
        body: 'Autonomous send outside the window',
        status: 'sent',
        tierContext: 1,
        decidedBy: 'system (autonomous)',
        decidedAt: now,
        sentAt: new Date(now.getTime() - 20 * 60_000),
      },
    });
    await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'agent_sent',
        body: 'Human-approved send inside the window',
        status: 'sent',
        tierContext: 2,
        decidedBy: 'Minh Tran',
        decidedAt: now,
        sentAt: new Date(now.getTime() - 1 * 60_000),
      },
    });

    const metrics = await collectAlertingMetrics(testDb.prisma, { now, volumeWindowMinutes: 5 });

    expect(metrics.autonomousSendsInWindow).toBe(1);
  });

  it('reports zero backlog age when nothing is unreviewed', async () => {
    const metrics = await collectAlertingMetrics(testDb.prisma, { now: new Date() });

    expect(metrics.oldestUnreviewedAuditSampleAgeHours).toBe(0);
  });

  it('reports the oldest unreviewed sample age, ignoring already-reviewed samples', async () => {
    const account = await createAccount();
    const now = new Date('2026-08-06T12:00:00Z');
    const oldMessage = await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'agent_sent',
        body: 'Old autonomous send',
        status: 'sent',
        tierContext: 1,
        decidedBy: 'system (autonomous)',
        decidedAt: now,
        sentAt: now,
      },
    });
    const reviewedMessage = await testDb.prisma.message.create({
      data: {
        accountId: account.id,
        role: 'agent_sent',
        body: 'Already-reviewed autonomous send',
        status: 'sent',
        tierContext: 1,
        decidedBy: 'system (autonomous)',
        decidedAt: now,
        sentAt: now,
      },
    });
    await testDb.prisma.auditSample.create({
      data: {
        messageId: oldMessage.id,
        accountId: account.id,
        sampledAt: new Date(now.getTime() - 30 * 3_600_000),
        reviewStatus: 'unreviewed',
      },
    });
    await testDb.prisma.auditSample.create({
      data: {
        messageId: reviewedMessage.id,
        accountId: account.id,
        sampledAt: new Date(now.getTime() - 1000 * 3_600_000),
        reviewStatus: 'fine',
      },
    });

    const metrics = await collectAlertingMetrics(testDb.prisma, { now });

    expect(metrics.oldestUnreviewedAuditSampleAgeHours).toBe(30);
  });

  it('estimates Claude API spend from recorded token counts at list pricing, excluding models with no pricing entry', async () => {
    const account = await createAccount();
    const now = new Date('2026-08-06T12:00:00Z');
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await testDb.prisma.llmCall.create({
      data: {
        purpose: 'draft_generation',
        accountId: account.id,
        modelId: 'claude-sonnet-5',
        promptVersion: 'v1',
        requestTokens: 1_000_000,
        responseTokens: 1_000_000,
        latencyMs: 500,
        outcome: 'success',
        createdAt: now,
      },
    });
    await testDb.prisma.llmCall.create({
      data: {
        purpose: 'draft_generation',
        accountId: account.id,
        modelId: 'some-future-model',
        promptVersion: 'v1',
        requestTokens: 1_000_000,
        responseTokens: 1_000_000,
        latencyMs: 500,
        outcome: 'success',
        createdAt: now,
      },
    });
    await testDb.prisma.llmCall.create({
      data: {
        purpose: 'draft_generation',
        accountId: account.id,
        modelId: 'claude-sonnet-5',
        promptVersion: 'v1',
        requestTokens: 100,
        responseTokens: 100,
        latencyMs: 500,
        outcome: 'success',
        createdAt: new Date(now.getFullYear(), now.getMonth() - 1, 15),
      },
    });

    const metrics = await collectAlertingMetrics(testDb.prisma, { now });

    // 1M request tokens @ $3/M + 1M response tokens @ $15/M = $18 — the unpriced model and last
    // month's call are both excluded.
    expect(metrics.claudeApiSpendEstimateUsdMonthToDate).toBe(18);
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('some-future-model'));
  });
});

describe('formatAlertingMetrics', () => {
  it('prints one KEY=VALUE line per metric', () => {
    const output = formatAlertingMetrics({
      autonomousSendingEnabled: 1,
      autonomousSendsInWindow: 3,
      oldestUnreviewedAuditSampleAgeHours: 12.5,
      claudeApiSpendEstimateUsdMonthToDate: 42.1,
    });

    expect(output).toBe(
      [
        'AUTONOMOUS_SENDING_ENABLED=1',
        'AUTONOMOUS_SENDS_IN_WINDOW=3',
        'OLDEST_UNREVIEWED_AUDIT_SAMPLE_AGE_HOURS=12.5',
        'CLAUDE_API_SPEND_ESTIMATE_USD_MONTH_TO_DATE=42.1',
      ].join('\n'),
    );
  });
});
