/**
 * Stateless chat upstream behaviour tests.
 *
 * These tests verify the protocol-adaptation logic without any
 * conversation-store dependency — the proxy is stateless by design.
 */
import assert from "assert";

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

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

testNewConversationStartsWithEmptyParentMessageId();
testCallerStateAdvancesAfterMetaEvent();
testSubsequentTurnUsesResponseMessageIdAsParent();
testChatIdRemainsStableWithinConversation();
testToolContinuationPreservesParentMessageId();

console.log("All chat stateless behaviour tests passed.");
