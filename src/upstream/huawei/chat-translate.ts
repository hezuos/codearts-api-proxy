/**
 * Message and tool call translation between OpenAI and CodeArts formats.
 */

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
  DEFAULT_TOOLS,
  SUB_AGENT_TOOLS,
  convertOpenAIToolsToCodeArts,
  deriveSubAgentTools,
  type ToolDefinition,
} from "./tools";

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
          const text = Reflect.get(item, "text");
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
  if (explicit.length > 0) return explicit;

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
  return request.messages
    .slice(assistantIndex + 1)
    .filter(
      (msg) =>
        msg.role === "tool" && !!msg.tool_call_id && byId.has(msg.tool_call_id),
    )
    .map((msg) => {
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
    return subAgent ? deriveSubAgentTools(callerTools) : callerTools;
  }
  return subAgent ? SUB_AGENT_TOOLS : DEFAULT_TOOLS;
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
        console.log(
          `  normalizeToolCall: Task.subagent_type "${args.subagent_type}" → "${repaired}"`,
        );
        args.subagent_type = repaired;
        return JSON.stringify(args);
      }
    }
  } catch {
    // leave as-is
  }
  return argsStr;
}

export function mapToolCalls(
  raw: CodeArtsRawToolCall[] | null | undefined,
): OpenAIToolCall[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((tc, i) => {
    const name = tc.function?.name ?? tc.name ?? "unknown";
    const rawArgs =
      tc.function?.arguments ??
      (typeof tc.arguments === "string"
        ? tc.arguments
        : JSON.stringify(tc.arguments ?? {}));
    return {
      id: tc.id ?? `call_${i}`,
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
    const name = tc.function?.name ?? tc.name ?? "unknown";
    const rawArgs =
      tc.function?.arguments ??
      (typeof tc.arguments === "string"
        ? tc.arguments
        : JSON.stringify(tc.arguments ?? {}));
    return {
      index: i,
      id: tc.id ?? `call_${i}`,
      type: "function",
      function: { name, arguments: normalizeToolCallArguments(name, rawArgs) },
    };
  });
}
