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
import {
  CONVERSATION_ID_HEADER,
  applyConversationIdHeader,
  resolveConversationIdentity,
} from "../upstream/huawei/conversation-id";
import type { AuthContext } from "../store/api-key-store";
import { runMigrationLoop } from "../routing/migration-loop";
import { listUsableAccounts } from "../routing/candidate-pool";
import { UpstreamAuthError, UpstreamConcurrencyError, UpstreamContextLengthError, NoUsableAccountError } from "../utils/errors";
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

  // Check for cache refresh request
  const forceRefresh = req.query.refresh === "true";
  if (forceRefresh) {
    invalidateCache();
  }

  const traceId = getTraceId(req);

  // 用户级 Key：用候选集中首个可用账号的凭据获取模型列表；
  // 账号级 Key：沿用其绑定账号的凭据。
  let accountId: string;
  let session: StoredHuaweiSession | undefined;
  if (auth.kind === "aggregate") {
    const first = listUsableAccounts(auth.userId)[0];
    if (!first) {
      res
        .status(401)
        .json(
          createOpenAIError(
            "No usable provider account for this API key. " +
              "All bound accounts are revoked, invalid, or have no usable session.",
            "auth_error",
          ),
        );
      return;
    }
    accountId = first.accountId;
    session = first.session;
  } else {
    accountId = auth.providerAccountId;
    session = auth.session;
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

  if (!isChatCompletionRequest(req.body)) {
    res
      .status(400)
      .json(createOpenAIError("Invalid chat completion request body"));
    return;
  }

  const traceId = getTraceId(req);
  const log = logger.withTrace(traceId);
  const body = req.body as OpenAIChatCompletionRequest;

  // ── Stable conversation key ───────────────────────────────────────────────
  // 请求头 X-Conversation-Id 提供账号无关的稳定对话键；缺失或请求体已提供时安全降级。
  applyConversationIdHeader(body, req.header(CONVERSATION_ID_HEADER));

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
    provider_account: "(pending)",
    messagesCount: msgCount,
    lastMessage: `[${lastMsg?.role}] ${lastMsgPreview}`,
    codearts_chat_id: body.codearts?.chat_id ?? "(none)",
    codearts_conversation_id: body.codearts?.conversation_id ?? "(none)",
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
    void handleStreamingRequest(body, auth, traceId, res);
  } else {
    void handleNonStreamingRequest(body, auth, traceId, res);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers with auto-refresh-on-401 retry
// ---------------------------------------------------------------------------

async function handleStreamingRequest(
  request: OpenAIChatCompletionRequest,
  auth: AuthContext,
  traceId: string,
  res: Response,
): Promise<void> {
  await runWithMigration(request, auth, traceId, res, async (session, _keyId, signal) => {
    await streamHuaweiChatToResponse(request, session, traceId, res, signal);
  });
}

async function handleNonStreamingRequest(
  request: OpenAIChatCompletionRequest,
  auth: AuthContext,
  traceId: string,
  res: Response,
): Promise<void> {
  await runWithMigration(request, auth, traceId, res, async (session, _keyId, signal) => {
    const response = await sendHuaweiChatRequest(request, session, traceId, signal);
    res.json(response);
  });
}

/**
 * 按路由计划执行请求，并在可迁移失败时换账号重试。
 *
 * - 账号由路由器按分配策略选定；每个账号在一次请求内**至多尝试一次**；
 * - 跨账号迁移发生在上游层**同账号重试耗尽之后**（上游层策略不变）；
 * - 迁移前先对凭证失效做一次刷新重试，刷新后仍失败才换账号；
 * - 换下的账号进入冷却，后续请求不再选它。
 */
async function runWithMigration(
  request: OpenAIChatCompletionRequest,
  auth: AuthContext,
  traceId: string,
  res: Response,
  attempt: (
    session: StoredHuaweiSession,
    keyId: string,
    signal: AbortSignal,
  ) => Promise<void>,
): Promise<void> {
  const log = logger.withTrace(traceId);
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) {
      ac.abort();
      log.info("Client disconnected, cancelling upstream request");
    }
  });

  await runMigrationLoop({
    auth,
    conversationId: resolveConversationIdentity(request).conversationId,
    signal: ac.signal,
    attempt: (target, signal) => attempt(target.session, target.keyId, signal),
    refresh: (target) =>
      tryRefreshSession(target.keyId, traceId, target.accountId),
    responseStarted: () => res.headersSent,
    onFinalError: (error) => sendErrorResponse(res, error),
    onMigrate: (info) =>
      log.warn("[routing] migrating to another account", {
        provider_account: info.fromAccountId,
        cause: info.cause,
        attempted_accounts: info.attempted,
      }),
    onAuthRefresh: (target, httpStatus) =>
      log.info("Auth error, refreshing credentials", {
        httpStatus,
        provider_account: target.accountId,
      }),
    onRefreshRetryFailed: (error) =>
      log.error("Retry after refresh also failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
  });
}

async function tryRefreshSession(
  keyId: string,
  traceId: string,
  accountId?: string,
): Promise<StoredHuaweiSession | undefined> {
  const log = logger.withTrace(traceId);
  try {
    const refreshed = await refreshStoredSession(keyId, accountId);
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

export function sendErrorResponse(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (!res.headersSent) {
    if (error instanceof UpstreamConcurrencyError) {
      const retryAfterSeconds = Math.max(1, Math.ceil(error.retryAfterMs / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res
        .status(429)
        .json(
          createOpenAIError(
            `Chat request failed: ${message}`,
            "rate_limit_error",
            "upstream_concurrency_limit",
          ),
        );
      return;
    }
    if (error instanceof UpstreamContextLengthError) {
      res
        .status(400)
        .json(
          createOpenAIError(
            `Chat request failed: ${message}`,
            "invalid_request_error",
            "context_length_exceeded",
          ),
        );
      return;
    }
    const statusCode =
      error instanceof UpstreamAuthError || error instanceof NoUsableAccountError
        ? 401
        : 502;
    const errorType =
      error instanceof UpstreamAuthError || error instanceof NoUsableAccountError
        ? "auth_error"
        : "upstream_error";
    res
      .status(statusCode)
      .json(createOpenAIError(`Chat request failed: ${message}`, errorType));
  } else {
    // SSE already started — 上下文超限用标准 error 事件下发，其余仍用文本 chunk
    const errorBody =
      error instanceof UpstreamContextLengthError
        ? createOpenAIError(
            `Chat request failed: ${message}`,
            "invalid_request_error",
            "context_length_exceeded",
          )
        : createOpenAIError(`[Error: ${message}]`, "upstream_error");
    res.write(`data: ${JSON.stringify(errorBody)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
}
