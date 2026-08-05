import type { ClassificationResult } from './classify-inbound-reply.js';

export type HardTriggerRuleName =
  | 'pricing_question'
  | 'technical_compliance_question'
  | 'negative_sentiment'
  | 'relationship_conflict'
  | 'non_english_language'
  | 'classification_uncertain';

export interface HardTriggerDecision {
  fires: boolean;
  rule: HardTriggerRuleName | null;
  reasonSummary: string;
  detail: string;
}

export interface DecisionSettings {
  sentimentConfidenceFloor: 'Low' | 'Medium' | 'High';
}

const CONFIDENCE_RANK = { low: 1, mid: 2, high: 3 } as const;
const FLOOR_RANK = { Low: 1, Medium: 2, High: 3 } as const;

export function decideHardTrigger(
  result: ClassificationResult,
  settings: DecisionSettings,
): HardTriggerDecision {
  // Fail closed, case (a): the call itself failed. We cannot verify that no rule fired.
  if (!result.parsed) {
    return uncertain(`The classification call ${result.outcome} — the reply could not be checked.`);
  }

  const { fires, rule, confidence, language_detected: language, rationale } = result.parsed;

  // Fail closed, case (b): the model answered but was not confident.
  if (confidence === 'low') {
    return uncertain('The classifier reported low confidence in its own answer.');
  }

  // Spec §7: a non-English reply escalates on its own, whether or not a rule matched — the tone
  // rules were never validated in another language, so the agent must not continue autonomously.
  if (language && language.toLowerCase() !== 'en') {
    return {
      fires: true,
      rule: 'non_english_language',
      reasonSummary: `Reply is not in English (detected: ${language})`,
      detail:
        'The tone and structure rules were written and reviewed in English only, so a reply in ' +
        'another language is handed to a human rather than answered autonomously.',
    };
  }

  if (!fires || !rule) {
    return { fires: false, rule: null, reasonSummary: '', detail: '' };
  }

  // The confidence floor is a signal-detection threshold on sentiment specifically (spec §11) —
  // it tunes precision on the one rule that is a judgment call, not the rules that are factual.
  if (
    rule === 'negative_sentiment' &&
    CONFIDENCE_RANK[confidence] < FLOOR_RANK[settings.sentimentConfidenceFloor]
  ) {
    return uncertain(
      `Negative sentiment was reported at ${confidence} confidence, below the configured floor of ` +
        `${settings.sentimentConfidenceFloor}.`,
    );
  }

  return { fires: true, rule, reasonSummary: summaryFor(rule), detail: rationale };
}

function uncertain(detail: string): HardTriggerDecision {
  return {
    fires: true,
    rule: 'classification_uncertain',
    reasonSummary: 'Could not confirm whether a hard trigger fired',
    detail: `${detail} Escalated rather than assumed safe.`,
  };
}

function summaryFor(rule: HardTriggerRuleName): string {
  switch (rule) {
    case 'pricing_question':
      return 'Buyer asked about pricing or commercial terms';
    case 'technical_compliance_question':
      return 'Buyer asked a technical or compliance question beyond verified knowledge';
    case 'negative_sentiment':
      return 'Buyer replied with a complaint, correction, or opt-out';
    case 'relationship_conflict':
      return 'Buyer referred to an existing Erria relationship not on record';
    case 'non_english_language':
      return 'Reply is not in English';
    default:
      return 'Could not confirm whether a hard trigger fired';
  }
}
