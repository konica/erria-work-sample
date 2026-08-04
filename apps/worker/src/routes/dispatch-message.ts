import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@erria/db';
import { dispatchMessage, type DispatchMode } from '@erria/domain';

export function registerDispatchMessageRoute(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; dispatchMode: DispatchMode },
) {
  app.post<{ Params: { messageId: string } }>(
    '/internal/dispatch-message/:messageId',
    async (request, reply) => {
      const result = await dispatchMessage(
        deps.dispatchMode,
        { messageId: request.params.messageId },
        { prisma: deps.prisma },
      );

      switch (result.status) {
        case 'not_found':
          return reply.code(404).send(result);
        case 'refused':
          return reply.code(409).send(result);
        case 'unsendable':
          return reply.code(422).send(result);
        case 'sent':
        case 'already_sent':
          return reply.send(result);
      }
    },
  );
}
