const JOB_NAMES = ['followup-cadence', 'audit-sample-maintenance', 'stuck-send-reconciliation'] as const;
export type JobName = (typeof JOB_NAMES)[number];

export async function runJob(name: string): Promise<void> {
  if (!(JOB_NAMES as readonly string[]).includes(name)) {
    throw new Error(`Unknown job: ${name}. Expected one of ${JOB_NAMES.join(', ')}`);
  }
  // Real job bodies (follow-up cadence, audit-sample maintenance, the stuck-send
  // reconciliation sweep) land in Plans 2-3, once their owning flows exist. This task
  // only establishes the `--job=<name>` entrypoint contract Azure Container Apps
  // Jobs will invoke, per the Azure doc's §2 scheduled-jobs sketch.
  console.log(`[stub] job "${name}" invoked — no-op until a later plan implements it`);
}
