/**
 * Spec §11's "locked, engineer-only" tier. Deliberately constants, not `Setting` columns: storing
 * them in the database would imply an admin can change them, which is exactly the implication the
 * spec rules out. Served read-only so the Settings screen can show what the policy is.
 */
export const LOCKED_POLICY = {
  hardTriggerRules: [
    {
      key: 'pricing_question',
      label: 'Pricing or commercial terms',
      description: 'The agent has no authority to quote, so any commercial question routes to a human.',
    },
    {
      key: 'technical_compliance_question',
      label: 'Technical or compliance question beyond verified knowledge',
      description: 'Questions whose answers depend on specifics the dossier does not cover.',
    },
    {
      key: 'negative_sentiment',
      label: 'Negative sentiment, complaint, or opt-out',
      description: 'Escalates and stops all further outreach to that account until a human reviews.',
    },
    {
      key: 'relationship_conflict',
      label: 'Sign of an existing Erria relationship not on record',
      description: 'An unknown relationship is a reason to stop, not to guess.',
    },
    {
      key: 'compliance_deadline_content',
      label: "Message citing a vessel's compliance deadline",
      description:
        'Capped at Tier 2 minimum — never sent fully autonomously — because referencing a ' +
        "recipient's own compliance data reads as helpful or as surveillance depending entirely on framing.",
    },
  ],
  rolloutOverlayEnabled: true,
  rolloutOverlayDescription:
    'Every new account starts at Tier 2 minimum regardless of score, until it has earned promotion. ' +
    'This is a risk-appetite decision, not a tuning knob.',
} as const;
