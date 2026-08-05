import Anthropic from '@anthropic-ai/sdk';
import { HANDOFF_SYSTEM_PROMPT, FALLBACK_NEXT_STEP_BY_RULE } from './handoff-system-prompt.js';

export const HANDOFF_MODEL_ID = 'claude-sonnet-5';
const HANDOFF_TIMEOUT_MS = 20_000;

export interface GenerateNextStepInput {
  rule: string;
  replyBody: string;
  accountName: string;
}

export interface GenerateNextStepResult {
  text: string;
  outcome: 'success' | 'error';
  latencyMs: number;
  requestTokens: number;
  responseTokens: number;
  errorDetail: string | null;
}

export async function generateRecommendedNextStep(
  input: GenerateNextStepInput,
  deps: { client: Anthropic },
): Promise<GenerateNextStepResult> {
  const startedAt = Date.now();

  try {
    const response = await deps.client.messages.create(
      {
        model: HANDOFF_MODEL_ID,
        max_tokens: 400,
        system: [
          {
            type: 'text' as const,
            text: HANDOFF_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
          },
        ],
        messages: [
          {
            role: 'user' as const,
            content:
              `Account: ${input.accountName}\nRule that fired: ${input.rule}\n\n` +
              `<inbound_reply>\n${input.replyBody}\n</inbound_reply>`,
          },
        ],
      },
      { timeout: HANDOFF_TIMEOUT_MS, maxRetries: 0 },
    );

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    return {
      text: text || fallbackFor(input.rule),
      outcome: 'success',
      latencyMs: Date.now() - startedAt,
      requestTokens: response.usage.input_tokens,
      responseTokens: response.usage.output_tokens,
      errorDetail: null,
    };
  } catch (error) {
    // Deliberately no retry and never a thrown error: this text is a convenience for the human.
    // An escalation that exists with a generic next step beats an escalation that failed to open.
    return {
      text: fallbackFor(input.rule),
      outcome: 'error',
      latencyMs: Date.now() - startedAt,
      requestTokens: 0,
      responseTokens: 0,
      errorDetail: error instanceof Error ? error.message : String(error),
    };
  }
}

function fallbackFor(rule: string): string {
  return FALLBACK_NEXT_STEP_BY_RULE[rule] ?? 'Read the reply and decide the next action manually.';
}
