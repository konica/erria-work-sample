import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@erria/db';
import type Anthropic from '@anthropic-ai/sdk';
import type { DispatchMode } from '@erria/domain';
import { registerProcessTriggerRoute } from './routes/process-trigger.js';
import { registerDispatchMessageRoute } from './routes/dispatch-message.js';

export interface ServerDeps {
  prisma: PrismaClient;
  anthropic: Anthropic;
  // Optional, defaulting to 'sandbox': a public review console must never risk booting into a
  // mode that would send real mail just because a test or caller omitted it (ADR-0007).
  dispatchMode?: DispatchMode;
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
    registerDispatchMessageRoute(app, { prisma: deps.prisma, dispatchMode: deps.dispatchMode ?? 'sandbox' });
  }
  return app;
}
