import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { draftMessage, DRAFT_MODEL_ID } from './draft-message.js';

function buildInput() {
  return {
    toneSystemPrompt: 'test tone prompt',
    account: {
      companyName: 'Song Hong Shipping',
      segment: 'Offshore support vessel operator',
      hub: 'Haiphong',
      relationshipSummary: 'New account · first contact 12 Jul 2026',
    },
    vessel: { name: 'MV Song Hong Pioneer', imo: '9123456', flag: 'Vietnam' },
    trigger: {
      category: 'life-raft service window',
      description: 'Life raft may be approaching its next scheduled service window',
      source: 'public_data' as const,
      confidenceLabel: 'mid' as const,
      verifiabilityNote: 'Partly verifiable — service interval is illustrative',
    },
    tier: 2 as const,
  };
}

describe('draftMessage', () => {
  it('returns a successful draft on the first attempt', async () => {
    const parsedOutput = {
      should_draft: true,
      draft_text: 'Hi Ms. Pham, ...',
      confidence_label: 'high' as const,
      abstain_reason: null,
    };
    const client = {
      messages: {
        parse: vi.fn().mockResolvedValue({
          parsed_output: parsedOutput,
          usage: { input_tokens: 500, output_tokens: 120 },
        }),
      },
    } as unknown as Anthropic;

    const result = await draftMessage(buildInput(), { client });

    expect(result.outcome).toBe('success');
    expect(result.parsed).toEqual(parsedOutput);
    expect(result.requestTokens).toBe(500);
    expect(result.responseTokens).toBe(120);
    expect(client.messages.parse).toHaveBeenCalledTimes(1);
    expect(client.messages.parse).toHaveBeenCalledWith(
      expect.objectContaining({ model: DRAFT_MODEL_ID }),
      expect.objectContaining({ timeout: 20_000, maxRetries: 0 }),
    );
  });

  it('retries once on a connection failure and reports retried_success', async () => {
    const parsedOutput = {
      should_draft: true,
      draft_text: 'Hi Ms. Pham, ...',
      confidence_label: 'high' as const,
      abstain_reason: null,
    };
    const parse = vi
      .fn()
      .mockRejectedValueOnce(new Anthropic.APIConnectionError({ message: 'network blip' }))
      .mockResolvedValueOnce({
        parsed_output: parsedOutput,
        usage: { input_tokens: 500, output_tokens: 120 },
      });
    const client = { messages: { parse } } as unknown as Anthropic;

    const result = await draftMessage(buildInput(), { client });

    expect(result.outcome).toBe('retried_success');
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('does not retry on a 429 and reports error', async () => {
    const parse = vi.fn().mockRejectedValue(
      // @ts-expect-error — RateLimitError's `headers` param types as required `Headers` in the
      // installed SDK version, but `undefined` is valid at runtime and is what the brief specifies.
      new Anthropic.RateLimitError(429, { message: 'rate limited' }, 'rate limited', undefined),
    );
    const client = { messages: { parse } } as unknown as Anthropic;

    const result = await draftMessage(buildInput(), { client });

    expect(result.outcome).toBe('error');
    expect(parse).toHaveBeenCalledTimes(1);
  });
});
