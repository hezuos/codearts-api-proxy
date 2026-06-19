/**
 * Chat request body construction and HTTP transport.
 */

import { randomUUID, createHash } from "crypto";
import https from "https";
import { config, upstreamTimeoutMs } from "../../config";
import { getProviderAccount } from "../../auth/store";
import { signRequest, type SigningCredentials } from "../../auth/huawei/credentials";
import type { StoredHuaweiSession } from "../../auth/huawei/session-store";
import { UpstreamTimeoutError } from "../../utils/errors";
import { logger } from "../../utils/logger";
import type { OpenAIChatCompletionRequest, OpenAIChatMessage } from "../../types/openai";
import { extractUserMessage, extractToolResults, resolveTools, normalizeMessageContent } from "./chat-translate";

// ---------------------------------------------------------------------------
// Model mapping
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL_ID = "GLM-5.1";

export const MODEL_MAP: Record<string, string> = {
  "glm-5.1": "GLM-5.1",
  "GLM-5.1": "GLM-5.1",
};

function resolveModelId(request: OpenAIChatCompletionRequest): string {
  const override = request.codearts?.model_id?.trim();
  if (override) return override;
  return (
    MODEL_MAP[request.model.toLowerCase()] ?? request.model ?? DEFAULT_MODEL_ID
  );
}

// ---------------------------------------------------------------------------
// In-memory parent_message_id tracker (with TTL eviction)
// ---------------------------------------------------------------------------

const TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

const lastResponseMessageId = new Map<string, string>();
const lastResponseMessageTs = new Map<string, number>();

const chatIdRole = new Map<string, "main" | "sub">();

// Periodic TTL cleanup
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of lastResponseMessageTs) {
    if (now - ts > TTL_MS) {
      lastResponseMessageId.delete(key);
      lastResponseMessageTs.delete(key);
      chatIdRole.delete(key);
    }
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

export function getLastResponseMessageId(chatId: string): string | undefined {
  return lastResponseMessageId.get(chatId);
}

export function setLastResponseMessageId(chatId: string, messageId: string): void {
  lastResponseMessageId.set(chatId, messageId);
  lastResponseMessageTs.set(chatId, Date.now());
}

export function getChatIdRole(chatId: string): "main" | "sub" | undefined {
  return chatIdRole.get(chatId);
}

export function setChatIdRole(chatId: string, role: "main" | "sub"): void {
  chatIdRole.set(chatId, role);
}

// ---------------------------------------------------------------------------
// Conversation ID derivation
// ---------------------------------------------------------------------------

function deriveConversationId(
  messages: OpenAIChatMessage[],
  providerAccountId: string,
): string {
  // Include system prompt in fingerprint to distinguish different opencode sessions.
  // opencode's system prompt contains session/project/working-directory info,
  // so different processes naturally produce different fingerprints even when
  // sharing the same API key and sending similar first user messages.
  const systemMsg = messages.find((m) => m.role === "system");
  const firstUserMsg = messages.find((m) => m.role === "user");
  if (!systemMsg && !firstUserMsg) return randomUUID().replace(/-/g, "");
  const systemContent = systemMsg ? normalizeMessageContent(systemMsg.content) : "";
  const userContent = firstUserMsg ? normalizeMessageContent(firstUserMsg.content) : "";
  return createHash("sha256")
    .update(`${providerAccountId}:${systemContent}:${userContent}`)
    .digest("hex")
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// Request body construction
// ---------------------------------------------------------------------------

function buildTaskParameters(
  request: OpenAIChatCompletionRequest,
  tools: ReturnType<typeof resolveTools>,
): Record<string, unknown> {
  const subAgent = request.codearts?.sub_agent;
  const toolResults = extractToolResults(request);
  const isToolContinuation = toolResults.length > 0;

  // tool continuation: 只传 tool_result（和 spec 一致），其余字段由 CodeArts 从上下文获取
  if (isToolContinuation) {
    return { tool_result: toolResults };
  }

  const params: Record<string, unknown> = {
    codebase_search: request.codearts?.codebase_search ?? false,
    preferred_language: request.codearts?.preferred_language?.trim() || "zh-cn",
    enable_code_interpreter: request.codearts?.enable_code_interpreter ?? false,
    projectLevelPrompt: request.codearts?.project_level_prompt ?? "",
    isSubAgent: !!subAgent,
    tools,
    environmentDetails: {
      osVersion: request.codearts?.os_version?.trim() || "win32",
      currentDate: new Date().toISOString().replace("Z", ""),
      currentWorkingDirectory:
        request.codearts?.current_working_directory?.trim() ||
        request.codearts?.workspace_root?.trim() ||
        "",
    },
    routerVersion: "v2",
    isNewClient: true,
    features: { support_end_tag: true },
    ide: "CodeArts Agent",
    contexts: request.codearts?.contexts ?? [],
    expert_rules: request.codearts?.expert_rules ?? [],
  };

  if (toolResults.length > 0) {
    params.tool_result = toolResults;
  }

  if (subAgent) {
    params.subAgent_type = subAgent.type;
    params.subAgent_prompt = subAgent.prompt ?? "";
  }

  return params;
}

export function buildRequestBody(
  request: OpenAIChatCompletionRequest,
  session: StoredHuaweiSession,
): { body: Record<string, unknown>; json: string } {
  const toolResults = extractToolResults(request);
  const isToolContinuation = toolResults.length > 0;
  const subAgent = request.codearts?.sub_agent;

  const tools = resolveTools(request);
  const modelId = resolveModelId(request);

  const chatId =
    request.codearts?.chat_id?.trim() || deriveConversationId(request.messages, session.providerAccountId);

  // Sub-agent / main-agent chat_id collision detection
  const currentRole = subAgent ? "sub" : "main";
  const previousRole = getChatIdRole(chatId);
  setChatIdRole(chatId, currentRole);

  if (previousRole && previousRole !== currentRole) {
    logger.warn("CHAT_ID COLLISION", {
      chat_id: chatId,
      previousRole,
      currentRole,
    });
  } else if (subAgent) {
    logger.info("Sub-agent request", { chat_id: chatId, previousRole: previousRole ?? "none" });
  } else if (isToolContinuation) {
    logger.info("Main-agent tool continuation", {
      chat_id: chatId,
      previousRole: previousRole ?? "none",
      lastResponseMessageId: getLastResponseMessageId(chatId) ?? "(none)",
    });
  }

  const parentMessageId =
    request.codearts?.parent_message_id ??
    getLastResponseMessageId(chatId) ??
    "";

  const providerAccount = getProviderAccount(session.providerAccountId);
  const userId =
    providerAccount?.providerUserName?.trim() ||
    providerAccount?.providerUserId?.trim() ||
    session.providerAccountId;

  // 对于非内置工具，把 tool result 内容合并到用户消息中
  // CodeArts 无法处理非内置工具的 tool_result，直接以文本形式发送
  let messagesBody: unknown[];
  if (isToolContinuation) {
    messagesBody = [];
  } else {
    const userMsg = extractUserMessage(request.messages);
    const lastMsg = request.messages[request.messages.length - 1];
    // 如果最后一条是 tool 消息（非内置工具的 result），追加到用户消息中
    if (lastMsg?.role === "tool" && lastMsg.content) {
      const toolContent = normalizeMessageContent(lastMsg.content);
      if (toolContent) {
        const combined = userMsg
          ? `${userMsg}\n\n[工具执行结果]\n${toolContent}`
          : `[工具执行结果]\n${toolContent}`;
        messagesBody = [{ type: "text", content: combined }];
      } else {
        messagesBody = [{ type: "text", content: userMsg || "[工具执行结果为空]" }];
      }
    } else {
      messagesBody = [{ type: "text", content: userMsg }];
    }
  }

  const body: Record<string, unknown> = {
    chat_id: chatId,
    messages: messagesBody,
    client: "IDE",
    task: "plan-execute",
    task_parameters: buildTaskParameters(request, tools),
    batch_task_parameters: [],
    attempt: 1,
    user_id: userId,
    agent_id: "CodeAgent",
    parent_message_id: parentMessageId,
    is_delta_response: true,
    model_id: modelId,
  };

  return { body, json: JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// HTTP / SSE transport
// ---------------------------------------------------------------------------

export function buildChatHeaders(
  chatUrl: string,
  body: string,
  credentials: SigningCredentials,
  traceId: string,
): Record<string, string> {
  const extra: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Agent-Type": "ChatAgent",
    "X-Language": "zh-CN",
    "x-snap-traceid": traceId,
    client_version: config.pluginVersion,
    "plugin-name": "codearts-snap_vscode",
    "plugin-version": config.pluginVersion,
    "ide-name": "CodeArts Agent",
    "ide-version": config.ideVersion,
    is_confidential: "false",
    "heartbeat-enable": "true",
  };

  const signed = signRequest(
    {
      method: "POST",
      url: chatUrl,
      headers: { "Content-Type": "application/json" },
      body,
    },
    credentials,
  );

  return { ...extra, ...signed };
}

export function httpsPost(
  urlStr: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
): Promise<{ status: number; stream: AsyncIterable<string> }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request aborted before start"));
      return;
    }

    const url = new URL(urlStr);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        signal,
      },
      (res) => {
        res.setEncoding("utf8");
        const iter: AsyncIterable<string> = {
          [Symbol.asyncIterator]() {
            let buf = "";
            let done = false;
            let streamError: Error | null = null;
            const pending: Array<{
              resolve: (v: IteratorResult<string>) => void;
            }> = [];
            const lines: string[] = [];

            function flush() {
              while (pending.length > 0 && lines.length > 0) {
                pending
                  .shift()!
                  .resolve({ value: lines.shift()!, done: false });
              }
              if (done) {
                while (pending.length > 0) {
                  pending.shift()!.resolve({ value: "", done: true });
                }
              }
            }

            res.on("data", (chunk: string) => {
              buf += chunk;
              const parts = buf.split("\n");
              buf = parts.pop() ?? "";
              for (const line of parts) lines.push(line);
              flush();
            });
            res.on("end", () => {
              if (buf) {
                lines.push(buf);
                buf = "";
              }
              done = true;
              flush();
            });
            res.on("error", (err: Error) => {
              streamError = err;
              done = true;
              flush();
            });

            return {
              next() {
                if (lines.length > 0)
                  return Promise.resolve({
                    value: lines.shift()!,
                    done: false,
                  });
                if (done) {
                  if (streamError) return Promise.reject(streamError);
                  return Promise.resolve({ value: "", done: true as const });
                }
                return new Promise<IteratorResult<string>>((resolve) => {
                  pending.push({ resolve });
                });
              },
            };
          },
        };
        resolve({ status: res.statusCode ?? 0, stream: iter });
      },
    );
    req.on("error", reject);
    req.setTimeout(upstreamTimeoutMs, () => {
      req.destroy();
      reject(new UpstreamTimeoutError(urlStr, upstreamTimeoutMs));
    });
    req.write(body);
    req.end();
  });
}
