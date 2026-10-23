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

function testColdStartFoldsHistoryWhenInjectionEnabled(): void {
  const chatId = "v2-222222222222222222222222222222";
  const result = chatRequest.buildV2RequestBody(
    request(chatId, [user("old"), assistant("old answer"), user("next")]),
    session,
  );
  const msgs = messagesOf(result.body);
  assert.equal(msgs.length, 1, "冷启动多轮历史应折叠为单条 user 消息");
  assert.equal(msgs[0].role, "user");
  assert.ok(String(msgs[0].content).includes("old"), "折叠内容应包含历史");
}

// ---------------------------------------------------------------------------
// 热链续传
// ---------------------------------------------------------------------------

function testWarmContinuationSendsOnlyLatestTurn(): void {
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
  assert.equal(msgs.length, 1, "热链续传仅发送最新 user turn");
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[0].content, "next");
}

function testTailDivergenceFoldsMissingSegment(): void {
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
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, "user");
  assert.ok(String(msgs[0].content).includes("external"));
}

function testMiddleDamageFoldsFullContext(): void {
  const chatId = "v2-555555555555555555555555555555";
  const prefix = [user("old"), assistant("old answer")];
  seedChain(chatId, prefix, assistant("new answer"));

  const result = chatRequest.buildV2RequestBody(
    request(chatId, [user("totally"), assistant("different"), user("current")]),
    session,
  );

  assert.equal(result.divergence, "middle-damage");
  const msgs = messagesOf(result.body);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, "user");
}

// ---------------------------------------------------------------------------
// 工具续传
// ---------------------------------------------------------------------------

function testToolContinuationEmitsAssistantToolPair(): void {
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
  assert.equal(msgs.length, 2, "工具续传应发送 [assistant(tool_calls), tool(result)] 消息对");
  assert.equal(msgs[0].role, "assistant");
  assert.ok(Array.isArray(msgs[0].tool_calls), "assistant 消息应携带 tool_calls");
  assert.equal(msgs[1].role, "tool");
  assert.equal(msgs[1].tool_call_id, "call_1");
  assert.equal(msgs[1].content, "result text");
}

function testToolContinuationWithoutMatchingAssistantFallsBackToUserText(): void {
  const chatId = "v2-777777777777777777777777777777";
  const prefix = [user("old"), assistant("old answer")];
  seedChain(chatId, prefix, assistant("new answer"));

  // 客户端只回传 tool 结果，历史中无匹配的 assistant tool_call。
  // 该 tool 结果不可追溯，被分叉分类归为 tail-divergence，
  // 降级为折叠缺失尾部（仅保留最新 user turn）。
  const result = chatRequest.buildV2RequestBody(
    request(chatId, [...prefix, user("next"), tool("orphan result", "call_orphan")]),
    session,
  );

  const msgs = messagesOf(result.body);
  assert.equal(msgs.length, 1, "不可追溯的 tool 结果应降级为单条 user 消息");
  assert.equal(msgs[0].role, "user");
  assert.ok(String(msgs[0].content).includes("next"), "应保留最新 user turn");
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
// Run
// ---------------------------------------------------------------------------

testColdStartSingleUserMessage();
testColdStartFoldsHistoryWhenInjectionEnabled();
testWarmContinuationSendsOnlyLatestTurn();
testTailDivergenceFoldsMissingSegment();
testMiddleDamageFoldsFullContext();
testToolContinuationEmitsAssistantToolPair();
testToolContinuationWithoutMatchingAssistantFallsBackToUserText();
testSubAgentFieldsPassthrough();
testSubAgentFiltersTools();
testToolsForwardedWhenProvided();
testToolsOmittedWhenAbsent();
testMaxTokensOverride();

console.log("All v2 request body tests passed.");