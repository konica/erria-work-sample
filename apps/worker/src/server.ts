import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@erria/db';
import type Anthropic from '@anthropic-ai/sdk';
import { registerProcessTriggerRoute } from './routes/process-trigger.js';

export interface ServerDeps {
  prisma: PrismaClient;
  anthropic: Anthropic;
}

/**
 * Builds the worker's HTTP server. Without `deps` only `/health` is registered, which keeps the
 * liveness probe usable (and testable) without a database or an Anthropic client.
 */
export function buildServer(deps?: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: true });
  app.get('/health', async () => ({ status: 'ok' }));
  if (deps) {
    registerProcessTriggerRoute(app, deps);
  }
  return app;
}
