import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { draftOutputSchema, type DraftOutput } from './draft-output-schema.js';

export const DRAFT_MODEL_ID = 'claude-sonnet-5';
const DRAFT_TIMEOUT_MS = 20_000;

export interface DraftMessageInput {
  toneSystemPrompt: string;
  account: { companyName: string; segment: string; hub: string; relationshipSummary: string };
  vessel: { name: string; imo: string; flag: string } | null;
  trigger: {
    category: string;
    description: string;
    source: string;
    confidenceLabel: string;
    verifiabilityNote: string;
  };
  tier: 1 | 2 | 3;
}

export interface DraftMessageResult {
  outcome: 'success' | 'retried_success' | 'timeout' | 'error';
  parsed: DraftOutput | null;
  latencyMs: number;
  errorDetail: string | null;
  requestTokens: number;
  responseTokens: number;
}

export async function draftMessage(
  input: DraftMessageInput,
  deps: { client: Anthropic },
): Promise<DraftMessageResult> {
  const startedAt = Date.now();
  const params = {
    model: DRAFT_MODEL_ID,
    max_tokens: 1024,
    system: [
      {
        type: 'text' as const,
        text: input.toneSystemPrompt,
        cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
      },
    ],
    messages: [{ role: 'user' as const, content: buildUserContent(input) }],
    output_config: { format: zodOutputFormat(draftOutputSchema) },
  };
  const requestOptions = { timeout: DRAFT_TIMEOUT_MS, maxRetries: 0 };

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
  return error instanceof Anthropic.APIConnectionError || error instanceof Anthropic.InternalServerError;
}

function toErrorResult(error: unknown, startedAt: number): DraftMessageResult {
  const isConnectionFailure = error instanceof Anthropic.APIConnectionError;
  return {
    outcome: isConnectionFailure ? 'timeout' : 'error',
    parsed: null,
    latencyMs: Date.now() - startedAt,
    errorDetail: error instanceof Error ? error.message : String(error),
    requestTokens: 0,
    responseTokens: 0,
  };
}

function buildUserContent(input: DraftMessageInput): string {
  const vesselLine = input.vessel
    ? `Vessel: ${input.vessel.name} (IMO ${input.vessel.imo}, flag ${input.vessel.flag})`
    : 'Vessel: none specified';

  return [
    `Account: ${input.account.companyName} — ${input.account.segment} · ${input.account.hub}`,
    `Relationship: ${input.account.relationshipSummary}`,
    vesselLine,
    `Trigger: ${input.trigger.category} — ${input.trigger.description}`,
    `Trigger source: ${input.trigger.source} (confidence: ${input.trigger.confidenceLabel})`,
    `Verifiability note: ${input.trigger.verifiabilityNote}`,
    `Account tier: ${input.tier}`,
  ].join('\n');
}
