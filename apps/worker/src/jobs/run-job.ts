import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@erria/db';
import type { DispatchMode } from '@erria/domain';
import { reconcileStuckSends } from './reconcile-stuck-sends.js';
import { runFollowupCadence } from './followup-cadence.js';

const JOB_NAMES = ['followup-cadence', 'audit-sample-maintenance', 'stuck-send-reconciliation'] as const;
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

  // audit-sample-maintenance lands in a later plan, once the flow it serves exists. The
  // entrypoint contract is established; the body is not written yet.
  console.log(`[stub] job "${name}" invoked — no-op until a later plan implements it`);
}
