## MODIFIED Requirements

### REQ-SSE-001: Upstream SSE parsing

The system SHALL parse upstream streaming responses robustly even when event formatting includes heartbeats or mixed line formats. Malformed SSE data lines (JSON parse failure) SHALL be logged as warnings and skipped, not treated as fatal errors.

**Rationale:** Upstream SSE streams may include non-standard formatting that must be handled gracefully. Network noise (proxy heartbeats, CDN injections) should not terminate the entire request.

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

## ADDED Requirements

### Requirement: Upstream stream error propagation

The system SHALL propagate upstream response stream errors to the SSE consumer, rather than silently treating them as normal stream completion.

#### Scenario: Upstream connection reset during streaming

- **WHEN** the upstream HTTPS response stream emits an error event (e.g., connection reset)
- **THEN** the system SHALL throw the error in the SSE async iterator
- **AND** the streaming handler SHALL send an error chunk to the client before closing
- **AND** the system SHALL log the stream error

#### Scenario: Upstream connection reset during non-streaming

- **WHEN** the upstream HTTPS response stream emits an error event during non-streaming request
- **THEN** the system SHALL throw the error
- **AND** the error handler SHALL return an appropriate error response to the client
