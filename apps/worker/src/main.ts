import { buildServer } from './server.js';
import { runJob } from './jobs/run-job.js';

const jobArg = process.argv.find((arg) => arg.startsWith('--job='));

async function main() {
  if (jobArg) {
    const jobName = jobArg.split('=')[1];
    await runJob(jobName);
    process.exit(0);
  }

  const server = buildServer();
  const port = process.env.WORKER_PORT ? Number(process.env.WORKER_PORT) : 3100;
  await server.listen({ port, host: '0.0.0.0' });
}

main();
