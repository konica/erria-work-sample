import { prisma } from '@erria/db';
import type { DispatchMode } from '@erria/domain';
import { reconcileStuckSends } from './reconcile-stuck-sends.js';

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

  // followup-cadence and audit-sample-maintenance land in later plans, once the flows they serve
  // exist. The entrypoint contract is established; the bodies are not written yet.
  console.log(`[stub] job "${name}" invoked — no-op until a later plan implements it`);
}
