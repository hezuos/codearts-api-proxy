---
spec: sse-streaming
status: implemented
priority: high
created: 2026-04-14
updated: 2026-04-17
---

# SSE Streaming

## Purpose

The system SHALL handle Server-Sent Events (SSE) streaming between upstream CodeArts services and downstream OpenAI-compatible clients.

## Requirements

### REQ-SSE-001: Upstream SSE parsing

The system SHALL parse upstream streaming responses robustly even when event formatting includes heartbeats or mixed line formats. Malformed SSE data lines (JSON parse failure) SHALL be logged as warnings and skipped, not treated as fatal errors. The implementation SHALL use Node.js `Readable` stream utilities instead of a hand-written AsyncIterator.

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

#### Scenario: Stream uses Readable utility

- **WHEN** the system creates an SSE parser from an upstream response
- **THEN** the implementation SHALL use `for await...of` on a Node.js Readable or async generator
- **AND** the implementation SHALL NOT use a hand-written AsyncIterator with pending resolve queues

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

### Requirement: Streaming usage chunk on include_usage

The system SHALL emit a final SSE chunk containing the `usage` object before the `[DONE]` marker when the client requests `stream_options.include_usage: true`. The `usage` object SHALL populate cache token fields in **both** the OpenAI standard position (`prompt_tokens_details.cached_tokens` / `prompt_tokens_details.text_tokens`) and the DeepSeek top-level position (`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`), consistent with the non-streaming `openai-api` cache token usage estimation requirement.

**Rationale:** new-api consumes `usage.prompt_tokens_details.cached_tokens` from the final stream chunk via `handleLastResponse` (`relay/channel/openai/helper.go:134`), which deserializes the chunk's `usage` field directly into `dto.Usage`. Without `prompt_tokens_details.cached_tokens` in the stream chunk, new-api's "缓存↓" log column stays empty for streaming responses even when the proxy estimates a non-zero cache hit.

#### Scenario: include_usage requested

- **GIVEN** a streaming chat completion request with `stream_options.include_usage: true`
- **WHEN** the upstream stream completes successfully with an estimated `cache_hit = C` (where `C >= 0`) and `prompt_tokens = N`
- **THEN** the system SHALL emit a final chunk with `choices: []` and a populated `usage` object
- **AND** the `usage` object SHALL include `prompt_tokens_details.cached_tokens: C` and `prompt_tokens_details.text_tokens: max(0, N - C)`
- **AND** the `usage` object SHALL include `prompt_cache_hit_tokens: C` and `prompt_cache_miss_tokens: max(0, N - C)`
- **AND** the `usage` object SHALL include `cache_estimated: true`
- **AND** the system SHALL then emit `data: [DONE]` and close the response

#### Scenario: include_usage not requested

- **GIVEN** a streaming chat completion request without `stream_options.include_usage` or with it set to `false`
- **WHEN** the upstream stream completes successfully
- **THEN** the system SHALL NOT emit a usage chunk
- **AND** the system SHALL emit `data: [DONE]` and close the response (preserving current behavior)
