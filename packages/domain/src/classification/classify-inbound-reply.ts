import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  classificationOutputSchema,
  type ClassificationOutput,
} from './classification-output-schema.js';

export const CLASSIFICATION_MODEL_ID = 'claude-sonnet-5';
const CLASSIFICATION_TIMEOUT_MS = 20_000;

export interface ClassifyInboundReplyInput {
  systemPrompt: string;
  replyBody: string;
}

export interface ClassificationResult {
  outcome: 'success' | 'retried_success' | 'timeout' | 'error';
  parsed: ClassificationOutput | null;
  latencyMs: number;
  errorDetail: string | null;
  requestTokens: number;
  responseTokens: number;
}

export async function classifyInboundReply(
  input: ClassifyInboundReplyInput,
  deps: { client: Anthropic },
): Promise<ClassificationResult> {
  const startedAt = Date.now();

  const params = {
    model: CLASSIFICATION_MODEL_ID,
    max_tokens: 512,
    system: [
      {
        type: 'text' as const,
        // Fixed Erria-authored rules only. The reply never reaches this block.
        text: input.systemPrompt,
        cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
      },
    ],
    messages: [
      {
        role: 'user' as const,
        content: `Classify the following inbound reply.\n\n<inbound_reply>\n${input.replyBody}\n</inbound_reply>`,
      },
    ],
    output_config: { format: zodOutputFormat(classificationOutputSchema) },
  };
  const requestOptions = { timeout: CLASSIFICATION_TIMEOUT_MS, maxRetries: 0 };

  let response;
  let retried = false;
  try {
    response = await deps.client.messages.parse(params, requestOptions);
  } catch (firstError) {
    if (!isRetryable(firstError)) {
      return toErrorResult(firstError, startedAt);
    }
    try {
      response = await deps.client.messages.parse(params, requestOptions);
      retried = true;
    } catch (secondError) {
      return toErrorResult(secondError, startedAt);
    }
  }

  if (!response.parsed_output) {
    return {
      outcome: 'error',
      parsed: null,
      latencyMs: Date.now() - startedAt,
      errorDetail: 'schema_validation_failed',
      requestTokens: response.usage.input_tokens,
      responseTokens: response.usage.output_tokens,
    };
  }

  return {
    outcome: retried ? 'retried_success' : 'success',
    parsed: response.parsed_output,
    latencyMs: Date.now() - startedAt,
    errorDetail: null,
    requestTokens: response.usage.input_tokens,
    responseTokens: response.usage.output_tokens,
  };
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof Anthropic.APIConnectionError || error instanceof Anthropic.InternalServerError
  );
}

function toErrorResult(error: unknown, startedAt: number): ClassificationResult {
  return {
    outcome: error instanceof Anthropic.APIConnectionError ? 'timeout' : 'error',
    parsed: null,
    latencyMs: Date.now() - startedAt,
    errorDetail: error instanceof Error ? error.message : String(error),
    requestTokens: 0,
    responseTokens: 0,
  };
}
