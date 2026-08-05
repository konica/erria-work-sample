import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@erria/db';
import type Anthropic from '@anthropic-ai/sdk';
import {
  CLASSIFICATION_MODEL_ID,
  HANDOFF_MODEL_ID,
  HARD_TRIGGER_SYSTEM_PROMPT,
  classifyInboundReply,
  decideHardTrigger,
  generateRecommendedNextStep,
  openEscalation,
} from '@erria/domain';

const CLASSIFICATION_PROMPT_VERSION = 'v1';
const HANDOFF_PROMPT_VERSION = 'v1';
const DEFAULT_SENTIMENT_FLOOR = 'Medium' as const;

export function registerClassifyInboundRoute(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; anthropic: Anthropic },
) {
  app.post<{ Params: { messageId: string } }>(
    '/internal/classify-inbound/:messageId',
    async (request, reply) => {
      const message = await deps.prisma.message.findUnique({
        where: { id: request.params.messageId },
        include: { account: true },
      });

      if (!message) {
        return reply.code(404).send({ error: 'message_not_found' });
      }
      if (message.role !== 'buyer_inbound') {
        return reply.code(409).send({ error: 'not_an_inbound_message', role: message.role });
      }

      const settings = await deps.prisma.setting.findUnique({ where: { id: 1 } });

      const classification = await classifyInboundReply(
        { systemPrompt: HARD_TRIGGER_SYSTEM_PROMPT, replyBody: message.body },
        { client: deps.anthropic },
      );

      await deps.prisma.llmCall.create({
        data: {
          purpose: 'hard_trigger_classification',
          accountId: message.accountId,
          messageId: message.id,
          modelId: CLASSIFICATION_MODEL_ID,
          promptVersion: CLASSIFICATION_PROMPT_VERSION,
          requestTokens: classification.requestTokens,
          responseTokens: classification.responseTokens,
          latencyMs: classification.latencyMs,
          outcome: classification.outcome,
          errorDetail: classification.errorDetail,
        },
      });

      const decision = decideHardTrigger(classification, {
        sentimentConfidenceFloor: settings?.sentimentConfidenceFloor ?? DEFAULT_SENTIMENT_FLOOR,
      });

      if (!decision.fires || !decision.rule) {
        return reply.send({ escalated: false });
      }

      const nextStep = await generateRecommendedNextStep(
        {
          rule: decision.rule,
          replyBody: message.body,
          accountName: message.account.companyName,
        },
        { client: deps.anthropic },
      );

      await deps.prisma.llmCall.create({
        data: {
          purpose: 'handoff_generation',
          accountId: message.accountId,
          messageId: message.id,
          modelId: HANDOFF_MODEL_ID,
          promptVersion: HANDOFF_PROMPT_VERSION,
          requestTokens: nextStep.requestTokens,
          responseTokens: nextStep.responseTokens,
          latencyMs: nextStep.latencyMs,
          outcome: nextStep.outcome,
          errorDetail: nextStep.errorDetail,
        },
      });

      const escalation = await openEscalation(deps.prisma, {
        accountId: message.accountId,
        triggerMessageId: message.id,
        rule: decision.rule,
        reasonSummary: decision.reasonSummary,
        detail: decision.detail,
        recommendedNextStep: nextStep.text,
      });

      await deps.prisma.message.update({
        where: { id: message.id },
        data: { escalationId: escalation.id },
      });

      return reply.send({ escalated: true, rule: decision.rule, escalationId: escalation.id });
    },
  );
}
