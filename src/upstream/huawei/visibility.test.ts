/**
 * 可见性测试：folding/proactive/tail-divergence notice + PROTOCOL_ERROR 回归。
 *
 * 验证原本静默的处理路径现在向客户端发送 notice chunk/metadata，
 * 且 PROTOCOL_ERROR 仍保持静默（不触发 notice）。
 */
import assert from "assert";
import type { Response } from "express";

// 必须在 require config 之前设置环境变量，使 chainDivergenceRepairEnabled=true。
process.env.CHAIN_DIVERGENCE_REPAIR_ENABLED = "true";
process.env.FULL_CONTEXT_INJECTION_ENABLED = "true";

// ---------------------------------------------------------------------------
// Mock helpers (复用 stream-recovery 模式)
// ---------------------------------------------------------------------------

interface HttpsPostResult { status: number; stream: AsyncIterable<string> }
type HttpsPostFn = (urlStr: string, headers: Record<string, string>, body: string, signal?: AbortSignal) => Promise<HttpsPostResult>;

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
    `data: ${JSON.stringify({ finish_reason: "stop" })}\n`,
    "data: [DONE]\n",
  ];
}

function mockRes(): { res: Response; writes: string[] } {
  const writes: string[] = [];
  const res = {
    write: (data: string) => { writes.push(data); return true; },
    end: () => {}, setHeader: () => {}, flushHeaders: () => {}, on: () => {}, once: () => {},
  } as unknown as Response;
  return { res, writes };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const chatRequestModule = require("./chat-request");
const originalHttpsPost = chatRequestModule.httpsPost;
let mockFn: HttpsPostFn | null = null;
function installMock(fn: HttpsPostFn): void { mockFn = fn; }
Object.defineProperty(chatRequestModule, "httpsPost", {
  get: () => (urlStr: string, headers: Record<string, string>, body: string, signal?: AbortSignal) => {
    if (mockFn) return mockFn(urlStr, headers, body, signal);
    return originalHttpsPost(urlStr, headers, body, signal);
  },
  configurable: true,
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { streamHuaweiChatToResponse } = require("./chat-stream") as typeof import("./chat-stream");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sendHuaweiChatRequest } = require("./chat") as typeof import("./chat");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { encryptString } = require("../../auth/crypto/encryption") as typeof import("../../auth/crypto/encryption");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const translate = require("./chat-translate") as typeof import("./chat-translate");
import { createHash } from "crypto";
import type { OpenAIChatMessage, OpenAIChatCompletionRequest } from "../../types/openai";
import type { StoredHuaweiSession } from "../../auth/huawei/session-store";

const session = {
  keyId: "test-key", providerAccountId: "test-provider",
  accessKey: "AKTEST", secretKeyCiphertext: encryptString("SKTEST"), securityToken: "token-test",
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
function streamRequest(chatId: string, messages: OpenAIChatMessage[]): OpenAIChatCompletionRequest {
  return { model: "GLM-5.1", messages, stream: true, codearts: { chat_id: chatId } };
}
function nonStreamRequest(chatId: string, messages: OpenAIChatMessage[]): OpenAIChatCompletionRequest {
  return { model: "GLM-5.1", messages, stream: false, codearts: { chat_id: chatId } };
}

function extractContents(writes: string[]): string {
  let text = "";
  for (const w of writes) {
    if (!w.startsWith("data: ")) continue;
    const line = w.replace("data: ", "").trim();
    if (line === "[DONE]") continue;
    try { const c = JSON.parse(line); if (c.choices?.[0]?.delta?.content) text += c.choices[0].delta.content; } catch { /* */ }
  }
  return text;
}
function extractMetas(writes: string[]): Record<string, string | undefined>[] {
  const metas: Record<string, string | undefined>[] = [];
  for (const w of writes) {
    if (!w.startsWith("data: ")) continue;
    const line = w.replace("data: ", "").trim();
    if (line === "[DONE]") continue;
    try { const c = JSON.parse(line); if (c.codearts) metas.push(c.codearts); } catch { /* */ }
  }
  return metas;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testStreamingProactiveResetEmitsNotice(): Promise<void> {
  const chatId = "vis-111111111111111111111111111111";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);
  chatRequestModule.setLastPromptTokens(chatId, 185000); // > 180000 → proactive reset

  installMock(async () => ({ status: 200, stream: sseStream(successEvents()) }));
  const { res, writes } = mockRes();
  await streamHuaweiChatToResponse(streamRequest(chatId, [...prefix, lastReply, user("next")]), session, "t1", res);

  const text = extractContents(writes);
  assert.ok(text.includes("上下文已压缩"), `proactive reset should emit notice; got: ${text}`);
  const metas = extractMetas(writes);
  assert.ok(metas.some((m) => m.context_reset === "proactive"), "should carry context_reset=proactive metadata");
}

async function testStreamingFoldingEmitsNotice(): Promise<void> {
  const chatId = "vis-222222222222222222222222222222";
  // 构造 middle-damage：prefix + 修改中间消息 + lastReply
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);
  // 修改 prefix 中间消息 → middle-damage
  const modifiedPrefix = [user("old modified"), assistant("old answer")];

  installMock(async () => ({ status: 200, stream: sseStream(successEvents()) }));
  const { res, writes } = mockRes();
  await streamHuaweiChatToResponse(streamRequest(chatId, [...modifiedPrefix, lastReply, user("next")]), session, "t2", res);

  const text = extractContents(writes);
  assert.ok(text.includes("上下文已重置"), `folding should emit notice; got: ${text}`);
  const metas = extractMetas(writes);
  assert.ok(metas.some((m) => m.context_reset === "true"), "should carry context_reset=true metadata");
}

async function testNonStreamingFoldingMarksMetadata(): Promise<void> {
  const chatId = "vis-333333333333333333333333333333";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);
  const modifiedPrefix = [user("old modified"), assistant("old answer")];

  installMock(async () => ({ status: 200, stream: sseStream(successEvents()) }));
  const result = await sendHuaweiChatRequest(nonStreamRequest(chatId, [...modifiedPrefix, lastReply, user("next")]), session, "t3");

  assert.ok(result.codearts?.context_reset, `non-stream folding should mark context_reset metadata; got: ${JSON.stringify(result.codearts)}`);
}

async function testNonStreamingProactiveResetMarksMetadata(): Promise<void> {
  const chatId = "vis-444444444444444444444444444444";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);
  chatRequestModule.setLastPromptTokens(chatId, 185000);

  installMock(async () => ({ status: 200, stream: sseStream(successEvents()) }));
  const result = await sendHuaweiChatRequest(nonStreamRequest(chatId, [...prefix, lastReply, user("next")]), session, "t4");

  assert.equal(result.codearts?.context_reset, "proactive", "non-stream proactive should mark context_reset=proactive");
}

async function testProtocolErrorRemainsSilent(): Promise<void> {
  const chatId = "vis-555555555555555555555555555555";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  installMock(async () => ({
    status: 200,
    stream: sseStream([
      `data: ${JSON.stringify({ chat_id: "test-chat", response_message_id: "resp-1", request_message_id: "req-1" })}\n`,
      `data: ${JSON.stringify({ delta: { content: "Hello" } })}\n`,
      `data: ${JSON.stringify({ error_code: "PROTOCOL_ERROR", error_msg: "malformed" })}\n`,
      `data: ${JSON.stringify({ delta: { content: " world" } })}\n`,
      `data: ${JSON.stringify({ finish_reason: "stop" })}\n`,
      "data: [DONE]\n",
    ]),
  }));

  const { res, writes } = mockRes();
  await streamHuaweiChatToResponse(streamRequest(chatId, [...prefix, lastReply, user("next")]), session, "t5", res);

  const text = extractContents(writes);
  // PROTOCOL_ERROR 不应触发 notice chunk（不应出现"上下文"/"重置"/"压缩"等 notice 文本）
  assert.ok(!text.includes("上下文已压缩"), "PROTOCOL_ERROR should not trigger proactive reset notice");
  assert.ok(!text.includes("上下文已重置"), "PROTOCOL_ERROR should not trigger folding notice");
  assert.ok(!text.includes("链尾偏离"), "PROTOCOL_ERROR should not trigger tail-divergence notice");
  assert.ok(!text.includes("上下文长度超过"), "PROTOCOL_ERROR should not trigger 00001216 notice");
  // 正常内容应通过
  assert.ok(text.includes("Hello world"), "normal content should pass through despite PROTOCOL_ERROR");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

(async () => {
  await testStreamingProactiveResetEmitsNotice();
  await testStreamingFoldingEmitsNotice();
  await testNonStreamingFoldingMarksMetadata();
  await testNonStreamingProactiveResetMarksMetadata();
  await testProtocolErrorRemainsSilent();
  console.log("All visibility tests passed.");
})().catch((e) => { console.error(e); process.exit(1); });
