/**
 * 流式错误恢复测试（chat-stream.ts 00001216 + tail-divergence notice chunk）。
 *
 * 通过劫持 require.cache 替换 httpsPost，mock res 捕获 res.write。
 */
import assert from "assert";
import type { Response } from "express";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

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

function mockRes(): { res: Response; writes: string[]; ended: boolean } {
  const writes: string[] = [];
  const res = {
    write: (data: string) => { writes.push(data); return true; },
    end: () => {},
    setHeader: () => {},
    flushHeaders: () => {},
    on: () => {},
    once: () => {},
  } as unknown as Response;
  return { res, writes, ended: false };
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
import { createHash } from "crypto";
import type { OpenAIChatMessage, OpenAIChatCompletionRequest } from "../../types/openai";
import type { StoredHuaweiSession } from "../../auth/huawei/session-store";

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

/** 从 res.writes 中提取所有 SSE chunk 的 content 文本 */
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

/** 从 res.writes 中提取所有 chunk 的 codearts metadata */
function extractMetadata(writes: string[]): Record<string, string | undefined>[] {
  const metas: Record<string, string | undefined>[] = [];
  for (const w of writes) {
    if (!w.startsWith("data: ")) continue;
    const line = w.replace("data: ", "").trim();
    if (line === "[DONE]") continue;
    try {
      const chunk = JSON.parse(line);
      if (chunk.codearts) metas.push(chunk.codearts);
    } catch { /* ignore */ }
  }
  return metas;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testStreaming00001216EmitsNoticeChunkAndRetries(): Promise<void> {
  const chatId = "str-111111111111111111111111111111";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  let attempt = 0;
  installMock(async () => {
    attempt++;
    if (attempt === 1) return { status: 200, stream: sseStream(errorEvents("ChatAgent.00001216", "Prompt length exceeds")) };
    return { status: 200, stream: sseStream(successEvents()) };
  });

  const { res, writes } = mockRes();
  await streamHuaweiChatToResponse(request(chatId, [...prefix, lastReply, user("next")]), session, "trace-1", res);

  assert.equal(attempt, 2, "should retry once after 00001216");
  const text = extractContents(writes);
  assert.ok(text.includes("上下文长度超过上游限制"), `notice should mention context length; got: ${text}`);
  assert.ok(text.includes("Hello world"), "should include retried successful content");
}

async function testStreamingTailDivergenceEmitsNoticeChunk(): Promise<void> {
  const chatId = "str-222222222222222222222222222222";
  // 构造 tail-divergence：prefix + lastReply + new user（lastReply hash 不匹配 → tail-divergence）
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);
  // 修改 lastReply 使 hash 不匹配 → tail-divergence
  const modifiedReply = assistant("modified answer");

  let attempt = 0;
  installMock(async () => {
    attempt++;
    if (attempt === 1) return { status: 200, stream: sseStream(errorEvents("SOME_ERROR", "chain broken")) };
    return { status: 200, stream: sseStream(successEvents()) };
  });

  const { res, writes } = mockRes();
  await streamHuaweiChatToResponse(request(chatId, [...prefix, modifiedReply, user("next")]), session, "trace-2", res);

  assert.equal(attempt, 2, "should retry after tail-divergence error");
  const text = extractContents(writes);
  assert.ok(text.includes("链尾偏离修复失败"), `notice should mention tail-divergence; got: ${text}`);
}

async function testStreaming00001216AfterResyncNotRetried(): Promise<void> {
  const chatId = "str-333333333333333333333333333333";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  installMock(async () => {
    // 每次都返回 00001216
    return { status: 200, stream: sseStream(errorEvents("ChatAgent.00001216", "exceeds")) };
  });

  const { res, writes } = mockRes();
  await streamHuaweiChatToResponse(request(chatId, [...prefix, lastReply, user("next")]), session, "trace-3", res);

  assert.equal(callCount, 2, "should attempt exactly 2 times (resyncRetried guard)");
  const text = extractContents(writes);
  assert.ok(text.includes("上下文长度超过上游限制"), "should emit notice once");
}

async function testStreamingNoticeChunkCarriesMetadata(): Promise<void> {
  const chatId = "str-444444444444444444444444444444";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  let attempt = 0;
  installMock(async () => {
    attempt++;
    if (attempt === 1) return { status: 200, stream: sseStream(errorEvents("ChatAgent.00001216", "exceeds")) };
    return { status: 200, stream: sseStream(successEvents()) };
  });

  const { res, writes } = mockRes();
  await streamHuaweiChatToResponse(request(chatId, [...prefix, lastReply, user("next")]), session, "trace-4", res);

  const metas = extractMetadata(writes);
  const hasErrorRecovery = metas.some((m) => m.error_recovery === "ChatAgent.00001216");
  assert.ok(hasErrorRecovery, `notice chunk should carry error_recovery metadata; got metas: ${JSON.stringify(metas)}`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

(async () => {
  await testStreaming00001216EmitsNoticeChunkAndRetries();
  await testStreamingTailDivergenceEmitsNoticeChunk();
  await testStreaming00001216AfterResyncNotRetried();
  await testStreamingNoticeChunkCarriesMetadata();
  console.log("All stream-recovery tests passed.");
})().catch((e) => { console.error(e); process.exit(1); });
