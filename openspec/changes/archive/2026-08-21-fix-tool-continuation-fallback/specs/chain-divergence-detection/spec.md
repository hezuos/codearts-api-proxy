## MODIFIED Requirements

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

## ADDED Requirements

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
