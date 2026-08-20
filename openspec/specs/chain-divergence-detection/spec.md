---
spec: chain-divergence-detection
status: implemented
priority: high
created: 2026-08-20
updated: 2026-08-20
---

# Chain Divergence Detection

## Purpose

Detects when a conversation previously served through CodeArts diverges from the client's current message history, and repairs the upstream request by appending only a missing tail when the old chain is intact or rebuilding from scratch when it is not.

## Requirements

### Requirement: Chain state is tracked per conversation

The proxy SHALL maintain in memory for each resolved `chat_id` a chain state containing a prefix hash chain of the client's last confirmed message history, its length, and a hash of the latest assistant reply returned to the client. The state SHALL share the upstream parent-linkage TTL and SHALL be removed together with that linkage state.

#### Scenario: Successful turn records client history state

- **WHEN** the proxy successfully completes a CodeArts turn
- **THEN** it SHALL compute the prefix chain from the client's original `request.messages`, not from any folded text sent upstream
- **AND** it SHALL store the newly returned assistant reply hash for the next suffix check

#### Scenario: Tool continuation updates state

- **GIVEN** a tool continuation bypasses divergence detection
- **WHEN** CodeArts returns the next assistant response successfully
- **THEN** the proxy SHALL still update chain state from the complete client message history
- **AND** it SHALL store the new assistant response hash, not the preceding tool-call response hash

#### Scenario: State is absent after restart

- **GIVEN** the proxy restarts after serving a conversation
- **WHEN** the next request arrives
- **THEN** the in-memory chain state SHALL be treated as absent
- **AND** the request SHALL fall back to full-context injection rules

### Requirement: Message continuity hashes are canonical

The proxy SHALL include role, normalized content, name, refusal, reasoning content, tool linkage, and tool-call id/type/name/arguments when hashing messages. Tool calls SHALL be sorted by id before hashing so array-order-only changes do not create false divergence. When hashing an assistant reply that carries tool calls, the proxy SHALL canonicalize tool-call `type` (missing/empty and literal `"function"` SHALL normalize to the same value), coalesce absent and empty `reasoning_content` to the same value, and serialize `arguments` with identical rules as the client-side record, so the proxy's reconstructed assistant reply and the client's persisted copy of the same turn hash equal and are recognized as the same boundary message.

#### Scenario: Metadata changes are detected

- **GIVEN** two messages have the same visible content but different continuity metadata
- **WHEN** the proxy hashes them
- **THEN** their hashes SHALL differ

#### Scenario: Tool-call order does not cause false divergence

- **GIVEN** two messages contain the same tool calls in different array orders
- **WHEN** the proxy hashes them
- **THEN** their hashes SHALL be equal after canonical sorting

#### Scenario: Reconstructed reply hashes equal the client copy

- **GIVEN** a turn where the upstream returned an assistant reply carrying tool calls and reasoning content
- **AND** the client echoes that same reply back in its next history
- **WHEN** the proxy hashes the reconstructed reply and the client's echoed message
- **THEN** their hashes SHALL be equal despite differences such as tool-call `type` being missing versus `"function"`, or `reasoning_content` being absent versus empty

### Requirement: Divergence detection classifies the complete suffix

When the client does not provide a parent linkage and chain state exists, the proxy SHALL compare the tracked prefix and the entire suffix. It SHALL classify the request as normal continuation when the suffix is one valid turn, tail divergence when the prefix matches but the suffix contains explicit extra turns, or middle damage when the prefix fails or the suffix cannot be safely validated.

#### Scenario: Normal single-turn continuation

- **GIVEN** the tracked prefix matches
- **AND** the suffix begins with the tracked last assistant reply, contains only traceable tool results, and ends with exactly one user message
- **WHEN** the proxy classifies the request
- **THEN** it SHALL use incremental forwarding

#### Scenario: Tail divergence after provider switching

- **GIVEN** the tracked prefix matches
- **AND** the suffix contains an external provider turn such as `[lastReply, externalUser, externalAssistant, currentUser]`
- **WHEN** the proxy classifies the request
- **THEN** it SHALL classify the request as tail divergence
- **AND** it SHALL append the folded missing suffix using the tracked parent linkage

#### Scenario: Unverifiable suffix

- **GIVEN** the tracked prefix matches
- **AND** the suffix contains an untraceable tool message or an ambiguous role sequence
- **WHEN** the proxy classifies the request
- **THEN** it SHALL classify the request as middle damage
- **AND** it SHALL reset continuity and fold the complete client history

#### Scenario: Prefix mismatch

- **GIVEN** the tracked prefix does not match, or the client history is shorter than the tracked chain
- **WHEN** the proxy classifies the request
- **THEN** it SHALL classify the request as middle damage
- **AND** it SHALL reset continuity and fold the complete client history

#### Scenario: Duplicate or stale request

- **GIVEN** the client history length exactly equals the tracked chain length
- **AND** the complete history matches the tracked prefix
- **WHEN** the proxy classifies the request
- **THEN** it SHALL treat the request as duplicate or stale
- **AND** it SHALL NOT send the last user message to CodeArts again

### Requirement: Repair is independent from cold-start injection

`CHAIN_DIVERGENCE_REPAIR_ENABLED` SHALL control divergence repair independently from `FULL_CONTEXT_INJECTION_ENABLED`. Middle-damage resets and tail-divergence repair fallbacks SHALL still fold the full history when the repair flag is enabled even if the cold-start flag is disabled.

#### Scenario: Repair flag enabled alone

- **GIVEN** `CHAIN_DIVERGENCE_REPAIR_ENABLED=true` and `FULL_CONTEXT_INJECTION_ENABLED=false`
- **AND** divergence is classified as middle damage
- **WHEN** the proxy builds the request
- **THEN** it SHALL fold the full client history rather than forwarding only the latest user message

### Requirement: Requests excluded from divergence detection

Tool continuations, sub-agent requests, and requests with caller-provided `parent_message_id` SHALL bypass divergence detection and retain their existing continuity behavior.

#### Scenario: Tool continuation bypass

- **GIVEN** the request is a verified tool continuation
- **WHEN** the proxy processes it
- **THEN** it SHALL use empty `messages` and structured `task_parameters.tool_result`
- **AND** it SHALL not run divergence detection

#### Scenario: Sub-agent bypass

- **GIVEN** `codearts.sub_agent` is present
- **WHEN** the proxy processes the request
- **THEN** it SHALL preserve sub-agent behavior without divergence repair

#### Scenario: Caller parent bypass

- **GIVEN** the client supplies a non-empty `codearts.parent_message_id`
- **WHEN** the proxy processes the request
- **THEN** it SHALL trust that linkage and bypass divergence detection

### Requirement: Tail repair preserves tool segment semantics without repeating the first user message

When a tail-divergence repair is folded for a request whose missing suffix consists only of tool-segment messages (an assistant reply carrying tool calls followed by its tool results, with no new user message), the proxy SHALL forward the missing segment with its real semantics — the tool call and its results marked as tool execution output — and SHALL NOT substitute already-confirmed user or system messages from the client history as the new suffix. A tool-segment-only suffix SHALL be a valid tail repair and SHALL NOT be treated as a new user request. Content the client has already sent to CodeArts (its user or system messages) SHALL NOT be placed on the parent chain a second time as part of a tool-segment repair.

#### Scenario: Tool-segment tail repair sends tool context, not a confirmed user/system

- **GIVEN** chain state is tracked
- **AND** the client history appends only `[assistant(tool_call), tool(result)]` with no new user message
- **WHEN** the proxy builds the tail-divergence repair
- **THEN** it SHALL send the missing tool segment (assistant tool call and tool result content) to CodeArts using the tracked parent linkage
- **AND** it SHALL NOT send confirmed user or system messages from the client history as the request body

#### Scenario: Tool-only suffix is a valid repair

- **GIVEN** the tracked prefix matches
- **AND** the missing suffix is composed entirely of tool-segment messages with no user message
- **WHEN** the proxy classifies the request
- **THEN** it SHALL classify the request as tail divergence (not middle damage and not a duplicate/stale abort)
- **AND** it SHALL build a repair body that carries the tool context

#### Scenario: Tool result following the tracked reply is a valid repair

- **GIVEN** the tracked prefix matches
- **AND** the tracked last assistant reply already appears at the boundary (boundary is the tracked reply)
- **AND** the only missing suffix is the tool result for that reply
- **WHEN** the proxy builds the tail-divergence repair
- **THEN** it SHALL fold the tool result (with its tool name and truncated content) as the repair body
- **AND** it SHALL NOT include any confirmed user or system message from the client history in the repair

### Requirement: Tail repair failure falls back to full reset

If a tail-divergence repair fails upstream, the proxy SHALL retry once with empty `parent_message_id` and folded full client history. It SHALL not retry indefinitely.

#### Scenario: Streaming repair failure

- **WHEN** a streaming tail-divergence repair receives an upstream error
- **THEN** the proxy SHALL issue one full-reset retry
- **AND** it SHALL preserve the existing rate-limit retry path separately

#### Scenario: Non-streaming repair failure

- **WHEN** a non-streaming tail-divergence repair receives an upstream error
- **THEN** the proxy SHALL issue one full-reset retry
- **AND** it SHALL return the error if that retry also fails
