import { buildServer } from './server.js';
import { runJob } from './jobs/run-job.js';

const jobArg = process.argv.find((arg) => arg.startsWith('--job='));

function assertDatabaseUrl(): void {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'Missing required environment variable DATABASE_URL. Set it before starting the worker server (see .env.example).',
    );
  }
}

async function main() {
  if (jobArg) {
    const jobName = jobArg.slice('--job='.length);
    await runJob(jobName);
    process.exit(0);
  }

  assertDatabaseUrl();

  const server = buildServer();
  const port = process.env.WORKER_PORT ? Number(process.env.WORKER_PORT) : 3100;
  await server.listen({ port, host: '0.0.0.0' });

  const shutdown = (signal: NodeJS.Signals) => {
    server.log.info(`Received ${signal}, closing server gracefully...`);
    server
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error('Error during worker server shutdown:', error);
        process.exit(1);
      });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  console.error('Fatal error in worker main():', error);
  process.exit(1);
});
