/**
 * Huawei CodeArts Agent chat upstream — non-streaming handler + public re-exports.
 */

import { randomUUID, createHash } from "crypto";
import { setTimeout as delay } from "timers/promises";
import { config, getChatUrl } from "../../config";
import { getCredentials } from "../../auth/huawei/credentials";
import type { StoredHuaweiSession } from "../../auth/huawei/session-store";
import { UpstreamAuthError, UpstreamConcurrencyError, UpstreamContextLengthError, isPromptLengthExceeded } from "../../utils/errors";
import { logger } from "../../utils/logger";
import type {
  OpenAIChatCompletion,
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
} from "../../types/openai";
import { cleanToolCalls, computeChainForMessages, flushToolCallDeltas, mergeToolCallDeltas, normalizeForChain, normalizeToolCallsForChain, type ToolCallAccumulator } from "./chat-translate";
import { parseSSE, type CodeArtsSSEEvent } from "./chat-protocol";
import {
  buildV2RequestBody,
  buildChatHeaders,
  httpsPost,
  getLastResponseMessageId,
  setLastResponseMessageId,
  getChatIdRole,
  setChainState,
  getLastPromptTokens,
  setLastPromptTokens,
  computeCacheUsage,
} from "./chat-request";
import { acquireUpstreamSlot, isConcurrentSessionLimitError, reportConcurrencyLimit, reportUpstreamSuccess } from "./upstream-gate";

// Re-export public API
export { streamHuaweiChatToResponse } from "./chat-stream";
export { DEFAULT_MODEL_ID, MODEL_MAP } from "./chat-request";

// ---------------------------------------------------------------------------
// Non-streaming chat handler
// ---------------------------------------------------------------------------

/** 读尽一个失败响应体（仅用于非 200 分支）。 */
async function readErrorBody(stream: AsyncIterable<string>): Promise<string> {
  let body = "";
  for await (const line of stream) body += line;
  return body;
}

export async function sendHuaweiChatRequest(
  request: OpenAIChatCompletionRequest,
  session: StoredHuaweiSession,
  traceId: string,
  signal?: AbortSignal,
): Promise<OpenAIChatCompletion> {
  // 槽位覆盖整个请求，避免并行请求超过账号的并发会话上限。
  const release = await acquireUpstreamSlot(session.providerAccountId, signal);
  try {
    return await sendHuaweiChatRequestInner(request, session, traceId, signal);
  } finally {
    release();
  }
}

async function sendHuaweiChatRequestInner(
  request: OpenAIChatCompletionRequest,
  session: StoredHuaweiSession,
  traceId: string,
  signal?: AbortSignal,
): Promise<OpenAIChatCompletion> {
  const log = logger.withTrace(traceId);
  const credentials = getCredentials(session);
  const chatUrl = getChatUrl();
  const { body: requestBody, json: body, divergence, isToolContinuation, chatId } = buildV2RequestBody(request, session);
  const headers = buildChatHeaders(chatUrl, body, credentials, traceId);

  // v2 无 parent_message_id；续传判定完全依赖链状态（按派生 chatId 索引）。
  const hasContinuity = !!getLastResponseMessageId(chatId);

  // ── Outgoing request log ──────────────────────────────────────────────────
  const msgArr = requestBody.messages as unknown[];

  log.info("OUTGOING REQUEST → CodeArts (non-stream, v2)", {
    url: `POST ${chatUrl}`,
    model_id: requestBody.model,
    messagesCount: msgArr.length,
    isToolContinuation,
    isSubAgent: (requestBody.isSubAgent as boolean | undefined) ?? false,
  });
  log.debug("Outgoing body (full)", { body });

  // ── Continuity info ───────────────────────────────────────────────────────
  if (!request.codearts?.chat_id) {
    log.info("chat_id derived from message hash (v2)");
  }

  const { status: initialStatus, stream: initialStream } = await httpsPost(chatUrl, headers, body, signal);
  let status = initialStatus;
  let stream = initialStream;

  log.info("CodeArts HTTP response", { status });

  // ── Concurrent-session limit is retryable (HTTP 400 / TM.00001041) ────────
  let concurrencyAttempt = 0;
  let errorBody = "";
  while (status !== 200) {
    errorBody = await readErrorBody(stream);
    log.error("CodeArts error body", { status, body: errorBody.slice(0, 500) });

    if (!isConcurrentSessionLimitError(errorBody)) break;
    // 每个请求只降一档：重试期间的再次撞限不重复降级。
    if (concurrencyAttempt === 0) reportConcurrencyLimit(session.providerAccountId);

    if (concurrencyAttempt >= config.upstreamConcurrencyRetryMax) {
      throw new UpstreamConcurrencyError(
        "Upstream concurrent session limit reached (TM.00001041, max 3). " +
          `Retried ${config.upstreamConcurrencyRetryMax} time(s); ` +
          "please close other CodeArts Agent sessions and retry.",
        config.upstreamConcurrencyRetryDelayMs * 2 ** config.upstreamConcurrencyRetryMax,
        traceId,
      );
    }
    concurrencyAttempt++;
    const delayMs =
      config.upstreamConcurrencyRetryDelayMs * 2 ** (concurrencyAttempt - 1) +
      Math.floor(Math.random() * 250);
    log.warn("[codearts→proxy] concurrent session limit reached, retrying", {
      attempt: concurrencyAttempt,
      maxRetries: config.upstreamConcurrencyRetryMax,
      delayMs,
    });
    await delay(delayMs, undefined, signal ? { signal } : undefined);
    ({ status, stream } = await httpsPost(chatUrl, headers, body, signal));
    log.info("CodeArts HTTP response", { status });
  }

  reportUpstreamSuccess(session.providerAccountId);

  if (status !== 200) {
    if (status === 401 || status === 403)
      throw new UpstreamAuthError(status, errorBody);
    if (status === 413 || isPromptLengthExceeded(errorBody)) {
      throw new UpstreamContextLengthError(errorBody, traceId);
    }
    if (divergence === "tail-divergence") {
      log.info("[proxy→codearts] tail-divergence classified (no repair)", { status });
    }
    throw new Error(
      `CodeArts chat returned HTTP ${status}: ${errorBody.substring(0, 500)}`,
    );
  }

  let fullContent = "";
  let fullReasoning = "";
  let promptTokens = 0;
  let completionTokens = 0;
  /** v2 工具调用分片累加器（按 index 合并，非流式响应也需聚合） */
  const toolCallAccumulators = new Map<number, ToolCallAccumulator>();
  /** 上游真实缓存用量（v2 通道返回时优先使用） */
  let upstreamPromptTokensDetails: CodeArtsSSEEvent["prompt_tokens_details"] | undefined;
  const responseMetadata: Record<string, string | undefined> = {};

  let sseEventCount = 0;

  for await (const event of parseSSE(stream)) {
    sseEventCount++;
    if (event.chat_id) responseMetadata.chat_id = event.chat_id;
    if (event.response_message_id)
      responseMetadata.response_message_id = event.response_message_id;
    if (event.request_message_id)
      responseMetadata.request_message_id = event.request_message_id;

    if (event.chat_id || event.response_message_id) {
      log.debug("SSE meta", { chat_id: event.chat_id, response_message_id: event.response_message_id });
    }

    if (event.error_code && event.error_code !== "0" && event.error_code !== "ChatAgent.00000000") {
      if (event.error_code === "PROTOCOL_ERROR") {
        // Malformed SSE line — skip, don't fail the entire request
        continue;
      }
      log.error("SSE error from CodeArts", { code: event.error_code, msg: event.error_msg ?? "unknown" });
      if (isPromptLengthExceeded(event.error_code) || isPromptLengthExceeded(event.error_msg)) {
        throw new UpstreamContextLengthError(
          `${event.error_code}: ${event.error_msg ?? "unknown"}`,
          traceId,
        );
      }
      if (divergence === "tail-divergence") {
        log.info("[proxy→codearts] tail-divergence classified (no repair)", {
          code: event.error_code,
        });
      }
      throw new Error(
        `CodeArts error ${event.error_code}: ${event.error_msg ?? "unknown"}`,
      );
    }
    if (event.delta?.content) fullContent += event.delta.content;
    if (event.delta?.reasoning_content)
      fullReasoning += event.delta.reasoning_content;
    if (event.delta?.tool_calls) {
      for (const tc of event.delta.tool_calls) {
        const hasIdentity =
          (tc.id && tc.id !== "-") || (tc.function?.name ?? tc.name);
        if (hasIdentity) {
          log.debug("SSE tool_call", { id: tc.id, name: tc.function?.name ?? tc.name });
        }
      }
      mergeToolCallDeltas(toolCallAccumulators, event.delta.tool_calls);
    }
    if (event.prompt_tokens) promptTokens = event.prompt_tokens;
    if (event.completion_tokens) completionTokens = event.completion_tokens;
    if (event.prompt_tokens_details) upstreamPromptTokensDetails = event.prompt_tokens_details;
  }

  // 分片累加完成后一次性还原为完整工具调用
  const toolCalls = cleanToolCalls(flushToolCallDeltas(toolCallAccumulators));

  // Update response_message_id tracker only on successful turns
  if (responseMetadata.response_message_id) {
    // v2 上游事件不含 chat_id；使用构建侧派生的 chatId 维护链状态。
    const cid = chatId;
    if (cid) {
      const prevValue = getLastResponseMessageId(cid);
      const role = getChatIdRole(cid);
      setLastResponseMessageId(cid, responseMetadata.response_message_id);
      const assistantMessage: OpenAIChatMessage = {
        role: "assistant",
        content: fullContent,
        refusal: null,
        // 链状态重建统一不携带 reasoning_content（与 chat-stream.ts 一致）；
        // 工具调用 type 缺省补 "function"（仅用于 lastReplyHash，不改发送给客户端的消息）。
        // 可空值差异由 normalizeForChain 归一化兜底。
        tool_calls: normalizeToolCallsForChain(toolCalls),
      };
      const chain = computeChainForMessages(request.messages);
      setChainState(cid, {
        prefixChain: chain.hash,
        prefixLen: chain.length,
        lastReplyHash: createHash("sha256").update(normalizeForChain(assistantMessage)).digest("hex"),
      });
      log.info("lastResponseMessageId updated", {
        chat_id: cid,
        response_message_id: responseMetadata.response_message_id,
        prevValue: prevValue !== responseMetadata.response_message_id ? prevValue : undefined,
        role: role ?? "unknown",
      });
    }
  }

  log.info("RESPONSE COMPLETE (non-stream)", {
    sse_events: sseEventCount,
    text_chars: fullContent.length,
    tool_calls: toolCalls?.length ?? 0,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    response_message_id: responseMetadata.response_message_id ?? "(none)",
  });

  const message: OpenAIChatMessage = {
    role: "assistant",
    content: fullContent,
    refusal: null,
  };
  if (fullReasoning) message.reasoning_content = fullReasoning;
  if (toolCalls) message.tool_calls = toolCalls;

  // 优先使用上游真实 usage（v2 通道返回）；否则回退到 divergence 估算。
  const cacheUsage = upstreamPromptTokensDetails
    ? {
        prompt_cache_hit_tokens: upstreamPromptTokensDetails.cached_tokens ?? 0,
        prompt_cache_miss_tokens: upstreamPromptTokensDetails.text_tokens ?? 0,
        cache_estimated: false as const,
        prompt_tokens_details: upstreamPromptTokensDetails,
      }
    : computeCacheUsage(
        promptTokens,
        getLastPromptTokens(chatId),
        divergence,
        hasContinuity,
        isToolContinuation,
      );

  // 记录本轮 prompt_tokens 供下一轮续传估算缓存命中（guard > 0 避免增量事件 0 值污染）。
  // 必须在 computeCacheUsage 之后调用——否则 getLastPromptTokens 读到的是本轮刚写入的值，
  // 导致 cacheHit 永远等于 promptTokens、cacheMiss 永远为 0。
  if (responseMetadata.response_message_id && promptTokens > 0) {
    setLastPromptTokens(chatId, promptTokens);
  }

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    codearts: responseMetadata,
    choices: [
      { index: 0, message: message as OpenAIChatCompletion["choices"][number]["message"], finish_reason: toolCalls ? "tool_calls" : "stop", logprobs: null },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      ...cacheUsage,
    },
  };
}
