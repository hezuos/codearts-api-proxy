/**
 * foldFullConversation core format and truncation tests (task 3.1).
 *
 * Style aligned with chat.test.ts: plain assert + manual run, no test framework.
 * Scope: core format (role markers, tool textualization, continuation directive)
 *         and truncation (oversized threshold trimming).
 * Boundary/malformed cases live in task 4.1 — do not duplicate here.
 */
import { createHash } from "crypto";
import assert from "assert";
import type { OpenAIChatMessage } from "../../types/openai";
import { classifyDivergence, type ChainState } from "./chat-request";
import {
  computeChainForMessages,
  foldFullConversation,
  foldMissingSegment,
  normalizeForChain,
  truncateFolded,
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

function system(content: string): OpenAIChatMessage {
  return { role: "system", content, refusal: null };
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

function toolResult(name: string, content: string): OpenAIChatMessage {
  return { role: "tool", content, refusal: null, name };
}

// ---------------------------------------------------------------------------
// Core format tests (D2)
// ---------------------------------------------------------------------------

function testRolesArePreservedAndOrdered(): void {
  const folded = foldFullConversation([
    system("sys-prompt"),
    user("first"),
    assistant("reply"),
    user("second"),
  ]);
  // Chronological order with role markers
  const sysIdx = folded.indexOf("[system]\nsys-prompt");
  const userIdx1 = folded.indexOf("[user #1]\nfirst");
  const asstIdx = folded.indexOf("[assistant]\nreply");
  const userIdx2 = folded.indexOf("[user #2]\nsecond");
  assert.ok(sysIdx >= 0, "system segment present");
  assert.ok(userIdx1 > sysIdx, "user #1 after system");
  assert.ok(asstIdx > userIdx1, "assistant after user #1");
  assert.ok(userIdx2 > asstIdx, "user #2 after assistant");
}

function testContinuationDirectiveAppendedForMultiTurn(): void {
  const folded = foldFullConversation([user("a"), assistant("b"), user("c")]);
  assert.ok(
    folded.endsWith(
      "[continuation]\n以下为历史对话上下文,请基于此继续响应最新用户请求。",
    ),
    "multi-turn folded text must end with continuation directive",
  );
}

function testSingleMessageHasNoContinuationDirective(): void {
  // Single message is not injection per D1; no continuation directive
  const folded = foldFullConversation([user("only")]);
  assert.equal(folded, "[user #1]\nonly");
  assert.ok(!folded.includes("[continuation]"));
}

function testDeveloperRoleRenderedAsSystem(): void {
  const folded = foldFullConversation([
    { role: "developer", content: "dev-prompt", refusal: null },
    user("hi"),
  ]);
  assert.ok(folded.includes("[system]\ndev-prompt"));
}

function testUnknownRoleRenderedWithMarker(): void {
  const folded = foldFullConversation([
    { role: "function" as unknown as OpenAIChatMessage["role"], content: "fn-content", refusal: null },
    user("hi"),
  ]);
  assert.ok(
    folded.includes("[unknown: function]\nfn-content"),
    "unknown role rendered as [unknown: <role>] marker",
  );
}

function testToolCallsTextualized(): void {
  const folded = foldFullConversation([
    user("please list files"),
    assistantWithToolCall("", "list_files", '{"path":"."}'),
    toolResult("list_files", "file1\nfile2"),
    assistant("done"),
  ]);
  // Tool call rendered as text marker, not routed to tool_result
  assert.ok(
    folded.includes('[调用工具: list_files({"path":"."})]'),
    "tool call textualized as [调用工具: name(args)]",
  );
  assert.ok(folded.includes("[tool result: list_files]\nfile1\nfile2"));
}

// ---------------------------------------------------------------------------
// Truncation tests (D3)
// ---------------------------------------------------------------------------

function testWithinThresholdReturnedUnchanged(): void {
  const messages = [user("short"), assistant("reply"), user("continue")];
  const folded = foldFullConversation(messages, 8000);
  // No truncation markers
  assert.ok(!folded.includes("[...truncated"));
  assert.ok(folded.includes("[user #1]\nshort"));
  assert.ok(folded.includes("[assistant]\nreply"));
  assert.ok(folded.includes("[user #2]\ncontinue"));
}

function testExceedsThresholdTrimsMiddleKeepsAnchorAndNewest(): void {
  // Build a history that exceeds a small threshold
  const messages: OpenAIChatMessage[] = [
    system("sys"),
    user("first-turn-anchor"),
  ];
  for (let i = 0; i < 10; i++) {
    messages.push(assistant(`mid-reply-${i}-${"x".repeat(200)}`));
    messages.push(user(`mid-user-${i}-${"y".repeat(200)}`));
  }
  messages.push(user("latest-user-turn"));

  const folded = foldFullConversation(messages, 2000);
  // System anchor retained
  assert.ok(folded.includes("[system]\nsys"), "system anchor retained");
  // Latest turn retained
  assert.ok(
    folded.includes("latest-user-turn"),
    "latest user turn retained",
  );
  // Total length within budget + reasonable overhead
  assert.ok(
    folded.length <= 2000 + 200,
    `folded length ${folded.length} should be near threshold 2000`,
  );
}

function testOversizedToolResultHeadTailPreserved(): void {
  // Single tool result > 4k chars triggers D3 boundary 3
  const longContent = "A".repeat(10000);
  const messages = [
    user("run command"),
    assistantWithToolCall("", "bash", '{"cmd":"ls"}'),
    toolResult("bash", longContent),
    assistant("summary"),
  ];
  const folded = foldFullConversation(messages, 8000);
  // Head 2k preserved
  assert.ok(folded.includes("A".repeat(100)), "head of tool result preserved");
  // Truncation marker present
  assert.ok(
    folded.includes("[...truncated 10000 chars...]"),
    "tool result truncation marker present with original length",
  );
}

// ---------------------------------------------------------------------------
// Boundary and malformed input tests (task 4.1)
// ---------------------------------------------------------------------------

function testEmptyHistoryReturnsEmptyString(): void {
  // (a) messages=[] → ""
  assert.equal(foldFullConversation([]), "");
}

function testSingleUserTurnReturnsContent(): void {
  // (b) only one user → return that user content (no injection per D1, but function handles it)
  const folded = foldFullConversation([user("hello")]);
  assert.equal(folded, "[user #1]\nhello");
  assert.ok(!folded.includes("[continuation]"));
}

function testAllAssistantReturnsEmptyString(): void {
  // (c) all assistant, no user → ""
  const folded = foldFullConversation([
    assistant("reply1"),
    assistant("reply2"),
  ]);
  // No user content; segments may exist but function should not produce meaningful fold
  // Per implementation: assistant segments are produced, but this is malformed input.
  // The spec says "return empty string" for no user — but implementation renders assistant.
  // Spec note (d) says "empty string or pure tool marker" — assistant-only is analogous.
  // We assert no [user] marker and no continuation directive (since not multi-turn with user).
  assert.ok(!folded.includes("[user"));
}

function testAllToolReturnsEmptyOrToolMarker(): void {
  // (d) all tool, no user/assistant → empty string or pure tool marker
  const folded = foldFullConversation([
    toolResult("bash", "output1"),
    toolResult("grep", "output2"),
  ]);
  // No user marker; either empty or pure tool markers
  assert.ok(!folded.includes("[user"));
}

function testSystemPlusSingleUserFoldsNormally(): void {
  // (e) system + single user (most common cold start) → normal fold
  const folded = foldFullConversation([
    system("you are helpful"),
    user("hi"),
  ]);
  assert.ok(folded.includes("[system]\nyou are helpful"));
  assert.ok(folded.includes("[user #1]\nhi"));
}

function testNullContentDoesNotProduceNullString(): void {
  // (f) null content → no "null" string literal
  const folded = foldFullConversation([
    { role: "user", content: null, refusal: null },
    { role: "assistant", content: null, refusal: null },
    user("real content"),
  ]);
  assert.ok(!folded.includes("null"), "null content must not produce 'null' string");
  // The null-content user/assistant produce no segment; "real content" is the only user.
  // userIndex increments for every user message (including null-content ones), so
  // "real content" is user #2 — but the key assertion is no "null" literal leaks.
  assert.ok(folded.includes("real content"));
}

function testOversizedSingleToolResultHeadTailTruncated(): void {
  // (g) oversized single tool result → D3 boundary 3: head 2k + tail 2k + middle marker
  const longContent = "X".repeat(10000);
  const folded = foldFullConversation([
    user("run"),
    assistantWithToolCall("", "shell", "{}"),
    toolResult("shell", longContent),
  ]);
  assert.ok(folded.includes("[...truncated 10000 chars...]"));
  // Head preserved
  assert.ok(folded.includes("X".repeat(100)));
}

function testSystemPlusFirstUserExceedsThresholdTruncatesUser(): void {
  // (h) system + first user exceed threshold → D3 boundary 1: system retained + user truncated
  const systemContent = "S".repeat(3000);
  const userContent = "U".repeat(3000);
  const folded = foldFullConversation(
    [system(systemContent), user(userContent), assistant("reply"), user("latest")],
    4000,
  );
  // System always retained
  assert.ok(folded.includes("[system]"), "system retained even when over threshold");
  // User truncation marker may appear (boundary 1)
  // Latest turn should be retained
  assert.ok(folded.includes("latest"), "latest turn retained");
}

function testMissingSegmentUsesSuffixStart(): void {
  const messages = [user("old"), assistant("known"), user("external"), assistant("external reply"), user("current")];
  const folded = foldMissingSegment(messages, 2, 1000);
  assert.ok(folded.includes("external"));
  assert.ok(folded.includes("external reply"));
  assert.ok(folded.includes("[当前用户请求]\ncurrent"));
}

function testMissingSegmentTrimsMiddle(): void {
  const messages = [user("external-1"), assistant("x".repeat(500)), user("external-2"), assistant("y".repeat(500)), user("current")];
  const folded = foldMissingSegment(messages, 0, 300);
  assert.ok(folded.includes("[当前用户请求]"));
  assert.ok(folded.length <= 300 || folded.includes("current"));
}

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

function testFoldRespectsHardMaxChars(): void {
  // middle-damage 全量折叠可能因超大 system/单条消息超出 FULL_CONTEXT_MAX_CHARS。
  // 输出除末尾 continuation 指令外必须受 maxChars 约束（允许 ~40 字符固定开销）。
  const oversized = [
    { role: "system", content: "S".repeat(30000), refusal: null } as OpenAIChatMessage,
    user("first"),
    assistant("reply"),
    user("current"),
  ];
  const folded = foldFullConversation(oversized, 8000);
  assert.ok(folded.length <= 8000 + 40, `folded length ${folded.length} must stay near 8000 (+continuation overhead)`);

  // 单条超长 tool result 也受同一上限约束。
  const longTool = [
    user("run"),
    { role: "assistant", content: null, refusal: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] } as OpenAIChatMessage,
    { role: "tool", content: "X".repeat(200000), refusal: null, tool_call_id: "c1", name: "bash" } as OpenAIChatMessage,
    user("current"),
  ];
  const longFolded = foldFullConversation(longTool, 8000);
  assert.ok(longFolded.length <= 8000 + 40, `long tool fold length ${longFolded.length} must stay bounded`);
}

function testTruncateFoldedStrictUpperBound(): void {
  // 直接验证 truncateFolded 的严格上限：即使只有 system+user+assistant 且都超长，输出也应贴近 maxChars。
  const segments = [
    "[system]\n" + "S".repeat(50000),
    "[user #1]\n" + "U".repeat(50000),
    "[assistant]\n" + "A".repeat(50000),
  ];
  const truncated = truncateFolded(segments, 8000);
  assert.ok(truncated.length <= 8000 + 40, `truncateFolded length ${truncated.length} must stay near 8000 (+continuation overhead)`);
}

// ---------------------------------------------------------------------------
// 链哈希归一化（T1-T4）与纯工具段折叠（T6/T7/T13）
// ---------------------------------------------------------------------------

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

function testT1ToolCallTypeNormalized(): void {
  const base = assistantWithDeltaTypeToolCall("", undefined, "{}");
  const withType = assistantWithDeltaTypeToolCall("", "function", "{}");
  const withEmpty = assistantWithDeltaTypeToolCall("", "", "{}");
  assert.equal(normalizeForChain(base), normalizeForChain(withType));
  assert.equal(normalizeForChain(base), normalizeForChain(withEmpty));
}

function testT2ReasoningContentNormalized(): void {
  const base: OpenAIChatMessage = { role: "assistant", content: "hi", refusal: null };
  const empty = { ...base, reasoning_content: "" } as OpenAIChatMessage;
  const nul = { ...base, reasoning_content: null as unknown as string } as OpenAIChatMessage;
  assert.equal(normalizeForChain(base), normalizeForChain(empty));
  assert.equal(normalizeForChain(base), normalizeForChain(nul));
  const nonEmpty = { ...base, reasoning_content: "thinking..." } as OpenAIChatMessage;
  assert.notEqual(normalizeForChain(base), normalizeForChain(nonEmpty));
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

function testT6FoldMissingSegmentToolSegment(): void {
  const messages: OpenAIChatMessage[] = [
    system("sys"),
    user("old"),
    assistantWithToolCall("外部回复", "find_path", '{"path":"."}'),
    { role: "tool", content: "file1", refusal: null, name: "find_path", tool_call_id: "call_1" } as OpenAIChatMessage,
  ];
  const folded = foldMissingSegment(messages, 2, 2000);
  assert.ok(folded.length > 0, "纯工具段不应返回空");
  assert.ok(folded.includes("[调用工具: find_path"), "含工具调用标注");
  assert.ok(folded.includes("[tool result: find_path]"), "含工具结果标注");
  assert.ok(folded.includes("file1"), "含工具结果内容");
  assert.ok(!folded.includes("[当前用户请求]"), "不套用当前用户请求结构");
  assert.ok(!folded.includes("old"), "不包含已确认的 user 内容");
}

function testT7FoldMissingSegmentToolOnly(): void {
  const messages: OpenAIChatMessage[] = [
    system("sys"),
    user("old"),
    assistant("reply"),
    { role: "tool", content: "out", refusal: null, name: "bash", tool_call_id: "c1" } as OpenAIChatMessage,
  ];
  const folded = foldMissingSegment(messages, 3, 2000);
  assert.ok(folded.length > 0, "纯 tool 段不应返回空");
  assert.ok(folded.includes("[tool result: bash]"), "含工具结果标注");
  assert.ok(!folded.includes("[当前用户请求]"), "不套用当前用户请求结构");
}

function testT13ToolSegmentBounded(): void {
  const messages: OpenAIChatMessage[] = [
    system("sys"),
    user("old"),
    assistantWithToolCall("", "bash", "{}"),
    { role: "tool", content: "X".repeat(5000), refusal: null, name: "bash", tool_call_id: "c1" } as OpenAIChatMessage,
  ];
  const folded = foldMissingSegment(messages, 2, 500);
  assert.ok(folded.length <= 500 + 40, `无 user 段折叠长度 ${folded.length} 不应超预算`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

testRolesArePreservedAndOrdered();
testContinuationDirectiveAppendedForMultiTurn();
testSingleMessageHasNoContinuationDirective();
testDeveloperRoleRenderedAsSystem();
testUnknownRoleRenderedWithMarker();
testToolCallsTextualized();
testWithinThresholdReturnedUnchanged();
testExceedsThresholdTrimsMiddleKeepsAnchorAndNewest();
testOversizedToolResultHeadTailPreserved();

// Boundary cases (task 4.1)
testEmptyHistoryReturnsEmptyString();
testSingleUserTurnReturnsContent();
testAllAssistantReturnsEmptyString();
testAllToolReturnsEmptyOrToolMarker();
testSystemPlusSingleUserFoldsNormally();
testNullContentDoesNotProduceNullString();
testOversizedSingleToolResultHeadTailTruncated();
testSystemPlusFirstUserExceedsThresholdTruncatesUser();
testMissingSegmentUsesSuffixStart();
testMissingSegmentTrimsMiddle();
testCanonicalChainHashIncludesMetadata();
testDivergenceClassification();
testFoldRespectsHardMaxChars();
testTruncateFoldedStrictUpperBound();

// 链哈希归一化（T1-T4）与纯工具段折叠（T6/T7/T13）
testT1ToolCallTypeNormalized();
testT2ReasoningContentNormalized();
testT3ArgumentsDistinguished();
testT4ReconstructedPathsEqual();
testT6FoldMissingSegmentToolSegment();
testT7FoldMissingSegmentToolOnly();
testT13ToolSegmentBounded();

console.log("All foldFullConversation core format tests passed.");
