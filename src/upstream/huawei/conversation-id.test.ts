/**
 * 对话标识稳定化测试（add-account-routing 组 1）。
 *
 * 覆盖：
 * - 1.1 稳定对话键字段与 X-Conversation-Id 请求头读取、解析失败时安全降级；
 * - 1.2 来源链优先级、账号无关、跨系统提示词稳定、无随机兜底；
 * - 1.3 链状态按 (对话标识, 账号) 组合，互不污染。
 */
import assert from "assert";
import type {
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
} from "../../types/openai";
import {
  applyConversationIdHeader,
  buildChainKey,
  resolveConversationIdentity,
} from "./conversation-id";
import {
  getLastResponseMessageId,
  setLastResponseMessageId,
  setChainState,
  getChainState,
} from "./chat-request";

function user(content: string): OpenAIChatMessage {
  return { role: "user", content, refusal: null };
}

function system(content: string): OpenAIChatMessage {
  return { role: "system", content, refusal: null };
}

function request(
  messages: OpenAIChatMessage[],
  codearts?: OpenAIChatCompletionRequest["codearts"],
): OpenAIChatCompletionRequest {
  return {
    model: "GLM-5.1",
    messages,
    stream: false,
    ...(codearts ? { codearts } : {}),
  };
}

// ---------------------------------------------------------------------------
// 1.1 稳定对话键字段与请求头读取
// ---------------------------------------------------------------------------

function testHeaderFillsConversationKey(): void {
  const req = request([user("hi")]);
  assert.equal(applyConversationIdHeader(req, "conv-1"), true, "请求头应写入对话键");
  assert.equal(req.codearts?.conversation_id, "conv-1");
}

function testHeaderDoesNotOverrideBody(): void {
  const req = request([user("hi")], { conversation_id: "from-body" });
  assert.equal(applyConversationIdHeader(req, "from-header"), false, "请求体优先，不应覆盖");
  assert.equal(req.codearts?.conversation_id, "from-body");
}

function testMissingHeaderIsNoop(): void {
  const req = request([user("hi")]);
  assert.equal(applyConversationIdHeader(req, undefined), false);
  assert.equal(applyConversationIdHeader(req, "   "), false, "空白请求头应被忽略");
  assert.equal(req.codearts, undefined, "无请求头时不应写入 codearts 扩展");
}

function testMalformedCodeartsDegradesSafely(): void {
  const req = request([user("hi")]);
  // 运行时可能收到非对象的 codearts 字段。
  (req as { codearts?: unknown }).codearts = "not-an-object";
  assert.equal(applyConversationIdHeader(req, "conv-2"), true, "非法 codearts 应安全重建而非抛错");
  assert.equal(req.codearts?.conversation_id, "conv-2");
}

// ---------------------------------------------------------------------------
// 1.2 来源链与稳定性
// ---------------------------------------------------------------------------

function testBodyChatIdWins(): void {
  const identity = resolveConversationIdentity(
    request([user("hi")], { chat_id: "body-id", conversation_id: "stable-id" }),
  );
  assert.equal(identity.conversationId, "body-id");
  assert.equal(identity.source, "body");
}

function testStableKeyWinsOverFingerprint(): void {
  const identity = resolveConversationIdentity(
    request([user("hi")], { conversation_id: "stable-id" }),
  );
  assert.equal(identity.source, "stable-key");
  assert.ok(identity.conversationId);
}

function testFingerprintFallbackIgnoresSystemPrompt(): void {
  const a = resolveConversationIdentity(request([system("cwd=/a"), user("问题")]));
  const b = resolveConversationIdentity(request([system("cwd=/b"), user("问题")]));
  assert.equal(a.source, "fingerprint");
  assert.equal(a.conversationId, b.conversationId, "系统提示词漂移不应改变指纹");
}

function testFingerprintDiffersForDifferentFirstUserMessage(): void {
  const a = resolveConversationIdentity(request([user("问题 A")]));
  const b = resolveConversationIdentity(request([user("问题 B")]));
  assert.notEqual(a.conversationId, b.conversationId);
}

function testNoUserMessageMeansNoIdentity(): void {
  const identity = resolveConversationIdentity(request([system("只有系统提示词")]));
  assert.equal(identity.conversationId, undefined, "无 user 消息不得派生标识");
  assert.equal(identity.source, "none");
}

function testEmptyMessagesMeansNoIdentity(): void {
  const identity = resolveConversationIdentity(request([]));
  assert.equal(identity.conversationId, undefined);
  assert.equal(identity.source, "none");
}

function testNoRandomFallback(): void {
  const first = resolveConversationIdentity(request([]));
  const second = resolveConversationIdentity(request([]));
  assert.equal(first.conversationId, undefined, "不得以随机值冒充稳定标识");
  assert.equal(second.conversationId, undefined);
}

// ---------------------------------------------------------------------------
// 1.3 链状态按 (对话标识, 账号) 组合
// ---------------------------------------------------------------------------

function testChainKeyCombinesConversationAndAccount(): void {
  assert.notEqual(
    buildChainKey("conv-1", "acc-A"),
    buildChainKey("conv-1", "acc-B"),
    "不同账号的链状态键应不同",
  );
  assert.equal(
    buildChainKey("conv-1", "acc-A"),
    buildChainKey("conv-1", "acc-A"),
    "相同组合应得到相同键",
  );
}

function testChainStateDoesNotCrossContaminate(): void {
  const keyA = buildChainKey("conv-shared", "acc-A");
  const keyB = buildChainKey("conv-shared", "acc-B");

  setLastResponseMessageId(keyA, "msg-from-A");
  setChainState(keyA, {
    prefixChain: "hash-a",
    prefixLen: 2,
    lastReplyHash: "reply-a",
  });

  assert.equal(getLastResponseMessageId(keyA), "msg-from-A");
  assert.equal(getLastResponseMessageId(keyB), undefined, "账号 B 不应读到账号 A 的消息标识");
  assert.equal(getChainState(keyB), undefined, "账号 B 不应读到账号 A 的链状态");
  assert.equal(getChainState(keyA)?.lastReplyHash, "reply-a");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

testHeaderFillsConversationKey();
testHeaderDoesNotOverrideBody();
testMissingHeaderIsNoop();
testMalformedCodeartsDegradesSafely();
testBodyChatIdWins();
testStableKeyWinsOverFingerprint();
testFingerprintFallbackIgnoresSystemPrompt();
testFingerprintDiffersForDifferentFirstUserMessage();
testNoUserMessageMeansNoIdentity();
testEmptyMessagesMeansNoIdentity();
testNoRandomFallback();
testChainKeyCombinesConversationAndAccount();
testChainStateDoesNotCrossContaminate();

console.log("All conversation identity tests passed.");
