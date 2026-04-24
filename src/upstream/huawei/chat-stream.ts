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
} from "../../types/openai";
import { mapToolCallDeltas } from "./chat-translate";
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
): Promise<void> {
  const log = logger.withTrace(traceId);
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
  const envDetails = tp?.environmentDetails as Record<string, unknown> | undefined;

  log.info("OUTGOING REQUEST → CodeArts", {
    url: `POST ${chatUrl}`,
    model_id: parsedBody.model_id,
    chat_id: parsedBody.chat_id,
    parent_message_id: parsedBody.parent_message_id,
    messagesCount: msgArr.length,
    toolResultCount,
    isSubAgent: (tp?.isSubAgent as boolean | undefined) ?? false,
    cwd: envDetails?.currentWorkingDirectory ?? "",
  });
  log.debug("Outgoing body (full)", { body });

  // ── Continuity info ───────────────────────────────────────────────────────
  if (!request.codearts?.chat_id) {
    log.info("chat_id derived from message hash", { chat_id: parsedBody.chat_id });
  }
  if (!request.codearts?.parent_message_id && parsedBody.parent_message_id) {
    log.info("parent_message_id auto-filled from last turn", { parent_message_id: parsedBody.parent_message_id });
  }
  if (toolResultCount > 0 && !parsedBody.parent_message_id) {
    log.warn("tool_result continuation but parent_message_id is empty — CodeArts may lack context");
  }

  // ── Tool continuation parent_message_id validation ────────────────────────
  if (toolResultCount > 0 && parsedBody.parent_message_id) {
    const cid = parsedBody.chat_id as string;
    const role = getChatIdRole(cid);
    if (role === "sub") {
      log.warn("Tool continuation for chat_id but last known role was sub — parent_message_id may point to sub-agent turn", { chat_id: cid });
    }
    const toolResults = tp?.tool_result as Array<Record<string, unknown>> | undefined;
    if (toolResults) {
      const toolCallIds = toolResults.map((tr) => tr.toolCallId ?? "(none)").join(", ");
      log.info("Tool continuation", { chat_id: cid, parent_message_id: parsedBody.parent_message_id, toolCallIds, role: role ?? "unknown" });
    }
  }

  const { status, stream } = await httpsPost(chatUrl, headers, body);

  // ── HTTP status log ───────────────────────────────────────────────────────
  log.info("CodeArts HTTP response", { status });

  if (status !== 200) {
    let errorBody = "";
    for await (const line of stream) errorBody += line;
    log.error("CodeArts error body", { status, body: errorBody.slice(0, 500) });
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
  const responseMetadata: Record<string, string | undefined> = {};

  // ── SSE event counters ────────────────────────────────────────────────────
  let sseEventCount = 0;
  let sseTextChars = 0;
  let sseToolCallCount = 0;
  let sseHadError = false;

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
      log.debug("SSE meta", { chat_id: event.chat_id, response_message_id: event.response_message_id, request_message_id: event.request_message_id });
    }

    // Log errors
    if (
      event.error_code &&
      event.error_code !== "0" &&
      event.error_code !== "ChatAgent.00000000"
    ) {
      sseHadError = true;
      log.error("SSE error from CodeArts", { code: event.error_code, msg: event.error_msg ?? "unknown" });
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
      if (event.delta.tool_calls && event.delta.tool_calls.length > 0) {
        for (const tc of event.delta.tool_calls) {
          const hasIdentity =
            (tc.id && tc.id !== "-") || (tc.function?.name ?? tc.name);
          if (hasIdentity) {
            sseToolCallCount++;
            log.debug("SSE tool_call", { id: tc.id, name: tc.function?.name ?? tc.name });
          }
        }
      }
      if (event.delta.content) {
        sseTextChars += event.delta.content.length;
      }

      if (!sentRole && event.delta.role) {
        const role = [
          "assistant",
          "user",
          "system",
          "tool",
          "function",
        ].includes(event.delta.role)
          ? (event.delta
              .role as OpenAIChatCompletionChunk["choices"][number]["delta"]["role"])
          : "assistant";
        res.write(
          `data: ${JSON.stringify({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            codearts: { ...responseMetadata },
            choices: [{ index: 0, delta: { role }, finish_reason: null }],
          } satisfies OpenAIChatCompletionChunk)}\n\n`,
        );
        sentRole = true;
      }

      const delta: OpenAIChatCompletionChunk["choices"][number]["delta"] = {};
      if (event.delta.content) delta.content = event.delta.content;
      if (event.delta.reasoning_content)
        delta.reasoning_content = event.delta.reasoning_content;
      const toolCallDeltas = mapToolCallDeltas(event.delta.tool_calls);
      if (toolCallDeltas) delta.tool_calls = toolCallDeltas;

      if (Object.keys(delta).length > 0) {
        res.write(
          `data: ${JSON.stringify({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            codearts: { ...responseMetadata },
            choices: [{ index: 0, delta, finish_reason: null }],
          } satisfies OpenAIChatCompletionChunk)}\n\n`,
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
  log.info("STREAM COMPLETE", {
    sse_events: sseEventCount,
    text_chars: sseTextChars,
    tool_calls: sseToolCallCount,
    response_message_id: responseMetadata.response_message_id ?? "(none)",
    chat_id: responseMetadata.chat_id ?? "(none)",
  });

  res.write(
    `data: ${JSON.stringify({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      codearts: { ...responseMetadata },
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    } satisfies OpenAIChatCompletionChunk)}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}
