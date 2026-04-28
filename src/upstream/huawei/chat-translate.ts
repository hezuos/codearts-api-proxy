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
// Tool call mapping (CodeArts → OpenAI)
// ---------------------------------------------------------------------------

const SUBAGENT_CASE_REPAIR: Record<string, string> = {
  "Explore": "explore",
  "specagent": "spec-agent",
  "spec_agent": "spec-agent",
  "General": "general",
  "general-purpose": "general",
};

function normalizeToolCallArguments(name: string, argsStr: string): string {
  if (name !== "Task") return argsStr;
  try {
    const args = JSON.parse(argsStr) as Record<string, unknown>;
    if (typeof args.subagent_type === "string") {
      const repaired = SUBAGENT_CASE_REPAIR[args.subagent_type];
      if (repaired && repaired !== args.subagent_type) {
        logger.debug("normalizeToolCall: Task.subagent_type repaired", { from: args.subagent_type, to: repaired });
        args.subagent_type = repaired;
        return JSON.stringify(args);
      }
    }
  } catch {
    // leave as-is
  }
  return argsStr;
}

/** Generate a stable tool call ID when CodeArts doesn't provide one (non-streaming only). */
function generateToolCallId(): string {
  return `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function mapToolCalls(
  raw: CodeArtsRawToolCall[] | null | undefined,
): OpenAIToolCall[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((tc) => {
    const name = tc.function?.name ?? tc.name ?? "unknown";
    const rawArgs =
      tc.function?.arguments ??
      (typeof tc.arguments === "string"
        ? tc.arguments
        : JSON.stringify(tc.arguments ?? {}));
    return {
      id: (tc.id && tc.id !== "-") ? tc.id : generateToolCallId(),
      type: "function",
      function: { name, arguments: normalizeToolCallArguments(name, rawArgs) },
    };
  });
}

export function mapToolCallDeltas(
  raw: CodeArtsRawToolCall[] | null | undefined,
): OpenAIToolCallDelta[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((tc, i) => {
    const name = tc.function?.name ?? tc.name;
    const rawArgs =
      tc.function?.arguments ??
      (typeof tc.arguments === "string"
        ? tc.arguments
        : JSON.stringify(tc.arguments ?? {}));
    // In streaming mode, id only appears in the first chunk of each tool_call.
    // Subsequent chunks have no id — leave it undefined so the client uses index.
    const id = (tc.id && tc.id !== "-") ? tc.id : undefined;
    // In streaming mode, name only appears in the first chunk.
    // Subsequent chunks have no name — omit it so the client keeps the name from the first chunk.
    const func: { name?: string; arguments?: string } = {};
    if (name) func.name = name;
    if (rawArgs) func.arguments = normalizeToolCallArguments(name ?? "unknown", rawArgs);
    return {
      index: i,
      ...(id ? { id } : {}),
      type: "function",
      function: func,
    };
  });
}
