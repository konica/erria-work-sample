import type { PrismaClient } from '@erria/db';

export interface AlertingMetrics {
  autonomousSendingEnabled: 0 | 1;
  autonomousSendsInWindow: number;
  oldestUnreviewedAuditSampleAgeHours: number;
  claudeApiSpendEstimateUsdMonthToDate: number;
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

/**
 * List price per million tokens (issue #62), not the introductory rate (cheaper, expires
 * 2026-08-31) — so this estimate stays a conservative ceiling rather than one that quietly goes
 * stale the day the intro window closes. It is derived from token counts already recorded on
 * `LlmCall`, not the vendor's actual invoice: nothing here calls an Anthropic billing API.
 * A model id with no entry is logged and excluded rather than crashing the job — new models get
 * used before anyone remembers to price them here.
 */
const MODEL_PRICING_USD_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5': { input: 3, output: 15 },
};

/**
 * Feeds the four autonomous-send alerts that have no host-level equivalent (issue #62): kill
 * switch state (so a flip can be alerted on), autonomous send volume (the anomaly tripwire),
 * audit-sample review backlog, and estimated Claude API spend. Each query filters on
 * `decidedBy: 'system (autonomous)'` or `tierContext: 1` — the same discriminator
 * `dispatch-message.ts`'s log line tags as `tier=autonomous` — so autonomous-tier activity stays
 * isolable from human-approved activity throughout.
 *
 * Deliberately does NOT go through `readSettingsFailClosed`: that helper exists so a kill-switch
 * read failure holds a *send* for approval, but this is the monitoring job itself — swallowing its
 * own read failure would silently report a stale "switch is off" instead of the job failing loudly
 * (which the heartbeat-absence alert would then catch).
 */
export async function collectAlertingMetrics(
  prisma: PrismaClient,
  deps: { now?: Date; volumeWindowMinutes?: number } = {},
): Promise<AlertingMetrics> {
  const now = deps.now ?? new Date();
  const volumeWindowMinutes = deps.volumeWindowMinutes ?? 5;

  const settings = await prisma.setting.findUnique({ where: { id: 1 } });

  const autonomousSendsInWindow = await prisma.message.count({
    where: {
      decidedBy: 'system (autonomous)',
      sentAt: { gte: new Date(now.getTime() - volumeWindowMinutes * MS_PER_MINUTE) },
    },
  });

  const oldestUnreviewed = await prisma.auditSample.findFirst({
    where: { reviewStatus: 'unreviewed' },
    orderBy: { sampledAt: 'asc' },
  });
  const oldestUnreviewedAuditSampleAgeHours = oldestUnreviewed
    ? (now.getTime() - oldestUnreviewed.sampledAt.getTime()) / MS_PER_HOUR
    : 0;

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const callsThisMonth = await prisma.llmCall.findMany({
    where: { createdAt: { gte: monthStart } },
    select: { modelId: true, requestTokens: true, responseTokens: true },
  });

  let claudeApiSpendEstimateUsdMonthToDate = 0;
  for (const call of callsThisMonth) {
    const pricing = MODEL_PRICING_USD_PER_MILLION_TOKENS[call.modelId];
    if (!pricing) {
      console.warn(
        `[alerting-metrics] no pricing entry for model "${call.modelId}" — excluded from spend estimate`,
      );
      continue;
    }
    claudeApiSpendEstimateUsdMonthToDate +=
      (call.requestTokens / 1_000_000) * pricing.input +
      (call.responseTokens / 1_000_000) * pricing.output;
  }

  return {
    autonomousSendingEnabled: settings?.autonomousSendingEnabled ? 1 : 0,
    autonomousSendsInWindow,
    oldestUnreviewedAuditSampleAgeHours: Math.round(oldestUnreviewedAuditSampleAgeHours * 100) / 100,
    claudeApiSpendEstimateUsdMonthToDate: Math.round(claudeApiSpendEstimateUsdMonthToDate * 100) / 100,
  };
}

/** KEY=VALUE lines, one per metric — the shape `deploy/scripts/report-autonomous-alerting-metrics.sh` greps out of this job's stdout and forwards to Azure Monitor. */
export function formatAlertingMetrics(metrics: AlertingMetrics): string {
  return [
    `AUTONOMOUS_SENDING_ENABLED=${metrics.autonomousSendingEnabled}`,
    `AUTONOMOUS_SENDS_IN_WINDOW=${metrics.autonomousSendsInWindow}`,
    `OLDEST_UNREVIEWED_AUDIT_SAMPLE_AGE_HOURS=${metrics.oldestUnreviewedAuditSampleAgeHours}`,
    `CLAUDE_API_SPEND_ESTIMATE_USD_MONTH_TO_DATE=${metrics.claudeApiSpendEstimateUsdMonthToDate}`,
  ].join('\n');
}
