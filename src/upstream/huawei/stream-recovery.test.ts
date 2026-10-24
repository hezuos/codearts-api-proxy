/**
 * 流式错误处理测试：限流重试仍保留；分叉不再修复；错误如实下发为 SSE error 事件。
 *
 * 通过劫持 require.cache 替换 httpsPost，mock res 捕获 res.write。
 */
import assert from "assert";
import { createHash } from "crypto";
import type { Response } from "express";
import type { OpenAIChatMessage, OpenAIChatCompletionRequest } from "../../types/openai";
import type { StoredHuaweiSession } from "../../auth/huawei/session-store";

interface HttpsPostResult { status: number; stream: AsyncIterable<string> }
type HttpsPostFn = (
  urlStr: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
) => Promise<HttpsPostResult>;

function sseStream(events: string[]): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next(): Promise<IteratorResult<string>> {
          if (i < events.length) return Promise.resolve({ value: events[i++], done: false });
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function successEvents(): string[] {
  return [
    `data: ${JSON.stringify({ chat_id: "test-chat", response_message_id: "resp-1", request_message_id: "req-1" })}\n`,
    `data: ${JSON.stringify({ delta: { content: "Hello" } })}\n`,
    `data: ${JSON.stringify({ delta: { content: " world" } })}\n`,
    `data: ${JSON.stringify({ finish_reason: "stop" })}\n`,
    "data: [DONE]\n",
  ];
}

function errorEvents(code: string, msg: string): string[] {
  return [
    `data: ${JSON.stringify({ chat_id: "test-chat", response_message_id: "resp-1", request_message_id: "req-1" })}\n`,
    `data: ${JSON.stringify({ error_code: code, error_msg: msg })}\n`,
    "data: [DONE]\n",
  ];
}

function mockRes(): { res: Response; writes: string[] } {
  const writes: string[] = [];
  const res = {
    write: (data: string) => { writes.push(data); return true; },
    end: () => {},
    setHeader: () => {},
    flushHeaders: () => {},
    on: () => {},
    once: () => {},
  } as unknown as Response;
  return { res, writes };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const chatRequestModule = require("./chat-request");
const originalHttpsPost = chatRequestModule.httpsPost;
let mockFn: HttpsPostFn | null = null;
let callCount = 0;

function installMock(fn: HttpsPostFn): void {
  mockFn = fn;
  callCount = 0;
}

Object.defineProperty(chatRequestModule, "httpsPost", {
  get: () => (urlStr: string, headers: Record<string, string>, body: string, signal?: AbortSignal) => {
    callCount++;
    if (mockFn) return mockFn(urlStr, headers, body, signal);
    return originalHttpsPost(urlStr, headers, body, signal);
  },
  configurable: true,
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { streamHuaweiChatToResponse } = require("./chat-stream") as typeof import("./chat-stream");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { encryptString } = require("../../auth/crypto/encryption") as typeof import("../../auth/crypto/encryption");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const translate = require("./chat-translate") as typeof import("./chat-translate");

const session = {
  keyId: "test-key",
  providerAccountId: "test-provider",
  accessKey: "AKTEST",
  secretKeyCiphertext: encryptString("SKTEST"),
  securityToken: "token-test",
} as StoredHuaweiSession;

function user(content: string): OpenAIChatMessage { return { role: "user", content, refusal: null }; }
function assistant(content: string): OpenAIChatMessage { return { role: "assistant", content, refusal: null }; }
function hash(message: OpenAIChatMessage): string {
  return createHash("sha256").update(translate.normalizeForChain(message)).digest("hex");
}
function seedChain(chatId: string, prefix: OpenAIChatMessage[], lastReply: OpenAIChatMessage): void {
  const chain = translate.computeChainForMessages(prefix);
  chatRequestModule.setChainState(chatId, { prefixChain: chain.hash, prefixLen: chain.length, lastReplyHash: hash(lastReply) });
  chatRequestModule.setLastResponseMessageId(chatId, "parent-1");
}
function request(chatId: string, messages: OpenAIChatMessage[]): OpenAIChatCompletionRequest {
  return { model: "GLM-5.1", messages, stream: true, codearts: { chat_id: chatId } };
}

/** 从 res.writes 中提取所有 SSE chunk 的 content 文本（含 notice chunk） */
function extractContents(writes: string[]): string {
  let text = "";
  for (const w of writes) {
    if (!w.startsWith("data: ")) continue;
    const line = w.replace("data: ", "").trim();
    if (line === "[DONE]") continue;
    try {
      const chunk = JSON.parse(line);
      if (chunk.choices?.[0]?.delta?.content) text += chunk.choices[0].delta.content;
    } catch { /* ignore */ }
  }
  return text;
}

/** 提取 SSE error 事件体的集合 */
function extractErrors(writes: string[]): Array<{ code?: string | null; message?: string }> {
  const errors: Array<{ code?: string | null; message?: string }> = [];
  for (const w of writes) {
    if (!w.startsWith("data: ")) continue;
    const line = w.replace("data: ", "").trim();
    if (line === "[DONE]") continue;
    try {
      const chunk = JSON.parse(line);
      if (chunk.error) errors.push(chunk.error);
    } catch { /* ignore */ }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testRateLimitRetriesOnce(): Promise<void> {
  const chatId = "str-rate-limit";
  let attempt = 0;
  installMock(async () => {
    attempt++;
    if (attempt === 1) return { status: 200, stream: sseStream(errorEvents("InferHub.ModelArts.81101.429", "rate limited")) };
    return { status: 200, stream: sseStream(successEvents()) };
  });

  const { res, writes } = mockRes();
  await streamHuaweiChatToResponse(request(chatId, [user("hi")]), session, "trace-rate-limit", res);

  assert.equal(attempt, 2, "限流错误应重试一次");
  const text = extractContents(writes);
  assert.ok(text.includes("正在重试"), `应提示正在重试；got: ${text}`);
  assert.ok(text.includes("Hello world"), "重试成功后应输出内容");
}

async function testPromptLengthEmitsTerminalErrorEvent(): Promise<void> {
  installMock(async () => ({
    status: 200,
    stream: sseStream(errorEvents("ChatAgent.00001216", "Prompt length exceeds: 344632 must less than 196608")),
  }));

  const { res, writes } = mockRes();
  await streamHuaweiChatToResponse(request("str-prompt-length", [user("hi")]), session, "trace-pl", res);

  assert.equal(callCount, 1, "上下文超限不得重试");
  const errors = extractErrors(writes);
  assert.equal(errors.length, 1, "应只下发一个终态错误事件");
  assert.equal(errors[0]?.code, "context_length_exceeded");
  assert.ok(writes.some((w) => w.includes("[DONE]")), "应正常结束流");
}

async function testTailDivergenceIsNotRepaired(): Promise<void> {
  const chatId = "str-tail-divergence";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  installMock(async () => ({
    status: 200,
    stream: sseStream(errorEvents("SomeError.000001", "boom")),
  }));

  const { res, writes } = mockRes();
  await streamHuaweiChatToResponse(
    request(chatId, [...prefix, lastReply, user("external"), assistant("ext"), user("next")]),
    session,
    "trace-tail",
    res,
  );

  assert.equal(callCount, 1, "分叉不得触发修复重试");
  const errors = extractErrors(writes);
  assert.equal(errors[0]?.code, "SomeError.000001", "错误应如实透传");
}

async function testNonRetryableErrorEmitsErrorWithoutToolCalls(): Promise<void> {
  installMock(async () => ({
    status: 200,
    stream: sseStream(errorEvents("SomeError.000042", "unexpected failure")),
  }));

  const { res, writes } = mockRes();
  await streamHuaweiChatToResponse(request("str-generic-error", [user("hi")]), session, "trace-generic", res);

  const errors = extractErrors(writes);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.code, "SomeError.000042");
  const text = extractContents(writes);
  assert.equal(text.trim(), "", "不得伪造内容或工具调用");
}

async function run(): Promise<void> {
  await testRateLimitRetriesOnce();
  await testPromptLengthEmitsTerminalErrorEvent();
  await testTailDivergenceIsNotRepaired();
  await testNonRetryableErrorEmitsErrorWithoutToolCalls();
  console.log("All stream-recovery tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
