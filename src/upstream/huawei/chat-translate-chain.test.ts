/**
 * 链哈希归一化（T1-T5）与 v2 tool_call 分片累加测试。
 *
 * 折叠/截断相关用例已随 foldFullConversation 一并移除。
 * 风格与项目其他测试一致：assert + 手动串联运行，无测试框架。
 */
import { createHash } from "crypto";
import assert from "assert";
import type { OpenAIChatMessage } from "../../types/openai";
import { classifyDivergence, type ChainState } from "./chat-request";
import {
  cleanToolCalls,
  computeChainForMessages,
  flushToolCallDeltas,
  mergeToolCallDeltas,
  normalizeForChain,
  type ToolCallAccumulator,
} from "./chat-translate";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function user(content: string): OpenAIChatMessage {
  return { role: "user", content, refusal: null };
}

function assistant(content: string): OpenAIChatMessage {
  return { role: "assistant", content, refusal: null };
}

function assistantWithToolCall(
  content: string,
  toolName: string,
  args: string,
): OpenAIChatMessage {
  return {
    role: "assistant",
    content,
    refusal: null,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: toolName, arguments: args },
      },
    ],
  };
}

function assistantWithDeltaTypeToolCall(
  content: string,
  toolCallType: string | undefined,
  args: string,
): OpenAIChatMessage {
  return {
    role: "assistant",
    content,
    refusal: null,
    tool_calls: [
      {
        id: "call_1",
        ...(toolCallType === undefined ? {} : { type: toolCallType as "function" }),
        function: { name: "Read", arguments: args },
      },
    ],
  } as unknown as OpenAIChatMessage;
}

// ---------------------------------------------------------------------------
// 链指纹与分叉分类
// ---------------------------------------------------------------------------

function testCanonicalChainHashIncludesMetadata(): void {
  const first: OpenAIChatMessage = {
    ...assistantWithToolCall("", "Read", "{}"),
    tool_calls: [
      { id: "b", type: "function", function: { name: "B", arguments: "{}" } },
      { id: "a", type: "function", function: { name: "A", arguments: "{}" } },
    ],
  };
  const reordered = { ...first, tool_calls: [...(first.tool_calls ?? [])].reverse() };
  assert.equal(normalizeForChain(first), normalizeForChain(reordered));
  assert.notEqual(
    normalizeForChain(first),
    normalizeForChain({ ...first, tool_call_id: "different" }),
  );
  const prefix = computeChainForMessages([user("a"), assistant("b")]);
  const full = computeChainForMessages([user("a"), assistant("b"), user("c")]);
  assert.notEqual(prefix.hash, full.hash);
}

function testDivergenceClassification(): void {
  const prefixMessages = [user("old"), assistant("reply")];
  const prefix = computeChainForMessages(prefixMessages);
  const hash = (message: OpenAIChatMessage): string =>
    createHash("sha256").update(normalizeForChain(message)).digest("hex");
  const state: ChainState = { prefixChain: prefix.hash, prefixLen: prefix.length, lastReplyHash: hash(assistant("new reply")) };
  const normal = classifyDivergence([...prefixMessages, assistant("new reply"), user("next")], state);
  assert.equal(normal.divergence, "normal");
  assert.equal(normal.suffixStart, 3);
  const tail = classifyDivergence([...prefixMessages, assistant("new reply"), user("external"), assistant("external reply"), user("next")], state);
  assert.equal(tail.divergence, "tail-divergence");
  assert.equal(tail.suffixStart, 3);
  const middle = classifyDivergence([user("changed"), assistant("reply"), assistant("new reply"), user("next")], state);
  assert.equal(middle.divergence, "middle-damage");
  const stale = classifyDivergence(prefixMessages, state);
  assert.equal(stale.divergence, "duplicate/stale");
}

// ---------------------------------------------------------------------------
// 链哈希归一化（T1-T4）
// ---------------------------------------------------------------------------

function testT1ToolCallTypeNormalized(): void {
  const base = assistantWithDeltaTypeToolCall("", undefined, "{}");
  const withType = assistantWithDeltaTypeToolCall("", "function", "{}");
  const withEmpty = assistantWithDeltaTypeToolCall("", "", "{}");
  assert.equal(normalizeForChain(base), normalizeForChain(withType));
  assert.equal(normalizeForChain(base), normalizeForChain(withEmpty));
}

function testT2ReasoningContentNormalized(): void {
  // v2 通道默认返回 reasoning_content，而客户端回传时可能不带（或为空）。
  // 链指纹统一忽略该字段，因此带/不带 reasoning 的同一回复哈希相等。
  const base: OpenAIChatMessage = { role: "assistant", content: "hi", refusal: null };
  const empty = { ...base, reasoning_content: "" } as OpenAIChatMessage;
  const nul = { ...base, reasoning_content: null as unknown as string } as OpenAIChatMessage;
  assert.equal(normalizeForChain(base), normalizeForChain(empty));
  assert.equal(normalizeForChain(base), normalizeForChain(nul));
  const nonEmpty = { ...base, reasoning_content: "thinking..." } as OpenAIChatMessage;
  assert.equal(
    normalizeForChain(base),
    normalizeForChain(nonEmpty),
    "reasoning_content 不应影响链指纹（避免 v2 下误判 divergence）",
  );
}

function testT3ArgumentsDistinguished(): void {
  const make = (args: string): OpenAIChatMessage =>
    ({
      role: "assistant",
      content: "",
      refusal: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: args } }],
    }) as unknown as OpenAIChatMessage;
  assert.equal(normalizeForChain(make('{"a":1}')), normalizeForChain(make('{"a":1}')));
  assert.notEqual(normalizeForChain(make('{"a":1}')), normalizeForChain(make('{"a":2}')));
}

function testT5ReasoningReplyHashesEqualClientCopy(): void {
  // v2 通道返回带 reasoning_content 的回复；客户端回传时可能不带 reasoning。
  // 两者哈希应相等，否则会被误判为 divergence。
  const proxyReply: OpenAIChatMessage = {
    role: "assistant",
    content: "answer",
    refusal: null,
    reasoning_content: "let me think...",
  } as OpenAIChatMessage;
  const clientEcho: OpenAIChatMessage = {
    role: "assistant",
    content: "answer",
    refusal: null,
  };
  assert.equal(
    normalizeForChain(proxyReply),
    normalizeForChain(clientEcho),
    "带 reasoning 的回复应与客户端回传的无 reasoning 副本哈希相等",
  );
}

function testT4ReconstructedPathsEqual(): void {
  // chat-stream.ts 风格：无 reasoning、type 缺省
  const streamStyle: OpenAIChatMessage = {
    role: "assistant",
    content: "reply",
    refusal: null,
    tool_calls: [{ id: "c1", function: { name: "Bash", arguments: "{}" } }],
  } as unknown as OpenAIChatMessage;
  // chat.ts 风格：含空 reasoning、type="function"
  const chatStyle: OpenAIChatMessage = {
    role: "assistant",
    content: "reply",
    refusal: null,
    reasoning_content: "",
    tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: "{}" } }],
  } as unknown as OpenAIChatMessage;
  assert.equal(normalizeForChain(streamStyle), normalizeForChain(chatStyle));
}

// ---------------------------------------------------------------------------
// v2 tool_call 分片累加（非流式聚合）
// ---------------------------------------------------------------------------

function testMergeToolCallFragmentsIntoOneCall(): void {
  const acc = new Map<number, ToolCallAccumulator>();
  mergeToolCallDeltas(acc, [
    { index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } },
  ]);
  mergeToolCallDeltas(acc, [{ index: 0, function: { arguments: '{"city": "杭州' } }]);
  mergeToolCallDeltas(acc, [{ index: 0, function: { arguments: '"}' } }]);

  const calls = cleanToolCalls(flushToolCallDeltas(acc));
  assert.ok(calls && calls.length === 1, "分片应合并为单个 tool_call");
  assert.equal(calls[0]?.id, "call_1");
  assert.equal(calls[0]?.function.name, "get_weather");
  assert.equal(calls[0]?.function.arguments, '{"city": "杭州"}');
}

function testMergeKeepsParallelCallsSeparate(): void {
  const acc = new Map<number, ToolCallAccumulator>();
  mergeToolCallDeltas(acc, [
    { index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "" } },
    { index: 1, id: "call_b", type: "function", function: { name: "grep", arguments: "" } },
  ]);
  mergeToolCallDeltas(acc, [
    { index: 0, function: { arguments: '{"path": "a.ts"}' } },
    { index: 1, function: { arguments: '{"pattern": "TODO"}' } },
  ]);

  const calls = cleanToolCalls(flushToolCallDeltas(acc));
  assert.ok(calls && calls.length === 2, "并行调用应按 index 分开");
  assert.equal(calls[0]?.function.name, "read_file");
  assert.equal(calls[0]?.function.arguments, '{"path": "a.ts"}');
  assert.equal(calls[1]?.function.name, "grep");
  assert.equal(calls[1]?.function.arguments, '{"pattern": "TODO"}');
}

function testMergeSupportsTopLevelNameAndArguments(): void {
  const acc = new Map<number, ToolCallAccumulator>();
  mergeToolCallDeltas(acc, [{ index: 0, id: "call_2", name: "bash", arguments: { command: "ls" } }]);

  const calls = cleanToolCalls(flushToolCallDeltas(acc));
  assert.ok(calls && calls.length === 1);
  assert.equal(calls[0]?.function.name, "bash");
  assert.equal(calls[0]?.function.arguments, '{"command":"ls"}');
}

function testMergeWithoutDeltasReturnsUndefined(): void {
  assert.equal(flushToolCallDeltas(new Map()), undefined);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

testCanonicalChainHashIncludesMetadata();
testDivergenceClassification();
testT1ToolCallTypeNormalized();
testT2ReasoningContentNormalized();
testT3ArgumentsDistinguished();
testT4ReconstructedPathsEqual();
testT5ReasoningReplyHashesEqualClientCopy();
testMergeToolCallFragmentsIntoOneCall();
testMergeKeepsParallelCallsSeparate();
testMergeSupportsTopLevelNameAndArguments();
testMergeWithoutDeltasReturnsUndefined();

console.log("All chat-translate chain/merge tests passed.");
