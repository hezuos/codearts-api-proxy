import type { Request, Response } from "express";
import {
  refreshStoredSession,
  type StoredHuaweiSession,
} from "../auth/huawei/session-store";
import { getRequestAuth } from "../middleware/authenticate-api-key";
import { getTraceId } from "../middleware/request-context";
import type { OpenAIChatCompletionRequest } from "../types/openai";
import { buildModelsResponse } from "../translation/openai-mock";
import {
  sendHuaweiChatRequest,
  streamHuaweiChatToResponse,
} from "../upstream/huawei/chat";
import { UpstreamAuthError } from "../utils/errors";
import { logger } from "../utils/logger";
import {
  getModelList,
  invalidateCache,
} from "../upstream/huawei/models";
import { createOpenAIError } from "../utils/openai-error";

function isChatCompletionRequest(
  value: unknown,
): value is OpenAIChatCompletionRequest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const request = value as Partial<OpenAIChatCompletionRequest>;
  return typeof request.model === "string" && Array.isArray(request.messages);
}

export async function listModels(req: Request, res: Response): Promise<void> {
  const auth = getRequestAuth(req);
  const session = auth.session;
  const accountId = auth.providerAccountId;

  if (!session?.accessKey || !session?.secretKeyCiphertext) {
    res
      .status(401)
      .json(
        createOpenAIError(
          "No active Huawei Cloud session. Please authenticate first.",
          "auth_error",
        ),
      );
    return;
  }

  // Check for cache refresh request
  const forceRefresh = req.query.refresh === "true";
  if (forceRefresh) {
    invalidateCache();
  }

  const traceId = getTraceId(req);

  try {
    const models = await getModelList(accountId, session, traceId, forceRefresh);
    res.json(buildModelsResponse(models));
  } catch (error) {
    logger.withTrace(traceId).error("Model list fetch failed, returning static models", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.json(buildModelsResponse());
  }
}

export function createChatCompletion(req: Request, res: Response): void {
  const auth = getRequestAuth(req);
  const session = auth.session;
  const accountId = auth.providerAccountId;

  if (!isChatCompletionRequest(req.body)) {
    res
      .status(400)
      .json(createOpenAIError("Invalid chat completion request body"));
    return;
  }

  if (!session?.accessKey || !session?.secretKeyCiphertext) {
    res
      .status(401)
      .json(
        createOpenAIError(
          "No active Huawei Cloud session. Please authenticate first.",
          "auth_error",
        ),
      );
    return;
  }

  const traceId = getTraceId(req);
  const log = logger.withTrace(traceId);
  const body = req.body as OpenAIChatCompletionRequest;

  // ── Incoming request log ──────────────────────────────────────────────────
  const msgCount = body.messages?.length ?? 0;
  const lastMsg = body.messages?.[msgCount - 1];
  const lastMsgPreview =
    typeof lastMsg?.content === "string"
      ? lastMsg.content.slice(0, 120).replace(/\n/g, "\\n")
      : lastMsg?.role === "tool"
        ? `[tool result id=${lastMsg.tool_call_id}]`
        : lastMsg?.tool_calls
          ? `[tool_calls count=${lastMsg.tool_calls.length}]`
          : "(empty)";

  log.info("[client→proxy] REQUEST", {
    model: body.model,
    stream: !!body.stream,
    provider_account: accountId,
    messagesCount: msgCount,
    lastMessage: `[${lastMsg?.role}] ${lastMsgPreview}`,
    codearts_chat_id: body.codearts?.chat_id ?? "(none)",
    codearts_parent_message_id: body.codearts?.parent_message_id ?? "(none)",
    codearts_tool_results_count: body.codearts?.tool_results?.length ?? 0,
    codearts_sub_agent_type: body.codearts?.sub_agent?.type,
  });
  log.debug("[client→proxy] body (full)", { body: req.body });

  // ── Tool-specific debug logs ──────────────────────────────────────────────
  if (body.tools?.length) {
    log.debug("[client→proxy] tools", {
      count: body.tools.length,
      names: body.tools.map((t) => t.function?.name ?? "(unnamed)"),
    });
  }
  const toolMessages = body.messages?.filter((m) => m.role === "tool") ?? [];
  if (toolMessages.length > 0) {
    log.debug("[client→proxy] tool messages", {
      count: toolMessages.length,
      details: toolMessages.map((m) => ({
        tool_call_id: m.tool_call_id,
        content_preview: typeof m.content === "string" ? m.content.slice(0, 200) : "(non-string)",
      })),
    });
  }
  const assistantWithTools = body.messages?.filter((m) => m.tool_calls?.length) ?? [];
  if (assistantWithTools.length > 0) {
    log.debug("[client→proxy] assistant tool_calls", {
      count: assistantWithTools.length,
      details: assistantWithTools.flatMap((m) =>
        (m.tool_calls ?? []).map((tc) => ({
          id: tc.id,
          name: tc.function?.name,
          arguments_preview: tc.function?.arguments?.slice(0, 200),
        }))
      ),
    });
  }

  if (req.body.stream) {
    void handleStreamingRequest(body, auth.session, auth.apiKeyId, traceId, res);
  } else {
    void handleNonStreamingRequest(body, auth.session, auth.apiKeyId, traceId, res);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers with auto-refresh-on-401 retry
// ---------------------------------------------------------------------------

async function handleStreamingRequest(
  request: OpenAIChatCompletionRequest,
  session: StoredHuaweiSession,
  keyId: string,
  traceId: string,
  res: Response,
): Promise<void> {
  const log = logger.withTrace(traceId);
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) {
      ac.abort();
      log.info("Client disconnected, cancelling upstream request");
    }
  });
  try {
    await streamHuaweiChatToResponse(request, session, traceId, res, ac.signal);
  } catch (error) {
    if (error instanceof UpstreamAuthError && !res.headersSent) {
      log.info("Auth error, refreshing credentials", { httpStatus: error.httpStatus });
      const refreshed = await tryRefreshSession(keyId, traceId);
      if (refreshed) {
        try {
          await streamHuaweiChatToResponse(request, refreshed, traceId, res, ac.signal);
          return;
        } catch (retryError) {
          log.error("Retry after refresh also failed", { error: retryError instanceof Error ? retryError.message : String(retryError) });
          sendErrorResponse(res, retryError, request.model);
          return;
        }
      }
    }
    sendErrorResponse(res, error, request.model);
  }
}

async function handleNonStreamingRequest(
  request: OpenAIChatCompletionRequest,
  session: StoredHuaweiSession,
  keyId: string,
  traceId: string,
  res: Response,
): Promise<void> {
  const log = logger.withTrace(traceId);
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) {
      ac.abort();
      log.info("Client disconnected, cancelling upstream request");
    }
  });
  try {
    const response = await sendHuaweiChatRequest(request, session, traceId, ac.signal);
    res.json(response);
  } catch (error) {
    if (error instanceof UpstreamAuthError) {
      log.info("Auth error, refreshing credentials", { httpStatus: error.httpStatus });
      const refreshed = await tryRefreshSession(keyId, traceId);
      if (refreshed) {
        try {
          const response = await sendHuaweiChatRequest(
            request,
            refreshed,
            traceId,
            ac.signal,
          );
          res.json(response);
          return;
        } catch (retryError) {
          log.error("Retry after refresh also failed", { error: retryError instanceof Error ? retryError.message : String(retryError) });
          sendErrorResponse(res, retryError, request.model);
          return;
        }
      }
    }
    sendErrorResponse(res, error, request.model);
  }
}

async function tryRefreshSession(
  keyId: string,
  traceId: string,
): Promise<StoredHuaweiSession | undefined> {
  const log = logger.withTrace(traceId);
  try {
    const refreshed = await refreshStoredSession(keyId);
    if (refreshed?.accessKey && refreshed?.secretKeyCiphertext) {
      log.info("Credentials refreshed successfully");
      return refreshed;
    }
    log.warn("Refresh returned incomplete session");
    return undefined;
  } catch (refreshError) {
    log.error("Credential refresh failed", { error: refreshError instanceof Error ? refreshError.message : String(refreshError) });
    return undefined;
  }
}

function sendErrorResponse(res: Response, error: unknown, model: string): void {
  const message = error instanceof Error ? error.message : String(error);
  if (!res.headersSent) {
    const statusCode = error instanceof UpstreamAuthError ? 401 : 502;
    const errorType =
      error instanceof UpstreamAuthError ? "auth_error" : "upstream_error";
    res
      .status(statusCode)
      .json(createOpenAIError(`Chat request failed: ${message}`, errorType));
  } else {
    // SSE already started — send error as a chunk then close
    const errChunk = {
      id: "chatcmpl-error",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: { content: `\n[Error: ${message}]` },
          finish_reason: null,
        },
      ],
    };
    res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
}
