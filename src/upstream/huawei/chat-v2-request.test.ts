/**
 * v2 请求体构造测试。
 *
 * 覆盖 v2 通道（OpenAI 兼容）请求体各场景：
 * 冷启动、热链续传、工具续传、子代理、max_tokens 默认值、tools 透传。
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

function assistantWithToolCall(
  content: string,
  toolCallId: string,
  toolName: string,
): OpenAIChatMessage {
  return {
    role: "assistant",
    content,
    refusal: null,
    tool_calls: [
      { id: toolCallId, type: "function", function: { name: toolName, arguments: "{}" } },
    ],
  } as unknown as OpenAIChatMessage;
}

function hash(message: OpenAIChatMessage): string {
  return createHash("sha256").update(translate.normalizeForChain(message)).digest("hex");
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

function request(
  chatId: string,
  messages: OpenAIChatMessage[],
  tools?: OpenAIChatCompletionRequest["tools"],
): OpenAIChatCompletionRequest {
  return {
    model: "glm-5.3",
    messages,
    stream: true,
    codearts: { chat_id: chatId },
    ...(tools ? { tools } : {}),
  };
}

function messagesOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return body.messages as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// 冷启动
// ---------------------------------------------------------------------------

function testColdStartSingleUserMessage(): void {
  const chatId = "v2-111111111111111111111111111111";
  const result = chatRequest.buildV2RequestBody(request(chatId, [user("hello")]), session);

  assert.equal(result.body.model, "glm-5.3", "model 应透传客户端 model");
  assert.equal(result.body.stream, true);
  assert.equal(result.body.tool_stream, true, "v2 应始终携带 tool_stream");
  assert.equal(result.body.max_tokens, 65536, "默认 max_tokens 应为上游上限 64k");
  const msgs = messagesOf(result.body);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[0].content, "hello");
  assert.equal(result.body.parent_message_id, undefined, "v2 不应携带 parent_message_id");
  assert.equal(result.body.chat_id, undefined, "v2 不应携带 chat_id");
  assert.equal(result.body.task_parameters, undefined, "v2 不应携带 task_parameters");
}

function testColdStartPassesThroughFullHistory(): void {
  const chatId = "v2-222222222222222222222222222222";
  const result = chatRequest.buildV2RequestBody(
    request(chatId, [user("old"), assistant("old answer"), user("next")]),
    session,
  );
  const msgs = messagesOf(result.body);
  assert.equal(msgs.length, 3, "v2 无状态上游：冷启动多轮历史应全量透传");
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[0].content, "old");
  assert.equal(msgs[1].role, "assistant");
  assert.equal(msgs[1].content, "old answer");
  assert.equal(msgs[2].role, "user");
  assert.equal(msgs[2].content, "next");
}

// ---------------------------------------------------------------------------
// 热链续传
// ---------------------------------------------------------------------------

function testWarmContinuationPassesThroughFullHistory(): void {
  const chatId = "v2-333333333333333333333333333333";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  const result = chatRequest.buildV2RequestBody(
    request(chatId, [...prefix, lastReply, user("next")]),
    session,
  );

  assert.equal(result.divergence, "normal");
  assert.equal(result.suffixStart, 3);
  const msgs = messagesOf(result.body);
  assert.equal(msgs.length, 4, "v2 无状态上游：热链续传也应全量透传");
  assert.equal(msgs[3].role, "user");
  assert.equal(msgs[3].content, "next");
}

function testTailDivergencePassesThroughFullHistory(): void {
  const chatId = "v2-444444444444444444444444444444";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  const result = chatRequest.buildV2RequestBody(
    request(chatId, [...prefix, lastReply, user("external"), assistant("ext answer"), user("current")]),
    session,
  );

  assert.equal(result.divergence, "tail-divergence");
  const msgs = messagesOf(result.body);
  assert.equal(msgs.length, 6, "尾部偏差同样全量透传（含外部交换）");
  assert.equal(msgs[5].role, "user");
  assert.equal(msgs[5].content, "current");
}

function testMiddleDamagePassesThroughFullHistory(): void {
  const chatId = "v2-555555555555555555555555555555";
  const prefix = [user("old"), assistant("old answer")];
  seedChain(chatId, prefix, assistant("new answer"));

  const result = chatRequest.buildV2RequestBody(
    request(chatId, [user("totally"), assistant("different"), user("current")]),
    session,
  );

  assert.equal(result.divergence, "middle-damage");
  const msgs = messagesOf(result.body);
  assert.equal(msgs.length, 3, "中段损伤同样全量透传（上游无状态，无需重置）");
}

// ---------------------------------------------------------------------------
// 工具续传
// ---------------------------------------------------------------------------

function testToolContinuationIncludesFullHistoryWithToolPair(): void {
  const chatId = "v2-666666666666666666666666666666";
  const prefix = [user("old"), assistant("old answer")];
  const lastReply = assistant("new answer");
  seedChain(chatId, prefix, lastReply);

  const toolCallAssistant = assistantWithToolCall(null as unknown as string, "call_1", "Bash");
  const result = chatRequest.buildV2RequestBody(
    request(chatId, [...prefix, lastReply, toolCallAssistant, tool("result text", "call_1")]),
    session,
  );

  assert.equal(result.isToolContinuation, true);
  const msgs = messagesOf(result.body);
  assert.equal(msgs.length, 5, "工具续传全量透传（含完整历史与工具交换）");
  assert.equal(msgs[3].role, "assistant");
  assert.ok(Array.isArray(msgs[3].tool_calls), "assistant 消息应携带 tool_calls");
  assert.equal(msgs[4].role, "tool");
  assert.equal(msgs[4].tool_call_id, "call_1");
  assert.equal(msgs[4].content, "result text");
}

function testNonTraceableToolResultPassesThroughAsToolMessage(): void {
  const chatId = "v2-777777777777777777777777777777";
  const prefix = [user("old"), assistant("old answer")];
  seedChain(chatId, prefix, assistant("new answer"));

  // 客户端只回传 tool 结果，历史中无匹配的 assistant tool_call。
  const result = chatRequest.buildV2RequestBody(
    request(chatId, [...prefix, user("next"), tool("orphan result", "call_orphan")]),
    session,
  );

  const msgs = messagesOf(result.body);
  assert.equal(msgs.length, 4, "不可追溯 tool 结果同样透传（模型自行理解）");
  assert.equal(msgs[3].role, "tool");
  assert.equal(msgs[3].content, "orphan result");
}

// ---------------------------------------------------------------------------
// 子代理
// ---------------------------------------------------------------------------

function testSubAgentFieldsPassthrough(): void {
  const chatId = "v2-888888888888888888888888888888";
  const result = chatRequest.buildV2RequestBody(
    {
      ...request(chatId, [user("explore the repo")]),
      codearts: { chat_id: chatId, sub_agent: { type: "Explore", prompt: "find files" } },
    },
    session,
  );

  assert.equal(result.body.isSubAgent, true, "子代理应透传 isSubAgent");
  assert.equal(result.body.subAgent_type, "Explore");
  assert.equal(result.body.subAgent_prompt, "find files");
}

function testSubAgentFiltersTools(): void {
  const chatId = "v2-999999999999999999999999999999";
  const tools = [
    { type: "function" as const, function: { name: "Bash", description: "", parameters: {} } },
    { type: "function" as const, function: { name: "Task", description: "", parameters: {} } },
    { type: "function" as const, function: { name: "Read", description: "", parameters: {} } },
  ];
  const result = chatRequest.buildV2RequestBody(
    {
      ...request(chatId, [user("explore")], tools),
      codearts: { chat_id: chatId, sub_agent: { type: "Explore" } },
    },
    session,
  );

  const forwarded = result.body.tools as Array<{ function: { name: string } }>;
  const names = forwarded.map((t) => t.function.name).sort();
  assert.deepEqual(names, ["Bash", "Read"], "子代理应仅携带缩减后的工具集");
}

// ---------------------------------------------------------------------------
// tools / max_tokens
// ---------------------------------------------------------------------------

function testToolsForwardedWhenProvided(): void {
  const chatId = "v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const tools = [
    { type: "function" as const, function: { name: "Bash", description: "run", parameters: {} } },
  ];
  const result = chatRequest.buildV2RequestBody(request(chatId, [user("hi")], tools), session);
  const forwarded = result.body.tools as Array<{ function: { name: string } }>;
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].function.name, "Bash");
}

function testToolsOmittedWhenAbsent(): void {
  const chatId = "v2-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const result = chatRequest.buildV2RequestBody(request(chatId, [user("hi")]), session);
  assert.equal(result.body.tools, undefined, "客户端未传 tools 时不应携带 tools");
}

function testMaxTokensOverride(): void {
  const chatId = "v2-cccccccccccccccccccccccccccccccc";
  const result = chatRequest.buildV2RequestBody(
    { ...request(chatId, [user("hi")]), max_tokens: 1024 },
    session,
  );
  assert.equal(result.body.max_tokens, 1024, "客户端指定 max_tokens 时应透传");
}

// ---------------------------------------------------------------------------
// v2 专有行为：max_tokens clamp / 上游恒流式 / forceResync 折叠 / 显式 tool_results
// ---------------------------------------------------------------------------

function testMaxTokensClampedToLimit(): void {
  const chatId = "v2-dddddddddddddddddddddddddddddddd";
  const result = chatRequest.buildV2RequestBody(
    { ...request(chatId, [user("hi")]), max_tokens: 999999 },
    session,
  );
  assert.equal(result.body.max_tokens, 65536, "超限 max_tokens 应 clamp 到 65536");
}

function testUpstreamStreamAlwaysTrue(): void {
  const chatId = "v2-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const result = chatRequest.buildV2RequestBody(
    { ...request(chatId, [user("hi")]), stream: false },
    session,
  );
  assert.equal(result.body.stream, true, "上游请求应始终 stream:true（非流式客户端由聚合路径处理）");
}

function testForceResyncFoldsToSingleUserMessage(): void {
  const chatId = "v2-ffffffffffffffffffffffffffffffff";
  const prefix = [user("old"), assistant("old answer")];
  seedChain(chatId, prefix, assistant("new answer"));

  const result = chatRequest.buildV2RequestBody(
    request(chatId, [...prefix, assistant("new answer"), user("next")]),
    session,
    { forceResync: true },
  );

  assert.equal(result.divergence, "middle-damage");
  const msgs = messagesOf(result.body);
  assert.equal(msgs.length, 1, "forceResync 逃生通道：折叠为单条 user 消息");
  assert.equal(msgs[0].role, "user");
}

function testExplicitToolResultsAppendedAsToolMessages(): void {
  const chatId = "v2-10101010101010101010101010101010";
  const result = chatRequest.buildV2RequestBody(
    {
      ...request(chatId, [user("next")]),
      codearts: {
        chat_id: chatId,
        tool_results: [{ toolCallId: "c1", name: "find_path", status: "success", result: "ok" }],
      },
    },
    session,
  );

  const msgs = messagesOf(result.body);
  // 全量透传 [user("next")] + 合成 [assistant(tool_calls), tool(result)]
  assert.equal(msgs.length, 3, "显式 tool_results 应合成为工具消息对附加");
  assert.equal(msgs[1].role, "assistant");
  assert.ok(Array.isArray(msgs[1].tool_calls));
  assert.equal(msgs[2].role, "tool");
  assert.equal(msgs[2].tool_call_id, "c1");
  assert.equal(msgs[2].content, "ok");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

testColdStartSingleUserMessage();
testColdStartPassesThroughFullHistory();
testWarmContinuationPassesThroughFullHistory();
testTailDivergencePassesThroughFullHistory();
testMiddleDamagePassesThroughFullHistory();
testToolContinuationIncludesFullHistoryWithToolPair();
testNonTraceableToolResultPassesThroughAsToolMessage();
testSubAgentFieldsPassthrough();
testSubAgentFiltersTools();
testToolsForwardedWhenProvided();
testToolsOmittedWhenAbsent();
testMaxTokensOverride();
testMaxTokensClampedToLimit();
testUpstreamStreamAlwaysTrue();
testForceResyncFoldsToSingleUserMessage();
testExplicitToolResultsAppendedAsToolMessages();

console.log("All v2 request body tests passed.");