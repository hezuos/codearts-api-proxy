## MODIFIED Requirements

### REQ-API-002: Chat completions endpoint
The system SHALL provide an OpenAI-compatible chat completions endpoint for non-streaming requests. The implementation SHALL use a unified HTTP client (native `https` module) and shared request construction logic.

#### Scenario: Client requests non-streaming completion
- **GIVEN** a client submits a valid chat completions request without streaming
- **WHEN** the system processes the request
- **THEN** the system SHALL translate the request upstream using the unified HTTP client
- **AND** the system SHALL return an OpenAI-compatible chat completion response

### REQ-API-003: Streaming chat completions endpoint
The system SHALL provide an OpenAI-compatible chat completions streaming mode. The implementation SHALL use a unified HTTP client and shared request construction logic, with no duplicated code between streaming and non-streaming paths.

#### Scenario: Client requests streaming completion
- **GIVEN** a client submits a valid chat completions request with streaming enabled
- **WHEN** the system processes the request
- **THEN** the system SHALL return an OpenAI-compatible event stream
- **AND** the stream SHALL represent incremental completion output
- **AND** the request construction and logging SHALL be shared with the non-streaming path
