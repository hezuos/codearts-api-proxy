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

// ---------------------------------------------------------------------------
// Force-resync synthetic tool_call
// ---------------------------------------------------------------------------
// 当上游 00001216（prompt length exceeds limit）forceResync 重试仍失败时，
// proxy 合成一个 tool_call 下发给客户端，让客户端执行后续传。proxy 通过
// tool_call_id 注册识别回传的 tool_result，走 forceResync 路径（清空
// parent_message_id + 全量折叠），让对话能继续。
//
// 工具选择策略（按客户端可执行性优先级）：
//   1. Bash        — echo "codearts::forceResync"（最通用）
//   2. Glob        — 查找不存在的模式（返回空结果，无副作用）
//   3. Grep        — 搜索不存在的模式（返回空结果，无副作用）
//   4. Read        — 读不存在的路径（返回错误，但 tool_result 仍会回传）
//   5. askFollowupQuestion — 问一个空问题（客户端会提示用户）
// 若客户端 tools 列表不含任何可识别工具，返回 null（调用方回退到 Error chunk）。
// ---------------------------------------------------------------------------

export const FORCE_RESYNC_TOOL_RESULT = "codearts::forceResync";

/** 已注册的 forceResync tool_call id 集合（30 分钟 TTL）。 */
const forceResyncToolCallIds = new Map<string, number>();

function cleanupForceResyncToolCallIds(): void {
  const now = Date.now();
  for (const [id, createdAt] of forceResyncToolCallIds) {
    if (now - createdAt > SYNTHETIC_TOOL_CALL_TTL_MS) {
      forceResyncToolCallIds.delete(id);
    }
  }
}

/** 判断 tool_call_id 是否为 proxy 合成的 forceResync tool_call。 */
export function isForceResyncToolCallId(toolCallId: string | undefined): boolean {
  if (!toolCallId) return false;
  cleanupForceResyncToolCallIds();
  return forceResyncToolCallIds.has(toolCallId);
}

/** 根据客户端 tools 列表选择一个可执行的 forceResync tool_call。返回 null 表示无可用工具。 */
export function buildForceResyncToolCall(
  clientToolNames: string[],
): OpenAIToolCall | null {
  const nameSet = new Set(clientToolNames);
  const id = `call_forceresync_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let toolName: string | null = null;
  let argumentsText = "{}";

  if (nameSet.has("Bash")) {
    toolName = "Bash";
    argumentsText = JSON.stringify({ command: `echo "${FORCE_RESYNC_TOOL_RESULT}"` });
  } else if (nameSet.has("Glob")) {
    toolName = "Glob";
    argumentsText = JSON.stringify({ pattern: FORCE_RESYNC_TOOL_RESULT });
  } else if (nameSet.has("Grep")) {
    toolName = "Grep";
    argumentsText = JSON.stringify({ pattern: FORCE_RESYNC_TOOL_RESULT });
  } else if (nameSet.has("Read")) {
    toolName = "Read";
    argumentsText = JSON.stringify({ filePath: FORCE_RESYNC_TOOL_RESULT });
  } else if (nameSet.has("askFollowupQuestion")) {
    toolName = "askFollowupQuestion";
    argumentsText = JSON.stringify({ question: FORCE_RESYNC_TOOL_RESULT });
  }

  if (!toolName) return null;

  cleanupForceResyncToolCallIds();
  forceResyncToolCallIds.set(id, Date.now());
  logger.info("[proxy→client] synthesized forceResync tool_call", { toolName, id });
  return {
    id,
    type: "function",
    function: { name: toolName, arguments: argumentsText },
  };
}

/**
 * 检测请求尾部 tool message 是否为 forceResync tool_result（通过 tool_call_id 注册识别）。
 * 返回 true 时，调用方应走 forceResync 路径，并从 messages 中剥离该 tool exchange。
 */
export function detectForceResyncToolResult(
  request: OpenAIChatCompletionRequest,
): boolean {
  const lastMsg = request.messages[request.messages.length - 1];
  if (!lastMsg || lastMsg.role !== "tool") return false;
  return isForceResyncToolCallId(lastMsg.tool_call_id);
}

/**
 * 从 request.messages 尾部剥离 forceResync tool exchange（assistant tool_call + tool result）。
 * 返回新 messages 数组（不修改原数组）。若尾部不是 forceResync exchange，返回原数组。
 */
export function stripForceResyncToolExchange(
  request: OpenAIChatCompletionRequest,
): OpenAIChatMessage[] {
  const n = request.messages.length;
  if (n < 2) return request.messages;
  const last = request.messages[n - 1];
  const prev = request.messages[n - 2];
  if (last.role !== "tool" || prev.role !== "assistant") return request.messages;
  if (!isForceResyncToolCallId(last.tool_call_id)) return request.messages;
  return request.messages.slice(0, n - 2);
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
