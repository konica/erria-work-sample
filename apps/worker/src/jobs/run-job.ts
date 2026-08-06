import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@erria/db';
import type { DispatchMode } from '@erria/domain';
import { reconcileStuckSends } from './reconcile-stuck-sends.js';
import { runFollowupCadence } from './followup-cadence.js';
import { collectAlertingMetrics, formatAlertingMetrics } from './report-alerting-metrics.js';

const JOB_NAMES = [
  'followup-cadence',
  'audit-sample-maintenance',
  'stuck-send-reconciliation',
  'autonomous-alerting-metrics',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

const STALE_AFTER_MINUTES = 5;

export interface RunJobDeps {
  dispatchMode: DispatchMode;
}

export async function runJob(
  name: string,
  deps: RunJobDeps = { dispatchMode: 'sandbox' },
): Promise<void> {
  if (!(JOB_NAMES as readonly string[]).includes(name)) {
    throw new Error(`Unknown job: ${name}. Expected one of ${JOB_NAMES.join(', ')}`);
  }

  if (name === 'stuck-send-reconciliation') {
    const result = await reconcileStuckSends(prisma, deps.dispatchMode, {
      staleAfterMinutes: STALE_AFTER_MINUTES,
    });
    console.log(
      `[job] stuck-send-reconciliation: dispatched ${result.dispatched}, flagged ${result.flagged}`,
    );
    return;
  }

  if (name === 'followup-cadence') {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await runFollowupCadence(prisma, anthropic, deps.dispatchMode);
    console.log(
      `[job] followup-cadence: sent ${result.followupsSent}, held ${result.followupsHeld}, ` +
        `sequences ended ${result.sequencesEnded}`,
    );
    return;
  }

  if (name === 'autonomous-alerting-metrics') {
    // Issue #62: feeds the app-level alerts a host-side cron script can't compute on its own
    // (kill-switch state, autonomous send volume, audit-sample backlog, Claude API spend) —
    // printed as KEY=VALUE lines a wrapper script greps out of this job's stdout and forwards to
    // Azure Monitor (deploy/scripts/report-autonomous-alerting-metrics.sh), the same split
    // disk-usage/TLS-expiry monitoring already uses for host-level metrics (issue #61).
    const metrics = await collectAlertingMetrics(prisma);
    console.log(formatAlertingMetrics(metrics));
    return;
  }

  // audit-sample-maintenance lands in a later plan, once the flow it serves exists. The
  // entrypoint contract is established; the body is not written yet. Its heartbeat (issue #62)
  // still proves cron/Docker/the image are healthy even before that body exists.
  console.log(`[stub] job "${name}" invoked — no-op until a later plan implements it`);
}
