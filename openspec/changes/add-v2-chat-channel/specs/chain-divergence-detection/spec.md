## MODIFIED Requirements

### Requirement: Chain state is tracked per conversation

The proxy SHALL maintain in memory for each resolved `chat_id` a chain state containing a prefix hash chain of the client's last confirmed message history, its length, and a hash of the latest assistant reply returned to the client. The state SHALL share the upstream parent-linkage TTL and SHALL be removed together with that linkage state. On the v2 channel, where the upstream does not return a CodeArts-native parent linkage identifier, the chain state SHALL be the primary basis for deciding whether a request continues an existing conversation or requires a full-context rebuild.

#### Scenario: Successful turn records client history state

- **WHEN** the proxy successfully completes an upstream turn
- **THEN** it SHALL compute the prefix chain from the client's original `request.messages`, not from any folded text sent upstream
- **AND** it SHALL store the newly returned assistant reply hash for the next suffix check

#### Scenario: Tool continuation updates state

- **GIVEN** a tool continuation bypasses divergence detection
- **WHEN** the upstream returns the next assistant response successfully
- **THEN** the proxy SHALL still update chain state from the complete client message history
- **AND** it SHALL store the new assistant response hash, not the preceding tool-call response hash

#### Scenario: State is absent after restart

- **GIVEN** the proxy restarts after serving a conversation
- **WHEN** the next request arrives
- **THEN** the in-memory chain state SHALL be treated as absent
- **AND** the request SHALL fall back to full-context injection rules

#### Scenario: Continuation without upstream parent linkage

- **GIVEN** the upstream channel does not return a parent linkage identifier
- **AND** the proxy has chain state for the resolved `chat_id`
- **WHEN** the proxy processes a follow-up request
- **THEN** the proxy SHALL use the chain state to decide whether the request is a valid continuation
- **AND** the proxy SHALL NOT depend on an upstream parent linkage identifier to continue the conversation

### Requirement: Message continuity hashes are canonical

The proxy SHALL include role, normalized content, name, refusal, reasoning content, tool linkage, and tool-call id/type/name/arguments when hashing messages. Tool calls SHALL be sorted by id before hashing so array-order-only changes do not create false divergence. When hashing an assistant reply that carries tool calls, the proxy SHALL canonicalize tool-call `type` (missing/empty and literal `"function"` SHALL normalize to the same value), coalesce absent and empty `reasoning_content` to the same value, and serialize `arguments` with identical rules as the client-side record, so the proxy's reconstructed assistant reply and the client's persisted copy of the same turn hash equal and are recognized as the same boundary message. Because the v2 channel returns `reasoning_content` by default, the proxy SHALL ensure that a reply carrying reasoning content hashes equal to the client's echoed copy of that same reply, so reasoning content does not cause false divergence.

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

#### Scenario: Reasoning content does not cause false divergence

- **GIVEN** the upstream v2 channel returned an assistant reply carrying `reasoning_content`
- **AND** the client echoes that reply back without `reasoning_content` (or with an empty value)
- **WHEN** the proxy classifies the next request
- **THEN** the proxy SHALL NOT classify the request as divergent solely because of the `reasoning_content` difference