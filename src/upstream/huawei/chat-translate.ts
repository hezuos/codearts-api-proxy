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
import { extractRecoveredToolResults } from "./chat-recovery";
import { isCodeArtsBuiltinTool } from "./tools";
import { config } from "../../config";

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
  const toolResults = extractRecoveredToolResults(request, normalizeMessageContent) ?? [];

  // CodeArts 只接受内置工具的 tool_result。对于客户端自定义工具（如 sequentialthinking、find_path），
  // CodeArts 无法处理其结果，返回 ChatAgent.00009999 / ChatAgent.00001208。
  // 过滤掉非内置工具，让其通过下一轮消息传递结果。
  const builtinResults = toolResults.filter((tr) => isCodeArtsBuiltinTool(tr.name));
  if (builtinResults.length !== toolResults.length) {
    const skipped = toolResults.filter((tr) => !isCodeArtsBuiltinTool(tr.name));
    logger.info("[client→proxy] skipping non-builtin tool_results", {
      skipped: skipped.map((tr) => tr.name),
    });
  }

  return builtinResults;
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

// ---------------------------------------------------------------------------
// Full-context injection: fold multi-turn history into a single text message
// ---------------------------------------------------------------------------

/**
 * Continuation directive appended to the folded text (design D2).
 * Helps the model distinguish "history replay" from "current task" and avoid
 * restating the history instead of continuing it.
 */
const FOLD_CONTINUATION_DIRECTIVE =
  "[continuation]\n以下为历史对话上下文,请基于此继续响应最新用户请求。";

/**
 * Truncation marker for a single oversized tool result (design D3 boundary 3).
 * Keeps head 2K + tail 2K chars, replaces the middle with this marker.
 */
const TOOL_RESULT_HEAD_TAIL_CHARS = 2000;
const TOOL_RESULT_TRUNCATE_MARKER = (originalLength: number) =>
  `[...truncated ${originalLength} chars...]`;

/**
 * Truncation marker for an oversized first user turn (design D3 boundary 1).
 */
const USER_TRUNCATE_MARKER = "[...truncated...]";

/**
 * Fold a single tool result content with head/tail preservation (design D3 boundary 3).
 * If content ≤ threshold, return as-is. Otherwise keep head 2K + marker + tail 2K.
 */
function truncateToolResultContent(content: string): string {
  if (content.length <= 2 * TOOL_RESULT_HEAD_TAIL_CHARS + 100) return content;
  const head = content.slice(0, TOOL_RESULT_HEAD_TAIL_CHARS);
  const tail = content.slice(content.length - TOOL_RESULT_HEAD_TAIL_CHARS);
  return `${head}\n${TOOL_RESULT_TRUNCATE_MARKER(content.length)}\n${tail}`;
}

/**
 * Render a single message as a folded text segment (design D2).
 * Returns null if the message produces no meaningful segment (e.g. empty content
 * with no tool calls) — caller filters nulls out.
 *
 * Role mapping (D2):
 *   - system/developer → [system]
 *   - user → [user #N] (N tracked by caller via userIndex)
 *   - assistant → [assistant] + [调用工具: name(args)] for each tool_call
 *   - tool → [tool result: name]
 *   - unknown → [unknown: <role>]
 */
function foldMessageSegment(
  msg: OpenAIChatMessage,
  userIndex: number,
): string | null {
  const content = normalizeMessageContent(msg.content);

  switch (msg.role) {
    case "system":
    case "developer":
      return content ? `[system]\n${content}` : null;
    case "user":
      return content ? `[user #${userIndex}]\n${content}` : null;
    case "assistant": {
      const parts: string[] = [];
      if (content) parts.push(`[assistant]\n${content}`);
      else parts.push("[assistant]");
      // Tool calls textualized (D4): never route to task_parameters.tool_result
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name ?? "unknown";
          const args = tc.function?.arguments ?? "{}";
          parts.push(`[调用工具: ${name}(${args})]`);
        }
      }
      // Only emit if there's content or tool_calls; bare "[assistant]" with neither is noise
      if (!content && (!msg.tool_calls || msg.tool_calls.length === 0)) return null;
      return parts.join("\n");
    }
    case "tool": {
      const name = msg.name ?? "unknown";
      const truncated = truncateToolResultContent(content);
      return content ? `[tool result: ${name}]\n${truncated}` : `[tool result: ${name}]`;
    }
    default:
      // Unknown role (e.g. "function") — render as marker, never bare text (D2)
      return content ? `[unknown: ${msg.role}]\n${content}` : null;
  }
}

/**
 * Fold the complete client message history into a single text string for
 * full-context injection on cache miss (design D2/D3/D4).
 *
 * Behavior:
 *   - Empty history or no meaningful segments → return "" (caller falls back to extractUserMessage)
 *   - Single message → return its folded form (no continuation directive; not injection per D1)
 *   - Multi-turn → join segments with blank-line separators + continuation directive
 *   - Truncation (D3): if total chars > maxChars, keep system + first user + greedy newest turns
 *
 * @param messages Client message history (OpenAI format)
 * @param maxChars Character budget for the folded text (default 8000)
 * @returns Folded text, or "" if no meaningful content
 */
export function foldFullConversation(
  messages: OpenAIChatMessage[],
  maxChars: number = 8000,
): string {
  if (!messages || messages.length === 0) return "";

  // First pass: render all segments with user index tracking
  let userIndex = 0;
  const segments: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") userIndex++;
    const seg = foldMessageSegment(msg, userIndex);
    if (seg !== null) segments.push(seg);
  }

  if (segments.length === 0) return "";
  if (segments.length === 1) return segments[0];

  // Join with blank-line separators + continuation directive
  const body = segments.join("\n\n");
  const folded = `${body}\n\n${FOLD_CONTINUATION_DIRECTIVE}`;

  // D3 truncation: if within budget, return as-is
  if (folded.length <= maxChars) return folded;

  // D3 truncation: keep system + first user + greedy newest turns
  return truncateFolded(segments, maxChars);
}

/**
 * D3 truncation: preserve system + first user (anchored context) + greedy newest turns.
 *
 * Strategy:
 *   1. Always keep the first segment if it's [system] or [user #1] (anchor)
 *   2. From the newest segments backward, greedily accumulate until char budget is hit
 *   3. If system + first user alone exceed budget, truncate first user (boundary 1)
 */
function truncateFolded(segments: string[], maxChars: number): string {
  // Identify anchor: leading [system] and/or [user #1] segments
  const anchorIndices: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].startsWith("[system]") || segments[i].startsWith("[user #1]")) {
      anchorIndices.push(i);
    } else {
      break; // anchor is only the leading run
    }
  }
  const anchorSegs = anchorIndices.map((i) => segments[i]);
  const restSegs = segments.slice(anchorIndices.length);

  // Budget for the continuation directive + separator overhead
  const overhead = FOLD_CONTINUATION_DIRECTIVE.length + 4; // "\n\n" separators
  let budget = maxChars - overhead;

  // Greedy newest: accumulate from the end of restSegs backward
  const keptRest: string[] = [];
  for (let i = restSegs.length - 1; i >= 0; i--) {
    const seg = restSegs[i];
    const cost = seg.length + 2; // "\n\n" separator
    if (budget - cost < 0) break;
    budget -= cost;
    keptRest.unshift(seg);
  }

  // Anchor budget: whatever remains
  let anchorBudget = budget;
  const keptAnchor: string[] = [];
  for (const seg of anchorSegs) {
    const cost = seg.length + (keptAnchor.length > 0 ? 2 : 0);
    if (anchorBudget - cost >= 0) {
      anchorBudget -= cost;
      keptAnchor.push(seg);
    } else {
      // D3 boundary 1: system always retained; first user truncated if needed
      if (seg.startsWith("[system]")) {
        keptAnchor.push(seg); // system retained even if over budget
      } else if (seg.startsWith("[user #1]")) {
        // Truncate first user to remaining budget
        const remaining = anchorBudget - (USER_TRUNCATE_MARKER.length + 2);
        if (remaining > 0) {
          const lines = seg.split("\n");
          const header = lines[0]; // "[user #1]"
          const userContent = lines.slice(1).join("\n");
          keptAnchor.push(`${header}\n${userContent.slice(0, remaining)}\n${USER_TRUNCATE_MARKER}`);
        } else {
          keptAnchor.push(`${seg.split("\n")[0]}\n${USER_TRUNCATE_MARKER}`);
        }
        anchorBudget = -1; // no more budget
      }
    }
  }

  const allKept = [...keptAnchor, ...keptRest];
  if (allKept.length === 0) return "";

  return `${allKept.join("\n\n")}\n\n${FOLD_CONTINUATION_DIRECTIVE}`;
}

/**
 * Resolve the effective max chars for a given model (per-model override or global default).
 */
export function resolveFullContextMaxChars(modelId: string): number {
  const { fullContextMaxChars, fullContextMaxCharsByModel } = config;
  const override = fullContextMaxCharsByModel[modelId];
  return override ?? fullContextMaxChars;
}
