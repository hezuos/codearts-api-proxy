/**
 * Chat request body construction and HTTP transport.
 */

import { randomUUID, createHash } from "crypto";
import https from "https";
import { config, upstreamTimeoutMs } from "../../config";
import { getProviderAccount } from "../../auth/store";
import { signRequest, type SigningCredentials } from "../../auth/huawei/credentials";
import type { StoredHuaweiSession } from "../../auth/huawei/session-store";
import { UpstreamTimeoutError } from "../../utils/errors";
import { logger } from "../../utils/logger";
import type { OpenAIChatCompletionRequest, OpenAIChatMessage } from "../../types/openai";
import {
  extractUserMessage,
  extractToolResults,
  resolveTools,
  normalizeMessageContent,
  foldFullConversation,
  foldMissingSegment,
  resolveFullContextMaxChars,
  computeChainForMessages,
  normalizeForChain,
} from "./chat-translate";
import {
  detectForceResyncToolResult,
  stripForceResyncToolExchange,
} from "./chat-recovery";

// ---------------------------------------------------------------------------
// Model mapping
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL_ID = "GLM-5.1";

export const MODEL_MAP: Record<string, string> = {
  "glm-5.1": "GLM-5.1",
  "GLM-5.1": "GLM-5.1",
};

function resolveModelId(request: OpenAIChatCompletionRequest): string {
  const override = request.codearts?.model_id?.trim();
  if (override) return override;
  return (
    MODEL_MAP[request.model.toLowerCase()] ?? request.model ?? DEFAULT_MODEL_ID
  );
}

// ---------------------------------------------------------------------------
// In-memory parent_message_id tracker (with TTL eviction)
// ---------------------------------------------------------------------------

const TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

const lastResponseMessageId = new Map<string, string>();
const lastResponseMessageTs = new Map<string, number>();

/**
 * 上一轮 prompt_tokens 追踪（按 chat_id），用于估算续传轮的缓存命中数。
 * 与 lastResponseMessageId 同生命周期、同 TTL 清理节奏。
 */
const lastPromptTokens = new Map<string, number>();

type Divergence = "normal" | "tail-divergence" | "middle-damage" | "duplicate/stale";

export interface ChainState {
  prefixChain: string;
  prefixLen: number;
  lastReplyHash: string;
}

const chainStates = new Map<string, ChainState>();

const chatIdRole = new Map<string, "main" | "sub">();

// Periodic TTL cleanup
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of lastResponseMessageTs) {
    if (now - ts > TTL_MS) {
      lastResponseMessageId.delete(key);
      lastResponseMessageTs.delete(key);
      chainStates.delete(key);
      chatIdRole.delete(key);
      lastPromptTokens.delete(key);
    }
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

export function getLastResponseMessageId(chatId: string): string | undefined {
  return lastResponseMessageId.get(chatId);
}

export function setLastResponseMessageId(chatId: string, messageId: string): void {
  lastResponseMessageId.set(chatId, messageId);
  lastResponseMessageTs.set(chatId, Date.now());
}

export function getLastPromptTokens(chatId: string): number | undefined {
  return lastPromptTokens.get(chatId);
}

export function setLastPromptTokens(chatId: string, tokens: number): void {
  lastPromptTokens.set(chatId, tokens);
  // 刷新 TTL 时间戳，避免被清理循环误删
  lastResponseMessageTs.set(chatId, Date.now());
}

/**
 * 估算 DeepSeek 风格缓存计费字段。
 *
 * 组合 divergence + parent_message_id + isToolContinuation 三信号判断缓存命中：
 * - normal / tail-divergence / duplicate/stale + 有 parent → 前缀缓存命中
 * - middle-damage / undefined → 全量重置，无缓存
 * - 无 parent + isToolContinuation → 服务端复用上轮完整上下文（messagesBody=[]）
 * - 无 parent + 非 tool continuation → cold-start
 *
 * cache_miss = max(0, promptTokens - cache_hit)
 */
export function computeCacheUsage(
  promptTokens: number,
  prevPromptTokens: number | undefined,
  divergence: Divergence | undefined,
  hasParent: boolean,
  isToolContinuation: boolean,
): {
    prompt_cache_hit_tokens: number;
    prompt_cache_miss_tokens: number;
    cache_estimated: true;
    prompt_tokens_details: { cached_tokens: number; text_tokens: number };
  } {
  let cacheHit = 0;

  if (divergence === "normal" || divergence === "tail-divergence" || divergence === "duplicate/stale") {
    if (hasParent) {
      cacheHit = prevPromptTokens ?? 0;
    }
  } else if (isToolContinuation && !hasParent) {
    cacheHit = prevPromptTokens ?? 0;
  }
  // middle-damage / undefined / cold-start → cacheHit 保持 0

  const cacheMiss = Math.max(0, promptTokens - cacheHit);
  return {
    prompt_cache_hit_tokens: cacheHit,
    prompt_cache_miss_tokens: cacheMiss,
    cache_estimated: true,
    prompt_tokens_details: { cached_tokens: cacheHit, text_tokens: cacheMiss },
  };
}

export function getChainState(chatId: string): ChainState | undefined {
  return chainStates.get(chatId);
}

export function setChainState(chatId: string, state: ChainState): void {
  chainStates.set(chatId, state);
  lastResponseMessageTs.set(chatId, Date.now());
}

export function hashMessage(message: OpenAIChatMessage): string {
  return createHash("sha256").update(normalizeForChain(message)).digest("hex");
}

export function classifyDivergence(
  messages: OpenAIChatMessage[],
  state: ChainState,
): { divergence: Divergence; suffixStart?: number } {
  const messageCount = messages.length;
  if (messageCount < state.prefixLen) {
    return { divergence: "middle-damage" };
  }
  const prefix = computeChainForMessages(messages, state.prefixLen);
  if (prefix.hash !== state.prefixChain) {
    return { divergence: "middle-damage" };
  }
  if (messageCount === state.prefixLen) {
    return { divergence: "duplicate/stale" };
  }

  const boundary = messages[state.prefixLen];
  const boundaryIsLastReply =
    !!boundary && hashMessage(boundary) === state.lastReplyHash;
  const suffixStart = boundaryIsLastReply ? state.prefixLen + 1 : state.prefixLen;
  const suffix = messages.slice(state.prefixLen);
  let validSuffix = boundaryIsLastReply;
  let explicitTailDivergence = !boundaryIsLastReply;
  let seenUser = false;
  let seenAssistant = false;
  // 纯工具续传尾段标志：边界=lastReply 且其后每条 tool 均可追溯（无 user/assistant/其它）
  let onlyTraceableTools = boundaryIsLastReply;
  const assistantToolCalls = boundary?.tool_calls ?? [];
  for (let i = boundaryIsLastReply ? 1 : 0; i < suffix.length; i++) {
    const message = suffix[i];
    if (message.role === "tool") {
      const matched = assistantToolCalls.some((toolCall) => toolCall.id === message.tool_call_id);
      if (!matched) {
        validSuffix = false;
        onlyTraceableTools = false;
      }
    } else if (message.role === "user") {
      if (seenUser || i !== suffix.length - 1) {
        validSuffix = false;
        explicitTailDivergence = true;
      }
      onlyTraceableTools = false;
      seenUser = true;
    } else if (message.role === "assistant") {
      validSuffix = false;
      explicitTailDivergence = true;
      onlyTraceableTools = false;
      seenAssistant = true;
    } else {
      validSuffix = false;
      onlyTraceableTools = false;
    }
  }
  if (!seenUser) validSuffix = false;
  if (validSuffix) return { divergence: "normal", suffixStart };
  if (explicitTailDivergence || seenAssistant) {
    return { divergence: "tail-divergence", suffixStart };
  }
  // 纯工具续传尾段（无 user/assistant，全部 tool 可追溯，边界=lastReply）：
  // 属于「工具结果待补发」，识别为 tail-divergence 以末段补发，而非 middle-damage 全量重置。
  if (boundaryIsLastReply && onlyTraceableTools && suffix.length > 0) {
    return { divergence: "tail-divergence", suffixStart };
  }
  return { divergence: "middle-damage" };
}

export function getChatIdRole(chatId: string): "main" | "sub" | undefined {
  return chatIdRole.get(chatId);
}

export function setChatIdRole(chatId: string, role: "main" | "sub"): void {
  chatIdRole.set(chatId, role);
}

// ---------------------------------------------------------------------------
// Conversation ID derivation
// ---------------------------------------------------------------------------

function deriveConversationId(
  messages: OpenAIChatMessage[],
  providerAccountId: string,
): string {
  // Include system prompt in fingerprint to distinguish different opencode sessions.
  // opencode's system prompt contains session/project/working-directory info,
  // so different processes naturally produce different fingerprints even when
  // sharing the same API key and sending similar first user messages.
  const systemMsg = messages.find((m) => m.role === "system");
  const firstUserMsg = messages.find((m) => m.role === "user");
  if (!systemMsg && !firstUserMsg) return randomUUID().replace(/-/g, "");
  const systemContent = systemMsg ? normalizeMessageContent(systemMsg.content) : "";
  const userContent = firstUserMsg ? normalizeMessageContent(firstUserMsg.content) : "";
  return createHash("sha256")
    .update(`${providerAccountId}:${systemContent}:${userContent}`)
    .digest("hex")
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// Request body construction
// ---------------------------------------------------------------------------

function buildTaskParameters(
  request: OpenAIChatCompletionRequest,
  tools: ReturnType<typeof resolveTools>,
): Record<string, unknown> {
  const subAgent = request.codearts?.sub_agent;
  const toolResults = extractToolResults(request);
  const isToolContinuation = toolResults.length > 0;

  // tool continuation: 只传 tool_result（和 spec 一致），其余字段由 CodeArts 从上下文获取
  if (isToolContinuation) {
    return { tool_result: toolResults };
  }

  const params: Record<string, unknown> = {
    codebase_search: request.codearts?.codebase_search ?? false,
    preferred_language: request.codearts?.preferred_language?.trim() || "zh-cn",
    enable_code_interpreter: request.codearts?.enable_code_interpreter ?? false,
    projectLevelPrompt: request.codearts?.project_level_prompt ?? "",
    isSubAgent: !!subAgent,
    tools,
    environmentDetails: {
      osVersion: request.codearts?.os_version?.trim() || "win32",
      currentDate: new Date().toISOString().replace("Z", ""),
      currentWorkingDirectory:
        request.codearts?.current_working_directory?.trim() ||
        request.codearts?.workspace_root?.trim() ||
        "",
    },
    routerVersion: "v2",
    isNewClient: true,
    features: { support_end_tag: true },
    ide: "CodeArts Agent",
    contexts: request.codearts?.contexts ?? [],
    expert_rules: request.codearts?.expert_rules ?? [],
  };

  if (toolResults.length > 0) {
    params.tool_result = toolResults;
  }

  if (subAgent) {
    params.subAgent_type = subAgent.type;
    params.subAgent_prompt = subAgent.prompt ?? "";
  }

  return params;
}

export function buildRequestBody(
  request: OpenAIChatCompletionRequest,
  session: StoredHuaweiSession,
  options: { forceResync?: boolean } = {},
): { body: Record<string, unknown>; json: string; divergence?: Divergence; suffixStart?: number; isToolContinuation: boolean; proactiveReset: boolean } {
  // 检测客户端回传的 forceResync tool_result（由 proxy 合成的 Bash echo tool_call 触发）。
  // 检测到时：剥离该 tool exchange，自动走 forceResync 路径。
  const forceResyncFromToolResult = detectForceResyncToolResult(request);
  const effectiveRequest: OpenAIChatCompletionRequest = forceResyncFromToolResult
    ? { ...request, messages: stripForceResyncToolExchange(request) }
    : request;
  if (forceResyncFromToolResult) {
    logger.info("[client→proxy] detected forceResync tool_result — switching to forceResync path", {
      messages_before: request.messages.length,
      messages_after: effectiveRequest.messages.length,
    });
  }
  const forceResync = options.forceResync || forceResyncFromToolResult;

  const toolResults = extractToolResults(effectiveRequest);
  const isToolContinuation = toolResults.length > 0;
  const subAgent = request.codearts?.sub_agent;

  const tools = resolveTools(request);
  const modelId = resolveModelId(request);

  const chatId =
    request.codearts?.chat_id?.trim() || deriveConversationId(effectiveRequest.messages, session.providerAccountId);

  // Sub-agent / main-agent chat_id collision detection
  const currentRole = subAgent ? "sub" : "main";
  const previousRole = getChatIdRole(chatId);
  setChatIdRole(chatId, currentRole);

  if (previousRole && previousRole !== currentRole) {
    logger.warn("CHAT_ID COLLISION", {
      chat_id: chatId,
      previousRole,
      currentRole,
    });
  } else if (subAgent) {
    logger.info("Sub-agent request", { chat_id: chatId, previousRole: previousRole ?? "none" });
  } else if (isToolContinuation) {
    logger.info("Main-agent tool continuation", {
      chat_id: chatId,
      previousRole: previousRole ?? "none",
      lastResponseMessageId: getLastResponseMessageId(chatId) ?? "(none)",
    });
  }

  let parentMessageId =
    request.codearts?.parent_message_id ??
    getLastResponseMessageId(chatId) ??
    "";

  const providerAccount = getProviderAccount(session.providerAccountId);
  const userId =
    providerAccount?.providerUserName?.trim() ||
    providerAccount?.providerUserId?.trim() ||
    session.providerAccountId;

  // 对于非内置工具，把 tool result 内容合并到用户消息中
  // CodeArts 无法处理非内置工具的 tool_result，直接以文本形式发送
  let messagesBody: unknown[];
  let divergence: Divergence | undefined;
  let suffixStart: number | undefined;
  let fullContextInjected = false;
  let fullContextChars = 0;
  const chainState = getChainState(chatId);
  const callerProvidedParent = !!request.codearts?.parent_message_id;
  const canRepair =
    config.chainDivergenceRepairEnabled &&
    !isToolContinuation &&
    !subAgent &&
    !callerProvidedParent &&
    !!chainState;

  if (forceResync && !isToolContinuation) {
    divergence = "middle-damage";
    parentMessageId = "";
  } else if (canRepair) {
    const classified = classifyDivergence(effectiveRequest.messages, chainState);
    divergence = classified.divergence;
    suffixStart = classified.suffixStart;
    if (divergence === "middle-damage" || divergence === "duplicate/stale") {
      // 中段损伤或重复/陈旧请求均无法继续信任旧链：清空 parent，
      // 走全量折叠重置让对话能继续（duplicate/stale 不再抛错，
      // 避免客户端重试时永久卡死）。
      parentMessageId = "";
    }
  }

  // 主动重置：当累积 prompt_tokens 接近上游硬限制时，强制全量折叠重置，
  // 避免 ChatAgent.00001216 错误。仅在 normal 热链续传路径触发。
  let proactiveReset = false;
  if (
    (divergence === undefined || divergence === "normal") &&
    parentMessageId &&
    !isToolContinuation &&
    !subAgent &&
    !callerProvidedParent &&
    (getLastPromptTokens(chatId) ?? 0) > config.upstreamPromptTokenResetThreshold
  ) {
    divergence = "middle-damage";
    parentMessageId = "";
    proactiveReset = true;
    logger.info("[proxy→codearts] PROACTIVE RESET (prompt_tokens threshold exceeded)", {
      chat_id: chatId,
      lastPromptTokens: getLastPromptTokens(chatId),
      threshold: config.upstreamPromptTokenResetThreshold,
    });
  }
  if (isToolContinuation) {
    messagesBody = [];
  } else if (divergence === "middle-damage" || divergence === "duplicate/stale" || forceResync) {
    const folded = foldFullConversation(
      effectiveRequest.messages,
      resolveFullContextMaxChars(modelId),
    );
    messagesBody = [{ type: "text", content: folded || extractUserMessage(effectiveRequest.messages) }];
    fullContextInjected = !!folded;
    fullContextChars = folded.length;
  } else if (divergence === "tail-divergence" && suffixStart !== undefined) {
    const folded = foldMissingSegment(
      effectiveRequest.messages,
      suffixStart,
      resolveFullContextMaxChars(modelId),
    );
    if (folded) {
      messagesBody = [{ type: "text", content: folded }];
      fullContextChars = folded.length;
    } else {
      // 防御分支（正常不可达）：suffixStart < messages.length 且无 user 段已能折叠。
      // 若折叠仍为空，绝不发送已确认的 user/system → 清空 parent 并全量折叠重置。
      parentMessageId = "";
      const fullFolded = foldFullConversation(
        effectiveRequest.messages,
        resolveFullContextMaxChars(modelId),
      );
      messagesBody = [{ type: "text", content: fullFolded || "" }];
      fullContextInjected = true;
      fullContextChars = fullFolded.length;
    }
  } else {
    const trackedParent = !!getLastResponseMessageId(chatId);
    const shouldInject =
      config.fullContextInjectionEnabled &&
      !callerProvidedParent &&
      !trackedParent &&
      !subAgent &&
      effectiveRequest.messages.length > 1;

    if (shouldInject) {
      const folded = foldFullConversation(effectiveRequest.messages, resolveFullContextMaxChars(modelId));
      if (folded) {
        messagesBody = [{ type: "text", content: folded }];
        fullContextInjected = true;
        fullContextChars = folded.length;
      } else {
        messagesBody = [{ type: "text", content: extractUserMessage(effectiveRequest.messages) }];
      }
    } else {
      const userMsg = extractUserMessage(effectiveRequest.messages);
      const lastMsg = effectiveRequest.messages[effectiveRequest.messages.length - 1];
      if (lastMsg?.role === "tool" && lastMsg.content) {
        const toolContent = normalizeMessageContent(lastMsg.content);
        const combined = toolContent
          ? `${userMsg ? `${userMsg}\n\n` : ""}[工具执行结果]\n${toolContent}`
          : userMsg || "[工具执行结果为空]";
        messagesBody = [{ type: "text", content: combined }];
      } else {
        messagesBody = [{ type: "text", content: userMsg }];
      }
    }
  }

  const body: Record<string, unknown> = {
    chat_id: chatId,
    messages: messagesBody,
    client: "IDE",
    task: "plan-execute",
    task_parameters: buildTaskParameters(effectiveRequest, tools),
    batch_task_parameters: [],
    attempt: 1,
    user_id: userId,
    agent_id: "CodeAgent",
    parent_message_id: parentMessageId,
    is_delta_response: true,
    model_id: modelId,
  };

  if (fullContextInjected || divergence) {
    logger.info("[proxy→codearts] REQUEST context classification", {
      chat_id: chatId,
      divergence: divergence ?? "cold-start",
      fullContextInjected,
      foldedChars: fullContextChars,
      suffixStart,
      messagesCount: effectiveRequest.messages.length,
      model_id: modelId,
    });
  }

  return { body, json: JSON.stringify(body), divergence, suffixStart, isToolContinuation, proactiveReset };
}

// ---------------------------------------------------------------------------
// v2 (OpenAI-compatible) request body construction
// ---------------------------------------------------------------------------

/**
 * v2 通道 `max_tokens` 上限。
 *
 * 实测（glm-5.3，/api/v2/chat/completions）：65536 成功，65537 起返回
 * `InferHub.001001005.400`（The request param is invalid）。
 * 因此默认值与上限均取 65536，并对客户端传入值做 clamp。
 */
export const V2_MAX_TOKENS_LIMIT = 65536;

/** v2 通道默认 max_tokens（等于上游允许的上限）。 */
export const V2_DEFAULT_MAX_TOKENS = V2_MAX_TOKENS_LIMIT;

/**
 * 构造 v2 通道（`/api/v2/chat/completions`，OpenAI 兼容）请求体。
 *
 * 与 `buildRequestBody` 共享链状态/分叉分类/主动重置逻辑，但输出 OpenAI 兼容形状：
 * `{ model, max_tokens, tool_stream, stream, messages, tools?, isSubAgent?, subAgent_type?, subAgent_prompt? }`。
 *
 * `messages` 构造规则：
 * - 冷启动 / 折叠场景：单条 `{ role: "user", content }`
 * - 热链续传（normal）：仅发送最新 user turn
 * - 工具续传：`[assistant(tool_calls), tool(result)]` 消息对
 * - 非内置工具 result：合并进 user 文本
 */
export function buildV2RequestBody(
  request: OpenAIChatCompletionRequest,
  session: StoredHuaweiSession,
  options: { forceResync?: boolean } = {},
): { body: Record<string, unknown>; json: string; divergence?: Divergence; suffixStart?: number; isToolContinuation: boolean; proactiveReset: boolean; chatId: string } {
  // 检测客户端回传的 forceResync tool_result（由 proxy 合成的 Bash echo tool_call 触发）。
  // 检测到时：剥离该 tool exchange，自动走 forceResync 路径。
  const forceResyncFromToolResult = detectForceResyncToolResult(request);
  const effectiveRequest: OpenAIChatCompletionRequest = forceResyncFromToolResult
    ? { ...request, messages: stripForceResyncToolExchange(request) }
    : request;
  if (forceResyncFromToolResult) {
    logger.info("[client→proxy] detected forceResync tool_result — switching to forceResync path", {
      messages_before: request.messages.length,
      messages_after: effectiveRequest.messages.length,
    });
  }
  const forceResync = options.forceResync || forceResyncFromToolResult;

  const toolResults = extractToolResults(effectiveRequest);
  const isToolContinuation = toolResults.length > 0;
  const subAgent = request.codearts?.sub_agent;

  const tools = resolveTools(request);
  const modelId = resolveModelId(request);

  const chatId =
    request.codearts?.chat_id?.trim() || deriveConversationId(effectiveRequest.messages, session.providerAccountId);

  // Sub-agent / main-agent chat_id collision detection
  const currentRole = subAgent ? "sub" : "main";
  const previousRole = getChatIdRole(chatId);
  setChatIdRole(chatId, currentRole);

  if (previousRole && previousRole !== currentRole) {
    logger.warn("CHAT_ID COLLISION", {
      chat_id: chatId,
      previousRole,
      currentRole,
    });
  } else if (subAgent) {
    logger.info("Sub-agent request", { chat_id: chatId, previousRole: previousRole ?? "none" });
  } else if (isToolContinuation) {
    logger.info("Main-agent tool continuation", {
      chat_id: chatId,
      previousRole: previousRole ?? "none",
      lastResponseMessageId: getLastResponseMessageId(chatId) ?? "(none)",
    });
  }

  // v2 无 parent_message_id 字段；链状态（chainStates）是续传判定的唯一依据。
  // 保留 trackedParent 仅用于判定「是否存在可续传的上一轮」。
  const trackedParent = !!getLastResponseMessageId(chatId);
  const callerProvidedParent = !!request.codearts?.parent_message_id;
  const hasContinuity = trackedParent || callerProvidedParent;

  const chainState = getChainState(chatId);
  const canRepair =
    config.chainDivergenceRepairEnabled &&
    !isToolContinuation &&
    !subAgent &&
    !callerProvidedParent &&
    !!chainState;

  let divergence: Divergence | undefined;
  let suffixStart: number | undefined;
  let fullContextInjected = false;
  let fullContextChars = 0;

  if (forceResync && !isToolContinuation) {
    divergence = "middle-damage";
  } else if (canRepair) {
    const classified = classifyDivergence(effectiveRequest.messages, chainState);
    divergence = classified.divergence;
    suffixStart = classified.suffixStart;
  }

  // 主动重置：当累积 prompt_tokens 接近上游硬限制时，强制全量折叠重置，
  // 避免 ChatAgent.00001216 错误。仅在 normal 热链续传路径触发。
  let proactiveReset = false;
  if (
    (divergence === undefined || divergence === "normal") &&
    hasContinuity &&
    !isToolContinuation &&
    !subAgent &&
    !callerProvidedParent &&
    (getLastPromptTokens(chatId) ?? 0) > config.upstreamPromptTokenResetThreshold
  ) {
    divergence = "middle-damage";
    proactiveReset = true;
    logger.info("[proxy→codearts] PROACTIVE RESET (prompt_tokens threshold exceeded)", {
      chat_id: chatId,
      lastPromptTokens: getLastPromptTokens(chatId),
      threshold: config.upstreamPromptTokenResetThreshold,
    });
  }

  // 显式 codearts.tool_results（v1 遗留扩展）：客户端历史不含工具交换，合成标准消息对附加。
  const explicitToolResults = request.codearts?.tool_results ?? [];
  const effectiveMessages =
    explicitToolResults.length > 0
      ? appendExplicitToolExchange(effectiveRequest.messages, explicitToolResults)
      : effectiveRequest.messages;

  const messagesBody = buildV2Messages({
    request: { ...effectiveRequest, messages: effectiveMessages },
    modelId,
    forceResync,
    proactiveReset,
    onFold: (chars) => {
      fullContextInjected = true;
      fullContextChars = chars;
    },
  });

  const body: Record<string, unknown> = {
    model: modelId,
    max_tokens: Math.min(request.max_tokens ?? V2_DEFAULT_MAX_TOKENS, V2_MAX_TOKENS_LIMIT),
    tool_stream: true,
    // v2 上游始终以 SSE 流式返回（stream:false 会返回普通 JSON，parseSSE 解析为空）。
    // 非流式客户端由 chat.ts 聚合 SSE 事件。
    stream: true,
    messages: messagesBody,
  };

  if (tools.length > 0) {
    body.tools = tools;
  }

  if (subAgent) {
    body.isSubAgent = true;
    body.subAgent_type = subAgent.type;
    body.subAgent_prompt = subAgent.prompt ?? "";
  }

  if (fullContextInjected || divergence) {
    logger.info("[proxy→codearts] REQUEST context classification (v2)", {
      chat_id: chatId,
      divergence: divergence ?? "cold-start",
      fullContextInjected,
      foldedChars: fullContextChars,
      suffixStart,
      messagesCount: effectiveRequest.messages.length,
      model_id: modelId,
    });
  }

  return { body, json: JSON.stringify(body), divergence, suffixStart, isToolContinuation, proactiveReset, chatId };
}

/**
 * 构造 v2 请求的 `messages` 数组（OpenAI 兼容形状）。
 *
 * v2 上游无服务端会话状态（实测确认：增量请求丢失上下文），
 * 每个请求必须携带完整对话历史：
 * - 默认：全量透传客户端 messages（原生 role/content/tool_calls 结构，token 效率最高）
 * - 逃生通道（forceResync / 主动重置 / 总字符超预算）：折叠为压缩单条文本
 */
function buildV2Messages(params: {
  request: OpenAIChatCompletionRequest;
  modelId: string;
  forceResync: boolean;
  proactiveReset: boolean;
  onFold: (chars: number) => void;
}): unknown[] {
  const { request, modelId, forceResync, proactiveReset, onFold } = params;
  const budget = resolveFullContextMaxChars(modelId);
  const totalChars = request.messages.reduce(
    (sum, m) => sum + normalizeMessageContent(m.content).length,
    0,
  );

  // 逃生通道：forceResync（00001216 恢复重试）/ 主动重置 / 历史超预算 → 折叠为压缩单条文本。
  if (forceResync || proactiveReset || totalChars > budget) {
    const folded = foldFullConversation(request.messages, budget);
    if (folded) onFold(folded.length);
    return [{ role: "user", content: folded || extractUserMessage(request.messages) }];
  }

  // v2 上游无状态：全量透传客户端历史（原生 OpenAI messages 结构）。
  // 工具续传场景天然包含 [assistant(tool_calls), tool(result)] 段。
  return request.messages.map(toV2Message);
}

/**
 * 将客户端消息投影为 v2 上游接受的 OpenAI 消息形状。
 * 剥离代理内部扩展字段（refusal / reasoning_content），developer 角色映射为 system。
 */
function toV2Message(m: OpenAIChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: m.role === "developer" ? "system" : m.role,
    content: m.content,
  };
  if (m.name) out.name = m.name;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.tool_calls && m.tool_calls.length > 0) out.tool_calls = m.tool_calls;
  return out;
}

/**
 * 将 v1 遗留的显式 codearts.tool_results 合成为标准 OpenAI 工具交换消息，
 * 附加到历史末尾（assistant(tool_calls) + tool(result) 消息对）。
 * 标准流程（客户端在 messages 中携带工具交换）不经过此路径。
 */
function appendExplicitToolExchange(
  messages: OpenAIChatMessage[],
  toolResults: CodeArtsToolResult[],
): OpenAIChatMessage[] {
  const toolCalls = toolResults.map((tr, i) => ({
    id: tr.toolCallId ?? `call_explicit_${i}`,
    type: "function" as const,
    function: { name: tr.name, arguments: JSON.stringify(tr.arguments ?? {}) },
  }));
  const assistantMsg: OpenAIChatMessage = {
    role: "assistant",
    content: null,
    refusal: null,
    tool_calls: toolCalls,
  };
  const toolMsgs: OpenAIChatMessage[] = toolResults.map((tr, i) => ({
    role: "tool" as const,
    content: tr.result ?? "",
    refusal: null,
    tool_call_id: toolCalls[i].id,
    name: tr.name,
  }));
  logger.info("[client→proxy] explicit codearts.tool_results synthesized as tool messages", {
    count: toolResults.length,
    names: toolResults.map((tr) => tr.name),
  });
  return [...messages, assistantMsg, ...toolMsgs];
}

// ---------------------------------------------------------------------------
// HTTP / SSE transport
// ---------------------------------------------------------------------------

export function buildChatHeaders(
  chatUrl: string,
  body: string,
  credentials: SigningCredentials,
  traceId: string,
): Record<string, string> {
  const extra: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Agent-Type": "ChatAgent",
    "X-Language": "zh-CN",
    "x-snap-traceid": traceId,
    client_version: config.pluginVersion,
    "plugin-name": "codearts-snap_vscode",
    "plugin-version": config.pluginVersion,
    "ide-name": "CodeArts Agent",
    "ide-version": config.ideVersion,
    is_confidential: "false",
    "heartbeat-enable": "true",
  };

  const signed = signRequest(
    {
      method: "POST",
      url: chatUrl,
      headers: { "Content-Type": "application/json" },
      body,
    },
    credentials,
  );

  return { ...extra, ...signed };
}

export function httpsPost(
  urlStr: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
): Promise<{ status: number; stream: AsyncIterable<string> }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request aborted before start"));
      return;
    }

    const url = new URL(urlStr);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        signal,
      },
      (res) => {
        res.setEncoding("utf8");
        const iter: AsyncIterable<string> = {
          [Symbol.asyncIterator]() {
            let buf = "";
            let done = false;
            let streamError: Error | null = null;
            const pending: Array<{
              resolve: (v: IteratorResult<string>) => void;
            }> = [];
            const lines: string[] = [];

            function flush() {
              while (pending.length > 0 && lines.length > 0) {
                pending
                  .shift()!
                  .resolve({ value: lines.shift()!, done: false });
              }
              if (done) {
                while (pending.length > 0) {
                  pending.shift()!.resolve({ value: "", done: true });
                }
              }
            }

            res.on("data", (chunk: string) => {
              buf += chunk;
              const parts = buf.split("\n");
              buf = parts.pop() ?? "";
              for (const line of parts) lines.push(line);
              flush();
            });
            res.on("end", () => {
              if (buf) {
                lines.push(buf);
                buf = "";
              }
              done = true;
              flush();
            });
            res.on("error", (err: Error) => {
              streamError = err;
              done = true;
              flush();
            });

            return {
              next() {
                if (lines.length > 0)
                  return Promise.resolve({
                    value: lines.shift()!,
                    done: false,
                  });
                if (done) {
                  if (streamError) return Promise.reject(streamError);
                  return Promise.resolve({ value: "", done: true as const });
                }
                return new Promise<IteratorResult<string>>((resolve) => {
                  pending.push({ resolve });
                });
              },
            };
          },
        };
        resolve({ status: res.statusCode ?? 0, stream: iter });
      },
    );
    req.on("error", reject);
    req.setTimeout(upstreamTimeoutMs, () => {
      req.destroy();
      reject(new UpstreamTimeoutError(urlStr, upstreamTimeoutMs));
    });
    req.write(body);
    req.end();
  });
}
