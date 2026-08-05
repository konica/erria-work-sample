import { describe, it, expect } from 'vitest';
import { decideHardTrigger } from './decide-hard-trigger.js';
import type { ClassificationResult } from './classify-inbound-reply.js';

function success(parsed: Partial<NonNullable<ClassificationResult['parsed']>> = {}): ClassificationResult {
  return {
    outcome: 'success',
    parsed: {
      fires: false,
      rule: null,
      confidence: 'high',
      language_detected: 'en',
      rationale: 'test',
      ...parsed,
    } as NonNullable<ClassificationResult['parsed']>,
    latencyMs: 100,
    errorDetail: null,
    requestTokens: 1,
    responseTokens: 1,
  };
}

describe('decideHardTrigger', () => {
  it('fires the reported rule when confidence clears the floor', () => {
    const decision = decideHardTrigger(
      success({ fires: true, rule: 'pricing_question', confidence: 'high' }),
      { sentimentConfidenceFloor: 'Medium' },
    );

    expect(decision).toMatchObject({ fires: true, rule: 'pricing_question' });
  });

  it('escalates as uncertain when the call failed entirely', () => {
    const decision = decideHardTrigger(
      {
        outcome: 'timeout',
        parsed: null,
        latencyMs: 20_000,
        errorDetail: 'timeout',
        requestTokens: 0,
        responseTokens: 0,
      },
      { sentimentConfidenceFloor: 'Medium' },
    );

    expect(decision).toMatchObject({ fires: true, rule: 'classification_uncertain' });
  });

  it('escalates as uncertain on a low-confidence "nothing fired"', () => {
    const decision = decideHardTrigger(success({ fires: false, rule: null, confidence: 'low' }), {
      sentimentConfidenceFloor: 'Medium',
    });

    expect(decision).toMatchObject({ fires: true, rule: 'classification_uncertain' });
  });

  it('holds negative_sentiment below the configured floor, escalating as uncertain instead', () => {
    const decision = decideHardTrigger(
      success({ fires: true, rule: 'negative_sentiment', confidence: 'mid' }),
      { sentimentConfidenceFloor: 'High' },
    );

    expect(decision).toMatchObject({ fires: true, rule: 'classification_uncertain' });
  });

  it('applies the floor only to negative_sentiment, not to other rules', () => {
    const decision = decideHardTrigger(
      success({ fires: true, rule: 'pricing_question', confidence: 'mid' }),
      { sentimentConfidenceFloor: 'High' },
    );

    expect(decision).toMatchObject({ fires: true, rule: 'pricing_question' });
  });

  it('escalates a non-English reply regardless of what else fired (spec §7)', () => {
    const decision = decideHardTrigger(
      success({ fires: false, rule: null, confidence: 'high', language_detected: 'vi' }),
      { sentimentConfidenceFloor: 'Medium' },
    );

    expect(decision).toMatchObject({ fires: true, rule: 'non_english_language' });
  });

  it('does not fire when nothing matched and the model was confident', () => {
    const decision = decideHardTrigger(success({ fires: false, rule: null, confidence: 'high' }), {
      sentimentConfidenceFloor: 'Medium',
    });

    expect(decision.fires).toBe(false);
  });
});
