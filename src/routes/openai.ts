import type { Request, Response } from "express";
import {
  getSession,
  refreshStoredSession,
  type StoredHuaweiSession,
} from "../auth/huawei/session-store";
import { getProviderAccount, listProviderAccounts } from "../auth/store";
import { getRequestAuth } from "../middleware/authenticate-api-key";
import { getTraceId } from "../middleware/request-context";
import type { OpenAIChatCompletionRequest } from "../types/openai";
import { buildModelsResponse } from "../translation/openai-mock";
import {
  sendHuaweiChatRequest,
  streamHuaweiChatToResponse,
  UpstreamAuthError,
} from "../upstream/huawei/chat";
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

  // Resolve provider account (same logic as chat completions)
  let providerAccount = auth.providerAccountId
    ? getProviderAccount(auth.providerAccountId)
    : undefined;
  if (!providerAccount) {
    const accounts = listProviderAccounts(auth.userId);
    providerAccount = accounts.find((a) => a.isDefault) ?? accounts[0];
  }
  if (!providerAccount) {
    res
      .status(400)
      .json(createOpenAIError("Provider account not found", "auth_error"));
    return;
  }

  const traceId = getTraceId(req);
  const accountId = providerAccount.id;

  // Get session for AK/SK signing
  const session = getSession(accountId);
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
    invalidateCache(accountId);
  }

  try {
    const models = await getModelList(accountId, session, traceId, forceRefresh);
    res.json(buildModelsResponse(models));
  } catch (error) {
    // Fallback: return static models on any error
    console.error(
      `[${traceId}] Model list fetch failed, returning static models:`,
      error instanceof Error ? error.message : error,
    );
    res.json(buildModelsResponse());
  }
}

export function createChatCompletion(req: Request, res: Response): void {
  const auth = getRequestAuth(req);

  // Resolve provider account: use the one bound to the API key,
  // or fall back to the user's default account
  let providerAccount = auth.providerAccountId
    ? getProviderAccount(auth.providerAccountId)
    : undefined;
  if (!providerAccount) {
    const accounts = listProviderAccounts(auth.userId);
    providerAccount = accounts.find((a) => a.isDefault) ?? accounts[0];
  }
  if (!providerAccount) {
    res
      .status(400)
      .json(createOpenAIError("Provider account not found", "auth_error"));
    return;
  }

  if (!isChatCompletionRequest(req.body)) {
    res
      .status(400)
      .json(createOpenAIError("Invalid chat completion request body"));
    return;
  }

  const traceId = getTraceId(req);
  const accountId = providerAccount.id;
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

  console.log(
    `[${traceId}] ── INCOMING REQUEST ──────────────────────────────────`,
  );
  console.log(`[${traceId}]   model          : ${body.model}`);
  console.log(`[${traceId}]   stream         : ${!!body.stream}`);
  console.log(`[${traceId}]   provider_account: ${accountId}`);
  console.log(`[${traceId}]   messages.count : ${msgCount}`);
  console.log(
    `[${traceId}]   last_message   : [${lastMsg?.role}] ${lastMsgPreview}`,
  );
  if (body.codearts) {
    console.log(
      `[${traceId}]   codearts.chat_id          : ${body.codearts.chat_id ?? "(none)"}`,
    );
    console.log(
      `[${traceId}]   codearts.parent_message_id: ${body.codearts.parent_message_id ?? "(none)"}`,
    );
    if (body.codearts.tool_results?.length) {
      console.log(
        `[${traceId}]   codearts.tool_results.count: ${body.codearts.tool_results.length}`,
      );
    }
    if (body.codearts.sub_agent) {
      console.log(
        `[${traceId}]   codearts.sub_agent: type=${body.codearts.sub_agent.type}`,
      );
    }
  }
  console.log(`[${traceId}]   body (full):\n${JSON.stringify(req.body)}`);
  console.log(
    `[${traceId}] ──────────────────────────────────────────────────────`,
  );

  const session = getSession(accountId);
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

  if (req.body.stream) {
    void handleStreamingRequest(body, accountId, traceId, res);
  } else {
    void handleNonStreamingRequest(body, accountId, traceId, res);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers with auto-refresh-on-401 retry
// ---------------------------------------------------------------------------

async function handleStreamingRequest(
  request: OpenAIChatCompletionRequest,
  accountId: string,
  traceId: string,
  res: Response,
): Promise<void> {
  const session = getSession(accountId)!;
  try {
    await streamHuaweiChatToResponse(request, session, traceId, res);
  } catch (error) {
    if (error instanceof UpstreamAuthError && !res.headersSent) {
      // Attempt to refresh credentials and retry once
      console.log(
        `[${traceId}] Auth error (${error.httpStatus}), refreshing credentials...`,
      );
      const refreshed = await tryRefreshSession(accountId, traceId);
      if (refreshed) {
        try {
          await streamHuaweiChatToResponse(request, refreshed, traceId, res);
          return;
        } catch (retryError) {
          console.error(
            `[${traceId}] Retry after refresh also failed:`,
            retryError,
          );
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
  accountId: string,
  traceId: string,
  res: Response,
): Promise<void> {
  const session = getSession(accountId)!;
  try {
    const response = await sendHuaweiChatRequest(request, session, traceId);
    res.json(response);
  } catch (error) {
    if (error instanceof UpstreamAuthError) {
      console.log(
        `[${traceId}] Auth error (${error.httpStatus}), refreshing credentials...`,
      );
      const refreshed = await tryRefreshSession(accountId, traceId);
      if (refreshed) {
        try {
          const response = await sendHuaweiChatRequest(
            request,
            refreshed,
            traceId,
          );
          res.json(response);
          return;
        } catch (retryError) {
          console.error(
            `[${traceId}] Retry after refresh also failed:`,
            retryError,
          );
          sendErrorResponse(res, retryError, request.model);
          return;
        }
      }
    }
    sendErrorResponse(res, error, request.model);
  }
}

async function tryRefreshSession(
  accountId: string,
  traceId: string,
): Promise<StoredHuaweiSession | undefined> {
  try {
    const refreshed = await refreshStoredSession(accountId);
    if (refreshed?.accessKey && refreshed?.secretKeyCiphertext) {
      console.log(`[${traceId}] Credentials refreshed successfully`);
      return refreshed;
    }
    console.warn(`[${traceId}] Refresh returned incomplete session`);
    return undefined;
  } catch (refreshError) {
    console.error(`[${traceId}] Credential refresh failed:`, refreshError);
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
