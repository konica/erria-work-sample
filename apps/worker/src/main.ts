import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@erria/db';
import { resolveDispatchMode } from '@erria/domain';
import { buildServer } from './server.js';
import { runJob } from './jobs/run-job.js';

const jobArg = process.argv.find((arg) => arg.startsWith('--job='));

function assertServerEnv(): void {
  for (const name of ['DATABASE_URL', 'ANTHROPIC_API_KEY'] as const) {
    if (!process.env[name]) {
      throw new Error(
        `Missing required environment variable ${name}. Set it before starting the worker server (see .env.example).`,
      );
    }
  }
}

async function main() {
  // Resolved (and, for an unrecognised value, thrown) before anything else runs: a public review
  // console can never risk booting into a mode that would send real mail (ADR-0007).
  const dispatchMode = resolveDispatchMode(process.env.MESSAGE_DISPATCH_MODE, { warn: console.warn });

  if (jobArg) {
    const jobName = jobArg.slice('--job='.length);
    await runJob(jobName);
    process.exit(0);
  }

  assertServerEnv();

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const server = buildServer({ prisma, anthropic, dispatchMode });
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
