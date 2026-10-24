/**
 * Message and tool call translation between OpenAI and CodeArts formats.
 */

import { randomUUID, createHash } from "crypto";
import type {
  OpenAIChatMessage,
  OpenAIChatCompletionRequest,
  OpenAIToolCall,
  OpenAIToolCallDelta,
} from "../../types/openai";
import type {
  CodeArtsRawToolCall,
} from "./chat-protocol";
import {
  convertOpenAIToolsToCodeArts,
  deriveSubAgentTools,
  type ToolDefinition,
} from "./tools";
import { logger } from "../../utils/logger";

// ---------------------------------------------------------------------------
// Message content normalization
// ---------------------------------------------------------------------------

export function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const text = (item as Record<string, unknown>).text;
          if (typeof text === "string") return text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
}

export function extractUserMessage(messages: OpenAIChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant" && msg.role !== "tool") {
      const text = normalizeMessageContent(msg.content);
      if (text) return text;
    }
  }
  return "";
}

/** v2 工具续传判定：尾部消息为 tool role（客户端已携带 assistant(tool_calls) + tool(result)）。 */
export function isToolContinuationRequest(messages: OpenAIChatMessage[]): boolean {
  return messages[messages.length - 1]?.role === "tool";
}

export function normalizeForChain(msg: OpenAIChatMessage): string {
  return JSON.stringify({
    role: msg.role,
    content: normalizeMessageContent(msg.content),
    name: msg.name ?? null,
    refusal: msg.refusal ?? null,
    // 链指纹统一忽略 reasoning_content：v2 通道默认返回 reasoning，
    // 而客户端回传时可能不带（或为空），计入指纹会导致误判 divergence。
    tool_call_id: msg.tool_call_id ?? null,
    tool_calls: (msg.tool_calls ?? [])
      .slice()
      .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""))
      .map((toolCall) => {
        // 宽化类型后比较（OpenAIToolCall.type 为字面量 "function"）
        const t = toolCall.type as string | undefined | null;
        // 归一化 tool_calls[].type：缺失/空与字面 "function" 统一（避免 proxy 重建 vs 客户端 echo 哈希漂移）
        const type = t === undefined || t === null || t === "" || t === "function" ? "function" : t;
        return {
          id: toolCall.id ?? null,
          type,
          name: toolCall.function?.name ?? null,
          arguments: toolCall.function?.arguments ?? null,
        };
      }),
  });
}

export function computeChainHash(
  previousHash: string,
  message: OpenAIChatMessage,
): string {
  return createHash("sha256")
    .update(previousHash)
    .update("\0")
    .update(normalizeForChain(message))
    .digest("hex");
}

/**
 * 链状态重建用的工具调用规范化：为缺失 type 的调用项补 "function"。
 * 仅用于计算 lastReplyHash 的 assistantMessage，不改动发给客户端的 tool_call。
 */
export function normalizeToolCallsForChain(
  toolCalls: OpenAIToolCall[] | undefined | null,
): OpenAIToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  return toolCalls.map((tc) => {
    if (tc.type === "function") return tc;
    return { ...tc, type: "function" as const };
  });
}

export function computeChainForMessages(
  messages: OpenAIChatMessage[],
  limit: number = messages.length,
): { hash: string; length: number } {
  const boundedLimit = Math.max(0, Math.min(limit, messages.length));
  let hash = "";
  for (let i = 0; i < boundedLimit; i++) {
    hash = computeChainHash(hash, messages[i]);
  }
  return { hash, length: boundedLimit };
}

// ---------------------------------------------------------------------------
// Tool resolution
// ---------------------------------------------------------------------------

export function resolveTools(
  request: OpenAIChatCompletionRequest,
): ToolDefinition[] {
  const subAgent = request.codearts?.sub_agent;
  const callerTools = request.tools?.length
    ? convertOpenAIToolsToCodeArts(request.tools)
    : undefined;

  if (callerTools) {
    const toolNames = callerTools.map((t) => t.function.name);
    logger.info("[client→proxy→codearts] tools", { count: toolNames.length, names: toolNames });
    const resolved = subAgent ? deriveSubAgentTools(callerTools) : callerTools;
    if (subAgent && resolved.length !== callerTools.length) {
      logger.info("[proxy→codearts] sub-agent tool filtering", {
        before: callerTools.length,
        after: resolved.length,
        names: resolved.map((t) => t.function.name),
      });
    }
    return resolved;
  }

  // 客户端未传 tools → 不传工具定义给 CodeArts
  // 避免客户端收到不认识的 tool_call 报 "unknown tool"
  logger.info("[proxy→codearts] no tools from client — sending empty tool list");
  return [];
}

// ---------------------------------------------------------------------------
// Tool call cleaning (CodeArts → OpenAI) — minimal, transparent
// ---------------------------------------------------------------------------

const SUBAGENT_CASE_REPAIR: Record<string, string> = {
  "Explore": "explore",
  "specagent": "spec-agent",
  "spec_agent": "spec-agent",
  "General": "general",
  "general-purpose": "general",
};

/** Repair Task tool's subagent_type case variants. */
function repairSubagentType(argsStr: string): string {
  try {
    const args = JSON.parse(argsStr) as Record<string, unknown>;
    if (typeof args.subagent_type === "string") {
      const repaired = SUBAGENT_CASE_REPAIR[args.subagent_type];
      if (repaired && repaired !== args.subagent_type) {
        logger.debug("cleanToolCall: Task.subagent_type repaired", { from: args.subagent_type, to: repaired });
        args.subagent_type = repaired;
        return JSON.stringify(args);
      }
    }
  } catch {
    // leave as-is
  }
  return argsStr;
}

/** Get arguments string from a CodeArtsRawToolCall, handling both nested and top-level forms. */
function extractArguments(tc: CodeArtsRawToolCall): string | undefined {
  if (tc.function?.arguments) return tc.function.arguments;
  if (typeof tc.arguments === "string") return tc.arguments;
  if (tc.arguments && typeof tc.arguments === "object") return JSON.stringify(tc.arguments);
  return undefined;
}

/**
 * Clean CodeArts streaming tool_call deltas into OpenAI-compatible format.
 * Minimal cleaning: remove null values, use CodeArts index, omit redundant top-level fields.
 * Only modifies content for Task tool's subagent_type repair.
 */
export function cleanToolCallDeltas(
  raw: CodeArtsRawToolCall[] | null | undefined,
): OpenAIToolCallDelta[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((tc, fallbackIndex) => {
    const result: OpenAIToolCallDelta = {
      index: tc.index ?? fallbackIndex,
    };

    // id: only include when present and non-placeholder
    if (tc.id && tc.id !== "-") result.id = tc.id;

    // type: only include when explicitly "function" (omit null/undefined)
    if (tc.type === "function") result.type = "function";

    // function: build from nested form, omit null values
    const name = tc.function?.name; // null → undefined via truthiness
    const rawArgs = extractArguments(tc);
    if (name || rawArgs) {
      const func: { name?: string; arguments?: string } = {};
      if (name) func.name = name;
      if (rawArgs) {
        func.arguments = name === "Task" ? repairSubagentType(rawArgs) : rawArgs;
      }
      result.function = func;
    }

    return result;
  });
}

/**
 * Clean CodeArts non-streaming tool_calls into OpenAI format.
 * Same as cleanToolCallDeltas but generates an id when missing (non-streaming requires stable IDs).
 */
export function cleanToolCalls(
  raw: CodeArtsRawToolCall[] | null | undefined,
): OpenAIToolCall[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((tc) => {
    const name = tc.function?.name ?? "unknown";
    const rawArgs = extractArguments(tc) ?? "{}";
    return {
      id: (tc.id && tc.id !== "-") ? tc.id : `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "function" as const,
      function: {
        name,
        arguments: name === "Task" ? repairSubagentType(rawArgs) : rawArgs,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// v2 tool_call 分片累加（非流式聚合）
// ---------------------------------------------------------------------------

/** 单次工具调用的累加状态。 */
export interface ToolCallAccumulator {
  index: number;
  id?: string;
  type?: string;
  name: string;
  arguments: string;
}

/**
 * 按 `index` 累加 tool_call 分片。
 *
 * v2 通道即使 `stream=false` 仍以 SSE 分片下发工具调用：首个分片带 `id`/`name`，
 * 后续分片只带 `arguments` 片段。若逐分片当作完整调用处理，同一次调用会被
 * 拆成多个 tool_call（`name=unknown`、参数碎片化）。
 */
export function mergeToolCallDeltas(
  accumulators: Map<number, ToolCallAccumulator>,
  raw: CodeArtsRawToolCall[] | null | undefined,
): void {
  if (!raw || raw.length === 0) return;
  raw.forEach((tc, fallbackIndex) => {
    const index = tc.index ?? fallbackIndex;
    const acc = accumulators.get(index) ?? { index, name: "", arguments: "" };
    if (tc.id && tc.id !== "-") acc.id = tc.id;
    if (tc.type === "function") acc.type = "function";
    // 重复下发完整 name 时跳过，避免拼成 get_weatherget_weather
    const name = tc.function?.name ?? tc.name;
    if (name && name !== acc.name) acc.name += name;
    const args = extractArguments(tc);
    if (args) acc.arguments += args;
    accumulators.set(index, acc);
  });
}

/** 将累加结果按 index 顺序还原为完整工具调用（供 `cleanToolCalls` 处理）。 */
export function flushToolCallDeltas(
  accumulators: Map<number, ToolCallAccumulator>,
): CodeArtsRawToolCall[] | undefined {
  if (accumulators.size === 0) return undefined;
  return [...accumulators.values()]
    .sort((a, b) => a.index - b.index)
    .map((acc) => ({
      index: acc.index,
      id: acc.id,
      type: acc.type ?? "function",
      function: {
        name: acc.name || undefined,
        arguments: acc.arguments || undefined,
      },
    }));
}

// Backward-compatible aliases
export const mapToolCallDeltas = cleanToolCallDeltas;
export const mapToolCalls = cleanToolCalls;
