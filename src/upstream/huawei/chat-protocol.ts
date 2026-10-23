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
  /** 上游真实缓存用量（v2 通道可能返回） */
  prompt_tokens_details?: {
    cached_tokens?: number;
    text_tokens?: number;
    audio_tokens?: number;
    cache_write_tokens?: number;
  };
  error_code?: string;
  error_msg?: string;
}

export interface CodeArtsRawToolCall {
  index?: number;
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

/**
 * v2 通道（OpenAI 兼容）chunk 形状。
 * 例：`{ id, object:"chat.completion.chunk", model, choices:[{index, delta, finish_reason}], usage? }`
 */
interface OpenAIV2Chunk {
  id?: string;
  object?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: CodeArtsRawToolCall[] | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      text_tokens?: number;
      audio_tokens?: number;
      cache_write_tokens?: number;
    };
  } | null;
  error?: { code?: string; message?: string } | null;
}

/**
 * 将 v2（OpenAI 兼容）chunk 归一化为内部 `CodeArtsSSEEvent`。
 *
 * 保留 `delta.content` / `delta.reasoning_content` / `delta.tool_calls`，
 * 并将 `usage` 映射为 `prompt_tokens` / `completion_tokens` / `prompt_tokens_details`。
 */
function normalizeV2Chunk(chunk: OpenAIV2Chunk): CodeArtsSSEEvent {
  const choice = chunk.choices?.[0];
  const event: CodeArtsSSEEvent = {};

  if (choice?.delta) {
    const delta: CodeArtsDelta = {};
    if (choice.delta.role !== undefined) delta.role = choice.delta.role;
    if (choice.delta.content !== undefined) delta.content = choice.delta.content;
    if (choice.delta.reasoning_content !== undefined)
      delta.reasoning_content = choice.delta.reasoning_content;
    if (choice.delta.tool_calls !== undefined) delta.tool_calls = choice.delta.tool_calls;
    event.delta = delta;
  }

  if (chunk.usage) {
    if (chunk.usage.prompt_tokens !== undefined) event.prompt_tokens = chunk.usage.prompt_tokens;
    if (chunk.usage.completion_tokens !== undefined)
      event.completion_tokens = chunk.usage.completion_tokens;
    if (chunk.usage.total_tokens !== undefined) event.total_tokens = chunk.usage.total_tokens;
    if (chunk.usage.prompt_tokens_details)
      event.prompt_tokens_details = chunk.usage.prompt_tokens_details;
  }

  // v2 流内错误（非标准 OpenAI，但上游可能返回）
  if (chunk.error?.code) {
    event.error_code = chunk.error.code;
    event.error_msg = chunk.error.message;
  }

  return event;
}

/** 判断是否为 v2（OpenAI 兼容）chunk 形状。 */
function isV2Chunk(value: unknown): value is OpenAIV2Chunk {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.choices);
}

export async function* parseSSE(
  stream: AsyncIterable<string>,
  traceId?: string,
): AsyncGenerator<CodeArtsSSEEvent> {
  for await (const line of stream) {
    if (!line.startsWith("data:")) continue;
    const json = line.slice(5).trim();
    if (!json || json === "[DONE]") continue;
    try {
      const parsed = JSON.parse(json) as unknown;
      // v2 通道：OpenAI 兼容 `choices[].delta` 形状 → 归一化
      if (isV2Chunk(parsed)) {
        yield normalizeV2Chunk(parsed);
        continue;
      }
      yield parsed as CodeArtsSSEEvent;
    } catch {
      const err = new ProtocolError(`Malformed SSE data: ${json.slice(0, 200)}`, json, traceId);
      logger.withTrace(traceId ?? "unknown").warn("Malformed SSE data ignored", { rawData: json.slice(0, 200) });
      yield { error_code: "PROTOCOL_ERROR", error_msg: err.message } as CodeArtsSSEEvent;
    }
  }
}
