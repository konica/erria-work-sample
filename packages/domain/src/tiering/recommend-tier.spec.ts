import { describe, it, expect } from 'vitest';
import { recommendTierForTrigger } from './recommend-tier.js';

describe('recommendTierForTrigger', () => {
  it('caps a new account at Tier 2 even with a qualifying score (spec §3 rollout overlay)', () => {
    const result = recommendTierForTrigger({
      accountAlreadyEarnedTier1: false,
      icpScore: 90,
      triggerConfidence: 'high',
      hasComplianceDeadlineContent: false,
    });

    expect(result.tier).toBe(2);
    expect(result.capReasons).toEqual(['new_account_rollout']);
  });

  it('caps an already-earned Tier 1 account at Tier 2 for compliance-deadline content (spec §4 rule 5)', () => {
    const result = recommendTierForTrigger({
      accountAlreadyEarnedTier1: true,
      icpScore: 90,
      triggerConfidence: 'high',
      hasComplianceDeadlineContent: true,
    });

    expect(result.tier).toBe(2);
    expect(result.capReasons).toEqual(['compliance_deadline_content']);
  });

  it('reports both cap reasons when a new account also has compliance-deadline content', () => {
    const result = recommendTierForTrigger({
      accountAlreadyEarnedTier1: false,
      icpScore: 90,
      triggerConfidence: 'high',
      hasComplianceDeadlineContent: true,
    });

    expect(result.tier).toBe(2);
    expect(result.capReasons).toEqual(['new_account_rollout', 'compliance_deadline_content']);
  });

  it('defaults an ambiguous trigger to Tier 2 with no cap reason (base condition, not an overlay)', () => {
    const result = recommendTierForTrigger({
      accountAlreadyEarnedTier1: true,
      icpScore: 90,
      triggerConfidence: 'low',
      hasComplianceDeadlineContent: false,
    });

    expect(result.tier).toBe(2);
    expect(result.capReasons).toEqual([]);
  });

  it('recommends Tier 1 for an already-earned account with a qualifying score and no cap (the documented gap)', () => {
    const result = recommendTierForTrigger({
      accountAlreadyEarnedTier1: true,
      icpScore: 90,
      triggerConfidence: 'high',
      hasComplianceDeadlineContent: false,
    });

    expect(result.tier).toBe(1);
    expect(result.capReasons).toEqual([]);
  });
});
