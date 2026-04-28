/**
 * Message and tool call translation between OpenAI and CodeArts formats.
 */

import { randomUUID } from "crypto";
import type {
  CodeArtsToolResult,
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

// ---------------------------------------------------------------------------
// Tool result extraction
// ---------------------------------------------------------------------------

function parseToolArguments(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function extractToolResults(
  request: OpenAIChatCompletionRequest,
): CodeArtsToolResult[] {
  const explicit = request.codearts?.tool_results ?? [];
  if (explicit.length > 0) {
    logger.debug("[client→proxy] tool_results (explicit codearts)", {
      count: explicit.length,
      details: explicit.map((tr) => ({
        name: tr.name,
        toolCallId: tr.toolCallId,
        status: tr.status,
        result_preview: tr.result?.slice(0, 200),
      })),
    });
    return explicit;
  }

  const lastMsg = request.messages[request.messages.length - 1];
  if (!lastMsg || lastMsg.role !== "tool") return [];

  let assistantIndex = -1;
  let recentToolCalls: OpenAIToolCall[] = [];
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const msg = request.messages[i];
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      assistantIndex = i;
      recentToolCalls = msg.tool_calls;
      break;
    }
  }
  if (assistantIndex === -1) return [];

  const byId = new Map(recentToolCalls.map((tc) => [tc.id, tc]));
  const toolMsgs = request.messages
    .slice(assistantIndex + 1)
    .filter(
      (msg) =>
        msg.role === "tool" && !!msg.tool_call_id && byId.has(msg.tool_call_id),
    );

  logger.debug("[client→proxy→codearts] tool_results extraction", {
    assistantToolCalls: recentToolCalls.map((tc) => ({ id: tc.id, name: tc.function.name })),
    toolMessages: request.messages
      .slice(assistantIndex + 1)
      .filter((m) => m.role === "tool")
      .map((m) => ({ tool_call_id: m.tool_call_id, matched: byId.has(m.tool_call_id ?? "") })),
    matchedCount: toolMsgs.length,
  });

  return toolMsgs.map((msg) => {
    const tc = byId.get(msg.tool_call_id!);
    return {
      feedback: "",
      result: normalizeMessageContent(msg.content),
      name: tc?.function.name ?? msg.name ?? "unknown",
      arguments: tc?.function.arguments
        ? parseToolArguments(tc.function.arguments)
        : {},
      status: "APPROVE",
      executeStatus: "success",
      toolCallId: msg.tool_call_id,
    } satisfies CodeArtsToolResult;
  });
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

// Backward-compatible aliases
export const mapToolCallDeltas = cleanToolCallDeltas;
export const mapToolCalls = cleanToolCalls;
