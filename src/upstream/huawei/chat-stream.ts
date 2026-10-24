/**
 * Streaming chat handler — SSE passthrough with OpenAI chunk wrapping.
 */

import { randomUUID, createHash } from "crypto";
import { setTimeout as delay } from "timers/promises";
import type { Response } from "express";
import { config, getChatUrl } from "../../config";
import { getCredentials } from "../../auth/huawei/credentials";
import type { StoredHuaweiSession } from "../../auth/huawei/session-store";
import { UpstreamAuthError, UpstreamConcurrencyError, UpstreamContextLengthError, isPromptLengthExceeded } from "../../utils/errors";
import { logger } from "../../utils/logger";
import { createOpenAIError } from "../../utils/openai-error";
import type {
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionDelta,
  OpenAIChatMessage,
} from "../../types/openai";
import { cleanToolCallDeltas, computeChainForMessages, normalizeForChain, normalizeToolCallsForChain } from "./chat-translate";
import { emitNoticeChunk } from "./chat-notice";
import { parseSSE, type CodeArtsSSEEvent } from "./chat-protocol";
import { acquireUpstreamSlot, isConcurrentSessionLimitError, reportConcurrencyLimit, reportUpstreamSuccess } from "./upstream-gate";
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

// ---------------------------------------------------------------------------
// Retryable SSE error detection
// ---------------------------------------------------------------------------

const MAX_SSE_RETRY = 1;
const SSE_RETRY_DELAY_MS = 2000;

/**
 * Determine if an SSE error_code is retryable (e.g. rate-limit / 429).
 * Matches patterns like "InferHub.ModelArts.81101.429" or any code
 * ending in ".429" / containing "RateLimit".
 */
function isRetryableSSEError(errorCode: string): boolean {
  if (errorCode.endsWith(".429") || errorCode === "429") return true;
  const lower = errorCode.toLowerCase();
  if (lower.includes("ratelimit") || lower.includes("rate_limit")) return true;
  return false;
}

export async function streamHuaweiChatToResponse(
  request: OpenAIChatCompletionRequest,
  session: StoredHuaweiSession,
  traceId: string,
  res: Response,
  signal?: AbortSignal,
): Promise<void> {
  // 槽位覆盖整条上游流的生命周期，避免并行请求超过账号的并发会话上限。
  const release = await acquireUpstreamSlot(session.providerAccountId, signal);
  try {
    await streamHuaweiChatToResponseInner(request, session, traceId, res, signal);
  } finally {
    release();
  }
}

async function streamHuaweiChatToResponseInner(
  request: OpenAIChatCompletionRequest,
  session: StoredHuaweiSession,
  traceId: string,
  res: Response,
  signal?: AbortSignal,
): Promise<void> {
  const log = logger.withTrace(traceId);
  const credentials = getCredentials(session);
  const chatUrl = getChatUrl();

  // ── Build initial request ────────────────────────────────────────────────
  const { body: requestBody, json: body, divergence: initialDivergence, isToolContinuation, chatId } = buildV2RequestBody(request, session);
  const headers = buildChatHeaders(chatUrl, body, credentials, traceId);

  // v2 无 parent_message_id；续传判定完全依赖链状态（按派生 chatId 索引）。
  const hasContinuity = !!getLastResponseMessageId(chatId);

  // ── Outgoing request log ──────────────────────────────────────────────────
  const msgArr = requestBody.messages as unknown[];
  const toolResultCount = isToolContinuation ? 1 : 0;

  log.info("[proxy→codearts] REQUEST", {
    url: `POST ${chatUrl}`,
    model_id: requestBody.model,
    messagesCount: msgArr.length,
    toolResultCount,
    isSubAgent: (requestBody.isSubAgent as boolean | undefined) ?? false,
  });
  log.debug("[proxy→codearts] body (full)", { body });

  // ── Continuity info ───────────────────────────────────────────────────────
  // v2 请求体无 chat_id / parent_message_id；续传完全依赖客户端回传的 messages 与链状态。
  if (!request.codearts?.chat_id) {
    log.info("chat_id derived from message hash (v2)");
  }
  if (isToolContinuation) {
    log.info("Tool continuation (v2)", {
      messagesCount: msgArr.length,
      hasContinuity: !!getLastResponseMessageId(chatId),
    });
  }

  const { status: initialStatus, stream: initialStream } = await httpsPost(chatUrl, headers, body, signal);
  let status = initialStatus;
  let stream = initialStream;

  // ── HTTP status handling (concurrent-session limit is retryable) ──────────
  let concurrencyAttempt = 0;
  while (status !== 200) {
    let errorBody = "";
    for await (const line of stream) errorBody += line;
    log.error("[codearts→proxy] HTTP error body", { status, body: errorBody.slice(0, 500) });

    if (status === 401 || status === 403)
      throw new UpstreamAuthError(status, errorBody);

    if (status === 413 || isPromptLengthExceeded(errorBody)) {
      throw new UpstreamContextLengthError(errorBody, traceId);
    }

    if (isConcurrentSessionLimitError(errorBody)) {
      // 每个请求只降一档：重试期间的再次撞限不重复降级。
      if (concurrencyAttempt === 0) reportConcurrencyLimit(session.providerAccountId);
      if (concurrencyAttempt < config.upstreamConcurrencyRetryMax) {
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
        continue;
      }

      throw new UpstreamConcurrencyError(
        "Upstream concurrent session limit reached (TM.00001041, max 3). " +
          `Retried ${config.upstreamConcurrencyRetryMax} time(s); ` +
          "please close other CodeArts Agent sessions and retry.",
        config.upstreamConcurrencyRetryDelayMs * 2 ** config.upstreamConcurrencyRetryMax,
        traceId,
      );
    }

    throw new Error(
      `CodeArts chat returned HTTP ${status}: ${errorBody.substring(0, 500)}`,
    );
  }

  // ── HTTP status log ─────────────────────────────────────────────────────
  log.info("[codearts→proxy] HTTP response", { status });
  reportUpstreamSuccess(session.providerAccountId);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const completionId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = request.model;
  let sentRole = false;
  let sentMetadata = false;
  const responseMetadata: Record<string, string | undefined> = {};

  // ── SSE event counters ────────────────────────────────────────────────────
  let sseEventCount = 0;
  let sseTextChars = 0;
  let sseToolCallCount = 0;
  let sseHadError = false;
  /** 已向客户端下发终态错误事件（如上下文超限）时，不再补 finish/usage chunk */
  let terminalErrorSent = false;
  let responseContent = "";
  let responseToolCalls: OpenAIChatMessage["tool_calls"] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  /** 上游真实缓存用量（v2 通道返回时优先使用） */
  let upstreamPromptTokensDetails: CodeArtsSSEEvent["prompt_tokens_details"] | undefined;
  const sseDebugLog: Array<{ event: number; delta?: string; error?: string; meta?: string }> = [];

  // ── SSE stream processing (retriable on rate-limit errors) ────────────────
  let retryCount = 0;
  let currentStream = stream;

  while (true) {
    let shouldRetry = false;

    for await (const event of parseSSE(currentStream)) {
      sseEventCount++;

      // Capture upstream session identifiers
      if (event.chat_id) responseMetadata.chat_id = event.chat_id;
      if (event.response_message_id)
        responseMetadata.response_message_id = event.response_message_id;
      if (event.request_message_id)
        responseMetadata.request_message_id = event.request_message_id;

      // 累积 token 计数（增量事件里为 0，只在最后事件有值）
      if (event.prompt_tokens) promptTokens = event.prompt_tokens;
      if (event.completion_tokens) completionTokens = event.completion_tokens;
      if (event.prompt_tokens_details) upstreamPromptTokensDetails = event.prompt_tokens_details;

      // Log meta event
      if (event.chat_id || event.response_message_id) {
        log.debug("[codearts→proxy] SSE meta", { chat_id: event.chat_id, response_message_id: event.response_message_id, request_message_id: event.request_message_id });
        sseDebugLog.push({ event: sseEventCount, meta: JSON.stringify({ chat_id: event.chat_id, response_message_id: event.response_message_id, request_message_id: event.request_message_id }) });
      }

      // Log errors
      if (
        event.error_code &&
        event.error_code !== "0" &&
        event.error_code !== "ChatAgent.00000000"
      ) {
        if (event.error_code === "PROTOCOL_ERROR") {
          // Malformed SSE line — skip, don't terminate the stream
          continue;
        }
        sseHadError = true;
        log.error("[codearts→proxy] SSE error", { code: event.error_code, msg: event.error_msg ?? "unknown" });
        sseDebugLog.push({ event: sseEventCount, error: JSON.stringify({ code: event.error_code, msg: event.error_msg }) });

        // ── 上下文超限：终态错误，不改写历史也不重试 ────────────────────
        if (isPromptLengthExceeded(event.error_code) || isPromptLengthExceeded(event.error_msg)) {
          const errorBody = createOpenAIError(
            `Upstream context length limit exceeded: ${event.error_code} - ${event.error_msg ?? "unknown"}`,
            "invalid_request_error",
            "context_length_exceeded",
          );
          res.write(`data: ${JSON.stringify(errorBody)}\n\n`);
          terminalErrorSent = true;
          break;
        }

        // ── Retry on rate-limit errors ────────────────────────────────────
        if (isRetryableSSEError(event.error_code) && retryCount < MAX_SSE_RETRY) {
          retryCount++;
          log.info("[codearts→proxy] Rate-limit SSE error, will retry", { code: event.error_code, retryCount });

          // Send a notice chunk to the client so they know what's happening
          const noticeResult = emitNoticeChunk(res, {
            id: completionId,
            created,
            model,
            content: `\n[上游限流: ${event.error_code} - ${event.error_msg ?? "unknown"}；正在重试...]\n`,
            sentRole,
            sentMetadata,
            responseMetadata,
          });
          sentRole = noticeResult.sentRole;
          sentMetadata = noticeResult.sentMetadata;

          // Wait before retrying
          await new Promise((resolve) => setTimeout(resolve, SSE_RETRY_DELAY_MS));
          if (signal?.aborted) break;

          // Rebuild request (chain state may have advanced from meta events)
          const retryBody = buildV2RequestBody(request, session);
          const retryHeaders = buildChatHeaders(chatUrl, retryBody.json, credentials, traceId);

          try {
            const retryResult = await httpsPost(chatUrl, retryHeaders, retryBody.json, signal);
            if (retryResult.status !== 200) {
              let retryErrorBody = "";
              for await (const line of retryResult.stream) retryErrorBody += line;
              log.error("[codearts→proxy] retry HTTP error", { status: retryResult.status, body: retryErrorBody.slice(0, 500) });
              // Fall through to normal error handling below
              break;
            }
            currentStream = retryResult.stream;
            shouldRetry = true;
            sseHadError = false; // Reset — the retry might succeed
            log.info("[codearts→proxy] retry request sent, continuing SSE stream");
          } catch (retryErr) {
            log.error("[codearts→proxy] retry request failed", { error: retryErr instanceof Error ? retryErr.message : String(retryErr) });
            break;
          }

          break; // Exit the for-await loop to start consuming the new stream
        }

        // ── 终态错误：如实上报，不合成工具调用、不伪装成正常输出 ────────
        const terminalError = createOpenAIError(
          `Upstream error: ${event.error_code} - ${event.error_msg ?? "unknown"}`,
          "upstream_error",
          event.error_code,
        );
        res.write(`data: ${JSON.stringify(terminalError)}\n\n`);
        terminalErrorSent = true;
        break;
      }

      if (event.delta) {
        // Collect debug info for full stream dump
        sseDebugLog.push({ event: sseEventCount, delta: JSON.stringify(event.delta) });

        if (event.delta.tool_calls && event.delta.tool_calls.length > 0) {
          for (const tc of event.delta.tool_calls) {
            const hasIdentity =
              (tc.id && tc.id !== "-") || (tc.function?.name ?? tc.name);
            if (hasIdentity) {
              sseToolCallCount++;
            }
            log.debug("[codearts→proxy] SSE tool_call", {
              id: tc.id,
              name: tc.function?.name ?? tc.name,
              hasId: !!(tc.id && tc.id !== "-"),
              arguments_preview: (tc.function?.arguments ?? (typeof tc.arguments === "string" ? tc.arguments : "")).slice(0, 300),
            });
          }
        }
        if (event.delta.content) {
          sseTextChars += event.delta.content.length;
          responseContent += event.delta.content;
        }

        // Build delta content
        const delta: OpenAIChatCompletionDelta = {};
        if (event.delta.content) delta.content = event.delta.content;
        if (event.delta.reasoning_content)
          delta.reasoning_content = event.delta.reasoning_content;
        const toolCallDeltas = cleanToolCallDeltas(event.delta.tool_calls);
        if (toolCallDeltas) {
          responseToolCalls = [...(responseToolCalls ?? []), ...(toolCallDeltas as OpenAIChatMessage["tool_calls"] ?? [])];
          delta.tool_calls = toolCallDeltas;
          log.debug("[proxy→client] tool_call delta", {
            deltas: toolCallDeltas.map((d) => ({
              index: d.index,
              id: d.id,
              name: d.function?.name,
              arguments_preview: d.function?.arguments?.slice(0, 200),
            })),
          });
        }

        // Merge role into first content delta (instead of sending a separate role-only chunk)
        if (!sentRole) {
          const role = event.delta.role && [
            "assistant",
            "user",
            "system",
            "tool",
            "function",
          ].includes(event.delta.role)
            ? (event.delta.role as OpenAIChatCompletionChunk["choices"][number]["delta"]["role"])
            : "assistant";
          delta.role = role;
          sentRole = true;
        }

        if (Object.keys(delta).length > 0) {
          // codearts metadata only in the first chunk
          const chunk = {
            id: completionId,
            object: "chat.completion.chunk" as const,
            created,
            model,
            ...(sentMetadata ? {} : { codearts: { ...responseMetadata } }),
            choices: [{ index: 0, delta, finish_reason: null }],
          };
          sentMetadata = true;
          res.write(
            `data: ${JSON.stringify(chunk as OpenAIChatCompletionChunk)}\n\n`,
          );
        }
      }
    }

    // If we broke out to retry with a new stream, continue the while loop
    if (shouldRetry) continue;
    break;
  }

  // ── Update response_message_id tracker ────────────────────────────────────
  if (!sseHadError && responseMetadata.response_message_id) {
    // v2 上游事件不含 chat_id；使用构建侧派生的 chatId 维护链状态。
    const cid = chatId;
    if (cid) {
      const prevValue = getLastResponseMessageId(cid);
      const role = getChatIdRole(cid);
      setLastResponseMessageId(cid, responseMetadata.response_message_id);
      const assistantMessage: OpenAIChatMessage = {
        role: "assistant",
        content: responseContent,
        refusal: null,
        tool_calls: normalizeToolCallsForChain(responseToolCalls),
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
  } else if (sseHadError) {
    log.warn("SSE had error — lastResponseMessageId NOT updated (preserved for retry)");
  }

  // 先快照上一轮 prompt_tokens 供本轮缓存估算，再记录本轮值供下一轮用。
  // 必须先快照再 set——否则 getLastPromptTokens 读到的是本轮刚写入的值，
  // 导致 cacheHit 永远等于 promptTokens、cacheMiss 永远为 0。
  const cid = chatId;
  const prevPromptTokens = getLastPromptTokens(cid);
  if (responseMetadata.response_message_id && promptTokens > 0) {
    setLastPromptTokens(cid, promptTokens);
  }

  // ── Stream complete log ───────────────────────────────────────────────────
  log.info("[codearts→proxy→client] STREAM COMPLETE", {
    sse_events: sseEventCount,
    text_chars: sseTextChars,
    tool_calls: sseToolCallCount,
    retries: retryCount,
    response_message_id: responseMetadata.response_message_id ?? "(none)",
    chat_id: responseMetadata.chat_id ?? "(none)",
  });
  log.debug("[codearts→proxy] SSE full stream", { events: sseDebugLog });

  // When LLM returns tool_calls, finish_reason must be "tool_calls" not "stop",
  // otherwise the client treats the conversation as finished and won't execute tools.
  const finishReason = sseToolCallCount > 0 ? "tool_calls" : "stop";

  if (!terminalErrorSent) {
    res.write(
      `data: ${JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      } as OpenAIChatCompletionChunk)}\n\n`,
    );
  }

  // 流式 usage chunk：仅在 stream_options.include_usage=true 时补发（OpenAI 协议 opt-in）
  if (request.stream_options?.include_usage && !terminalErrorSent) {
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
          prevPromptTokens,
          initialDivergence,
          hasContinuity,
          isToolContinuation,
        );
    res.write(
      `data: ${JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          ...cacheUsage,
        },
      } as OpenAIChatCompletionChunk)}\n\n`,
    );
  }

  res.write("data: [DONE]\n\n");
  res.end();
}
