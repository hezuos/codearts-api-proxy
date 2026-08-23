/**
 * 上游 prompt token 限制配置 + 主动重置测试。
 *
 * 覆盖：
 * - config.upstreamPromptTokenLimit / upstreamPromptTokenResetThreshold 默认值与 env 覆盖
 * - buildRequestBody 主动重置触发/跳过条件
 */
import assert from "assert";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const chatRequest = require("./chat-request") as typeof import("./chat-request");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { config } = require("../../config") as typeof import("../../config");

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

function testConfigDefaults(): void {
  assert.equal(
    config.upstreamPromptTokenLimit,
    196608,
    "default upstreamPromptTokenLimit should be 196608",
  );
  assert.equal(
    config.upstreamPromptTokenResetThreshold,
    180000,
    "default upstreamPromptTokenResetThreshold should be 180000",
  );
}

function testConfigThresholdLessThanLimit(): void {
  assert.ok(
    config.upstreamPromptTokenResetThreshold < config.upstreamPromptTokenLimit,
    "threshold must be less than limit",
  );
}

// ---------------------------------------------------------------------------
// Proactive reset in buildRequestBody
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const translate = require("./chat-translate") as typeof import("./chat-translate");
import { createHash } from "crypto";
import type { OpenAIChatMessage, OpenAIChatCompletionRequest } from "../../types/openai";

const session = {
  keyId: "test-key",
  providerAccountId: "test-provider",
} as import("../../auth/huawei/session-store").StoredHuaweiSession;

function user(content: string): OpenAIChatMessage {
  return { role: "user", content, refusal: null };
}

function assistant(content: string): OpenAIChatMessage {
  return { role: "assistant", content, refusal: null };
}

function hash(message: OpenAIChatMessage): string {
  return createHash("sha256")
    .update(translate.normalizeForChain(message))
    .digest("hex");
}

function seedChain(chatId: string, prefix: OpenAIChatMessage[], lastReply: OpenAIChatMessage): void {
  const chain = translate.computeChainForMessages(prefix);
  chatRequest.setChainState(chatId, {
    prefixChain: chain.hash,
    prefixLen: chain.length,
    lastReplyHash: hash(lastReply),
  });
  chatRequest.setLastResponseMessageId(chatId, "parent-1");
}

function request(chatId: string, messages: OpenAIChatMessage[]): OpenAIChatCompletionRequest {
  return {
    model: "GLM-5.1",
    messages,
    stream: false,
    codearts: { chat_id: chatId },
  };
}

function testProactiveResetTriggersOverThreshold(): void {
  const chatId = "a111111111111111111111111111111";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);
  chatRequest.setLastPromptTokens(chatId, 185000); // > 180000

  const result = chatRequest.buildRequestBody(
    request(chatId, [...prefix, lastReply, user("next")]),
    session,
  );

  assert.equal(result.divergence, "middle-damage", "should force middle-damage");
  assert.equal(result.body.parent_message_id, "", "should clear parent");
  assert.equal(result.proactiveReset, true, "should return proactiveReset=true");
}

function testProactiveResetSkipsUnderThreshold(): void {
  const chatId = "b222222222222222222222222222222";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);
  chatRequest.setLastPromptTokens(chatId, 150000); // < 180000

  const result = chatRequest.buildRequestBody(
    request(chatId, [...prefix, lastReply, user("next")]),
    session,
  );

  assert.equal(result.divergence, "normal", "should stay normal");
  assert.equal(result.body.parent_message_id, "parent-1", "should preserve parent");
  assert.equal(result.proactiveReset, false, "should return proactiveReset=false");
}

function testProactiveResetSkipsToolContinuation(): void {
  const chatId = "c333333333333333333333333333333";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);
  chatRequest.setLastPromptTokens(chatId, 185000);

  // tool continuation: last message is tool role
  const toolMsg: OpenAIChatMessage = {
    role: "tool",
    content: "tool result",
    refusal: null,
    tool_call_id: "call-1",
  };
  const result = chatRequest.buildRequestBody(
    request(chatId, [...prefix, lastReply, user("next"), toolMsg]),
    session,
  );

  assert.equal(result.proactiveReset, false, "tool continuation should not reset");
}

function testProactiveResetSkipsColdStart(): void {
  const chatId = "d444444444444444444444444444444";
  // No setLastResponseMessageId → no parent → cold start
  chatRequest.setLastPromptTokens(chatId, 185000);

  const result = chatRequest.buildRequestBody(
    request(chatId, [user("first message")]),
    session,
  );

  assert.equal(result.proactiveReset, false, "cold start should not reset");
}

function testProactiveResetSkipsUndefinedPromptTokens(): void {
  const chatId = "e555555555555555555555555555555";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);
  // No setLastPromptTokens → undefined

  const result = chatRequest.buildRequestBody(
    request(chatId, [...prefix, lastReply, user("next")]),
    session,
  );

  assert.equal(result.proactiveReset, false, "undefined promptTokens should not reset");
}

function testProactiveResetSkipsSubAgent(): void {
  const chatId = "f666666666666666666666666666666";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);
  chatRequest.setLastPromptTokens(chatId, 185000);

  const req = request(chatId, [...prefix, lastReply, user("next")]);
  req.codearts = { chat_id: chatId, sub_agent: { type: "test" } };
  const result = chatRequest.buildRequestBody(req, session);

  assert.equal(result.proactiveReset, false, "sub-agent should not reset");
}

function testProactiveResetSkipsCallerProvidedParent(): void {
  const chatId = "g777777777777777777777777777777";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);
  chatRequest.setLastPromptTokens(chatId, 185000);

  const req = request(chatId, [...prefix, lastReply, user("next")]);
  req.codearts = { chat_id: chatId, parent_message_id: "caller-provided-parent" };
  const result = chatRequest.buildRequestBody(req, session);

  assert.equal(result.proactiveReset, false, "caller-provided parent should not reset");
}

function testProactiveResetThresholdBoundary(): void {
  // == threshold → not triggered (strict >)
  const chatIdEq = "h888888888888888888888888888888";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatIdEq, prefix, lastReply);
  chatRequest.setLastPromptTokens(chatIdEq, 180000); // == threshold
  const resultEq = chatRequest.buildRequestBody(
    request(chatIdEq, [...prefix, lastReply, user("next")]),
    session,
  );
  assert.equal(resultEq.proactiveReset, false, "== threshold should not trigger");

  // threshold + 1 → triggered
  const chatIdGt = "i999999999999999999999999999999";
  seedChain(chatIdGt, prefix, lastReply);
  chatRequest.setLastPromptTokens(chatIdGt, 180001); // > threshold
  const resultGt = chatRequest.buildRequestBody(
    request(chatIdGt, [...prefix, lastReply, user("next")]),
    session,
  );
  assert.equal(resultGt.proactiveReset, true, "threshold+1 should trigger");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

testConfigDefaults();
testConfigThresholdLessThanLimit();
testProactiveResetTriggersOverThreshold();
testProactiveResetSkipsUnderThreshold();
testProactiveResetSkipsToolContinuation();
testProactiveResetSkipsColdStart();
testProactiveResetSkipsUndefinedPromptTokens();
testProactiveResetSkipsSubAgent();
testProactiveResetSkipsCallerProvidedParent();
testProactiveResetThresholdBoundary();

console.log("All proactive reset tests passed.");
