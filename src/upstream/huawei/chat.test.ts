/**
 * v2 无状态会话行为测试。
 *
 * v2 上游不保存会话状态：每个请求全量透传 messages，
 * 对话标识仅作为代理侧链状态/缓存追踪的索引（不会发送给上游）。
 *
 * 对话标识语义（add-account-routing）：
 * - 账号无关、跨系统提示词稳定；
 * - 来源链：codearts.chat_id → codearts.conversation_id → 首条 user 消息指纹；
 * - 三个来源均不可得时不绑定任何标识（不以随机值冒充稳定标识）。
 */
import assert from "assert";
import type {
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
} from "../../types/openai";
import { buildV2RequestBody } from "./chat-request";
import { buildChainKey } from "./conversation-id";
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

function deriveConversationId(messages: OpenAIChatMessage[]): string | undefined {
  return buildV2RequestBody(request(messages), session).conversationId;
}

// ---------------------------------------------------------------------------
// 对话标识派生
// ---------------------------------------------------------------------------

function testConversationIdStableForSameConversation(): void {
  const messages = [user("old"), user("next")];
  assert.equal(
    deriveConversationId(messages),
    deriveConversationId([...messages, user("later")]),
    "同一会话（首条 user 不变）应派生相同对话标识",
  );
}

function testConversationIdDiffersForDifferentFirstUserMessage(): void {
  const system = { role: "system" as const, content: "You are opencode.", refusal: null };
  const a = deriveConversationId([system, user("分析一下项目")]);
  const b = deriveConversationId([system, user("修一下这个 bug")]);
  assert.notEqual(a, b, "首条 user 不同应派生不同对话标识");
}

function testConversationIdIgnoresSystemPromptDrift(): void {
  const first = { role: "system" as const, content: "You are opencode. cwd=/a", refusal: null };
  const second = { role: "system" as const, content: "You are opencode. cwd=/b", refusal: null };
  assert.equal(
    deriveConversationId([first, user("同一个问题")]),
    deriveConversationId([second, user("同一个问题")]),
    "系统提示词漂移不应改变对话标识",
  );
}

function testConversationIdIgnoresAccountSwitch(): void {
  const other = { ...session, providerAccountId: "other-provider" } as StoredHuaweiSession;
  const messages = [user("同一个问题")];
  const a = buildV2RequestBody(request(messages), session);
  const b = buildV2RequestBody(request(messages), other);
  assert.equal(a.conversationId, b.conversationId, "切换账号不应改变对话标识");
  assert.notEqual(a.chainKey, b.chainKey, "但链状态键应按账号区分");
}

function testNoUserMessageMeansNoConversationId(): void {
  const system = { role: "system" as const, content: "You are a title generator.", refusal: null };
  const result = buildV2RequestBody(request([system]), session);
  assert.equal(result.conversationId, undefined, "无 user 消息时不应派生对话标识");
  assert.equal(result.chainKey, undefined, "无对话标识时不应维护链状态");
  assert.equal(result.identitySource, "none");
}

function testNoMessagesAtAllMeansNoConversationId(): void {
  const result = buildV2RequestBody(request([]), session);
  assert.equal(result.conversationId, undefined, "无任何消息时不应派生对话标识");
  assert.equal(result.identitySource, "none");
}

function testCallerChatIdOverrideWins(): void {
  const result = buildV2RequestBody(request([user("hi")], "pinned-chat-id"), session);
  assert.equal(result.conversationId, "pinned-chat-id", "调用方提供的 chat_id 应优先");
  assert.equal(result.identitySource, "body");
}

function testStableConversationKeyWinsOverFingerprint(): void {
  const req: OpenAIChatCompletionRequest = {
    model: "GLM-5.1",
    messages: [user("hi")],
    stream: false,
    codearts: { conversation_id: "stable-key-1" },
  };
  const result = buildV2RequestBody(req, session);
  assert.equal(result.identitySource, "stable-key");
  assert.ok(result.conversationId, "稳定对话键应派生出标识");
  assert.notEqual(result.conversationId, deriveConversationId([user("hi")]), "稳定对话键应不同于消息指纹");
}

function testChainKeyCombinesConversationAndAccount(): void {
  const result = buildV2RequestBody(request([user("hi")], "chat-x"), session);
  assert.equal(result.chainKey, buildChainKey("chat-x", "test-provider"));
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

testConversationIdStableForSameConversation();
testConversationIdDiffersForDifferentFirstUserMessage();
testConversationIdIgnoresSystemPromptDrift();
testConversationIdIgnoresAccountSwitch();
testNoUserMessageMeansNoConversationId();
testNoMessagesAtAllMeansNoConversationId();
testCallerChatIdOverrideWins();
testStableConversationKeyWinsOverFingerprint();
testChainKeyCombinesConversationAndAccount();
testEveryRequestCarriesFullHistory();
testToolContinuationDetection();

console.log("All v2 stateless chat behaviour tests passed.");
