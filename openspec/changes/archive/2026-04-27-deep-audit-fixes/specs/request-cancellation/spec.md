## ADDED Requirements

### Requirement: Client disconnect cancels upstream request

The system SHALL cancel upstream HTTP requests when the downstream client disconnects, to avoid wasting upstream quota and server resources.

#### Scenario: Client closes connection during streaming

- **WHEN** a client disconnects (closes TCP connection) while a streaming SSE response is in progress
- **THEN** the system SHALL destroy the upstream HTTPS connection
- **AND** the system SHALL stop consuming the upstream SSE stream
- **AND** the system SHALL log the cancellation event

#### Scenario: Client closes connection during non-streaming

- **WHEN** a client disconnects while a non-streaming request is awaiting upstream response
- **THEN** the system SHALL destroy the upstream HTTPS connection
- **AND** the system SHALL log the cancellation event

### Requirement: AbortController integration

The system SHALL use `AbortController` to propagate cancellation from Express response to upstream HTTPS request.

#### Scenario: AbortController signal triggers request destroy

- **WHEN** `res.on("close")` fires due to client disconnect
- **THEN** the associated `AbortController` SHALL be aborted
- **AND** the upstream `https.request` SHALL be destroyed via its `signal` option
