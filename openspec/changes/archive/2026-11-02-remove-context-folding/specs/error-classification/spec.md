# Spec Delta

## ADDED Requirements

### Requirement: Context length exceeded is a distinct error

When the upstream rejects a request because the prompt exceeds its length limit (CodeArts `ChatAgent.00001216`), the system SHALL expose an OpenAI-compatible error with HTTP status 400 and error code `context_length_exceeded`. The message SHALL describe the upstream limit so the client can decide to compact or summarize.

#### Scenario: Non-streaming request over the limit

- **WHEN** a non-streaming request is rejected by the upstream for prompt length
- **THEN** the proxy SHALL respond with HTTP 400
- **AND** the body SHALL carry error code `context_length_exceeded`
- **AND** the message SHALL mention the context or prompt length limit

#### Scenario: Streaming request over the limit before headers are sent

- **WHEN** a streaming request is rejected by the upstream for prompt length before any bytes reach the client
- **THEN** the proxy SHALL respond with HTTP 400 and the same error body as the non-streaming case

#### Scenario: Streaming rejection after headers are sent

- **WHEN** the upstream reports the prompt-length rejection as a stream error after the client response has started
- **THEN** the proxy SHALL emit a single SSE error event carrying the same error code and message
- **AND** it SHALL then end the stream normally

#### Scenario: No silent retry with rewritten history

- **WHEN** a prompt-length rejection is mapped to `context_length_exceeded`
- **THEN** the proxy SHALL NOT retry the request
- **AND** it SHALL NOT trim, fold, or otherwise rewrite the history

### Requirement: Upstream errors are not disguised as tool calls

The proxy SHALL surface upstream failures as errors. It SHALL NOT synthesize tool calls, fake tool results, or otherwise present a failed request as a successful or continuing turn.

#### Scenario: Non-length upstream error

- **WHEN** the upstream fails with an error other than the length limit
- **THEN** the proxy SHALL surface the error to the client
- **AND** it SHALL NOT emit a synthetic tool call

#### Scenario: No synthetic echo command

- **WHEN** any upstream error occurs
- **THEN** the proxy SHALL NOT ask the client to execute a command whose only purpose is to signal a proxy-side reset
