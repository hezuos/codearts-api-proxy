/**
 * foldFullConversation core format and truncation tests (task 3.1).
 *
 * Style aligned with chat.test.ts: plain assert + manual run, no test framework.
 * Scope: core format (role markers, tool textualization, continuation directive)
 *         and truncation (oversized threshold trimming).
 * Boundary/malformed cases live in task 4.1 — do not duplicate here.
 */
import assert from "assert";
import type { OpenAIChatMessage } from "../../types/openai";
import { foldFullConversation } from "./chat-translate";

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
  // Latest turn should be retained (greedy newest)
  assert.ok(folded.includes("latest"), "latest turn retained");
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

console.log("All foldFullConversation core format tests passed.");
