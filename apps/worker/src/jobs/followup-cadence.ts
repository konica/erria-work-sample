import type { PrismaClient } from '@erria/db';
import type Anthropic from '@anthropic-ai/sdk';
import {
  draftMessage,
  dispatchMessage,
  evaluateAutonomousSend,
  newFactsSince,
  readSettingsFailClosed,
  TONE_SYSTEM_PROMPT,
  DRAFT_MODEL_ID,
  type DispatchMode,
} from '@erria/domain';

const DRAFT_PROMPT_VERSION = 'v1';
const MS_PER_DAY = 86_400_000;

export interface FollowupResult {
  followupsSent: number;
  followupsHeld: number;
  sequencesEnded: number;
}

/**
 * Autonomous-send design §5's cadence: at most `Setting.maxFollowups`, at least
 * `Setting.minDaysBetweenFollowups` apart, each one citing new information located by
 * `newFactsSince` — never a bare "just checking in." Whether news exists is decided by ordinary
 * code BEFORE any Claude call, so the common case (nothing new) costs zero tokens and cannot
 * invent news; the model only ever chooses how to phrase facts the system already located.
 *
 * Scoped to Tier 1 accounts — follow-ups are an extension of the permission a Tier 1 account has
 * already earned to send unreviewed (§2), not a new capability Tier 2/3 accounts get for free.
 */
export async function runFollowupCadence(
  prisma: PrismaClient,
  anthropic: Anthropic,
  dispatchMode: DispatchMode,
): Promise<FollowupResult> {
  const settings = await readSettingsFailClosed(prisma);
  const maxFollowups = settings?.maxFollowups ?? 2;
  const minDays = settings?.minDaysBetweenFollowups ?? 5;

  const candidates = await prisma.trigger.findMany({
    where: { status: 'drafted', account: { currentTier: 1 } },
    include: {
      account: { include: { contacts: true } },
      vessel: true,
      messages: { where: { status: 'sent' }, orderBy: { sentAt: 'desc' } },
    },
  });

  const result: FollowupResult = { followupsSent: 0, followupsHeld: 0, sequencesEnded: 0 };

  for (const trigger of candidates) {
    const sentMessages = trigger.messages;
    const lastSent = sentMessages[0];
    if (!lastSent?.sentAt) continue;

    // A buyer reply ends the cadence — the conversation has moved on, and continuing to follow up
    // on the original trigger would talk past whatever the buyer actually said.
    const buyerReplied = await prisma.message.count({
      where: { accountId: trigger.accountId, role: 'buyer_inbound' },
    });
    if (buyerReplied > 0) continue;

    const followupCount = sentMessages.filter((message) => message.isFollowup).length;
    if (followupCount >= maxFollowups) continue;

    const daysElapsed = (Date.now() - lastSent.sentAt.getTime()) / MS_PER_DAY;
    if (daysElapsed < minDays) continue;

    // The gate the whole design turns on: computed by ordinary code, never asked of the model.
    const facts = await newFactsSince(prisma, trigger.accountId, lastSent.sentAt);
    if (facts.length === 0) {
      await prisma.trigger.update({ where: { id: trigger.id }, data: { status: 'sequence_ended' } });
      result.sequencesEnded += 1;
      continue;
    }

    const draft = await draftMessage(
      {
        toneSystemPrompt: `${TONE_SYSTEM_PROMPT}

This is a follow-up. Write about ONLY the following new information, which is the entire reason
this message is permitted to exist. Do not restate the original message and do not add anything
not listed here:
${facts.map((fact) => `- ${fact.summary}`).join('\n')}`,
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
        tier: 1,
      },
      { client: anthropic },
    );

    await prisma.llmCall.create({
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
    // A drafting failure or abstention is left as-is (Trigger.status stays 'drafted') rather than
    // ended or triaged — a follow-up that never sends is a missed opportunity, not an error, and
    // the next job run tries again from the same lastSent cutoff.
    if (!draftSucceeded || !draft.parsed || draft.parsed.should_draft === false) {
      continue;
    }

    const recipient = trigger.account.contacts.find((contact) => contact.email)?.email;
    const blockingEscalation = await prisma.escalation.findFirst({
      where: { accountId: trigger.accountId, status: 'active', agentSendDisabled: true },
    });

    const decision = evaluateAutonomousSend({
      autonomousSendingEnabled: settings?.autonomousSendingEnabled ?? false,
      hasActiveSendBlockingEscalation: blockingEscalation !== null,
      citesComplianceDeadline: trigger.hasComplianceDeadlineContent,
      draftConfidence: draft.parsed.confidence_label,
      hasContactEmail: Boolean(recipient),
    });

    const confidenceMeta = {
      model: DRAFT_MODEL_ID,
      confidenceLabel: draft.parsed.confidence_label,
      latencyMs: draft.latencyMs,
    };

    if (decision.outcome === 'triage') {
      await prisma.trigger.update({ where: { id: trigger.id }, data: { status: 'needs_triage' } });
      await prisma.tierHistoryEvent.create({
        data: {
          accountId: trigger.accountId,
          eventType: 'hold_at_tier',
          reason: 'Autonomous follow-up could not proceed — no contact email on this account.',
        },
      });
      continue;
    }

    if (decision.outcome === 'hold') {
      // Held at Tier 2 for this message only — Account.currentTier stays 1 (ADR-0003's
      // message-level cap, generalised by the autonomous-send design to all four hold reasons).
      await prisma.message.create({
        data: {
          accountId: trigger.accountId,
          triggerId: trigger.id,
          role: 'agent_draft',
          body: draft.parsed.draft_text,
          status: 'pending_review',
          tierContext: 2,
          hardRuleFlags: [decision.reason],
          isFollowup: true,
          followupSequenceNumber: followupCount + 1,
          confidenceMeta,
        },
      });
      result.followupsHeld += 1;
      continue;
    }

    // decision.outcome === 'send'. Persisted as 'approved' with a system decider BEFORE dispatch
    // is attempted, so the same dispatch path (and the reconciliation sweep watching it) covers a
    // failed follow-up send with no changes to either.
    const message = await prisma.message.create({
      data: {
        accountId: trigger.accountId,
        triggerId: trigger.id,
        role: 'agent_draft',
        body: draft.parsed.draft_text,
        status: 'approved',
        tierContext: 1,
        decidedBy: 'system (autonomous)',
        decidedAt: new Date(),
        isFollowup: true,
        followupSequenceNumber: followupCount + 1,
        confidenceMeta,
      },
    });

    const dispatchResult = await dispatchMessage(dispatchMode, { messageId: message.id }, { prisma });

    if (dispatchResult.status !== 'sent') {
      // Left 'approved' with no sentAt — exactly what the stuck-send reconciliation sweep already
      // watches for — rather than retried here.
      continue;
    }

    result.followupsSent += 1;
  }

  return result;
}
