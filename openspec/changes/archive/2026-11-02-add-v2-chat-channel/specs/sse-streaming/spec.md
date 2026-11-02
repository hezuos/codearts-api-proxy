## MODIFIED Requirements

### Requirement: REQ-SSE-001: Upstream SSE parsing

The system SHALL parse upstream streaming responses robustly even when event formatting includes heartbeats or mixed line formats. Malformed SSE data lines (JSON parse failure) SHALL be logged as warnings and skipped, not treated as fatal errors. The implementation SHALL use Node.js `Readable` stream utilities instead of a hand-written AsyncIterator. The parser SHALL accept both the CodeArts-native event shape and the OpenAI-compatible `choices[].delta` event shape emitted by the v2 channel.

**Rationale:** Upstream SSE streams may include non-standard formatting that must be handled gracefully. Network noise (proxy heartbeats, CDN injections) should not terminate the entire request. The v2 channel emits standard OpenAI chunks, so the parser must normalize both shapes into a single internal event representation.

#### Scenario: Heartbeats are ignored

- **GIVEN** the upstream stream emits heartbeat lines or non-payload keepalive frames
- **WHEN** the system processes the stream
- **THEN** the system SHALL ignore them without terminating the client stream

#### Scenario: Malformed JSON in SSE data is skipped

- **GIVEN** the upstream stream emits a `data:` line with invalid JSON
- **WHEN** the system parses the SSE stream
- **THEN** the system SHALL log a warning with the raw data (truncated)
- **AND** the system SHALL skip the malformed line and continue processing subsequent lines
- **AND** the system SHALL NOT terminate the client stream

#### Scenario: Stream uses Readable utility

- **WHEN** the system creates an SSE parser from an upstream response
- **THEN** the implementation SHALL use `for await...of` on a Node.js Readable or async generator
- **AND** the implementation SHALL NOT use a hand-written AsyncIterator with pending resolve queues

#### Scenario: OpenAI-compatible v2 chunk is normalized

- **GIVEN** the upstream v2 stream emits a chunk shaped as `{ choices: [{ index, delta, finish_reason }] }`
- **WHEN** the system parses the stream
- **THEN** the system SHALL normalize the chunk's `choices[0].delta` into the internal event representation
- **AND** the system SHALL preserve `delta.content`, `delta.reasoning_content`, and `delta.tool_calls`
- **AND** the system SHALL preserve `usage` fields when present

### Requirement: REQ-SSE-002: OpenAI delta stream emission

The system SHALL emit OpenAI-compatible streaming delta events to downstream clients.

**Rationale:** OpenAI streaming clients expect delta events in a specific format. The v2 channel already emits OpenAI-shaped deltas, so the proxy SHALL forward them without lossy re-shaping.

#### Scenario: Upstream partial output is forwarded incrementally

- **GIVEN** the upstream stream yields partial completion content
- **WHEN** the system processes each chunk
- **THEN** the system SHALL send one or more OpenAI-compatible delta events to the client
- **AND** the events SHALL be sent in order

#### Scenario: Reasoning content is forwarded

- **GIVEN** the upstream stream yields a delta carrying `reasoning_content`
- **WHEN** the system processes the chunk
- **THEN** the system SHALL include `reasoning_content` in the emitted client delta
- **AND** the system SHALL NOT merge reasoning content into the visible `content` field