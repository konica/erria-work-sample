import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { generateRecommendedNextStep } from './generate-next-step.js';

describe('generateRecommendedNextStep', () => {
  it('returns the generated note on success', async () => {
    const client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Buyer asked for a life-raft servicing quote. Hand to an AE.' }],
          usage: { input_tokens: 300, output_tokens: 40 },
        }),
      },
    } as unknown as Anthropic;

    const result = await generateRecommendedNextStep(
      { rule: 'pricing_question', replyBody: 'What would it cost?', accountName: 'Dai Duong' },
      { client },
    );

    expect(result.text).toContain('Hand to an AE');
    expect(result.outcome).toBe('success');
  });

  it('falls back to the rule-specific note when the call fails, never blocking the escalation', async () => {
    const client = {
      messages: {
        create: vi.fn().mockRejectedValue(new Anthropic.APIConnectionError({ message: 'down' })),
      },
    } as unknown as Anthropic;

    const result = await generateRecommendedNextStep(
      { rule: 'pricing_question', replyBody: 'What would it cost?', accountName: 'Dai Duong' },
      { client },
    );

    expect(result.outcome).toBe('error');
    expect(result.text).toContain('no pricing authority');
  });
});
