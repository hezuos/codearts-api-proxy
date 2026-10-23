/**
 * Streaming chat handler — SSE passthrough with OpenAI chunk wrapping.
 */

import { randomUUID, createHash } from "crypto";
import type { Response } from "express";
import { getChatUrl } from "../../config";
import { getCredentials } from "../../auth/huawei/credentials";
import type { StoredHuaweiSession } from "../../auth/huawei/session-store";
import { UpstreamAuthError } from "../../utils/errors";
import { logger } from "../../utils/logger";
import type {
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionDelta,
  OpenAIChatMessage,
} from "../../types/openai";
import { cleanToolCallDeltas, computeChainForMessages, normalizeForChain, normalizeToolCallsForChain } from "./chat-translate";
import { buildRecoveryChunks, buildSyntheticRecoveryToolCalls, buildForceResyncToolCall } from "./chat-recovery";
import { emitNoticeChunk } from "./chat-notice";
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
  const log = logger.withTrace(traceId);
  const credentials = getCredentials(session);
  const chatUrl = getChatUrl();

  // ── Build initial request ────────────────────────────────────────────────
  const { body: requestBody, json: body, divergence: initialDivergence, isToolContinuation, proactiveReset } = buildV2RequestBody(request, session);
  const headers = buildChatHeaders(chatUrl, body, credentials, traceId);

  // v2 无 parent_message_id；续传判定基于链状态（lastResponseMessageId）。
  const hasContinuity =
    !!request.codearts?.parent_message_id ||
    !!getLastResponseMessageId(request.codearts?.chat_id?.trim() ?? "");

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
      hasContinuity: !!getLastResponseMessageId(request.codearts?.chat_id ?? ""),
    });
  }

  const { status, stream } = await httpsPost(chatUrl, headers, body, signal);

  // ── HTTP status log ───────────────────────────────────────────────────────
  log.info("[codearts→proxy] HTTP response", { status });

  if (status !== 200) {
    let errorBody = "";
    for await (const line of stream) errorBody += line;
    log.error("[codearts→proxy] error body", { status, body: errorBody.slice(0, 500) });
    if (status === 401 || status === 403)
      throw new UpstreamAuthError(status, errorBody);
    throw new Error(
      `CodeArts chat returned HTTP ${status}: ${errorBody.substring(0, 500)}`,
    );
  }

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

  // ── Proactive reset / folding notice chunk (before upstream stream starts) ──
  // Gives client visibility that context was compressed/reset before the request.
  if (proactiveReset) {
    const result = emitNoticeChunk(res, {
      id: completionId,
      created,
      model,
      content: "\n[上下文已压缩：累积长度接近上游限制，已主动重置对话链继续。早期细节可能丢失。]\n",
      sentRole,
      sentMetadata,
      responseMetadata,
      extraMetadata: { context_reset: "proactive" },
    });
    sentRole = result.sentRole;
    sentMetadata = result.sentMetadata;
  } else if (initialDivergence === "middle-damage" || initialDivergence === "duplicate/stale") {
    const result = emitNoticeChunk(res, {
      id: completionId,
      created,
      model,
      content: "\n[上下文已重置：对话链已折叠重建。]\n",
      sentRole,
      sentMetadata,
      responseMetadata,
      extraMetadata: { context_reset: "true" },
    });
    sentRole = result.sentRole;
    sentMetadata = result.sentMetadata;
  }

  // ── SSE event counters ────────────────────────────────────────────────────
  let sseEventCount = 0;
  let sseTextChars = 0;
  let sseToolCallCount = 0;
  let sseHadError = false;
  let responseContent = "";
  let responseToolCalls: OpenAIChatMessage["tool_calls"] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  /** 上游真实缓存用量（v2 通道返回时优先使用） */
  let upstreamPromptTokensDetails: CodeArtsSSEEvent["prompt_tokens_details"] | undefined;
  const sseDebugLog: Array<{ event: number; delta?: string; error?: string; meta?: string }> = [];

  // ── SSE stream processing (retriable on rate-limit errors) ────────────────
  let retryCount = 0;
  let resyncRetried = false;
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

        // ── Tail-divergence repair fallback ───────────────────────────────
        // The parent chain may be unavailable or incompatible with the appended tail.
        if (initialDivergence === "tail-divergence" && !resyncRetried) {
          resyncRetried = true;
          log.warn("[proxy→codearts] tail-divergence repair failed, retrying full reset", {
            code: event.error_code,
          });
          // Emit notice chunk so client sees the resync attempt
          const noticeResult = emitNoticeChunk(res, {
            id: completionId,
            created,
            model,
            content: "\n[链尾偏离修复失败，正在全量重置重试...]\n",
            sentRole,
            sentMetadata,
            responseMetadata,
            extraMetadata: { error_recovery: "tail-divergence-resync" },
          });
          sentRole = noticeResult.sentRole;
          sentMetadata = noticeResult.sentMetadata;
          const resyncBody = buildV2RequestBody(request, session, { forceResync: true });
          const resyncHeaders = buildChatHeaders(chatUrl, resyncBody.json, credentials, traceId);
          try {
            const resyncResult = await httpsPost(chatUrl, resyncHeaders, resyncBody.json, signal);
            if (resyncResult.status === 200) {
              currentStream = resyncResult.stream;
              shouldRetry = true;
              sseHadError = false;
              break;
            }
            log.error("[proxy→codearts] full-reset fallback HTTP error", { status: resyncResult.status });
          } catch (resyncError) {
            log.error("[proxy→codearts] full-reset fallback failed", {
              error: resyncError instanceof Error ? resyncError.message : String(resyncError),
            });
          }
        }

        // ── ChatAgent.00001216 recovery: prompt length exceeds upstream limit ──
        if (event.error_code === "ChatAgent.00001216" && !resyncRetried) {
          resyncRetried = true;
          log.warn("[proxy→codearts] prompt length exceeds upstream limit, retrying with full context reset", {
            code: event.error_code,
          });
          const noticeResult = emitNoticeChunk(res, {
            id: completionId,
            created,
            model,
            content: "\n[上下文长度超过上游限制，正在全量重置重试...]\n",
            sentRole,
            sentMetadata,
            responseMetadata,
            extraMetadata: { error_recovery: "ChatAgent.00001216" },
          });
          sentRole = noticeResult.sentRole;
          sentMetadata = noticeResult.sentMetadata;
          const resyncBody = buildV2RequestBody(request, session, { forceResync: true });
          const resyncHeaders = buildChatHeaders(chatUrl, resyncBody.json, credentials, traceId);
          try {
            const resyncResult = await httpsPost(chatUrl, resyncHeaders, resyncBody.json, signal);
            if (resyncResult.status === 200) {
              currentStream = resyncResult.stream;
              shouldRetry = true;
              sseHadError = false;
              break;
            }
            log.error("[proxy→codearts] 00001216 full-reset fallback HTTP error", { status: resyncResult.status });
          } catch (resyncError) {
            log.error("[proxy→codearts] 00001216 full-reset fallback failed", {
              error: resyncError instanceof Error ? resyncError.message : String(resyncError),
            });
          }
        }

        // ── Recovery path (non-retryable or retry exhausted) ──────────────
        const recoveryToolCalls = buildSyntheticRecoveryToolCalls(request);
        // 00001216 forceResync 重试仍失败时，合成 tool_call 让客户端续传。
        // 根据客户端 tools 列表选择可执行的工具（Bash/Glob/Grep/Read/askFollowupQuestion）。
        // 客户端执行后回传 tool_result，proxy 通过 tool_call_id 注册识别后走 forceResync 路径。
        const clientToolNames = (request.tools ?? []).map((t) => t.function.name);
        const forceResyncToolCall =
          recoveryToolCalls.length === 0 && event.error_code === "ChatAgent.00001216"
            ? buildForceResyncToolCall(clientToolNames)
            : null;
        if (recoveryToolCalls.length > 0 || forceResyncToolCall) {
          const effectiveRecoveryToolCalls = forceResyncToolCall
            ? [forceResyncToolCall]
            : recoveryToolCalls;
          log.warn("[proxy→client] synthetic recovery tool_calls", {
            code: event.error_code,
            count: effectiveRecoveryToolCalls.length,
            names: effectiveRecoveryToolCalls.map((tc) => tc.function.name),
            forceResync: !!forceResyncToolCall,
          });
          const recovery = buildRecoveryChunks({
            completionId,
            created,
            model,
            responseMetadata,
            sentRole,
            sentMetadata,
            errorCode: event.error_code,
            errorMsg: event.error_msg ?? undefined,
            recoveryToolCalls: effectiveRecoveryToolCalls,
          });
          sentRole = recovery.sentRole;
          sentMetadata = recovery.sentMetadata;
          sseToolCallCount += effectiveRecoveryToolCalls.length;
          for (const chunk of recovery.chunks) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          break;
        }

        const errChunk: OpenAIChatCompletionChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          codearts: responseMetadata,
          choices: [
            {
              index: 0,
              delta: {
                content: `[Error: ${event.error_code} - ${event.error_msg ?? "unknown"}]`,
              },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
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

  // ── Update parent_message_id tracker ──────────────────────────────────────
  if (!sseHadError && responseMetadata.response_message_id) {
    const cid = responseMetadata.chat_id;
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
  const cid = responseMetadata.chat_id;
  const prevPromptTokens = cid ? getLastPromptTokens(cid) : undefined;
  if (responseMetadata.response_message_id && promptTokens > 0 && cid) {
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

  res.write(
    `data: ${JSON.stringify({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    } as OpenAIChatCompletionChunk)}\n\n`,
  );

  // 流式 usage chunk：仅在 stream_options.include_usage=true 时补发（OpenAI 协议 opt-in）
  if (request.stream_options?.include_usage) {
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
