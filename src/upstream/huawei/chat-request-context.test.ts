/**
 * 热链分叉请求构造测试。
 *
 * 不访问真实 CodeArts，直接验证 proxy 构造的上游请求：
 * normal、tail-divergence、middle-damage、duplicate/stale、工具尾部。
 */
import assert from "assert";
import { createHash } from "crypto";
import type { OpenAIChatMessage, OpenAIChatCompletionRequest } from "../../types/openai";

process.env.CHAIN_DIVERGENCE_REPAIR_ENABLED = "true";
process.env.FULL_CONTEXT_INJECTION_ENABLED = "true";

// 配置必须在设置环境变量之后懒加载。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const chatRequest = require("./chat-request") as typeof import("./chat-request");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const translate = require("./chat-translate") as typeof import("./chat-translate");

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

function tool(content: string, toolCallId: string): OpenAIChatMessage {
  return { role: "tool", content, refusal: null, tool_call_id: toolCallId };
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

function bodyText(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ content?: string }>;
  return messages.map((message) => message.content ?? "").join("\n");
}

function testNormalContinuation(): void {
  const chatId = "11111111111111111111111111111111";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  const result = chatRequest.buildRequestBody(
    request(chatId, [...prefix, lastReply, user("next")]),
    session,
  );

  assert.equal(result.divergence, "normal");
  assert.equal(result.suffixStart, 3);
  assert.equal(result.body.parent_message_id, "parent-1");
  assert.equal(bodyText(result.body), "next");
}

function testTailDivergenceSkipsParentReply(): void {
  const chatId = "22222222222222222222222222222222";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  const result = chatRequest.buildRequestBody(
    request(chatId, [
      ...prefix,
      lastReply,
      user("external user"),
      assistant("external answer"),
      user("current"),
    ]),
    session,
  );
  const text = bodyText(result.body);

  assert.equal(result.divergence, "tail-divergence");
  assert.equal(result.suffixStart, 3);
  assert.equal(result.body.parent_message_id, "parent-1");
  assert.ok(text.includes("external user"));
  assert.ok(text.includes("external answer"));
  assert.ok(text.includes("[当前用户请求]"));
  assert.ok(!text.includes("new answer"), "parent 已覆盖的回复不可重复补发");
}

function testTailDivergenceStartsAtBoundaryWhenReplyMissing(): void {
  const chatId = "33333333333333333333333333333333";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  const result = chatRequest.buildRequestBody(
    request(chatId, [...prefix, user("external user"), user("current")]),
    session,
  );
  const text = bodyText(result.body);

  assert.equal(result.divergence, "tail-divergence");
  assert.equal(result.suffixStart, 2);
  assert.ok(text.includes("external user"));
}

function testMiddleDamageResetsParent(): void {
  const chatId = "44444444444444444444444444444444";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  const result = chatRequest.buildRequestBody(
    request(chatId, [user("edited old"), assistant("old answer"), lastReply, user("current")]),
    session,
  );

  assert.equal(result.divergence, "middle-damage");
  assert.equal(result.body.parent_message_id, "");
  assert.ok(bodyText(result.body).includes("edited old"));
}

function testUntraceableToolResetsParent(): void {
  const chatId = "55555555555555555555555555555555";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  const result = chatRequest.buildRequestBody(
    request(chatId, [...prefix, lastReply, tool("unknown result", "unknown-call"), user("current")]),
    session,
  );

  assert.equal(result.divergence, "middle-damage");
  assert.equal(result.body.parent_message_id, "");
}

function testDuplicateRequestIsRejected(): void {
  const chatId = "66666666666666666666666666666666";
  const prefix = [user("old"), assistant("old answer")];
  seedChain(chatId, prefix, assistant("new answer"));

  assert.throws(
    () => chatRequest.buildRequestBody(request(chatId, prefix), session),
    /重复或陈旧/,
  );
}

testNormalContinuation();
testTailDivergenceSkipsParentReply();
testTailDivergenceStartsAtBoundaryWhenReplyMissing();
testMiddleDamageResetsParent();
testUntraceableToolResetsParent();
testDuplicateRequestIsRejected();

console.log("All warm-switch context repair request tests passed.");
