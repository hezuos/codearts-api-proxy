/**
 * Recovery helpers for upstream chat errors that can be surfaced to the client
 * as a visible warning plus a synthetic tool_call continuation.
 */

import { randomUUID } from "crypto";
import { logger } from "../../utils/logger";
import type {
  CodeArtsToolResult,
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
  OpenAIToolCall,
} from "../../types/openai";

const SYNTHETIC_TOOL_CALL_TTL_MS = 30 * 60 * 1000;
const syntheticToolCallBindings = new Map<
  string,
  { originalToolCallId: string; createdAt: number }
>();

function cleanupSyntheticToolCallBindings(): void {
  const now = Date.now();
  for (const [id, binding] of syntheticToolCallBindings) {
    if (now - binding.createdAt > SYNTHETIC_TOOL_CALL_TTL_MS) {
      syntheticToolCallBindings.delete(id);
    }
  }
}

function registerSyntheticToolCallId(originalToolCallId: string): string {
  cleanupSyntheticToolCallBindings();
  const syntheticId = `call_recovery_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  syntheticToolCallBindings.set(syntheticId, {
    originalToolCallId,
    createdAt: Date.now(),
  });
  return syntheticId;
}

export function resolveOriginalToolCallId(
  toolCallId: string | undefined,
): string | undefined {
  if (!toolCallId) return undefined;
  cleanupSyntheticToolCallBindings();
  return syntheticToolCallBindings.get(toolCallId)?.originalToolCallId ?? toolCallId;
}

function parseToolArguments(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeToolResultArguments(
  _request: OpenAIChatCompletionRequest,
  _toolName: string | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  // CodeArts 期望收到它原始发出的 arguments，不做任何修改
  return args;
}

function normalizeToolArgumentsText(
  request: OpenAIChatCompletionRequest,
  toolName: string | undefined,
  argumentsText: string,
): string {
  return JSON.stringify(
    normalizeToolResultArguments(request, toolName, parseToolArguments(argumentsText)),
  );
}

export function getTrailingToolExchange(
  request: OpenAIChatCompletionRequest,
): {
  assistantMsg?: OpenAIChatMessage;
  recentToolCalls: OpenAIToolCall[];
  trailingToolMessages: OpenAIChatMessage[];
  unmatchedToolMessages: OpenAIChatMessage[];
  matchedToolMessages: OpenAIChatMessage[];
} {
  const lastMsg = request.messages[request.messages.length - 1];
  if (!lastMsg || lastMsg.role !== "tool") {
    return {
      recentToolCalls: [],
      trailingToolMessages: [],
      unmatchedToolMessages: [],
      matchedToolMessages: [],
    };
  }

  let firstTrailingToolIndex = request.messages.length - 1;
  while (
    firstTrailingToolIndex > 0 &&
    request.messages[firstTrailingToolIndex - 1]?.role === "tool"
  ) {
    firstTrailingToolIndex--;
  }

  const assistantIndex = firstTrailingToolIndex - 1;
  const assistantMsg = assistantIndex >= 0 ? request.messages[assistantIndex] : undefined;
  const recentToolCalls = assistantMsg?.tool_calls ?? [];
  const byId = new Map(recentToolCalls.map((tc) => [tc.id, tc]));
  const trailingToolMessages = request.messages.slice(firstTrailingToolIndex);
  const unmatchedToolMessages = trailingToolMessages
    .filter((msg) => msg.role === "tool")
    .filter((msg) => {
      const originalId = resolveOriginalToolCallId(msg.tool_call_id);
      return !originalId || !byId.has(originalId);
    });
  const matchedToolMessages = trailingToolMessages.filter((msg) => {
    if (msg.role !== "tool" || !msg.tool_call_id) return false;
    const originalId = resolveOriginalToolCallId(msg.tool_call_id);
    return !!originalId && byId.has(originalId);
  });

  return {
    assistantMsg,
    recentToolCalls,
    trailingToolMessages,
    unmatchedToolMessages,
    matchedToolMessages,
  };
}

export function buildSyntheticRecoveryToolCalls(
  request: OpenAIChatCompletionRequest,
): OpenAIToolCall[] {
  const {
    assistantMsg,
    recentToolCalls,
    unmatchedToolMessages,
    matchedToolMessages,
  } = getTrailingToolExchange(request);

  if (!assistantMsg?.tool_calls?.length || unmatchedToolMessages.length > 0) {
    return [];
  }

  const matchedIds = new Set(
    matchedToolMessages
      .map((msg) => resolveOriginalToolCallId(msg.tool_call_id))
      .filter((id): id is string => !!id),
  );

  return recentToolCalls
    .filter((tc) => tc.id && matchedIds.has(tc.id))
    .map((tc) => ({
      id: registerSyntheticToolCallId(tc.id),
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: normalizeToolArgumentsText(
          request,
          tc.function.name,
          tc.function.arguments,
        ),
      },
    }));
}

export function extractRecoveredToolResults(
  request: OpenAIChatCompletionRequest,
  normalizeMessageContent: (content: unknown) => string,
): CodeArtsToolResult[] | undefined {
  const {
    assistantMsg,
    recentToolCalls,
    trailingToolMessages,
    unmatchedToolMessages,
    matchedToolMessages,
  } = getTrailingToolExchange(request);
  if (!assistantMsg?.tool_calls?.length) {
    logger.warn("[client→proxy→codearts] trailing tool messages have no preceding assistant tool_calls", {
      trailingToolMessages: trailingToolMessages.map((m) => ({
        tool_call_id: m.tool_call_id,
        name: m.name,
      })),
      precedingRole: assistantMsg?.role ?? "(none)",
    });
    return [];
  }

  const byId = new Map(recentToolCalls.map((tc) => [tc.id, tc]));
  if (unmatchedToolMessages.length > 0) {
    logger.warn("[client→proxy→codearts] trailing tool messages contain unmatched tool_call_id", {
      assistantToolCalls: recentToolCalls.map((tc) => ({ id: tc.id, name: tc.function.name })),
      unmatchedToolMessages: unmatchedToolMessages.map((m) => ({
        tool_call_id: m.tool_call_id,
        name: m.name,
      })),
    });
    return [];
  }

  logger.debug("[client→proxy→codearts] tool_results extraction", {
    assistantToolCalls: recentToolCalls.map((tc) => ({ id: tc.id, name: tc.function.name })),
    toolMessages: trailingToolMessages
      .filter((m) => m.role === "tool")
      .map((m) => ({
        tool_call_id: m.tool_call_id,
        matched: byId.has(resolveOriginalToolCallId(m.tool_call_id) ?? ""),
      })),
    matchedCount: matchedToolMessages.length,
  });

  return matchedToolMessages.map((msg) => {
    const originalToolCallId = resolveOriginalToolCallId(msg.tool_call_id);
    const tc = originalToolCallId ? byId.get(originalToolCallId) : undefined;
    return {
      feedback: "",
      result: normalizeMessageContent(msg.content),
      name: tc?.function.name ?? msg.name ?? "unknown",
      arguments: tc?.function.arguments
        ? normalizeToolResultArguments(
            request,
            tc.function.name,
            parseToolArguments(tc.function.arguments),
          )
        : {},
      status: "APPROVE",
      executeStatus: "success",
      toolCallId: originalToolCallId,
    } satisfies CodeArtsToolResult;
  });
}

export function buildRecoveryChunks(params: {
  completionId: string;
  created: number;
  model: string;
  responseMetadata: Record<string, string | undefined>;
  sentRole: boolean;
  sentMetadata: boolean;
  errorCode: string;
  errorMsg?: string;
  recoveryToolCalls: OpenAIToolCall[];
}): {
  chunks: OpenAIChatCompletionChunk[];
  sentRole: boolean;
  sentMetadata: boolean;
} {
  const recoveryNotice = `\n[上游错误: ${params.errorCode} - ${params.errorMsg ?? "unknown"}；正在尝试其他方式继续]\n`;
  const noticeChunk: OpenAIChatCompletionChunk = {
    id: params.completionId,
    object: "chat.completion.chunk",
    created: params.created,
    model: params.model,
    ...(params.sentMetadata ? {} : { codearts: params.responseMetadata }),
    choices: [
      {
        index: 0,
        delta: {
          ...(params.sentRole ? {} : { role: "assistant" }),
          content: recoveryNotice,
        },
        finish_reason: null,
      },
    ],
  };

  const recoveryChunk: OpenAIChatCompletionChunk = {
    id: params.completionId,
    object: "chat.completion.chunk",
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: params.recoveryToolCalls.map((tc, index) => ({
            index,
            id: tc.id,
            type: "function",
            function: tc.function,
          })),
        },
        finish_reason: null,
      },
    ],
  };

  return {
    chunks: [noticeChunk, recoveryChunk],
    sentRole: true,
    sentMetadata: true,
  };
}
