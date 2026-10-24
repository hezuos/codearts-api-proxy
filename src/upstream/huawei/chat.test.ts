/**
 * v2 无状态会话行为测试。
 *
 * v2 上游不保存会话状态：每个请求全量透传 messages，
 * chat_id 仅作为代理侧链状态/缓存追踪的索引（不会发送给上游）。
 */
import assert from "assert";
import type {
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
} from "../../types/openai";
import { buildV2RequestBody } from "./chat-request";
import type { StoredHuaweiSession } from "../../auth/huawei/session-store";

const session = {
  keyId: "test-key",
  providerAccountId: "test-provider",
} as StoredHuaweiSession;

function user(content: string): OpenAIChatMessage {
  return { role: "user", content, refusal: null };
}

function tool(content: string, toolCallId: string): OpenAIChatMessage {
  return { role: "tool", content, refusal: null, tool_call_id: toolCallId };
}

function request(
  messages: OpenAIChatMessage[],
  chatId?: string,
): OpenAIChatCompletionRequest {
  return {
    model: "GLM-5.1",
    messages,
    stream: false,
    ...(chatId ? { codearts: { chat_id: chatId } } : {}),
  };
}

function deriveChatId(messages: OpenAIChatMessage[]): string {
  return buildV2RequestBody(request(messages), session).chatId;
}

// ---------------------------------------------------------------------------
// chat_id 派生
// ---------------------------------------------------------------------------

function testChatIdStableForSameConversation(): void {
  const messages = [user("old"), user("next")];
  assert.equal(
    deriveChatId(messages),
    deriveChatId([...messages, user("later")]),
    "同一会话（system + 首条 user 不变）应派生相同 chat_id",
  );
}

function testChatIdDiffersForDifferentFirstUserMessage(): void {
  const system = { role: "system" as const, content: "You are opencode.", refusal: null };
  const a = deriveChatId([system, user("分析一下项目")]);
  const b = deriveChatId([system, user("修一下这个 bug")]);
  assert.notEqual(a, b, "首条 user 不同应派生不同 chat_id");
}

function testChatIdFallsBackToSystemPrompt(): void {
  const system = { role: "system" as const, content: "You are a title generator.", refusal: null };
  assert.equal(
    deriveChatId([system]),
    deriveChatId([system]),
    "无 user 时应能稳定地从 system prompt 派生",
  );
}

function testChatIdIsRandomWithoutAnyContextMessage(): void {
  const a = deriveChatId([]);
  const b = deriveChatId([]);
  assert.match(a, /^[0-9a-f]{32}$/, "无上下文时应生成 32 位十六进制 chat_id");
  assert.notEqual(a, b, "无上下文每次应生成不同的 chat_id");
}

function testCallerChatIdOverrideWins(): void {
  const result = buildV2RequestBody(request([user("hi")], "pinned-chat-id"), session);
  assert.equal(result.chatId, "pinned-chat-id", "调用方提供的 chat_id 应优先");
}

// ---------------------------------------------------------------------------
// 无状态透传
// ---------------------------------------------------------------------------

function testEveryRequestCarriesFullHistory(): void {
  const messages = [user("old"), { role: "assistant" as const, content: "reply", refusal: null }, user("next")];
  const result = buildV2RequestBody(request(messages, "chat-1"), session);
  assert.equal(
    (result.body.messages as unknown[]).length,
    messages.length,
    "v2 无服务端会话状态：每个请求都应全量携带历史",
  );
}

function testToolContinuationDetection(): void {
  const result = buildV2RequestBody(
    request([user("run"), tool("output", "call_1")], "chat-2"),
    session,
  );
  assert.equal(result.isToolContinuation, true, "尾部 tool 消息应判定为工具续传");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

testChatIdStableForSameConversation();
testChatIdDiffersForDifferentFirstUserMessage();
testChatIdFallsBackToSystemPrompt();
testChatIdIsRandomWithoutAnyContextMessage();
testCallerChatIdOverrideWins();
testEveryRequestCarriesFullHistory();
testToolContinuationDetection();

console.log("All v2 stateless chat behaviour tests passed.");
