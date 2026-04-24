/**
 * Huawei CodeArts Agent chat upstream — non-streaming handler + public re-exports.
 *
 * The streaming handler lives in chat-stream.ts.
 * Request body construction lives in chat-request.ts.
 * Message/tool translation lives in chat-translate.ts.
 * Protocol types + SSE parser live in chat-protocol.ts.
 */

import { randomUUID } from "crypto";
import { config } from "../../config";
import { getCredentials } from "../../auth/huawei/credentials";
import type { StoredHuaweiSession } from "../../auth/huawei/session-store";
import { UpstreamAuthError } from "../../utils/errors";
import type {
  OpenAIChatCompletion,
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
} from "../../types/openai";
import { mapToolCalls } from "./chat-translate";
import { parseSSE } from "./chat-protocol";
import {
  buildRequestBody,
  buildChatHeaders,
  httpsPost,
  getLastResponseMessageId,
  setLastResponseMessageId,
  getChatIdRole,
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
): Promise<OpenAIChatCompletion> {
  const credentials = getCredentials(session);
  const chatUrl = `${config.huaweiChatHost}/v1/chat/chat`;
  const body = buildRequestBody(request, session);
  const headers = buildChatHeaders(chatUrl, body, credentials, traceId);

  // ── Outgoing request log ──────────────────────────────────────────────────
  const parsedBody = JSON.parse(body) as Record<string, unknown>;
  const tp = parsedBody.task_parameters as Record<string, unknown> | undefined;
  const toolResultCount = Array.isArray(tp?.tool_result)
    ? (tp.tool_result as unknown[]).length
    : 0;
  const msgArr = parsedBody.messages as unknown[];
  console.log(`[${traceId}] ── OUTGOING REQUEST → CodeArts (non-stream) ─────`);
  console.log(`[${traceId}]   url             : POST ${chatUrl}`);
  console.log(`[${traceId}]   model_id        : ${parsedBody.model_id}`);
  console.log(`[${traceId}]   chat_id         : ${parsedBody.chat_id}`);
  console.log(
    `[${traceId}]   parent_message_id: ${parsedBody.parent_message_id}`,
  );
  console.log(`[${traceId}]   messages.count  : ${msgArr.length}`);
  console.log(`[${traceId}]   tool_result.count: ${toolResultCount}`);
  console.log(`[${traceId}]   body (full):\n${body}`);
  console.log(
    `[${traceId}] ──────────────────────────────────────────────────`,
  );

  // ── Continuity info ───────────────────────────────────────────────────────
  if (!request.codearts?.chat_id) {
    console.log(
      `[${traceId}] ℹ chat_id derived from message hash: ${parsedBody.chat_id as string}`,
    );
  }
  if (!request.codearts?.parent_message_id && parsedBody.parent_message_id) {
    console.log(
      `[${traceId}] ℹ parent_message_id auto-filled from last turn: ${parsedBody.parent_message_id as string}`,
    );
  }
  if (toolResultCount > 0 && !parsedBody.parent_message_id) {
    console.warn(
      `[${traceId}] ⚠ WARN: tool_result continuation but parent_message_id is empty!`,
    );
  }

  const { status, stream } = await httpsPost(chatUrl, headers, body);

  console.log(`[${traceId}] ← CodeArts HTTP status: ${status}`);

  if (status !== 200) {
    let errorBody = "";
    for await (const line of stream) errorBody += line;
    console.error(
      `[${traceId}] ← CodeArts error body: ${errorBody.slice(0, 500)}`,
    );
    if (status === 401 || status === 403)
      throw new UpstreamAuthError(status, errorBody);
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
  let sseHadError = false;

  for await (const event of parseSSE(stream)) {
    sseEventCount++;
    if (event.chat_id) responseMetadata.chat_id = event.chat_id;
    if (event.response_message_id)
      responseMetadata.response_message_id = event.response_message_id;
    if (event.request_message_id)
      responseMetadata.request_message_id = event.request_message_id;

    if (event.chat_id || event.response_message_id) {
      console.log(
        `[${traceId}] ← SSE meta  chat_id=${event.chat_id ?? "-"} response_message_id=${event.response_message_id ?? "-"}`,
      );
    }

    if (event.error_code && event.error_code !== "0") {
      sseHadError = true;
      console.error(
        `[${traceId}] ← SSE error  code=${event.error_code} msg=${event.error_msg ?? "unknown"}`,
      );
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
          console.log(
            `[${traceId}] ← SSE tool_call  id=${tc.id ?? "-"} name=${tc.function?.name ?? tc.name ?? "-"}`,
          );
        }
      }
    }
    const mapped = mapToolCalls(event.delta?.tool_calls);
    if (mapped) toolCalls = mapped;
    if (event.prompt_tokens) promptTokens = event.prompt_tokens;
    if (event.completion_tokens) completionTokens = event.completion_tokens;
  }

  // Update parent_message_id tracker only on successful turns
  if (!sseHadError && responseMetadata.response_message_id) {
    const cid = responseMetadata.chat_id;
    if (cid) {
      const prevValue = getLastResponseMessageId(cid);
      const role = getChatIdRole(cid);
      setLastResponseMessageId(cid, responseMetadata.response_message_id);
      if (prevValue && prevValue !== responseMetadata.response_message_id) {
        console.log(
          `[${traceId}] ℹ lastResponseMessageId updated: ${cid} → ${responseMetadata.response_message_id} ` +
          `(overwrote ${prevValue}, role=${role ?? "unknown"})`,
        );
      } else {
        console.log(
          `[${traceId}] ℹ lastResponseMessageId updated: ${cid} → ${responseMetadata.response_message_id} ` +
          `(role=${role ?? "unknown"})`,
        );
      }
    }
  }
  console.log(
    `[${traceId}] ── RESPONSE COMPLETE (non-stream) ────────────────`,
  );
  console.log(`[${traceId}]   sse_events      : ${sseEventCount}`);
  console.log(`[${traceId}]   text_chars      : ${fullContent.length}`);
  console.log(`[${traceId}]   tool_calls      : ${toolCalls?.length ?? 0}`);
  console.log(`[${traceId}]   prompt_tokens   : ${promptTokens}`);
  console.log(`[${traceId}]   completion_tokens: ${completionTokens}`);
  console.log(
    `[${traceId}]   response_message_id: ${responseMetadata.response_message_id ?? "(none)"}`,
  );
  console.log(
    `[${traceId}] ──────────────────────────────────────────────────`,
  );

  const message: OpenAIChatMessage = {
    role: "assistant",
    content: fullContent,
  };
  if (fullReasoning) message.reasoning_content = fullReasoning;
  if (toolCalls) message.tool_calls = toolCalls;

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    codearts: responseMetadata,
    choices: [
      { index: 0, message, finish_reason: toolCalls ? "tool_calls" : "stop" },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}
