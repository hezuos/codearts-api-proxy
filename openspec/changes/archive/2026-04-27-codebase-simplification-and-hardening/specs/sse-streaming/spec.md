## MODIFIED Requirements

### REQ-SSE-001: Upstream SSE parsing
The system SHALL parse upstream streaming responses robustly even when event formatting includes heartbeats or mixed line formats. The implementation SHALL use Node.js `Readable` stream utilities instead of a hand-written AsyncIterator.

#### Scenario: Heartbeats are ignored
- **GIVEN** the upstream stream emits heartbeat lines or non-payload keepalive frames
- **WHEN** the system processes the stream
- **THEN** the system SHALL ignore them without terminating the client stream

#### Scenario: Stream uses Readable utility
- **WHEN** the system creates an SSE parser from an upstream response
- **THEN** the implementation SHALL use `for await...of` on a Node.js Readable or async generator
- **AND** the implementation SHALL NOT use a hand-written AsyncIterator with pending resolve queues
