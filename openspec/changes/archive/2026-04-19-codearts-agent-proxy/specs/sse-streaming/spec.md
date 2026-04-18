---
spec: sse-streaming
status: implemented
priority: high
created: 2026-04-14
updated: 2026-04-17
---

# SSE Streaming

## Overview

The system SHALL handle Server-Sent Events (SSE) streaming between upstream CodeArts services and downstream OpenAI-compatible clients.

## Requirements

### REQ-SSE-001: Upstream SSE parsing

The system SHALL parse upstream streaming responses robustly even when event formatting includes heartbeats or mixed line formats.

**Rationale:** Upstream SSE streams may include non-standard formatting that must be handled gracefully.

#### Scenario: Heartbeats are ignored

- **GIVEN** the upstream stream emits heartbeat lines or non-payload keepalive frames
- **WHEN** the system processes the stream
- **THEN** the system SHALL ignore them without terminating the client stream

### REQ-SSE-002: OpenAI delta stream emission

The system SHALL emit OpenAI-compatible streaming delta events to downstream clients.

**Rationale:** OpenAI streaming clients expect delta events in a specific format.

#### Scenario: Upstream partial output is forwarded incrementally

- **GIVEN** the upstream stream yields partial completion content
- **WHEN** the system processes each chunk
- **THEN** the system SHALL send one or more OpenAI-compatible delta events to the client
- **AND** the events SHALL be sent in order

### REQ-SSE-003: Stream termination semantics

The system SHALL close downstream streams with explicit completion behavior when upstream streaming ends or fails.

**Rationale:** Clients need clear signals when streaming ends, whether successfully or due to errors.

#### Scenario: Upstream stream completes successfully

- **GIVEN** the upstream stream finishes normally
- **WHEN** the system completes processing
- **THEN** the system SHALL send the final completion marker expected by OpenAI-compatible streaming clients
- **AND** the system SHALL close the response

#### Scenario: Upstream stream fails mid-flight

- **GIVEN** the upstream stream errors after partial output has been sent
- **WHEN** the system detects the error
- **THEN** the system SHALL terminate the client stream consistently
- **AND** the system SHALL record the failure for observability
