/**
 * 错误恢复测试（chat.ts HTTP/SSE 00001216 恢复）。
 *
 * 通过劫持 require.cache 替换 httpsPost，模拟上游 00001216 错误 + forceResync 成功。
 */
import assert from "assert";

// ---------------------------------------------------------------------------
// Mock httpsPost via require.cache
// ---------------------------------------------------------------------------

interface HttpsPostResult { status: number; stream: AsyncIterable<string> }
type HttpsPostFn = (
  urlStr: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
) => Promise<HttpsPostResult>;

/** 模拟 SSE 事件流 */
function sseStream(events: string[]): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next(): Promise<IteratorResult<string>> {
          if (i < events.length) {
            return Promise.resolve({ value: events[i++], done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

/** 成功 SSE 响应事件 */
function successEvents(): string[] {
  return [
    `data: ${JSON.stringify({ chat_id: "test-chat", response_message_id: "resp-1", request_message_id: "req-1" })}\n`,
    `data: ${JSON.stringify({ delta: { content: "Hello" } })}\n`,
    `data: ${JSON.stringify({ delta: { content: " world" } })}\n`,
    `data: ${JSON.stringify({ finish_reason: "stop", usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n`,
    "data: [DONE]\n",
  ];
}

/** 00001216 SSE 错误事件 */
function error00001216Events(): string[] {
  return [
    `data: ${JSON.stringify({ chat_id: "test-chat", response_message_id: "resp-1", request_message_id: "req-1" })}\n`,
    `data: ${JSON.stringify({ error_code: "ChatAgent.00001216", error_msg: "Prompt length exceeds: 344632 must less than 196608" })}\n`,
    "data: [DONE]\n",
  ];
}

let mockHttpsPost: HttpsPostFn | null = null;
let callCount = 0;
const callBodies: string[] = [];

function installMock(fn: HttpsPostFn): void {
  mockHttpsPost = fn;
  callCount = 0;
  callBodies.length = 0;
}

// 劫持 chat-request 模块的 httpsPost
// eslint-disable-next-line @typescript-eslint/no-require-imports
const chatRequestModule = require("./chat-request");
const originalHttpsPost = chatRequestModule.httpsPost;
Object.defineProperty(chatRequestModule, "httpsPost", {
  get: () => {
    return (urlStr: string, headers: Record<string, string>, body: string, signal?: AbortSignal) => {
      callCount++;
      callBodies.push(body);
      if (mockHttpsPost) return mockHttpsPost(urlStr, headers, body, signal);
      return originalHttpsPost(urlStr, headers, body, signal);
    };
  },
  configurable: true,
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sendHuaweiChatRequest } = require("./chat") as typeof import("./chat");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const translate = require("./chat-translate") as typeof import("./chat-translate");
import { createHash } from "crypto";
import type { OpenAIChatMessage, OpenAIChatCompletionRequest } from "../../types/openai";
import type { StoredHuaweiSession } from "../../auth/huawei/session-store";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { encryptString } = require("../../auth/crypto/encryption") as typeof import("../../auth/crypto/encryption");

const session = {
  keyId: "test-key",
  providerAccountId: "test-provider",
  accessKey: "AKTEST",
  secretKeyCiphertext: encryptString("SKTEST"),
  securityToken: "token-test",
} as StoredHuaweiSession;

function user(content: string): OpenAIChatMessage {
  return { role: "user", content, refusal: null };
}
function assistant(content: string): OpenAIChatMessage {
  return { role: "assistant", content, refusal: null };
}
function hash(message: OpenAIChatMessage): string {
  return createHash("sha256").update(translate.normalizeForChain(message)).digest("hex");
}

function seedChain(chatId: string, prefix: OpenAIChatMessage[], lastReply: OpenAIChatMessage): void {
  const chain = translate.computeChainForMessages(prefix);
  chatRequestModule.setChainState(chatId, {
    prefixChain: chain.hash,
    prefixLen: chain.length,
    lastReplyHash: hash(lastReply),
  });
  chatRequestModule.setLastResponseMessageId(chatId, "parent-1");
}

function request(chatId: string, messages: OpenAIChatMessage[]): OpenAIChatCompletionRequest {
  return { model: "GLM-5.1", messages, stream: false, codearts: { chat_id: chatId } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testNonStreaming00001216TriggersForceResyncRetry(): Promise<void> {
  const chatId = "err-111111111111111111111111111111";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  let attempt = 0;
  installMock(async () => {
    attempt++;
    if (attempt === 1) {
      // 第一次：SSE 00001216 错误
      return { status: 200, stream: sseStream(error00001216Events()) };
    }
    // 第二次（forceResync）：成功
    return { status: 200, stream: sseStream(successEvents()) };
  });

  const result = await sendHuaweiChatRequest(
    request(chatId, [...prefix, lastReply, user("next")]),
    session,
    "trace-1",
  );

  assert.equal(attempt, 2, "should retry once after 00001216");
  assert.ok(result.choices[0].message.content?.includes("Hello world"), "should return successful content");
}

async function testNonStreaming00001216RetryAlsoFails(): Promise<void> {
  const chatId = "err-222222222222222222222222222222";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  installMock(async () => {
    // 每次都返回 00001216
    return { status: 200, stream: sseStream(error00001216Events()) };
  });

  let threw = false;
  try {
    await sendHuaweiChatRequest(
      request(chatId, [...prefix, lastReply, user("next")]),
      session,
      "trace-2",
    );
  } catch (e) {
    threw = true;
    assert.ok(
      (e as Error).message.includes("ChatAgent.00001216"),
      "should throw 00001216 error after retry also fails",
    );
  }
  assert.equal(threw, true, "should throw (not infinite retry)");
  assert.equal(callCount, 2, "should attempt exactly 2 times (original + 1 retry)");
}

async function testNonStreamingOtherErrorNotRetried(): Promise<void> {
  const chatId = "err-333333333333333333333333333333";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  installMock(async () => {
    // 返回非 00001216 错误
    return {
      status: 200,
      stream: sseStream([
        `data: ${JSON.stringify({ chat_id: chatId, response_message_id: "r1", request_message_id: "q1" })}\n`,
        `data: ${JSON.stringify({ error_code: "SOME_OTHER_ERROR", error_msg: "something else" })}\n`,
        "data: [DONE]\n",
      ]),
    };
  });

  let threw = false;
  try {
    await sendHuaweiChatRequest(
      request(chatId, [...prefix, lastReply, user("next")]),
      session,
      "trace-3",
    );
  } catch (e) {
    threw = true;
    assert.ok((e as Error).message.includes("SOME_OTHER_ERROR"), "should throw original error");
  }
  assert.equal(threw, true, "should throw without retry");
  assert.equal(callCount, 1, "should attempt only once (no retry for non-00001216)");
}

async function testNonStreamingHttp00001216TriggersRetry(): Promise<void> {
  const chatId = "err-444444444444444444444444444444";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  let attempt = 0;
  installMock(async () => {
    attempt++;
    if (attempt === 1) {
      // HTTP 错误，body 含 00001216
      return { status: 500, stream: sseStream(["ChatAgent.00001216: Prompt length exceeds"]) };
    }
    return { status: 200, stream: sseStream(successEvents()) };
  });

  const result = await sendHuaweiChatRequest(
    request(chatId, [...prefix, lastReply, user("next")]),
    session,
    "trace-4",
  );

  assert.equal(attempt, 2, "should retry after HTTP 00001216");
  assert.ok(result.choices[0].message.content?.includes("Hello world"), "should succeed on retry");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

(async () => {
  await testNonStreaming00001216TriggersForceResyncRetry();
  await testNonStreaming00001216RetryAlsoFails();
  await testNonStreamingOtherErrorNotRetried();
  await testNonStreamingHttp00001216TriggersRetry();
  console.log("All error-recovery tests passed.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
