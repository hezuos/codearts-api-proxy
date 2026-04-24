/**
 * Chat request body construction and HTTP transport.
 */

import { randomUUID, createHash } from "crypto";
import https from "https";
import { config } from "../../config";
import { getProviderAccount } from "../../auth/store";
import { signRequest, type SigningCredentials } from "../../auth/huawei/credentials";
import type { StoredHuaweiSession } from "../../auth/huawei/session-store";
import { UpstreamTimeoutError } from "../../utils/errors";
import type { OpenAIChatCompletionRequest, OpenAIChatMessage } from "../../types/openai";
import { extractUserMessage, extractToolResults, resolveTools, normalizeMessageContent } from "./chat-translate";

// ---------------------------------------------------------------------------
// Model mapping
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL_ID = "Glm-4.7-internal";

export const MODEL_MAP: Record<string, string> = {
  "gpt-4": DEFAULT_MODEL_ID,
  "gpt-4o": DEFAULT_MODEL_ID,
  "gpt-3.5-turbo": DEFAULT_MODEL_ID,
  "glm-4.7": DEFAULT_MODEL_ID,
  "glm-4.7-internal": "Glm-4.7-internal",
  "glm-5": "Glm-5-internal",
  "glm-5-internal": "Glm-5-internal",
  "glm-5.1": "GLM-5.1",
  "deepseek-v3.2": "deepseek-v3.2"
};

function resolveModelId(request: OpenAIChatCompletionRequest): string {
  const override = request.codearts?.model_id?.trim();
  if (override) return override;
  return (
    MODEL_MAP[request.model.toLowerCase()] ?? request.model ?? DEFAULT_MODEL_ID
  );
}

// ---------------------------------------------------------------------------
// In-memory parent_message_id tracker
// ---------------------------------------------------------------------------

const lastResponseMessageId = new Map<string, string>();

const chatIdRole = new Map<string, "main" | "sub">();

export function getLastResponseMessageId(chatId: string): string | undefined {
  return lastResponseMessageId.get(chatId);
}

export function setLastResponseMessageId(chatId: string, messageId: string): void {
  lastResponseMessageId.set(chatId, messageId);
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

function deriveConversationId(messages: OpenAIChatMessage[]): string {
  const firstMsg =
    messages.find((m) => m.role === "user") ??
    messages.find((m) => m.role === "system");
  if (!firstMsg) return randomUUID().replace(/-/g, "");
  const content = normalizeMessageContent(firstMsg.content);
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Request body construction
// ---------------------------------------------------------------------------

function buildTaskParameters(
  request: OpenAIChatCompletionRequest,
  tools: ReturnType<typeof resolveTools>,
): Record<string, unknown> {
  const subAgent = request.codearts?.sub_agent;
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

  const toolResults = extractToolResults(request);
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
): string {
  const toolResults = extractToolResults(request);
  const isToolContinuation = toolResults.length > 0;
  const subAgent = request.codearts?.sub_agent;

  const tools = resolveTools(request);
  const modelId = resolveModelId(request);

  const chatId =
    request.codearts?.chat_id?.trim() || deriveConversationId(request.messages);

  // Sub-agent / main-agent chat_id collision detection
  const currentRole = subAgent ? "sub" : "main";
  const previousRole = getChatIdRole(chatId);
  setChatIdRole(chatId, currentRole);

  if (previousRole && previousRole !== currentRole) {
    console.warn(
      `⚠ CHAT_ID COLLISION: chat_id=${chatId} was previously used by ${previousRole}-agent ` +
      `but now used by ${currentRole}-agent! ` +
      `lastResponseMessageId for this chat_id may be corrupted. ` +
      `This likely causes "Tool messages must be a response to a preceding tool calls" errors.`,
    );
  } else if (subAgent) {
    console.log(
      `ℹ Sub-agent request using chat_id=${chatId} (previousRole=${previousRole ?? "none"})`,
    );
  } else if (isToolContinuation) {
    console.log(
      `ℹ Main-agent tool continuation using chat_id=${chatId} (previousRole=${previousRole ?? "none"}, ` +
      `lastResponseMessageId=${getLastResponseMessageId(chatId) ?? "(none)"})`,
    );
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

  const body: Record<string, unknown> = {
    chat_id: chatId,
    messages: isToolContinuation
      ? []
      : [{ type: "text", content: extractUserMessage(request.messages) }],
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

  return JSON.stringify(body);
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
): Promise<{ status: number; stream: AsyncIterable<string> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        res.setEncoding("utf8");
        const iter: AsyncIterable<string> = {
          [Symbol.asyncIterator]() {
            let buf = "";
            let done = false;
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
            res.on("error", () => {
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
                if (done)
                  return Promise.resolve({ value: "", done: true as const });
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
    req.setTimeout(120_000, () => {
      req.destroy();
      reject(new UpstreamTimeoutError(urlStr, 120_000));
    });
    req.write(body);
    req.end();
  });
}
