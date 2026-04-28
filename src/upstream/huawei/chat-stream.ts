/**
 * Streaming chat handler — SSE passthrough with OpenAI chunk wrapping.
 */

import { randomUUID } from "crypto";
import type { Response } from "express";
import { config } from "../../config";
import { getCredentials } from "../../auth/huawei/credentials";
import type { StoredHuaweiSession } from "../../auth/huawei/session-store";
import { UpstreamAuthError } from "../../utils/errors";
import { logger } from "../../utils/logger";
import type {
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionDelta,
} from "../../types/openai";
import { cleanToolCallDeltas } from "./chat-translate";
import { parseSSE } from "./chat-protocol";
import {
  buildRequestBody,
  buildChatHeaders,
  httpsPost,
  getLastResponseMessageId,
  setLastResponseMessageId,
  getChatIdRole,
} from "./chat-request";

export async function streamHuaweiChatToResponse(
  request: OpenAIChatCompletionRequest,
  session: StoredHuaweiSession,
  traceId: string,
  res: Response,
  signal?: AbortSignal,
): Promise<void> {
  const log = logger.withTrace(traceId);
  const credentials = getCredentials(session);
  const chatUrl = `${config.huaweiChatHost}/v1/chat/chat`;
  const { body: requestBody, json: body } = buildRequestBody(request, session);
  const headers = buildChatHeaders(chatUrl, body, credentials, traceId);

  // ── Outgoing request log ──────────────────────────────────────────────────
  const tp = requestBody.task_parameters as Record<string, unknown> | undefined;
  const toolResultCount = Array.isArray(tp?.tool_result)
    ? (tp.tool_result as unknown[]).length
    : 0;
  const msgArr = requestBody.messages as unknown[];
  const envDetails = tp?.environmentDetails as Record<string, unknown> | undefined;

  log.info("[proxy→codearts] REQUEST", {
    url: `POST ${chatUrl}`,
    model_id: requestBody.model_id,
    chat_id: requestBody.chat_id,
    parent_message_id: requestBody.parent_message_id,
    messagesCount: msgArr.length,
    toolResultCount,
    isSubAgent: (tp?.isSubAgent as boolean | undefined) ?? false,
    cwd: envDetails?.currentWorkingDirectory ?? "",
  });
  log.debug("[proxy→codearts] body (full)", { body });

  // ── Continuity info ───────────────────────────────────────────────────────
  if (!request.codearts?.chat_id) {
    log.info("chat_id derived from message hash", { chat_id: requestBody.chat_id });
  }
  if (!request.codearts?.parent_message_id && requestBody.parent_message_id) {
    log.info("parent_message_id auto-filled from last turn", { parent_message_id: requestBody.parent_message_id });
  }
  if (toolResultCount > 0 && !requestBody.parent_message_id) {
    log.warn("tool_result continuation but parent_message_id is empty — CodeArts may lack context");
  }

  // ── Tool continuation parent_message_id validation ────────────────────────
  if (toolResultCount > 0 && requestBody.parent_message_id) {
    const cid = requestBody.chat_id as string;
    const role = getChatIdRole(cid);
    if (role === "sub") {
      log.warn("Tool continuation for chat_id but last known role was sub — parent_message_id may point to sub-agent turn", { chat_id: cid });
    }
    const toolResults = tp?.tool_result as Array<Record<string, unknown>> | undefined;
    if (toolResults) {
      const toolCallIds = toolResults.map((tr) => tr.toolCallId ?? "(none)").join(", ");
      log.info("Tool continuation", { chat_id: cid, parent_message_id: requestBody.parent_message_id, toolCallIds, role: role ?? "unknown" });
    }
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

  // ── SSE event counters ────────────────────────────────────────────────────
  let sseEventCount = 0;
  let sseTextChars = 0;
  let sseToolCallCount = 0;
  let sseHadError = false;
  const sseDebugLog: Array<{ event: number; delta?: string; error?: string; meta?: string }> = [];

  for await (const event of parseSSE(stream)) {
    sseEventCount++;

    // Capture upstream session identifiers
    if (event.chat_id) responseMetadata.chat_id = event.chat_id;
    if (event.response_message_id)
      responseMetadata.response_message_id = event.response_message_id;
    if (event.request_message_id)
      responseMetadata.request_message_id = event.request_message_id;

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
      }

      // Build delta content
      const delta: OpenAIChatCompletionDelta = {};
      if (event.delta.content) delta.content = event.delta.content;
      if (event.delta.reasoning_content)
        delta.reasoning_content = event.delta.reasoning_content;
      const toolCallDeltas = cleanToolCallDeltas(event.delta.tool_calls);
      if (toolCallDeltas) {
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

  // ── Update parent_message_id tracker ──────────────────────────────────────
  if (!sseHadError && responseMetadata.response_message_id) {
    const cid = responseMetadata.chat_id;
    if (cid) {
      const prevValue = getLastResponseMessageId(cid);
      const role = getChatIdRole(cid);
      setLastResponseMessageId(cid, responseMetadata.response_message_id);
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

  // ── Stream complete log ───────────────────────────────────────────────────
  log.info("[codearts→proxy→client] STREAM COMPLETE", {
    sse_events: sseEventCount,
    text_chars: sseTextChars,
    tool_calls: sseToolCallCount,
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
  res.write("data: [DONE]\n\n");
  res.end();
}
