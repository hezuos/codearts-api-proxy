#!/usr/bin/env node
/**
 * 真实 CodeArts 热链分叉验证脚本。
 *
 * 通过本地代理的公开 OpenAI 兼容接口运行，不使用 mock，也不读取或解密 data/ 中的凭据。
 * 需要先启动代理，并设置 OPENAI_API_KEY。
 */

import { randomBytes } from "crypto";

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CodeArtsMetadata {
  chat_id?: string;
  response_message_id?: string;
  request_message_id?: string;
}

interface CompletionResponse {
  choices?: Array<{ message?: { role?: string; content?: string } }>;
  codearts?: CodeArtsMetadata;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

const baseUrl = (process.env.OPENAI_BASE_URL ?? "http://localhost:1455").replace(/\/$/, "");
const apiKey = process.env.OPENAI_API_KEY ?? "sk-2d17495c-e91e-49fa-9d54-67f4c1c579f7";
const model = process.env.CODEARTS_TEST_MODEL ?? "GLM-5.2";
const stream = process.env.CODEARTS_TEST_STREAM === "true";

if (!apiKey) {
  console.error("缺少 OPENAI_API_KEY。请设置本地代理生成的 API Key，不要把密钥写进脚本。");
  process.exit(2);
}

function newChatId(): string {
  return randomBytes(16).toString("hex");
}

function makeMessages(...messages: Message[]): Message[] {
  return messages;
}

async function requestCompletion(
  chatId: string,
  messages: Message[],
): Promise<{ response: CompletionResponse; status: number; raw: string }> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify({
      model,
      stream,
      messages,
      codearts: { chat_id: chatId },
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    return {
      status: response.status,
      raw,
      response: { error: { message: raw.slice(0, 500) } },
    };
  }

  if (!stream) {
    return { status: response.status, raw, response: JSON.parse(raw) as CompletionResponse };
  }

  return { status: response.status, raw, response: parseStreamResponse(raw) };
}

function parseStreamResponse(raw: string): CompletionResponse {
  let content = "";
  let metadata: CodeArtsMetadata | undefined;
  let finishReason: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const chunk = JSON.parse(line.slice(6)) as {
        codearts?: CodeArtsMetadata;
        choices?: Array<{
          delta?: { content?: string };
          finish_reason?: string | null;
        }>;
      };
      metadata ??= chunk.codearts;
      content += chunk.choices?.[0]?.delta?.content ?? "";
      finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
    } catch {
      // 忽略无法解析的 SSE 行，代理本身也允许畸形行容错。
    }
  }

  return {
    codearts: metadata,
    choices: [{ message: { role: "assistant", content } }],
    usage: { completion_tokens: content.length },
    error: finishReason && finishReason !== "stop" && finishReason !== "tool_calls"
      ? { message: `流式结束原因: ${finishReason}` }
      : undefined,
  };
}

function assertOk(
  label: string,
  result: { response: CompletionResponse; status: number },
): CodeArtsMetadata {
  const metadata = result.response.codearts;
  if (result.status !== 200 || !metadata?.response_message_id) {
    throw new Error(`${label} 失败: HTTP ${result.status}, ${result.response.error?.message ?? "缺少 response_message_id"}`);
  }
  console.log(JSON.stringify({
    scenario: label,
    status: result.status,
    response_message_id: "已返回",
    prompt_tokens: result.response.usage?.prompt_tokens ?? null,
    completion_tokens: result.response.usage?.completion_tokens ?? null,
    content_preview: String(result.response.choices?.[0]?.message?.content ?? "").slice(0, 120),
  }));
  return metadata;
}

async function run(): Promise<void> {
  const chatId = newChatId();
  const system: Message = {
    role: "system",
    content: "你正在执行连续性验证。请严格按照当前用户请求中的 SPIKE 标记回复。",
  };
  const user1: Message = {
    role: "user",
    content: "第一轮验证，请回复 SPIKE-BASE-OK。",
  };

  // 1. 首轮：建立真实 CodeArts parent 链。
  const first = await requestCompletion(chatId, makeMessages(system, user1));
  assertOk("normal-first-turn", first);
  const assistant1: Message = {
    role: "assistant",
    content: String(first.response.choices?.[0]?.message?.content ?? "SPIKE-BASE-OK"),
  };

  // 2. 正常续传：旧历史 + 上轮 assistant + 当前 user。
  const user2: Message = { role: "user", content: "正常续传，请回复 SPIKE-NORMAL-OK。" };
  const normal = await requestCompletion(chatId, makeMessages(system, user1, assistant1, user2));
  const normalMeta = assertOk("normal-continuation", normal);
  const assistant2: Message = {
    role: "assistant",
    content: String(normal.response.choices?.[0]?.message?.content ?? "SPIKE-NORMAL-OK"),
  };

  // 3. 热切换：模拟外部 provider 在 CodeArts 上轮回复之后产生 user/assistant 轮次。
  // 不传 parent_message_id，验证 proxy 能从完整消息历史中自行检测并补发尾部。
  const externalUser: Message = {
    role: "user",
    content: "这是外部 provider 产生的历史问题：外部上下文标记 EXT-USER。",
  };
  const externalAssistant: Message = {
    role: "assistant",
    content: "这是外部 provider 的历史回复：外部上下文标记 EXT-ASSIST。",
  };
  const currentUser: Message = {
    role: "user",
    content: "切回 CodeArts 后请综合外部历史，并回复 SPIKE-SWITCH-OK。",
  };
  const switched = await requestCompletion(
    chatId,
    makeMessages(system, user1, assistant1, user2, assistant2, externalUser, externalAssistant, currentUser),
  );
  const switchedMeta = assertOk("provider-switch-tail-divergence", switched);
  if (switchedMeta.response_message_id === normalMeta.response_message_id) {
    throw new Error("热切换请求没有产生新的 response_message_id");
  }

  // 4. 中段损伤：修改早期 user 消息，必须触发 full reset，而不是把冲突内容追加到旧链。
  const editedUser: Message = {
    role: "user",
    content: "第一轮验证已被编辑：请回复 SPIKE-MIDDLE-RESET-OK。",
  };
  const middle = await requestCompletion(
    chatId,
    makeMessages(system, editedUser, assistant1, user2, assistant2, currentUser),
  );
  assertOk("middle-damage-full-reset", middle);

  // 5. 重复/陈旧请求：重复发送刚才的客户端历史，期望 proxy 拒绝而不重复调用上游。
  const stale = await requestCompletion(
    chatId,
    makeMessages(system, editedUser, assistant1, user2, assistant2, currentUser),
  );
  if (stale.status === 200) {
    throw new Error("duplicate/stale 请求意外成功，可能重复发送了最后一条 user");
  }
  console.log(JSON.stringify({
    scenario: "duplicate-stale-rejected",
    status: stale.status,
    expected: "非 200",
    error_preview: stale.response.error?.message ?? stale.raw.slice(0, 200),
  }));

  console.log(JSON.stringify({
    ok: true,
    chat_id: "本次测试已隔离",
    stream,
    base_url: baseUrl,
    model,
    note: "请同时查看 proxy 日志中的 divergence、suffixStart 和 fullContextInjected 字段。",
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
