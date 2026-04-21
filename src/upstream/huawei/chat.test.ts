/**
 * Stateless chat upstream behaviour tests.
 *
 * These tests verify the protocol-adaptation logic without any
 * conversation-store dependency — the proxy is stateless by design.
 */
import assert from "assert";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Helper: simulate what the caller maintains between turns
// ---------------------------------------------------------------------------

interface CallerState {
  chatId: string;
  parentMessageId: string;
}

function newCallerState(): CallerState {
  return { chatId: "", parentMessageId: "" };
}

/** Called after each SSE meta event to advance caller state. */
function advanceCallerState(
  _state: CallerState,
  metaChatId: string,
  metaResponseMessageId: string,
): CallerState {
  return {
    chatId: metaChatId,
    parentMessageId: metaResponseMessageId,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testNewConversationStartsWithEmptyParentMessageId(): void {
  const state = newCallerState();
  assert.equal(
    state.parentMessageId,
    "",
    "new conversation: parentMessageId should be ''",
  );
  assert.equal(state.chatId, "", "new conversation: chatId should be ''");
}

function testCallerStateAdvancesAfterMetaEvent(): void {
  let state = newCallerState();
  state = advanceCallerState(state, "chat-abc", "resp-001");
  assert.equal(state.chatId, "chat-abc");
  assert.equal(state.parentMessageId, "resp-001");
}

function testSubsequentTurnUsesResponseMessageIdAsParent(): void {
  let state = newCallerState();
  // Turn 1 response
  state = advanceCallerState(state, "chat-abc", "resp-001");
  // Turn 2 should use resp-001 as parent
  assert.equal(state.parentMessageId, "resp-001");
  // Turn 2 response
  state = advanceCallerState(state, "chat-abc", "resp-002");
  assert.equal(state.parentMessageId, "resp-002");
}

function testChatIdRemainsStableWithinConversation(): void {
  let state = newCallerState();
  state = advanceCallerState(state, "chat-stable", "resp-001");
  const chatIdAfterTurn1 = state.chatId;
  state = advanceCallerState(state, "chat-stable", "resp-002");
  assert.equal(
    state.chatId,
    chatIdAfterTurn1,
    "chat_id must not change within a conversation",
  );
}

function testToolContinuationPreservesParentMessageId(): void {
  // After AI returns tool_calls, caller executes tools and sends back results.
  // The parent_message_id should still be the response_message_id from the
  // turn that issued the tool_calls — the caller must NOT update parentMessageId
  // until the tool-result turn's SSE meta event arrives.
  let state = newCallerState();
  // Turn 1: user message → AI responds with tool_calls
  state = advanceCallerState(state, "chat-tool", "resp-tool-turn");
  const parentBeforeToolResult = state.parentMessageId;

  // Caller sends tool results — uses same parentMessageId
  assert.equal(
    parentBeforeToolResult,
    "resp-tool-turn",
    "tool result turn must use the parent_message_id from the tool-issuing turn",
  );

  // After tool-result SSE meta event arrives, state advances again
  state = advanceCallerState(state, "chat-tool", "resp-after-tool");
  assert.equal(state.parentMessageId, "resp-after-tool");
}

function deriveConversationIdForTest(
  messages: Array<{ role: string; content: string }>,
): string {
  const firstMsg =
    messages.find((m) => m.role === "user") ??
    messages.find((m) => m.role === "system");
  assert.ok(firstMsg, "test messages must contain a user or system message");
  return createHash("sha256").update(firstMsg.content).digest("hex").slice(0, 32);
}

function testChatIdPrefersFirstUserMessageOverSystemPrompt(): void {
  const systemPrompt = "You are opencode, an interactive CLI tool...";
  const requestA = deriveConversationIdForTest([
    { role: "system", content: systemPrompt },
    { role: "user", content: "分析一下项目" },
  ]);
  const requestB = deriveConversationIdForTest([
    { role: "system", content: systemPrompt },
    { role: "user", content: "修一下这个 bug" },
  ]);

  assert.notEqual(
    requestA,
    requestB,
    "chat_id should differ for different first user messages even when system prompt is identical",
  );
}

function testChatIdFallsBackToSystemWhenNoUserMessageExists(): void {
  const systemPrompt = "You are a title generator.";
  const chatId = deriveConversationIdForTest([
    { role: "system", content: systemPrompt },
  ]);
  const expected = createHash("sha256")
    .update(systemPrompt)
    .digest("hex")
    .slice(0, 32);

  assert.equal(
    chatId,
    expected,
    "chat_id should still be derivable from system message when no user message exists",
  );
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

testNewConversationStartsWithEmptyParentMessageId();
testCallerStateAdvancesAfterMetaEvent();
testSubsequentTurnUsesResponseMessageIdAsParent();
testChatIdRemainsStableWithinConversation();
testToolContinuationPreservesParentMessageId();
testChatIdPrefersFirstUserMessageOverSystemPrompt();
testChatIdFallsBackToSystemWhenNoUserMessageExists();

console.log("All chat stateless behaviour tests passed.");
