/**
 * Huawei CodeArts Agent chat upstream.
 *
 * Responsibilities:
 *   - AK/SK signing + auth header injection
 *   - Minimal protocol adaptation: OpenAI ↔ CodeArts message format
 *   - SSE streaming passthrough with OpenAI chunk wrapping
 *
 * NOT our responsibility:
 *   - Conversation state (chat_id, parent_message_id) — caller provides these
 *   - Tool call ID tracking — caller maintains its own history
 *   - Any field that can be passed through from the caller
 */
import { randomUUID, createHash } from "crypto";
import https from "https";
import type { Response } from "express";
import { config } from "../../config";
import { getProviderAccount } from "../../auth/store";
import { decryptString } from "../../auth/crypto/encryption";
import { signRequest, type SigningCredentials } from "../../auth/huawei/sign";
import type { StoredHuaweiSession } from "../../auth/huawei/session-store";
import type {
  CodeArtsToolResult,
  OpenAIChatCompletion,
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
  OpenAIChatCompletionChunk,
  OpenAIToolCall,
  OpenAIToolCallDelta,
} from "../../types/openai";
import { DEFAULT_TOOLS, SUB_AGENT_TOOLS, type ToolDefinition } from "./tools";

export class UpstreamAuthError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly responseBody: string,
  ) {
    super(
      `CodeArts auth error (HTTP ${httpStatus}): ${responseBody.substring(0, 300)}`,
    );
    this.name = "UpstreamAuthError";
  }
}

interface CodeArtsDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: CodeArtsRawToolCall[] | null;
}

interface CodeArtsSSEEvent {
  // meta fields (first event)
  chat_id?: string;
  response_message_id?: string;
  request_message_id?: string;
  // delta fields
  delta?: CodeArtsDelta;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  error_code?: string;
  error_msg?: string;
}

interface CodeArtsRawToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  name?: string;
  arguments?: Record<string, unknown> | string;
}

// ---------------------------------------------------------------------------
// Model mapping
// ---------------------------------------------------------------------------

const DEFAULT_MODEL_ID = "Glm-4.7-internal";

const MODEL_MAP: Record<string, string> = {
  "gpt-4": DEFAULT_MODEL_ID,
  "gpt-4o": DEFAULT_MODEL_ID,
  "gpt-3.5-turbo": DEFAULT_MODEL_ID,
  "glm-4.7": DEFAULT_MODEL_ID,
  "glm-4.7-internal": "Glm-4.7-internal",
  "glm-5": "Glm-5-internal",
  "glm-5-internal": "Glm-5-internal",
  "glm-5.1": "GLM-5.1",
  "deepseek-r1": "deepseek-r1",
  "deepseek-v3.2": "deepseek-v3.2",
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

/**
 * Maps chat_id → last response_message_id.
 * Used to automatically fill parent_message_id when the caller does not
 * provide it (which is always the case for OpenCode).
 * Process-scoped; resets on restart (first turn of each conversation will
 * have parent_message_id="" which is correct for a fresh conversation).
 */
const lastResponseMessageId = new Map<string, string>();

// ---------------------------------------------------------------------------
// Conversation ID derivation
// ---------------------------------------------------------------------------

/**
 * Derive a stable chat_id from the first user/system message in the conversation.
 * This ensures all turns of the same conversation (including tool continuations)
 * map to the same chat_id, even when the caller does not provide one explicitly.
 */
function deriveConversationId(messages: OpenAIChatMessage[]): string {
  const firstMsg = messages.find(
    (m) => m.role === "user" || m.role === "system",
  );
  if (!firstMsg) return randomUUID().replace(/-/g, "");
  const content = normalizeMessageContent(firstMsg.content);
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Request body construction
// ---------------------------------------------------------------------------

function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const text = Reflect.get(item, "text");
          if (typeof text === "string") return text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
}

function extractUserMessage(messages: OpenAIChatMessage[]): string {
  // CodeArts keeps history server-side via chat_id/parent_message_id.
  // We only send the current user turn.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant" && msg.role !== "tool") {
      const text = normalizeMessageContent(msg.content);
      if (text) return text;
    }
  }
  return "";
}

function parseToolArguments(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function extractToolResults(
  request: OpenAIChatCompletionRequest,
): CodeArtsToolResult[] {
  // Explicit tool_results from caller take priority
  const explicit = request.codearts?.tool_results ?? [];
  if (explicit.length > 0) return explicit;

  // Only extract tool results if the last message is a tool message.
  // If the last message is a user message, this is a new user turn — not a
  // tool continuation — even if there are tool messages earlier in history.
  const lastMsg = request.messages[request.messages.length - 1];
  if (!lastMsg || lastMsg.role !== "tool") return [];

  // Derive from messages: find the most recent assistant turn with tool_calls,
  // then collect the following tool messages.
  let assistantIndex = -1;
  let recentToolCalls: OpenAIToolCall[] = [];
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const msg = request.messages[i];
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      assistantIndex = i;
      recentToolCalls = msg.tool_calls;
      break;
    }
  }
  if (assistantIndex === -1) return [];

  const byId = new Map(recentToolCalls.map((tc) => [tc.id, tc]));
  return request.messages
    .slice(assistantIndex + 1)
    .filter(
      (msg) =>
        msg.role === "tool" && !!msg.tool_call_id && byId.has(msg.tool_call_id),
    )
    .map((msg) => {
      const tc = byId.get(msg.tool_call_id!);
      return {
        feedback: "",
        result: normalizeMessageContent(msg.content),
        name: tc?.function.name ?? msg.name ?? "unknown",
        arguments: tc?.function.arguments
          ? parseToolArguments(tc.function.arguments)
          : {},
        status: "APPROVE",
        executeStatus: "success",
        toolCallId: msg.tool_call_id,
      } satisfies CodeArtsToolResult;
    });
}

function buildTaskParameters(
  request: OpenAIChatCompletionRequest,
  tools: ToolDefinition[],
): Record<string, unknown> {
  const subAgent = request.codearts?.sub_agent;
  const params: Record<string, unknown> = {
    // CALLER_OR_DEFAULT: caller may override; default from captures
    codebase_search: request.codearts?.codebase_search ?? false,
    preferred_language: request.codearts?.preferred_language?.trim() || "zh-cn",
    enable_code_interpreter: request.codearts?.enable_code_interpreter ?? false,
    projectLevelPrompt: request.codearts?.project_level_prompt ?? "",
    // PROTOCOL: role as IDE host — tool list must match real IDE captures
    isSubAgent: !!subAgent,
    tools,
    environmentDetails: {
      // CALLER_OR_DEFAULT: default "win32" from captures; never use process.platform
      osVersion: request.codearts?.os_version?.trim() || "win32",
      // PROTOCOL: generated at request time
      currentDate: new Date().toISOString().replace("Z", ""),
      // PASSTHROUGH: must come from caller; empty string if not provided — never process.cwd()
      currentWorkingDirectory:
        request.codearts?.current_working_directory?.trim() ||
        request.codearts?.workspace_root?.trim() ||
        "",
    },
    // PROTOCOL: fixed values from captures
    routerVersion: "v2",
    isNewClient: true,
    features: { support_end_tag: true },
    ide: "CodeArts Agent",
    // PASSTHROUGH
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

function buildRequestBody(
  request: OpenAIChatCompletionRequest,
  session: StoredHuaweiSession,
): string {
  const toolResults = extractToolResults(request);
  const isToolContinuation = toolResults.length > 0;
  const subAgent = request.codearts?.sub_agent;
  const tools = subAgent ? SUB_AGENT_TOOLS : DEFAULT_TOOLS;
  const modelId = resolveModelId(request);

  // Caller is responsible for maintaining chat_id and parent_message_id.
  // We use what they provide. When not provided, derive a stable chat_id from
  // the first user/system message so all turns of the same conversation share
  // the same chat_id (instead of generating a new random UUID each turn).
  const chatId =
    request.codearts?.chat_id?.trim() || deriveConversationId(request.messages);

  // parent_message_id: prefer what caller provides; otherwise look up the
  // last response_message_id we received for this chat_id. Falls back to ""
  // for genuinely new conversations (correct per API spec).
  const parentMessageId =
    request.codearts?.parent_message_id ??
    lastResponseMessageId.get(chatId) ??
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

function getCredentials(session: StoredHuaweiSession): SigningCredentials {
  if (!session.accessKey || !session.secretKeyCiphertext) {
    throw new Error("Session missing AK/SK credentials");
  }
  return {
    accessKey: session.accessKey,
    secretKey: decryptString(session.secretKeyCiphertext),
    securityToken: session.securityToken,
  };
}

function buildChatHeaders(
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

function httpsPost(
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
      reject(new Error("Chat request timeout"));
    });
    req.write(body);
    req.end();
  });
}

async function* parseSSE(
  stream: AsyncIterable<string>,
): AsyncGenerator<CodeArtsSSEEvent> {
  for await (const line of stream) {
    if (!line.startsWith("data:")) continue;
    const json = line.slice(5).trim();
    if (!json || json === "[DONE]") continue;
    try {
      yield JSON.parse(json) as CodeArtsSSEEvent;
    } catch {
      // ignore malformed JSON
    }
  }
}

// ---------------------------------------------------------------------------
// Tool call translation
// ---------------------------------------------------------------------------

/**
 * Normalize tool call arguments before returning to OpenCode.
 * Currently: lowercase Task.subagent_type so OpenCode can find the agent.
 * The LLM sometimes generates "Explore", "General", etc. with uppercase,
 * but OpenCode registers agents in lowercase only.
 */
function normalizeToolCallArguments(name: string, argsStr: string): string {
  if (name !== "Task") return argsStr;
  try {
    const args = JSON.parse(argsStr) as Record<string, unknown>;
    if (typeof args.subagent_type === "string") {
      const normalized = args.subagent_type.toLowerCase();
      if (normalized !== args.subagent_type) {
        console.log(
          `  normalizeToolCall: Task.subagent_type "${args.subagent_type}" → "${normalized}"`,
        );
        args.subagent_type = normalized;
        return JSON.stringify(args);
      }
    }
  } catch {
    // leave as-is if not valid JSON
  }
  return argsStr;
}

function mapToolCalls(
  raw: CodeArtsRawToolCall[] | null | undefined,
): OpenAIToolCall[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((tc, i) => {
    const name = tc.function?.name ?? tc.name ?? "unknown";
    const rawArgs =
      tc.function?.arguments ??
      (typeof tc.arguments === "string"
        ? tc.arguments
        : JSON.stringify(tc.arguments ?? {}));
    return {
      id: tc.id ?? `call_${i}`,
      type: "function",
      function: { name, arguments: normalizeToolCallArguments(name, rawArgs) },
    };
  });
}

function mapToolCallDeltas(
  raw: CodeArtsRawToolCall[] | null | undefined,
): OpenAIToolCallDelta[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((tc, i) => {
    const name = tc.function?.name ?? tc.name ?? "unknown";
    const rawArgs =
      tc.function?.arguments ??
      (typeof tc.arguments === "string"
        ? tc.arguments
        : JSON.stringify(tc.arguments ?? {}));
    return {
      index: i,
      id: tc.id ?? `call_${i}`,
      type: "function",
      function: { name, arguments: normalizeToolCallArguments(name, rawArgs) },
    };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function streamHuaweiChatToResponse(
  request: OpenAIChatCompletionRequest,
  session: StoredHuaweiSession,
  traceId: string,
  res: Response,
): Promise<void> {
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
  console.log(`[${traceId}] ── OUTGOING REQUEST → CodeArts ──────────────────`);
  console.log(`[${traceId}]   url             : POST ${chatUrl}`);
  console.log(`[${traceId}]   model_id        : ${parsedBody.model_id}`);
  console.log(`[${traceId}]   chat_id         : ${parsedBody.chat_id}`);
  console.log(
    `[${traceId}]   parent_message_id: ${parsedBody.parent_message_id}`,
  );
  console.log(`[${traceId}]   messages.count  : ${msgArr.length}`);
  console.log(`[${traceId}]   tool_result.count: ${toolResultCount}`);
  console.log(
    `[${traceId}]   isSubAgent      : ${(tp?.isSubAgent as boolean | undefined) ?? false}`,
  );
  console.log(
    `[${traceId}]   cwd             : ${(tp?.environmentDetails as Record<string, unknown> | undefined)?.currentWorkingDirectory ?? ""}`,
  );
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
      `[${traceId}] ⚠ WARN: tool_result continuation but parent_message_id is empty!` +
        ` This is the first tool turn; CodeArts may lack context from previous assistant message.`,
    );
  }

  const { status, stream } = await httpsPost(chatUrl, headers, body);

  // ── HTTP status log ───────────────────────────────────────────────────────
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

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const completionId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = request.model;
  let sentRole = false;
  // Passthrough upstream metadata to caller so they can maintain continuity
  const responseMetadata: Record<string, string | undefined> = {};

  // ── SSE event counters ────────────────────────────────────────────────────
  let sseEventCount = 0;
  let sseTextChars = 0;
  let sseToolCallCount = 0;
  let sseHadError = false;

  for await (const event of parseSSE(stream)) {
    sseEventCount++;

    // Capture upstream session identifiers — pass back to caller
    if (event.chat_id) responseMetadata.chat_id = event.chat_id;
    if (event.response_message_id)
      responseMetadata.response_message_id = event.response_message_id;
    if (event.request_message_id)
      responseMetadata.request_message_id = event.request_message_id;

    // Log meta event
    if (event.chat_id || event.response_message_id) {
      console.log(
        `[${traceId}] ← SSE meta  chat_id=${event.chat_id ?? "-"} response_message_id=${event.response_message_id ?? "-"} request_message_id=${event.request_message_id ?? "-"}`,
      );
    }

    // Log errors
    if (
      event.error_code &&
      event.error_code !== "0" &&
      event.error_code !== "ChatAgent.00000000"
    ) {
      sseHadError = true;
      console.error(
        `[${traceId}] ← SSE error  code=${event.error_code} msg=${event.error_msg ?? "unknown"}`,
      );
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
      // Log tool calls — only print when id or name is present (first delta fragment).
      // Subsequent fragments only carry streamed arguments chunks; skip those.
      if (event.delta.tool_calls && event.delta.tool_calls.length > 0) {
        for (const tc of event.delta.tool_calls) {
          const hasIdentity =
            (tc.id && tc.id !== "-") || (tc.function?.name ?? tc.name);
          if (hasIdentity) {
            sseToolCallCount++;
            console.log(
              `[${traceId}] ← SSE tool_call  id=${tc.id ?? "-"} name=${tc.function?.name ?? tc.name ?? "-"}`,
            );
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

  // ── Update parent_message_id tracker (only on successful turns) ──────────
  // Do NOT update on error turns: if CodeArts failed to process the request,
  // the caller will retry with the same messages and we must point to the
  // same parent as before, not the failed turn's response_message_id.
  if (!sseHadError && responseMetadata.response_message_id) {
    const cid = responseMetadata.chat_id;
    if (cid) {
      lastResponseMessageId.set(cid, responseMetadata.response_message_id);
      console.log(
        `[${traceId}] ℹ lastResponseMessageId updated: ${cid} → ${responseMetadata.response_message_id}`,
      );
    }
  } else if (sseHadError) {
    console.warn(
      `[${traceId}] ⚠ SSE had error — lastResponseMessageId NOT updated (parent_message_id preserved for retry)`,
    );
  }

  // ── Stream complete log ───────────────────────────────────────────────────
  console.log(
    `[${traceId}] ── STREAM COMPLETE ────────────────────────────────────`,
  );
  console.log(`[${traceId}]   sse_events      : ${sseEventCount}`);
  console.log(`[${traceId}]   text_chars      : ${sseTextChars}`);
  console.log(`[${traceId}]   tool_calls      : ${sseToolCallCount}`);
  console.log(
    `[${traceId}]   response_message_id: ${responseMetadata.response_message_id ?? "(none)"}`,
  );
  console.log(
    `[${traceId}]   chat_id         : ${responseMetadata.chat_id ?? "(none)"}`,
  );
  console.log(
    `[${traceId}] ──────────────────────────────────────────────────────`,
  );

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
  let toolCalls: OpenAIToolCall[] | undefined;
  const responseMetadata: Record<string, string | undefined> = {};

  let sseEventCount = 0;
  let sseHadErrorNS = false;

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
      sseHadErrorNS = true;
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
  if (!sseHadErrorNS && responseMetadata.response_message_id) {
    const cid = responseMetadata.chat_id;
    if (cid)
      lastResponseMessageId.set(cid, responseMetadata.response_message_id);
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
