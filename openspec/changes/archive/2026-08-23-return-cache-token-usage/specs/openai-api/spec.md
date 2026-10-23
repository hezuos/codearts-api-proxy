## ADDED Requirements

### Requirement: Cache token usage estimation

The system SHALL include DeepSeek-style cache token fields in the `usage` object of chat completion responses, estimated from the previous turn's `prompt_tokens` using the request's `divergence` classification, `parent_message_id` presence, and `isToolContinuation` flag.

**Rationale:** Downstream clients (e.g. DeepSeek-compatible billing) need `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` to compute cost. Huawei Cloud upstream does not return cache hit/miss fields. The proxy already computes a `divergence` classification (`normal` / `tail-divergence` / `middle-damage` / `duplicate/stale`) via prefix-chain hash comparison in `classifyDivergence`, which precisely distinguishes "server reuses previous context" from "server treats as new input". Combining this with `parent_message_id` presence and `isToolContinuation` yields accurate cache hit estimation.

#### Scenario: Cold-start (no parent_message_id, not tool continuation)

- **GIVEN** a chat completion request without `parent_message_id` and not a tool continuation
- **WHEN** the system returns the response
- **THEN** the `usage` object SHALL include `prompt_cache_hit_tokens: 0` and `prompt_cache_miss_tokens` equal to `prompt_tokens`
- **AND** the `usage` object SHALL include `cache_estimated: true`

#### Scenario: Normal continuation (divergence=normal, parent present)

- **GIVEN** a chat completion request with `parent_message_id`, `divergence = "normal"`, and a known previous `prompt_tokens` for the same `chat_id`
- **WHEN** the system returns the response with `prompt_tokens = N`
- **THEN** the `usage` object SHALL include `prompt_cache_hit_tokens` equal to the previous turn's `prompt_tokens`
- **AND** the `usage` object SHALL include `prompt_cache_miss_tokens` equal to `max(0, N - previous_prompt_tokens)`
- **AND** the `usage` object SHALL include `cache_estimated: true`

#### Scenario: Tail divergence (divergence=tail-divergence, parent present)

- **GIVEN** a chat completion request with `parent_message_id` and `divergence = "tail-divergence"`
- **WHEN** the system returns the response
- **THEN** the `usage` object SHALL include `prompt_cache_hit_tokens` equal to the previous turn's `prompt_tokens` (prefix still cached, only tail is new)

#### Scenario: Middle damage or force resync (divergence=middle-damage or undefined)

- **GIVEN** a chat completion request with `divergence = "middle-damage"` or `divergence = undefined` (e.g. forceResync, prefix hash mismatch)
- **WHEN** the system returns the response
- **THEN** the `usage` object SHALL include `prompt_cache_hit_tokens: 0` (server did full context reset, no cache)
- **AND** the `usage` object SHALL include `prompt_cache_miss_tokens` equal to `prompt_tokens`

#### Scenario: Duplicate/stale (divergence=duplicate/stale)

- **GIVEN** a chat completion request with `divergence = "duplicate/stale"` (message count equals previous prefix length)
- **WHEN** the system returns the response
- **THEN** the `usage` object SHALL include `prompt_cache_hit_tokens` equal to the previous turn's `prompt_tokens` (full cache hit, repeated request)

#### Scenario: Tool continuation (isToolContinuation=true, no parent)

- **GIVEN** a chat completion request that is a tool continuation (`tool_result` present, `messagesBody` empty) without `parent_message_id`
- **WHEN** the system returns the response
- **THEN** the `usage` object SHALL include `prompt_cache_hit_tokens` equal to the previous turn's `prompt_tokens` (server reuses full previous context)

#### Scenario: Continuation without recorded previous tokens

- **GIVEN** a chat completion request that would estimate a non-zero `cache_hit` but has no recorded previous `prompt_tokens` for the `chat_id` (e.g. expired from TTL, process restart)
- **WHEN** the system returns the response
- **THEN** the `usage` object SHALL include `prompt_cache_hit_tokens: 0` and `prompt_cache_miss_tokens` equal to `prompt_tokens`
- **AND** the `usage` object SHALL include `cache_estimated: true`

#### Scenario: Previous prompt_tokens tracking

- **GIVEN** a chat completion response with a non-zero `prompt_tokens` and a `chat_id`
- **WHEN** the response completes successfully
- **THEN** the system SHALL record the `prompt_tokens` keyed by `chat_id` for use by the next continuation turn
- **AND** the system SHALL NOT record when `prompt_tokens` is zero (avoid polluting next turn's estimation with placeholder values from incremental SSE events)
- **AND** the recorded value SHALL expire after a TTL (4 hours) consistent with the existing `lastResponseMessageId` tracker

#### Scenario: Unknown fields ignored by legacy clients

- **GIVEN** a legacy OpenAI-compatible client that does not recognize cache token fields
- **WHEN** the system returns a response with `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `cache_estimated`
- **THEN** the client SHALL be able to ignore the unknown fields without error (additive, non-breaking)
