import { describe, it, expect } from 'vitest';
import { evaluateAutonomousSend, type AutonomousSendInput } from './evaluate-autonomous-send.js';

function allClear(): AutonomousSendInput {
  return {
    autonomousSendingEnabled: true,
    hasActiveSendBlockingEscalation: false,
    citesComplianceDeadline: false,
    draftConfidence: 'high',
    hasContactEmail: true,
  };
}

describe('evaluateAutonomousSend', () => {
  it('sends when every condition holds', () => {
    expect(evaluateAutonomousSend(allClear())).toEqual({ outcome: 'send' });
  });

  it('holds when autonomous sending is paused', () => {
    const decision = evaluateAutonomousSend({ ...allClear(), autonomousSendingEnabled: false });
    expect(decision).toEqual({ outcome: 'hold', reason: 'autonomous_paused_hold' });
  });

  it('holds when the account has a send-blocking escalation', () => {
    const decision = evaluateAutonomousSend({
      ...allClear(),
      hasActiveSendBlockingEscalation: true,
    });
    expect(decision).toEqual({ outcome: 'hold', reason: 'escalation_hold' });
  });

  it('holds when the message cites a compliance deadline (§4 rule 5)', () => {
    const decision = evaluateAutonomousSend({ ...allClear(), citesComplianceDeadline: true });
    expect(decision).toEqual({ outcome: 'hold', reason: 'compliance_deadline_content' });
  });

  it('holds on mid confidence', () => {
    const decision = evaluateAutonomousSend({ ...allClear(), draftConfidence: 'mid' });
    expect(decision).toEqual({ outcome: 'hold', reason: 'low_confidence_hold' });
  });

  it('routes to triage when there is no contact email — there is nothing to approve', () => {
    const decision = evaluateAutonomousSend({ ...allClear(), hasContactEmail: false });
    expect(decision).toEqual({ outcome: 'triage', reason: 'no_contact_email' });
  });

  it('reports the pause first when several conditions fail at once', () => {
    // Ordering is deliberate: the operator-facing reason ("we are paused") explains the hold better
    // than an incidental one, and a paused system should say so rather than blaming the draft.
    const decision = evaluateAutonomousSend({
      ...allClear(),
      autonomousSendingEnabled: false,
      draftConfidence: 'mid',
      citesComplianceDeadline: true,
    });
    expect(decision).toEqual({ outcome: 'hold', reason: 'autonomous_paused_hold' });
  });

  it('prefers triage over a hold when there is also no address', () => {
    // A held message assumes someone can send it. Without an address nobody can, so triage wins
    // even though a hold reason also applies.
    const decision = evaluateAutonomousSend({
      ...allClear(),
      hasContactEmail: false,
      draftConfidence: 'mid',
    });
    expect(decision).toEqual({ outcome: 'triage', reason: 'no_contact_email' });
  });
});
