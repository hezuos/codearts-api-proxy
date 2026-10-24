/**
 * Chat request body construction and HTTP transport.
 */

import { randomUUID, createHash } from "crypto";
import https from "https";
import { config, upstreamTimeoutMs } from "../../config";
import { signRequest, type SigningCredentials } from "../../auth/huawei/credentials";
import type { StoredHuaweiSession } from "../../auth/huawei/session-store";
import { UpstreamTimeoutError } from "../../utils/errors";
import { logger } from "../../utils/logger";
import type { OpenAIChatCompletionRequest, OpenAIChatMessage } from "../../types/openai";
import {
  isToolContinuationRequest,
  resolveTools,
  normalizeMessageContent,
  computeChainForMessages,
  normalizeForChain,
} from "./chat-translate";

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
// In-memory response_message_id tracker (with TTL eviction)
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
 * 组合 divergence + response_message_id + isToolContinuation 三信号判断缓存命中：
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
 * 输出 OpenAI 兼容形状：
 * `{ model, max_tokens, tool_stream, stream, messages, tools?, isSubAgent?, subAgent_type?, subAgent_prompt? }`。
 *
 * `messages` 始终按原顺序、原角色逐字透传客户端历史。
 */
export function buildV2RequestBody(
  request: OpenAIChatCompletionRequest,
  session: StoredHuaweiSession,
): { body: Record<string, unknown>; json: string; divergence?: Divergence; suffixStart?: number; isToolContinuation: boolean; chatId: string } {
  const isToolContinuation = isToolContinuationRequest(request.messages);
  const subAgent = request.codearts?.sub_agent;

  const tools = resolveTools(request);
  const modelId = resolveModelId(request);

  const chatId =
    request.codearts?.chat_id?.trim() || deriveConversationId(request.messages, session.providerAccountId);

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


  const chainState = getChainState(chatId);

  // 分叉分类仅用于日志与缓存估算，不改变请求内容、不触发修复。
  // 工具续传与子代理请求旁路分类（与既有要求一致）。
  let divergence: Divergence | undefined;
  let suffixStart: number | undefined;
  if (chainState && !isToolContinuation && !subAgent) {
    const classified = classifyDivergence(request.messages, chainState);
    divergence = classified.divergence;
    suffixStart = classified.suffixStart;
  }

  // v2 无状态：客户端历史按原顺序、原角色逐字透传，不合并、不改写、不截断。
  const messagesBody = request.messages.map(toV2Message);

  const body: Record<string, unknown> = {
    model: modelId,
    max_tokens: Math.min(request.max_tokens ?? V2_DEFAULT_MAX_TOKENS, V2_MAX_TOKENS_LIMIT),
    tool_stream: true,
    // v2 上游始终以 SSE 流式返回（stream:false 会返回普通 JSON，parseSSE 解析为空）。
    // 非流式客户端由 chat.ts 聚合 SSE 事件。
    stream: true,
    // 与 IDE 客户端保持一致：流式请求显式索取 usage。
    stream_options: request.stream_options ?? { include_usage: true },
    messages: messagesBody,
  };

  // 标准 OpenAI 采样参数：仅在客户端显式提供时透传。
  if (request.temperature != null) body.temperature = request.temperature;
  if (request.top_p != null) body.top_p = request.top_p;
  if (request.stop != null) body.stop = request.stop;
  if (request.presence_penalty != null) body.presence_penalty = request.presence_penalty;
  if (request.frequency_penalty != null) body.frequency_penalty = request.frequency_penalty;
  if (request.seed != null) body.seed = request.seed;
  if (request.response_format != null) body.response_format = request.response_format;
  if (request.tool_choice != null) body.tool_choice = request.tool_choice;

  if (tools.length > 0) {
    body.tools = tools;
  }

  if (subAgent) {
    body.isSubAgent = true;
    body.subAgent_type = subAgent.type;
    body.subAgent_prompt = subAgent.prompt ?? "";
  }

  if (divergence) {
    logger.info("[proxy→codearts] REQUEST context classification (v2)", {
      chat_id: chatId,
      divergence,
      suffixStart,
      messagesCount: request.messages.length,
      model_id: modelId,
    });
  }

  return { body, json: JSON.stringify(body), divergence, suffixStart, isToolContinuation, chatId };
}

/**
 * 将客户端消息投影为 v2 上游接受的 OpenAI 消息形状。
 *
 * v2 上游无服务端会话状态，每个请求都携带完整历史；投影只做字段映射
 * （developer → system、剔除代理内部字段），不改变内容。
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

            const onData = (chunk: string) => {
              buf += chunk;
              const parts = buf.split("\n");
              buf = parts.pop() ?? "";
              for (const line of parts) lines.push(line);
              flush();
            };
            const onEnd = () => {
              if (buf) {
                lines.push(buf);
                buf = "";
              }
              done = true;
              flush();
            };
            const onError = (err: Error) => {
              streamError = err;
              done = true;
              flush();
            };
            /**
             * 中断/连接关闭时可能只发 'close'（不发 'end'/'error'）。
             * 没有这个分支时迭代器会永久挂起，导致闸门槽位永远不释放。
             */
            const onClose = () => {
              if (done) return;
              done = true;
              flush();
            };
            res.on("data", onData);
            res.on("end", onEnd);
            res.on("error", onError);
            res.on("close", onClose);

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
              /**
               * 调用方提前退出（重试/链路修复/中断）时立即释放上游连接。
               * 否则被放弃的响应会继续占用上游并发会话槽位。
               */
              return(): Promise<IteratorResult<string>> {
                if (!done) {
                  done = true;
                  res.off("data", onData);
                  res.off("end", onEnd);
                  res.off("close", onClose);
                  flush();
                  res.destroy();
                }
                return Promise.resolve({ value: "", done: true as const });
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
