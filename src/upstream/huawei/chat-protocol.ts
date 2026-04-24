/**
 * CodeArts chat protocol types and SSE parser.
 */

import { ProtocolError } from "../../utils/errors";
import { logger } from "../../utils/logger";

// ---------------------------------------------------------------------------
// CodeArts upstream types
// ---------------------------------------------------------------------------

export interface CodeArtsDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: CodeArtsRawToolCall[] | null;
}

export interface CodeArtsSSEEvent {
  // meta fields (first event)
  chat_id?: string;
  response_message_id?: string;
  request_message_id?: string;
  // delta fields
  delta?: CodeArtsDelta;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  error_code?: string;
  error_msg?: string;
}

export interface CodeArtsRawToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  name?: string;
  arguments?: Record<string, unknown> | string;
}

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

export async function* parseSSE(
  stream: AsyncIterable<string>,
  traceId?: string,
): AsyncGenerator<CodeArtsSSEEvent> {
  for await (const line of stream) {
    if (!line.startsWith("data:")) continue;
    const json = line.slice(5).trim();
    if (!json || json === "[DONE]") continue;
    try {
      yield JSON.parse(json) as CodeArtsSSEEvent;
    } catch {
      const err = new ProtocolError(`Malformed SSE data: ${json.slice(0, 200)}`, json, traceId);
      logger.withTrace(traceId ?? "unknown").warn("Malformed SSE data ignored", { rawData: json.slice(0, 200) });
      yield { error_code: "PROTOCOL_ERROR", error_msg: err.message } as CodeArtsSSEEvent;
    }
  }
}
