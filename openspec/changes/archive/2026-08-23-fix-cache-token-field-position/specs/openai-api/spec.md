## MODIFIED Requirements

### Requirement: Cache token usage estimation

The system SHALL include cache token fields in the `usage` object of chat completion responses, estimated from the previous turn's `prompt_tokens` using the request's `divergence` classification, `parent_message_id` presence, and `isToolContinuation` flag. The cache hit value SHALL be exposed in **both** locations simultaneously:

1. **OpenAI standard position**: `usage.prompt_tokens_details.cached_tokens` and `usage.prompt_tokens_details.text_tokens` — read by OpenAI-compatible gateways (e.g. new-api) whose billing and log display only consume `prompt_tokens_details.cached_tokens`
2. **DeepSeek top-level position**: `usage.prompt_cache_hit_tokens` and `usage.prompt_cache_miss_tokens` — read by DeepSeek-native clients

Both locations SHALL carry the same `cache_hit` value. `prompt_tokens_details.text_tokens` SHALL equal `max(0, prompt_tokens - cached_tokens)`. The `cache_estimated: true` marker SHALL remain at the usage top level.

**Rationale:** new-api (`QuantumNous/new-api`) computes `summary.CacheTokens = usage.PromptTokensDetails.CachedTokens` (`service/text_quota.go:260`) and displays it in the log "缓存↓" column via `other.cache_tokens` (`service/log_info_generate.go:78`). Its `applyUsagePostProcessing` only copies top-level `prompt_cache_hit_tokens` into `prompt_tokens_details.cached_tokens` for `DeepSeek` / `Zhipu_v4` / `Moonshot` channel types — the `OpenAI` / `Custom` / `AdvancedCustom` branches do not. A proxy registered as an OpenAI or Custom channel therefore never surfaces cache tokens unless the proxy itself emits `prompt_tokens_details.cached_tokens`. Returning both positions is additive and backward-compatible.

#### Scenario: Cold-start (no parent_message_id, not tool continuation)

- **GIVEN** a chat completion request without `parent_message_id` and not a tool continuation
- **WHEN** the system returns the response with `prompt_tokens = N`
- **THEN** the `usage` object SHALL include `prompt_cache_hit_tokens: 0` and `prompt_cache_miss_tokens: N`
- **AND** the `usage` object SHALL include `prompt_tokens_details.cached_tokens: 0` and `prompt_tokens_details.text_tokens: N`
- **AND** the `usage` object SHALL include `cache_estimated: true`

#### Scenario: Normal continuation (divergence=normal, parent present)

- **GIVEN** a chat completion request with `parent_message_id`, `divergence = "normal"`, and a known previous `prompt_tokens = P` for the same `chat_id`
- **WHEN** the system returns the response with `prompt_tokens = N`
- **THEN** the `usage` object SHALL include `prompt_cache_hit_tokens: P` and `prompt_cache_miss_tokens: max(0, N - P)`
- **AND** the `usage` object SHALL include `prompt_tokens_details.cached_tokens: P` and `prompt_tokens_details.text_tokens: max(0, N - P)`

#### Scenario: Tail divergence (divergence=tail-divergence, parent present)

- **GIVEN** a chat completion request with `parent_message_id` and `divergence = "tail-divergence"`
- **WHEN** the system returns the response
- **THEN** both `prompt_cache_hit_tokens` and `prompt_tokens_details.cached_tokens` SHALL equal the previous turn's `prompt_tokens`

#### Scenario: Middle damage or force resync (divergence=middle-damage or undefined)

- **GIVEN** a chat completion request with `parent_message_id` and `divergence` of `middle-damage` or `undefined`
- **WHEN** the system returns the response with `prompt_tokens = N`
- **THEN** both `prompt_cache_hit_tokens` and `prompt_tokens_details.cached_tokens` SHALL be `0`
- **AND** `prompt_cache_miss_tokens` and `prompt_tokens_details.text_tokens` SHALL both equal `N`

#### Scenario: Duplicate/stale (divergence=duplicate/stale)

- **GIVEN** a chat completion request with `parent_message_id` and `divergence = "duplicate/stale"`
- **WHEN** the system returns the response
- **THEN** both `prompt_cache_hit_tokens` and `prompt_tokens_details.cached_tokens` SHALL equal the previous turn's `prompt_tokens`

#### Scenario: Previous tokens exceed current prompt_tokens (clamp)

- **GIVEN** a chat completion request with `parent_message_id`, `divergence = "normal"`, and a known previous `prompt_tokens = P` where `P > N` (current `prompt_tokens`)
- **WHEN** the system returns the response with `prompt_tokens = N`
- **THEN** both `prompt_cache_hit_tokens` and `prompt_tokens_details.cached_tokens` SHALL equal `P` (may exceed `prompt_tokens` — this is an inherent limitation of estimation from the previous turn)
- **AND** both `prompt_cache_miss_tokens` and `prompt_tokens_details.text_tokens` SHALL be `0` (clamped, not negative)
- **AND** the `usage` object SHALL include `cache_estimated: true` (client knows this is an estimate, not exact)

#### Scenario: Tool continuation (isToolContinuation=true, no parent)

- **GIVEN** a chat completion request that is a tool continuation (`tool_result` present, `messagesBody` empty) without `parent_message_id`
- **WHEN** the system returns the response
- **THEN** both `prompt_cache_hit_tokens` and `prompt_tokens_details.cached_tokens` SHALL equal the previous turn's `prompt_tokens`

#### Scenario: Continuation without recorded previous tokens

- **GIVEN** a chat completion request that would estimate a non-zero `cache_hit` but has no recorded previous `prompt_tokens` for the `chat_id` (e.g. expired from TTL, process restart)
- **WHEN** the system returns the response with `prompt_tokens = N`
- **THEN** both `prompt_cache_hit_tokens` and `prompt_tokens_details.cached_tokens` SHALL be `0`
- **AND** `prompt_cache_miss_tokens` and `prompt_tokens_details.text_tokens` SHALL both equal `N`
- **AND** the `usage` object SHALL include `cache_estimated: true`

#### Scenario: Previous prompt_tokens tracking

- **GIVEN** a chat completion response with a non-zero `prompt_tokens` and a `chat_id`
- **WHEN** the response completes successfully
- **THEN** the system SHALL record the `prompt_tokens` keyed by `chat_id` for use by the next continuation turn
- **AND** the system SHALL NOT record when `prompt_tokens` is zero (avoid polluting next turn's estimation with placeholder values from incremental SSE events)
- **AND** the recorded value SHALL expire after a TTL (4 hours) consistent with the existing `lastResponseMessageId` tracker
- **AND** the record operation SHALL happen **after** the current turn's cache usage computation completes (or equivalently, the computation SHALL consume a snapshot of the previous turn's value taken before the current turn's record operation), so that `getLastPromptTokens` reads the previous turn's value, not the current turn's just-written value
- **AND** the system SHALL NOT directly overwrite the record for the same `chat_id` with the current turn's `prompt_tokens` before the cache usage computation reads it, otherwise `cached_tokens` would always equal `prompt_tokens` and `text_tokens` would always be `0`

#### Scenario: Unknown fields ignored by legacy clients

- **GIVEN** a legacy OpenAI-compatible client that does not recognize cache token fields
- **WHEN** the system returns a response with `prompt_tokens_details` / `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `cache_estimated`
- **THEN** the client SHALL be able to ignore the unknown fields without error (additive, non-breaking)

#### Scenario: new-api OpenAI/Custom channel surfaces cache tokens in log

- **GIVEN** the proxy is registered in new-api as an `OpenAI` or `Custom` channel type
- **AND** the proxy returns a response with `usage.prompt_tokens_details.cached_tokens = C` where `C > 0`
- **WHEN** new-api processes the response and renders the usage log
- **THEN** the log's "缓存↓" column SHALL display `C` (because new-api's JSON deserialization populates `usage.PromptTokensDetails.CachedTokens` directly from the `prompt_tokens_details.cached_tokens` field, and `summary.CacheTokens` reads that field at `service/text_quota.go:260`)
