export type CapReason = 'new_account_rollout' | 'compliance_deadline_content';

export interface TierInput {
  /** Account.currentTier === 1, read before this trigger's own evaluation. */
  accountAlreadyEarnedTier1: boolean;
  icpScore: number;
  triggerConfidence: 'high' | 'mid' | 'low';
  hasComplianceDeadlineContent: boolean;
}

export interface TierRecommendation {
  tier: 1 | 2;
  rationale: string;
  capReasons: CapReason[];
}

export function recommendTierForTrigger(input: TierInput): TierRecommendation {
  const baseTier: 1 | 2 = input.icpScore >= 70 && input.triggerConfidence === 'high' ? 1 : 2;
  let tier: 1 | 2 = baseTier;
  const capReasons: CapReason[] = [];

  if (!input.accountAlreadyEarnedTier1 && baseTier === 1) {
    tier = 2;
    capReasons.push('new_account_rollout');
  }
  if (input.hasComplianceDeadlineContent && baseTier === 1) {
    tier = 2;
    capReasons.push('compliance_deadline_content');
  }

  return { tier, rationale: buildRationale(baseTier, tier, capReasons), capReasons };
}

function buildRationale(baseTier: 1 | 2, finalTier: 1 | 2, capReasons: CapReason[]): string {
  if (capReasons.length === 0) {
    return finalTier === 1
      ? 'High ICP fit and a high-confidence trigger — qualifies for Tier 1 on score alone.'
      : 'Moderate score or an ambiguous trigger — default Tier 2 per spec §3.';
  }

  const reasonText = capReasons
    .map((reason) =>
      reason === 'new_account_rollout'
        ? 'new account, held at Tier 2 minimum until 2 clean approvals (spec §3 rollout overlay)'
        : "message cites a vessel compliance/recertification deadline, capped at Tier 2 (spec §4 rule 5)",
    )
    .join('; and ');

  return `Base score would qualify for Tier ${baseTier}, but capped to Tier ${finalTier}: ${reasonText}.`;
}
