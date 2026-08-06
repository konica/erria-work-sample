import type { PrismaClient } from '@erria/db';
import { recommendTierForTrigger } from './recommend-tier.js';

export interface IncomingTriggerInput {
  accountId: string;
  vesselId: string | null;
  category: string;
  description: string;
  source: 'crm' | 'class_records' | 'public_data' | 'buyer_reply';
  confidenceLabel: 'high' | 'mid' | 'low';
  verifiabilityNote: string;
  detectedAt: Date;
  hasComplianceDeadlineContent: boolean;
}

export interface PersistedTrigger {
  triggerId: string;
  tier: 1 | 2;
  tierRationale: string;
}

/**
 * Persists an incoming Trigger together with the tier decision that governs it, in one
 * transaction: either the Trigger and its TierHistoryEvent both land, or neither does.
 */
export async function recordIncomingTrigger(
  prisma: PrismaClient,
  input: IncomingTriggerInput,
): Promise<PersistedTrigger> {
  return prisma.$transaction(async (tx) => {
    const account = await tx.account.findUniqueOrThrow({ where: { id: input.accountId } });
    const accountAlreadyEarnedTier1 = account.currentTier === 1;

    const recommendation = recommendTierForTrigger({
      accountAlreadyEarnedTier1,
      icpScore: account.icpScore,
      triggerConfidence: input.confidenceLabel,
      hasComplianceDeadlineContent: input.hasComplianceDeadlineContent,
    });

    const trigger = await tx.trigger.create({
      data: {
        accountId: input.accountId,
        vesselId: input.vesselId,
        category: input.category,
        description: input.description,
        source: input.source,
        confidenceLabel: input.confidenceLabel,
        verifiabilityNote: input.verifiabilityNote,
        detectedAt: input.detectedAt,
        status: 'processing',
        hasComplianceDeadlineContent: input.hasComplianceDeadlineContent,
      },
    });

    // An account that has already earned Tier 1 is never demoted by tiering a single trigger —
    // the Tier 2 outcome governs this draft only, recorded as `current_draft` (ADR-0003). Spec §3
    // reserves real demotion for negative signals, which this code path never sees.
    if (accountAlreadyEarnedTier1) {
      await tx.tierHistoryEvent.create({
        data: {
          accountId: input.accountId,
          eventType: 'current_draft',
          fromTier: account.currentTier,
          toTier: recommendation.tier,
          reason: recommendation.rationale,
        },
      });
    } else {
      if (account.currentTier !== recommendation.tier) {
        await tx.account.update({
          where: { id: input.accountId },
          data: { currentTier: recommendation.tier, tierRationale: recommendation.rationale },
        });
      }
      await tx.tierHistoryEvent.create({
        data: {
          accountId: input.accountId,
          eventType: 'hold_at_tier',
          fromTier: account.currentTier,
          toTier: recommendation.tier,
          reason: recommendation.rationale,
        },
      });
    }

    return {
      triggerId: trigger.id,
      tier: recommendation.tier,
      tierRationale: recommendation.rationale,
    };
  });
}
