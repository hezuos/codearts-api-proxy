/**
 * Huawei CodeArts Agent chat upstream — non-streaming handler + public re-exports.
 */

import { randomUUID, createHash } from "crypto";
import { config } from "../../config";
import { getCredentials } from "../../auth/huawei/credentials";
import type { StoredHuaweiSession } from "../../auth/huawei/session-store";
import { UpstreamAuthError } from "../../utils/errors";
import { logger } from "../../utils/logger";
import type {
  OpenAIChatCompletion,
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
} from "../../types/openai";
import { cleanToolCalls, computeChainForMessages, normalizeForChain, normalizeToolCallsForChain } from "./chat-translate";
import { parseSSE } from "./chat-protocol";
import {
  buildRequestBody,
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

// Re-export public API
export { streamHuaweiChatToResponse } from "./chat-stream";
export { DEFAULT_MODEL_ID, MODEL_MAP } from "./chat-request";

// ---------------------------------------------------------------------------
// Non-streaming chat handler
// ---------------------------------------------------------------------------

export async function sendHuaweiChatRequest(
  request: OpenAIChatCompletionRequest,
  session: StoredHuaweiSession,
  traceId: string,
  signal?: AbortSignal,
  options: { forceResync?: boolean } = {},
): Promise<OpenAIChatCompletion> {
  const log = logger.withTrace(traceId);
  const credentials = getCredentials(session);
  const chatUrl = `${config.huaweiChatHost}/v1/chat/chat`;
  const { body: requestBody, json: body, divergence, isToolContinuation, proactiveReset } = buildRequestBody(request, session, options);
  const headers = buildChatHeaders(chatUrl, body, credentials, traceId);

  // ── Outgoing request log ──────────────────────────────────────────────────
  const tp = requestBody.task_parameters as Record<string, unknown> | undefined;
  const toolResultCount = Array.isArray(tp?.tool_result)
    ? (tp.tool_result as unknown[]).length
    : 0;
  const msgArr = requestBody.messages as unknown[];

  log.info("OUTGOING REQUEST → CodeArts (non-stream)", {
    url: `POST ${chatUrl}`,
    model_id: requestBody.model_id,
    chat_id: requestBody.chat_id,
    parent_message_id: requestBody.parent_message_id,
    messagesCount: msgArr.length,
    toolResultCount,
  });
  log.debug("Outgoing body (full)", { body });

  // ── Continuity info ───────────────────────────────────────────────────────
  if (!request.codearts?.chat_id) {
    log.info("chat_id derived from message hash", { chat_id: requestBody.chat_id });
  }
  if (!request.codearts?.parent_message_id && requestBody.parent_message_id) {
    log.info("parent_message_id auto-filled from last turn", { parent_message_id: requestBody.parent_message_id });
  }
  if (toolResultCount > 0 && !requestBody.parent_message_id) {
    log.warn("tool_result continuation but parent_message_id is empty");
  }

  const { status, stream } = await httpsPost(chatUrl, headers, body, signal);

  log.info("CodeArts HTTP response", { status });

  if (status !== 200) {
    let errorBody = "";
    for await (const line of stream) errorBody += line;
    log.error("CodeArts error body", { status, body: errorBody.slice(0, 500) });
    if (status === 401 || status === 403)
      throw new UpstreamAuthError(status, errorBody);
    if (divergence === "tail-divergence" && !options.forceResync) {
      log.warn("[proxy→codearts] tail-divergence repair HTTP failure, retrying full reset", { status });
      return sendHuaweiChatRequest(request, session, traceId, signal, { forceResync: true });
    }
    if (errorBody.includes("ChatAgent.00001216") && !options.forceResync) {
      log.warn("[proxy→codearts] prompt length exceeds upstream limit, retrying with full context reset", { status });
      return sendHuaweiChatRequest(request, session, traceId, signal, { forceResync: true });
    }
    throw new Error(
      `CodeArts chat returned HTTP ${status}: ${errorBody.substring(0, 500)}`,
    );
  }

  let fullContent = "";
  let fullReasoning = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let toolCalls: OpenAIChatMessage["tool_calls"];
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
      if (divergence === "tail-divergence" && !options.forceResync) {
        log.warn("[proxy→codearts] tail-divergence repair SSE failure, retrying full reset", {
          code: event.error_code,
        });
        return sendHuaweiChatRequest(request, session, traceId, signal, { forceResync: true });
      }
      if (event.error_code === "ChatAgent.00001216" && !options.forceResync) {
        log.warn("[proxy→codearts] prompt length exceeds upstream limit (SSE), retrying with full context reset", {
          code: event.error_code,
        });
        return sendHuaweiChatRequest(request, session, traceId, signal, { forceResync: true });
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
    }
    const mapped = cleanToolCalls(event.delta?.tool_calls);
    if (mapped) {
      toolCalls = toolCalls ? [...toolCalls, ...mapped] : mapped;
    }
    if (event.prompt_tokens) promptTokens = event.prompt_tokens;
    if (event.completion_tokens) completionTokens = event.completion_tokens;
  }

  // Update parent_message_id tracker only on successful turns
  if (responseMetadata.response_message_id) {
    const cid = responseMetadata.chat_id;
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

  const cid = responseMetadata.chat_id;
  const cacheUsage = computeCacheUsage(
    promptTokens,
    cid ? getLastPromptTokens(cid) : undefined,
    divergence,
    !!requestBody.parent_message_id,
    isToolContinuation,
  );

  // 记录本轮 prompt_tokens 供下一轮续传估算缓存命中（guard > 0 避免增量事件 0 值污染）。
  // 必须在 computeCacheUsage 之后调用——否则 getLastPromptTokens 读到的是本轮刚写入的值，
  // 导致 cacheHit 永远等于 promptTokens、cacheMiss 永远为 0。
  if (responseMetadata.response_message_id && promptTokens > 0 && cid) {
    setLastPromptTokens(cid, promptTokens);
  }

  // Mark context reset in metadata for client visibility (folding / proactive reset / forceResync)
  if ((divergence === "middle-damage" || divergence === "duplicate/stale") && !proactiveReset) {
    responseMetadata.context_reset = "true";
  }
  if (proactiveReset) {
    responseMetadata.context_reset = "proactive";
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
