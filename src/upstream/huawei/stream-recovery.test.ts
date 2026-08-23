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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildForceResyncToolCall } = require("./chat-recovery") as typeof import("./chat-recovery");
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
function request(chatId: string, messages: OpenAIChatMessage[], tools?: OpenAIChatCompletionRequest["tools"]): OpenAIChatCompletionRequest {
  return { model: "GLM-5.1", messages, stream: true, codearts: { chat_id: chatId }, tools };
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
    return { status: 200, stream: sseStream(successEvents()) };
  });

  const { res, writes } = mockRes();
  await streamHuaweiChatToResponse(request(chatId, [...prefix, modifiedReply, user("next")]), session, "trace-2", res);

  // tail-divergence 是静默末段补发修复，不重试、不发 notice chunk。
  assert.equal(attempt, 1, "tail-divergence should not retry (silent suffix repair)");
  const text = extractContents(writes);
  assert.ok(text.includes("Hello world"), "should pass through upstream content");
  assert.ok(!text.includes("上下文已重置"), "tail-divergence should not emit reset notice");
  assert.ok(!text.includes("上下文已压缩"), "tail-divergence should not emit proactive notice");
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

async function testStreaming00001216AfterResyncEmitsForceResyncToolCall(): Promise<void> {
  // 00001216 重试仍失败时，应合成 tool_call 让客户端续传（而非 Error chunk + stop）。
  // 客户端传了 Bash 工具，应选择 Bash echo 方案。
  const chatId = "str-555555555555555555555555555555";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  installMock(async () => {
    // 每次都返回 00001216
    return { status: 200, stream: sseStream(errorEvents("ChatAgent.00001216", "exceeds")) };
  });

  const bashTool = { type: "function" as const, function: { name: "Bash", description: "", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false } } };
  const { res, writes } = mockRes();
  await streamHuaweiChatToResponse(request(chatId, [...prefix, lastReply, user("next")], [bashTool]), session, "trace-5", res);

  // 应该只调用 2 次（resyncRetried guard）
  assert.equal(callCount, 2, "should attempt exactly 2 times (resyncRetried guard)");

  // 应该下发 tool_call chunk（Bash echo codearts::forceResync）
  let foundToolCall = false;
  let finishReason: string | undefined;
  for (const w of writes) {
    if (!w.startsWith("data: ")) continue;
    const line = w.replace("data: ", "").trim();
    if (line === "[DONE]") continue;
    try {
      const chunk = JSON.parse(line);
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.function?.name === "Bash") {
            const args = JSON.parse(tc.function.arguments);
            if (args.command && args.command.includes("codearts::forceResync")) {
              foundToolCall = true;
            }
          }
        }
      }
      if (chunk.choices?.[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }
    } catch { /* ignore */ }
  }
  assert.ok(foundToolCall, "should emit Bash echo codearts::forceResync tool_call");
  assert.equal(finishReason, "tool_calls", `finish_reason should be "tool_calls" to let client continue; got: ${finishReason}`);
}

async function testForceResyncToolResultTriggersForceResyncPath(): Promise<void> {
  // 客户端回传 forceResync tool_result 时，proxy 应走 forceResync 路径
  // （清空 parent_message_id + 全量折叠）。
  // 通过 buildForceResyncToolCall 生成 tool_call（注册 id），模拟客户端回传。
  const chatId = "str-666666666666666666666666666666";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  // 用 buildForceResyncToolCall 生成 tool_call（会注册 id 到 forceResyncToolCallIds）
  const forceResyncToolCall = buildForceResyncToolCall(["Bash"]);
  assert.ok(forceResyncToolCall, "should synthesize forceResync tool_call");
  const forceResyncAssistant: OpenAIChatMessage = {
    role: "assistant",
    content: null,
    refusal: null,
    tool_calls: [forceResyncToolCall],
  };
  const forceResyncTool: OpenAIChatMessage = {
    role: "tool",
    content: "codearts::forceResync", // 客户端执行 echo 后的结果
    refusal: null,
    tool_call_id: forceResyncToolCall.id,
  };

  let capturedBody: string | null = null;
  installMock(async (_url, _headers, body) => {
    capturedBody = body;
    return { status: 200, stream: sseStream(successEvents()) };
  });

  const { res } = mockRes();
  await streamHuaweiChatToResponse(
    request(chatId, [...prefix, lastReply, user("next"), forceResyncAssistant, forceResyncTool]),
    session,
    "trace-6",
    res,
  );

  assert.ok(capturedBody, "should have captured request body");
  const parsed = JSON.parse(capturedBody as string);
  assert.equal(parsed.parent_message_id, "", `forceResync should clear parent_message_id; got: ${parsed.parent_message_id}`);
  // messages 应该是折叠后的单条文本（而非 tool continuation 的空数组）
  assert.ok(Array.isArray(parsed.messages) && parsed.messages.length === 1, "should fold to single message");
  assert.equal(parsed.messages[0].type, "text", "folded message should be text type");
}

async function testStreaming00001216NoClientToolsFallsBackToErrorChunk(): Promise<void> {
  // 客户端未传 tools 时，无法合成可执行的 tool_call，应回退到 Error chunk + stop。
  const chatId = "str-777777777777777777777777777777";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  installMock(async () => {
    return { status: 200, stream: sseStream(errorEvents("ChatAgent.00001216", "exceeds")) };
  });

  const { res, writes } = mockRes();
  // 不传 tools（undefined）
  await streamHuaweiChatToResponse(request(chatId, [...prefix, lastReply, user("next")]), session, "trace-7", res);

  let foundErrorChunk = false;
  let finishReason: string | undefined;
  for (const w of writes) {
    if (!w.startsWith("data: ")) continue;
    const line = w.replace("data: ", "").trim();
    if (line === "[DONE]") continue;
    try {
      const chunk = JSON.parse(line);
      if (chunk.choices?.[0]?.delta?.content?.includes("[Error:")) foundErrorChunk = true;
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
    } catch { /* ignore */ }
  }
  assert.ok(foundErrorChunk, "should emit Error chunk when no client tools available");
  assert.equal(finishReason, "stop", `finish_reason should be "stop" for fallback; got: ${finishReason}`);
}

async function testStreaming00001216GlobOnlyClientUsesGlob(): Promise<void> {
  // 客户端只传了 Glob（没有 Bash），应选择 Glob 方案合成 tool_call。
  const chatId = "str-888888888888888888888888888888";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  installMock(async () => {
    return { status: 200, stream: sseStream(errorEvents("ChatAgent.00001216", "exceeds")) };
  });

  const globTool = { type: "function" as const, function: { name: "Glob", description: "", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"], additionalProperties: false } } };
  const { res, writes } = mockRes();
  await streamHuaweiChatToResponse(request(chatId, [...prefix, lastReply, user("next")], [globTool]), session, "trace-8", res);

  let foundGlobToolCall = false;
  let finishReason: string | undefined;
  for (const w of writes) {
    if (!w.startsWith("data: ")) continue;
    const line = w.replace("data: ", "").trim();
    if (line === "[DONE]") continue;
    try {
      const chunk = JSON.parse(line);
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.function?.name === "Glob") {
            const args = JSON.parse(tc.function.arguments);
            if (args.pattern === "codearts::forceResync") foundGlobToolCall = true;
          }
        }
      }
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
    } catch { /* ignore */ }
  }
  assert.ok(foundGlobToolCall, "should emit Glob tool_call when only Glob available");
  assert.equal(finishReason, "tool_calls", `finish_reason should be "tool_calls"; got: ${finishReason}`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

(async () => {
  await testStreaming00001216EmitsNoticeChunkAndRetries();
  await testStreamingTailDivergenceEmitsNoticeChunk();
  await testStreaming00001216AfterResyncNotRetried();
  await testStreamingNoticeChunkCarriesMetadata();
  await testStreaming00001216AfterResyncEmitsForceResyncToolCall();
  await testForceResyncToolResultTriggersForceResyncPath();
  await testStreaming00001216NoClientToolsFallsBackToErrorChunk();
  await testStreaming00001216GlobOnlyClientUsesGlob();
  console.log("All stream-recovery tests passed.");
})().catch((e) => { console.error(e); process.exit(1); });
