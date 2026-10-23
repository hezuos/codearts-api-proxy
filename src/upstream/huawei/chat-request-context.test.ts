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

/** v2 请求体无 parent_message_id；用 messages 形状代替断言。 */
function isSingleUserMessage(body: Record<string, unknown>): boolean {
  const messages = body.messages as Array<{ role?: string }>;
  return messages.length === 1 && messages[0]?.role === "user";
}

function testNormalContinuation(): void {
  const chatId = "11111111111111111111111111111111";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  const result = chatRequest.buildV2RequestBody(
    request(chatId, [...prefix, lastReply, user("next")]),
    session,
  );

  assert.equal(result.divergence, "normal");
  assert.equal(result.suffixStart, 3);
  assert.equal(bodyText(result.body), "next");
  assert.ok(isSingleUserMessage(result.body), "v2 热链续传仅发送最新 user turn");
}

function testTailDivergenceSkipsParentReply(): void {
  const chatId = "22222222222222222222222222222222";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  const result = chatRequest.buildV2RequestBody(
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

  const result = chatRequest.buildV2RequestBody(
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

  const result = chatRequest.buildV2RequestBody(
    request(chatId, [...prefix, lastReply, tool("unknown result", "unknown-call"), user("current")]),
    session,
  );

  assert.equal(result.divergence, "middle-damage");
  assert.ok(isSingleUserMessage(result.body), "middle-damage 应全量折叠为单条 user 消息");
}

function testDuplicateRequestAutoRepairs(): void {
  const chatId = "66666666666666666666666666666666";
  const prefix = [user("old"), assistant("old answer")];
  seedChain(chatId, prefix, assistant("new answer"));

  // duplicate/stale 不应抛错导致用户无法继续对话（issue: 用户重试后永久卡死）。
  // 应自动重置链并全量折叠重发当前历史。
  const result = chatRequest.buildV2RequestBody(request(chatId, prefix), session);
  assert.ok(result, "buildV2RequestBody should not throw on duplicate/stale");
  assert.equal(result.divergence, "duplicate/stale");
  assert.ok(isSingleUserMessage(result.body), "duplicate/stale 应全量折叠为单条 user 消息");
  const text = bodyText(result.body);
  assert.ok(text.includes("old"), "自动修复后应折叠当前历史（含旧 user）");
}

testNormalContinuation();
testTailDivergenceSkipsParentReply();
testTailDivergenceStartsAtBoundaryWhenReplyMissing();
testMiddleDamageResetsParent();
testUntraceableToolResetsParent();
testDuplicateRequestAutoRepairs();

// 纯工具段修复：T5/T8/T9/T10
//---------------------------------------------------------------------------

function assistantWithToolCallMsg(
  content: string,
  toolName: string,
  toolCallType: string | undefined,
): OpenAIChatMessage {
  return {
    role: "assistant",
    content,
    refusal: null,
    tool_calls: [
      {
        id: "call_1",
        ...(toolCallType === undefined ? {} : { type: toolCallType as "function" }),
        function: { name: toolName, arguments: "{}" },
      },
    ],
  } as unknown as OpenAIChatMessage;
}

// T5a：边界成立（归一化生效）——客户端 echo type 缺省时 suffixStart 应为 prefixLen+1
function testT5BoundaryMatchesAfterEchoNormalized(): void {
  const chatId = "77777777777777777777777777777777";
  const prefix = [user("old"), assistant("old answer")];
  // proxy 重建（chat.ts 风格：type="function"、无 reasoning）
  const reconstructed = assistantWithToolCallMsg("new reply", "find_path", "function");
  seedChain(chatId, prefix, reconstructed);
  // 客户端 echo：type 缺省、reasoning null
  const echo = assistantWithToolCallMsg("new reply", "find_path", undefined);
  const result = chatRequest.buildV2RequestBody(
    request(chatId, [...prefix, echo, tool("out", "call_1")]),
    session,
  );
  // 纯工具段无 user → 仍 tail-divergence，但边界成立（suffixStart=prefixLen+1=3）
  assert.equal(result.divergence, "tail-divergence");
  assert.equal(result.suffixStart, 3);
  const text = bodyText(result.body);
  assert.ok(text.includes("[tool result:"), "应携带工具结果");
  assert.ok(!text.includes("old"), "不得重复已确认的 user/system");
  assert.ok(!text.includes("[当前用户请求]"));
}

// T5b：echo + 可追溯 tool + 末尾 user → normal 恢复（P1 端到端效果）
function testT5NormalAfterToolPairAndUser(): void {
  const chatId = "7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b";
  const prefix = [user("old"), assistant("old answer")];
  const reconstructed = assistantWithToolCallMsg("new reply", "find_path", "function");
  seedChain(chatId, prefix, reconstructed);
  const echo = assistantWithToolCallMsg("new reply", "find_path", undefined);
  const result = chatRequest.buildV2RequestBody(
    request(chatId, [...prefix, echo, tool("out", "call_1"), user("next")]),
    session,
  );
  assert.equal(result.divergence, "normal");
  assert.equal(result.suffixStart, 3);
  assert.equal(bodyText(result.body), "next");
}

// T8：tail-divergence 纯工具段（边界不相等，suffixStart=prefixLen）
function testT8TailToolSegmentBoundaryMismatch(): void {
  const chatId = "88888888888888888888888888888888";
  const prefix = [user("old"), assistant("old answer")];
  seedChain(chatId, prefix, assistant("new answer"));
  const external = assistantWithToolCallMsg("外部回复", "find_path", "function");
  const result = chatRequest.buildV2RequestBody(
    request(chatId, [...prefix, external, { ...tool("file1", "call_1"), name: "find_path" }]),
    session,
  );
  assert.equal(result.divergence, "tail-divergence");
  assert.equal(result.suffixStart, 2);
  const text = bodyText(result.body);
  assert.ok(text.includes("[调用工具: find_path"), "含工具调用标注");
  assert.ok(text.includes("[tool result: find_path]"), "含工具结果标注");
  assert.ok(text.includes("file1"));
  assert.ok(!text.includes("old"), "不得重复首条 user 内容");
  assert.ok(!text.includes("[当前用户请求]"));
}

// T9：纯 tool 段（边界相等，suffixStart=prefixLen+1）
function testT9TailToolOnlyBoundaryMatch(): void {
  const chatId = "99999999999999999999999999999999";
  const prefix = [user("old"), assistant("old answer")];
  const reconstructed = assistantWithToolCallMsg("new reply", "find_path", "function");
  seedChain(chatId, prefix, reconstructed);
  const echo = assistantWithToolCallMsg("new reply", "find_path", undefined);
  const result = chatRequest.buildV2RequestBody(
    request(chatId, [...prefix, echo, tool("out", "call_1")]),
    session,
  );
  assert.equal(result.divergence, "tail-divergence");
  assert.equal(result.suffixStart, 3);
  const text = bodyText(result.body);
  assert.ok(text.includes("[tool result:"), "应携带工具结果");
  assert.ok(!text.includes("old"));
}

// T10：可追溯 tool + 末尾 user → normal（工具结果随增量前进）
function testT10TraceableToolWithUserNormal(): void {
  const chatId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const prefix = [user("old"), assistant("old answer")];
  const reconstructed = assistantWithToolCallMsg("new reply", "find_path", "function");
  seedChain(chatId, prefix, reconstructed);
  const echo = assistantWithToolCallMsg("new reply", "find_path", undefined);
  const result = chatRequest.buildV2RequestBody(
    request(chatId, [...prefix, echo, tool("out", "call_1"), user("next")]),
    session,
  );
  assert.equal(result.divergence, "normal");
  assert.equal(bodyText(result.body), "next");
}

testT5BoundaryMatchesAfterEchoNormalized();
testT5NormalAfterToolPairAndUser();
testT8TailToolSegmentBoundaryMismatch();
testT9TailToolOnlyBoundaryMatch();
testT10TraceableToolWithUserNormal();

// 传递通道正交（T16/T17/T18/T20；T19 由 testDuplicateRequestAutoRepairs 覆盖）
//---------------------------------------------------------------------------

function testT16ToolContinuationBypass(): void {
  const chatId = "1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b";
  const prefix = [user("old"), assistant("old answer")];
  seedChain(chatId, prefix, assistant("new answer"));
  const result = chatRequest.buildV2RequestBody(
    {
      ...request(chatId, [...prefix, user("next")]),
      codearts: {
        chat_id: chatId,
        tool_results: [{ toolCallId: "c1", name: "find_path", status: "success", result: "ok" }],
      },
    },
    session,
  );
  assert.equal(result.divergence, undefined, "tool continuation 旁路，不参与分类");
  assert.ok((result.body.messages as unknown[]).length >= 1, "tool continuation 应携带 tool 消息");
}

function testT17CallerParentBypass(): void {
  const chatId = "2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b";
  const prefix = [user("old"), assistant("old answer")];
  seedChain(chatId, prefix, assistant("new answer"));
  const result = chatRequest.buildV2RequestBody(
    {
      ...request(chatId, [...prefix, user("next")]),
      codearts: { chat_id: chatId, parent_message_id: "caller-parent" },
    },
    session,
  );
  assert.equal(result.divergence, undefined, "调用方提供 parent 时旁路检测");
  assert.ok(isSingleUserMessage(result.body), "调用方 parent 旁路时仅发送最新 user turn");
}

function testT18SubAgentBypass(): void {
  const chatId = "3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b";
  const prefix = [user("old"), assistant("old answer")];
  seedChain(chatId, prefix, assistant("new answer"));
  const result = chatRequest.buildV2RequestBody(
    {
      ...request(chatId, [...prefix, user("next")]),
      codearts: { chat_id: chatId, sub_agent: { type: "Explore" } },
    },
    session,
  );
  assert.equal(result.divergence, undefined, "子代理旁路，不受修复影响");
  assert.ok((result.body.messages as unknown[]).length >= 1, "子代理使用普通消息传递");
  assert.equal(result.body.isSubAgent, true, "子代理字段应透传");
  assert.equal(result.body.subAgent_type, "Explore");
}

function testT20ColdStartNoChain(): void {
  const chatId = "4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b"; // 未 seed：无链状态
  const result = chatRequest.buildV2RequestBody(request(chatId, [user("hello")]), session);
  assert.equal(result.divergence, undefined);
  const msgs = result.body.messages as Array<{ content?: string }>;
  assert.ok(msgs.length >= 1 && (msgs[0]?.content?.length ?? 0) > 0, "冷启动应有消息内容");
  assert.equal(result.body.model, "GLM-5.1");
  assert.equal(result.body.tool_stream, true);
  assert.equal(result.body.max_tokens, 65536, "默认 max_tokens 应为上游上限 64k");
}

testT16ToolContinuationBypass();
testT17CallerParentBypass();
testT18SubAgentBypass();
testT20ColdStartNoChain();

console.log("All warm-switch context repair request tests passed.");
