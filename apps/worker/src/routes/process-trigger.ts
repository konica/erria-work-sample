import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@erria/db';
import type Anthropic from '@anthropic-ai/sdk';
import { draftMessage, TONE_SYSTEM_PROMPT, DRAFT_MODEL_ID } from '@erria/domain';

const DRAFT_PROMPT_VERSION = 'v1';

export function registerProcessTriggerRoute(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; anthropic: Anthropic },
) {
  app.post<{ Params: { triggerId: string } }>(
    '/internal/process-trigger/:triggerId',
    async (request, reply) => {
      const trigger = await deps.prisma.trigger.findUnique({
        where: { id: request.params.triggerId },
        include: { account: true, vessel: true },
      });

      if (!trigger) {
        return reply.code(404).send({ error: 'trigger_not_found' });
      }

      const draft = await draftMessage(
        {
          toneSystemPrompt: TONE_SYSTEM_PROMPT,
          account: {
            companyName: trigger.account.companyName,
            segment: trigger.account.segment,
            hub: trigger.account.hub,
            relationshipSummary: trigger.account.relationshipSummary,
          },
          vessel: trigger.vessel
            ? { name: trigger.vessel.name, imo: trigger.vessel.imo, flag: trigger.vessel.flag }
            : null,
          trigger: {
            category: trigger.category,
            description: trigger.description,
            source: trigger.source,
            confidenceLabel: trigger.confidenceLabel,
            verifiabilityNote: trigger.verifiabilityNote,
          },
          // `Account.currentTier` is a plain Int column; Flow 1 only ever drafts for Tier 2
          // accounts, so this widening cast is where the column meets the domain's 1 | 2 | 3.
          tier: trigger.account.currentTier as 1 | 2 | 3,
        },
        { client: deps.anthropic },
      );

      await deps.prisma.llmCall.create({
        data: {
          purpose: 'draft_generation',
          accountId: trigger.accountId,
          modelId: DRAFT_MODEL_ID,
          promptVersion: DRAFT_PROMPT_VERSION,
          requestTokens: draft.requestTokens,
          responseTokens: draft.responseTokens,
          latencyMs: draft.latencyMs,
          outcome: draft.outcome,
          errorDetail: draft.errorDetail,
        },
      });

      const draftSucceeded = draft.outcome === 'success' || draft.outcome === 'retried_success';

      // Two distinct roads to Needs Triage — the model abstained because the dossier is too thin,
      // or the call itself failed. The LlmCall row above keeps them tellable apart.
      if (!draftSucceeded || !draft.parsed || draft.parsed.should_draft === false) {
        await deps.prisma.trigger.update({
          where: { id: trigger.id },
          data: { status: 'needs_triage' },
        });
        await deps.prisma.tierHistoryEvent.create({
          data: {
            accountId: trigger.accountId,
            eventType: 'hold_at_tier',
            reason:
              draft.parsed?.abstain_reason ??
              `Drafting call ${draft.outcome} — routed to human triage`,
          },
        });
        return reply.send({ status: 'needs_triage' });
      }

      const message = await deps.prisma.message.create({
        data: {
          accountId: trigger.accountId,
          triggerId: trigger.id,
          role: 'agent_draft',
          body: draft.parsed.draft_text,
          status: 'pending_review',
          tierContext: trigger.account.currentTier,
          confidenceMeta: {
            model: DRAFT_MODEL_ID,
            confidenceLabel: draft.parsed.confidence_label,
            latencyMs: draft.latencyMs,
          },
        },
      });

      await deps.prisma.trigger.update({ where: { id: trigger.id }, data: { status: 'drafted' } });

      return reply.send({ status: 'drafted', messageId: message.id });
    },
  );
}
