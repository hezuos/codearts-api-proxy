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

The proxy SHALL include role, normalized content, name, refusal, reasoning content, tool linkage, and tool-call id/type/name/arguments when hashing messages. Tool calls SHALL be sorted by id before hashing so array-order-only changes do not create false divergence.

#### Scenario: Metadata changes are detected

- **GIVEN** two messages have the same visible content but different continuity metadata
- **WHEN** the proxy hashes them
- **THEN** their hashes SHALL differ

#### Scenario: Tool-call order does not cause false divergence

- **GIVEN** two messages contain the same tool calls in different array orders
- **WHEN** the proxy hashes them
- **THEN** their hashes SHALL be equal after canonical sorting

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
