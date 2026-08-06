import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@erria/db';
import type Anthropic from '@anthropic-ai/sdk';
import {
  draftMessage,
  dispatchMessage,
  evaluateAutonomousSend,
  shouldSampleSend,
  TONE_SYSTEM_PROMPT,
  DRAFT_MODEL_ID,
  type DispatchMode,
} from '@erria/domain';

const DRAFT_PROMPT_VERSION = 'v1';

export function registerProcessTriggerRoute(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; anthropic: Anthropic; dispatchMode: DispatchMode },
) {
  app.post<{ Params: { triggerId: string } }>(
    '/internal/process-trigger/:triggerId',
    async (request, reply) => {
      const trigger = await deps.prisma.trigger.findUnique({
        where: { id: request.params.triggerId },
        include: { account: { include: { contacts: true } }, vessel: true },
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

      const confidenceMeta = {
        model: DRAFT_MODEL_ID,
        confidenceLabel: draft.parsed.confidence_label,
        latencyMs: draft.latencyMs,
      };

      // Tier 2 (and Tier 3, which never reaches drafting) keep the original behavior unchanged:
      // every draft waits for a human, whatever the drafting call's own confidence was.
      if (trigger.account.currentTier !== 1) {
        const message = await deps.prisma.message.create({
          data: {
            accountId: trigger.accountId,
            triggerId: trigger.id,
            role: 'agent_draft',
            body: draft.parsed.draft_text,
            status: 'pending_review',
            tierContext: trigger.account.currentTier,
            confidenceMeta,
          },
        });

        await deps.prisma.trigger.update({ where: { id: trigger.id }, data: { status: 'drafted' } });

        return reply.send({ status: 'drafted', messageId: message.id });
      }

      // Tier 1: the account has earned permission to send unreviewed. Whether it applies to THIS
      // message is the gate's decision (autonomous-send design §2).
      const settings = await deps.prisma.setting.findUnique({ where: { id: 1 } });
      const recipient = trigger.account.contacts.find((contact) => contact.email)?.email;
      const blockingEscalation = await deps.prisma.escalation.findFirst({
        where: { accountId: trigger.accountId, status: 'active', agentSendDisabled: true },
      });

      const decision = evaluateAutonomousSend({
        autonomousSendingEnabled: settings?.autonomousSendingEnabled ?? false,
        hasActiveSendBlockingEscalation: blockingEscalation !== null,
        citesComplianceDeadline: trigger.hasComplianceDeadlineContent,
        draftConfidence: draft.parsed.confidence_label,
        hasContactEmail: Boolean(recipient),
      });

      if (decision.outcome === 'triage') {
        await deps.prisma.trigger.update({
          where: { id: trigger.id },
          data: { status: 'needs_triage' },
        });
        await deps.prisma.tierHistoryEvent.create({
          data: {
            accountId: trigger.accountId,
            eventType: 'hold_at_tier',
            reason: 'Tier 1 send could not proceed — no contact email on this account.',
          },
        });
        return reply.send({ status: 'needs_triage', reason: decision.reason });
      }

      if (decision.outcome === 'hold') {
        // Held at Tier 2 for this message only — Account.currentTier stays 1 (ADR-0003's
        // message-level cap, generalised by the autonomous-send design to all four hold reasons).
        const message = await deps.prisma.message.create({
          data: {
            accountId: trigger.accountId,
            triggerId: trigger.id,
            role: 'agent_draft',
            body: draft.parsed.draft_text,
            status: 'pending_review',
            tierContext: 2,
            hardRuleFlags: [decision.reason],
            confidenceMeta,
          },
        });

        await deps.prisma.trigger.update({ where: { id: trigger.id }, data: { status: 'drafted' } });

        return reply.send({
          status: 'held_for_approval',
          reason: decision.reason,
          messageId: message.id,
        });
      }

      // decision.outcome === 'send'. Persisted as 'approved' with a system decider BEFORE
      // dispatch, so the same dispatch path the human-approval flow uses — and the reconciliation
      // sweep that watches it — covers a failed autonomous send with no changes to either.
      const message = await deps.prisma.message.create({
        data: {
          accountId: trigger.accountId,
          triggerId: trigger.id,
          role: 'agent_draft',
          body: draft.parsed.draft_text,
          status: 'approved',
          tierContext: 1,
          decidedBy: 'system (autonomous)',
          decidedAt: new Date(),
          confidenceMeta,
        },
      });

      const priorAutonomousSends = await deps.prisma.message.count({
        where: { accountId: trigger.accountId, tierContext: 1, status: 'sent' },
      });

      const dispatchResult = await dispatchMessage(
        deps.dispatchMode,
        { messageId: message.id },
        { prisma: deps.prisma },
      );

      if (dispatchResult.status !== 'sent') {
        // The gap between the gate above and dispatch is small but real (e.g. an escalation could
        // open in between). The message is left 'approved' with no sentAt — exactly what the
        // stuck-send reconciliation sweep already watches for — rather than retried here.
        await deps.prisma.trigger.update({ where: { id: trigger.id }, data: { status: 'drafted' } });
        return reply.send({ status: 'approved_pending_dispatch', messageId: message.id });
      }

      // An account's first autonomous send is always sampled, whatever the configured rate — the
      // first message sent with nobody reading it is the riskiest one it will ever send.
      if (
        shouldSampleSend({
          sampleRatePercent: settings?.tier1AuditSampleRate ?? 10,
          isFirstAutonomousSend: priorAutonomousSends === 0,
          random: Math.random,
        })
      ) {
        await deps.prisma.auditSample.create({
          data: { messageId: message.id, accountId: trigger.accountId },
        });
      }

      await deps.prisma.trigger.update({ where: { id: trigger.id }, data: { status: 'drafted' } });

      return reply.send({ status: 'sent_autonomously', messageId: message.id });
    },
  );
}
