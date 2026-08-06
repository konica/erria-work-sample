export type HoldReason =
  | 'autonomous_paused_hold'
  | 'escalation_hold'
  | 'compliance_deadline_content'
  | 'low_confidence_hold';

export interface AutonomousSendInput {
  autonomousSendingEnabled: boolean;
  hasActiveSendBlockingEscalation: boolean;
  citesComplianceDeadline: boolean;
  draftConfidence: 'high' | 'mid' | 'low';
  hasContactEmail: boolean;
}

export type AutonomousSendDecision =
  | { outcome: 'send' }
  | { outcome: 'hold'; reason: HoldReason }
  | { outcome: 'triage'; reason: 'no_contact_email' };

/**
 * The five conditions from the autonomous-send design §2. Tier 1 grants permission to send
 * unreviewed; this decides whether that permission applies to one specific message.
 *
 * A 'hold' means the message drafts and waits for approval — Message.tierContext = 2 — while
 * Account.currentTier is untouched. That is §4 rule 5's mechanic (ADR-0003) used for all four
 * hold reasons rather than only for rule 5.
 */
export function evaluateAutonomousSend(input: AutonomousSendInput): AutonomousSendDecision {
  // Checked first: a message with no recipient cannot be approved by anyone, so holding it for a
  // human would park it somewhere nobody can act on. It is a data problem, not a judgment call.
  if (!input.hasContactEmail) {
    return { outcome: 'triage', reason: 'no_contact_email' };
  }

  // Then the operator-facing reason, so a paused system explains itself rather than blaming a draft.
  if (!input.autonomousSendingEnabled) {
    return { outcome: 'hold', reason: 'autonomous_paused_hold' };
  }

  if (input.hasActiveSendBlockingEscalation) {
    return { outcome: 'hold', reason: 'escalation_hold' };
  }

  if (input.citesComplianceDeadline) {
    return { outcome: 'hold', reason: 'compliance_deadline_content' };
  }

  // Only 'mid' is a gate concern. 'low' never gets here — §7 stops it before a draft exists.
  if (input.draftConfidence !== 'high') {
    return { outcome: 'hold', reason: 'low_confidence_hold' };
  }

  return { outcome: 'send' };
}
