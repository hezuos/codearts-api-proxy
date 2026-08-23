## ADDED Requirements

### Requirement: Streaming usage chunk on include_usage

The system SHALL emit a final SSE chunk containing the `usage` object before the `[DONE]` marker when the client requests `stream_options.include_usage: true`.

**Rationale:** Clients computing cache-aware billing from streaming responses need the usage object. Currently the streaming path emits no usage chunk at all, making billing impossible for streaming consumers.

#### Scenario: include_usage requested

- **GIVEN** a streaming chat completion request with `stream_options.include_usage: true`
- **WHEN** the upstream stream completes successfully
- **THEN** the system SHALL emit a final chunk with `choices: []` and a populated `usage` object
- **AND** the `usage` object SHALL include the cache token fields per the `openai-api` cache token usage estimation requirement
- **AND** the system SHALL then emit `data: [DONE]` and close the response

#### Scenario: include_usage not requested

- **GIVEN** a streaming chat completion request without `stream_options.include_usage` or with it set to `false`
- **WHEN** the upstream stream completes successfully
- **THEN** the system SHALL NOT emit a usage chunk
- **AND** the system SHALL emit `data: [DONE]` and close the response (preserving current behavior)
