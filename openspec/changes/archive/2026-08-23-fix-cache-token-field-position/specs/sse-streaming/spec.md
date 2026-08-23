## MODIFIED Requirements

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
