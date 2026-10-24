/**
 * 上游错误映射测试：上下文超限（ChatAgent.00001216 / HTTP 413）必须映射为
 * 明确的 context_length_exceeded 错误，且不得重试或用改写后的历史重发。
 *
 * 通过劫持 require.cache 替换 httpsPost 模拟上游响应。
 */
import assert from "assert";
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
          if (i < events.length) {
            return Promise.resolve({ value: events[i++], done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

let mockHttpsPost: HttpsPostFn | null = null;
let callCount = 0;

function installMock(fn: HttpsPostFn): void {
  mockHttpsPost = fn;
  callCount = 0;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const chatRequestModule = require("./chat-request");
const originalHttpsPost = chatRequestModule.httpsPost;
Object.defineProperty(chatRequestModule, "httpsPost", {
  get: () => {
    return (urlStr: string, headers: Record<string, string>, body: string, signal?: AbortSignal) => {
      callCount++;
      if (mockHttpsPost) return mockHttpsPost(urlStr, headers, body, signal);
      return originalHttpsPost(urlStr, headers, body, signal);
    };
  },
  configurable: true,
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sendHuaweiChatRequest } = require("./chat") as typeof import("./chat");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { streamHuaweiChatToResponse } = require("./chat-stream") as typeof import("./chat-stream");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sendErrorResponse } = require("../../routes/openai") as typeof import("../../routes/openai");
import { UpstreamContextLengthError, isPromptLengthExceeded } from "../../utils/errors";

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

function request(chatId: string): OpenAIChatCompletionRequest {
  return {
    model: "glm-5.3",
    messages: [user("hi")],
    stream: false,
    codearts: { chat_id: chatId },
  };
}

// ---------------------------------------------------------------------------
// 错误体识别
// ---------------------------------------------------------------------------

function testPromptLengthDetection(): void {
  assert.equal(isPromptLengthExceeded('{"error_code":"ChatAgent.00001216"}'), true);
  assert.equal(
    isPromptLengthExceeded("ChatAgent.00001216: Prompt length exceeds: 344632 must less than 196608"),
    true,
  );
  assert.equal(isPromptLengthExceeded("Prompt length exceeds limit"), true);
  assert.equal(isPromptLengthExceeded("ChatAgent.00000042"), false);
  assert.equal(isPromptLengthExceeded(undefined), false);
}

// ---------------------------------------------------------------------------
// HTTP 层映射
// ---------------------------------------------------------------------------

async function testHttp400PromptLengthMapsToContextLength(): Promise<void> {
  installMock(async () => ({
    status: 400,
    stream: sseStream([
      '{"error_code":"ChatAgent.00001216","error_msg":"Prompt length exceeds: 344632 must less than 196608"}',
    ]),
  }));

  await assert.rejects(
    sendHuaweiChatRequest(request("ctx-http-400"), session, "trace-ctx-400"),
    (error: unknown) => {
      assert.ok(error instanceof UpstreamContextLengthError, "应抛出 UpstreamContextLengthError");
      assert.ok(error.message.includes("context length"), "message 应含 context length 字样");
      return true;
    },
  );
  assert.equal(callCount, 1, "上下文超限不得重试");
}

async function testHttp413MapsToContextLength(): Promise<void> {
  installMock(async () => ({ status: 413, stream: sseStream([]) }));

  await assert.rejects(
    sendHuaweiChatRequest(request("ctx-http-413"), session, "trace-ctx-413"),
    (error: unknown) => error instanceof UpstreamContextLengthError,
  );
  assert.equal(callCount, 1, "413 不得重试");
}

async function testOtherHttpErrorStaysGeneric(): Promise<void> {
  installMock(async () => ({
    status: 400,
    stream: sseStream(['{"error_code":"SomeOther.0001","error_msg":"bad request"}']),
  }));

  await assert.rejects(
    sendHuaweiChatRequest(request("ctx-http-other"), session, "trace-ctx-other"),
    (error: unknown) => {
      assert.ok(!(error instanceof UpstreamContextLengthError));
      assert.ok(error instanceof Error && error.message.includes("HTTP 400"));
      return true;
    },
  );
  assert.equal(callCount, 1);
}

// ---------------------------------------------------------------------------
// SSE 层映射
// ---------------------------------------------------------------------------

async function testSsePromptLengthMapsToContextLength(): Promise<void> {
  installMock(async () => ({
    status: 200,
    stream: sseStream([
      `data: ${JSON.stringify({ chat_id: "c1", response_message_id: "r1" })}\n`,
      `data: ${JSON.stringify({ error_code: "ChatAgent.00001216", error_msg: "Prompt length exceeds: 344632 must less than 196608" })}\n`,
      "data: [DONE]\n",
    ]),
  }));

  await assert.rejects(
    sendHuaweiChatRequest(request("ctx-sse-1216"), session, "trace-ctx-sse"),
    (error: unknown) => error instanceof UpstreamContextLengthError,
  );
  assert.equal(callCount, 1, "SSE 上下文超限不得重试");
}

// ---------------------------------------------------------------------------
// 客户端响应映射
// ---------------------------------------------------------------------------

interface MockRes {
  headersSent: boolean;
  writableEnded: boolean;
  statusCode?: number;
  body?: unknown;
  chunks: string[];
  ended: boolean;
  status(code: number): MockRes;
  json(payload: unknown): void;
  write(chunk: string): boolean;
  end(): void;
  setHeader(): void;
  flushHeaders(): void;
}

function mockRes(headersSent: boolean): MockRes {
  const res: MockRes = {
    headersSent,
    writableEnded: false,
    chunks: [],
    ended: false,
    status(code: number): MockRes {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown): void {
      res.body = payload;
    },
    write(chunk: string): boolean {
      res.chunks.push(chunk);
      return true;
    },
    end(): void {
      res.ended = true;
    },
    setHeader(): void {
      /* noop */
    },
    flushHeaders(): void {
      res.headersSent = true;
    },
  };
  return res;
}

function testNonStreamingErrorResponseIs400(): void {
  const res = mockRes(false);
  sendErrorResponse(
    res as unknown as Parameters<typeof sendErrorResponse>[0],
    new UpstreamContextLengthError("ChatAgent.00001216: too long"),
  );
  assert.equal(res.statusCode, 400);
  const body = res.body as { error: { code: string; message: string; type: string } };
  assert.equal(body.error.code, "context_length_exceeded");
  assert.equal(body.error.type, "invalid_request_error");
  assert.ok(body.error.message.toLowerCase().includes("context length"));
}

function testStreamingErrorResponseUsesErrorEvent(): void {
  const res = mockRes(true);
  sendErrorResponse(
    res as unknown as Parameters<typeof sendErrorResponse>[0],
    new UpstreamContextLengthError("ChatAgent.00001216: too long"),
  );
  assert.equal(res.statusCode, undefined, "已发送 headers 时无法改状态码");
  const first = res.chunks[0] ?? "";
  assert.ok(first.startsWith("data: "), "应以 SSE data 行下发");
  const payload = JSON.parse(first.slice("data: ".length)) as { error: { code: string } };
  assert.equal(payload.error.code, "context_length_exceeded");
  assert.ok(res.chunks.some((c) => c.includes("[DONE]")), "结束时应发送 [DONE]");
  assert.equal(res.ended, true);
}

async function testStreamingInStreamPromptLengthEmitsErrorEvent(): Promise<void> {
  installMock(async () => ({
    status: 200,
    stream: sseStream([
      `data: ${JSON.stringify({ chat_id: "c1", response_message_id: "r1" })}\n`,
      `data: ${JSON.stringify({ error_code: "ChatAgent.00001216", error_msg: "Prompt length exceeds: 344632 must less than 196608" })}\n`,
      "data: [DONE]\n",
    ]),
  }));

  const res = mockRes(false);
  await streamHuaweiChatToResponse(
    { ...request("ctx-stream-inline"), stream: true },
    session,
    "trace-ctx-stream-inline",
    res as unknown as Parameters<typeof streamHuaweiChatToResponse>[3],
  );

  const output = res.chunks.join("");
  assert.ok(
    output.includes('"code":"context_length_exceeded"'),
    "流内超限应下发 context_length_exceeded 错误事件",
  );
  assert.ok(!output.includes("finish_reason\":\"stop"), "终态错误后不再补 finish chunk");
  assert.ok(output.includes("[DONE]"), "应正常结束流");
  assert.equal(res.ended, true);
}

async function run(): Promise<void> {
  testPromptLengthDetection();
  await testHttp400PromptLengthMapsToContextLength();
  await testHttp413MapsToContextLength();
  await testOtherHttpErrorStaysGeneric();
  await testSsePromptLengthMapsToContextLength();
  await testStreamingInStreamPromptLengthEmitsErrorEvent();
  testNonStreamingErrorResponseIs400();
  testStreamingErrorResponseUsesErrorEvent();
  console.log("All context-length error mapping tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
