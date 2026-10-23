---
spec: openai-api
status: implemented
priority: high
created: 2026-04-14
updated: 2026-04-28
---

# OpenAI-Compatible API

## Purpose

The system SHALL provide OpenAI-compatible endpoints for model listing and chat completions, including streaming responses.

## Requirements

### REQ-API-001: Models endpoint

The system SHALL provide an OpenAI-compatible models endpoint that dynamically fetches available models from the CodeArts upstream agent-center API. The endpoint SHALL require valid Bearer token authentication. The response SHALL contain both dynamically fetched models and static alias models from `MODEL_MAP`.

**Rationale:** Clients need real available model information for model selection UI. A hardcoded single model is insufficient.

#### Scenario: Client requests models

- **GIVEN** a client has valid authentication and a bound provider account
- **WHEN** the client calls the models endpoint
- **THEN** the system SHALL return an OpenAI-compatible models response containing dynamically fetched models merged with static alias models

#### Scenario: Client requests models without authentication

- **GIVEN** a client has no valid authentication
- **WHEN** the client calls the models endpoint
- **THEN** the system SHALL return HTTP 401 with an OpenAI-style error response

### REQ-API-002: Chat completions endpoint

The system SHALL provide an OpenAI-compatible chat completions endpoint for non-streaming requests. The request body construction SHALL return a structured object to avoid double serialization. The conversation ID derivation SHALL include user identity to prevent cross-account collision. The implementation SHALL use a unified HTTP client (native `https` module) and shared request construction logic.

**Rationale:** Non-streaming chat completions are the primary interface for LLM interactions. `buildRequestBody` returning JSON string then immediately `JSON.parse` wastes CPU on large request bodies. `deriveConversationId` using only message content causes collision when different accounts send the same first message.

#### Scenario: Client requests non-streaming completion

- **GIVEN** a client submits a valid chat completions request without streaming
- **WHEN** the system processes the request
- **THEN** the system SHALL translate the request upstream
- **AND** the system SHALL return an OpenAI-compatible chat completion response

#### Scenario: buildRequestBody returns structured object

- **WHEN** the system constructs the upstream request body
- **THEN** `buildRequestBody` SHALL return both the structured object and the JSON string
- **AND** the system SHALL NOT need to `JSON.parse` the result for logging

#### Scenario: Conversation ID includes user identity

- **WHEN** the system derives a conversation ID from the first user message
- **THEN** the hash input SHALL include the provider account ID as a prefix
- **AND** different accounts with the same first message SHALL produce different conversation IDs

### REQ-API-003: Streaming chat completions endpoint

The system SHALL provide an OpenAI-compatible chat completions streaming mode. The upstream request timeout SHALL be configurable via environment variable. The implementation SHALL use a unified HTTP client and shared request construction logic, with no duplicated code between streaming and non-streaming paths.

**Rationale:** Streaming responses enable real-time output for interactive applications. Hardcoded 120s timeout may be insufficient for long-running agent conversations.

#### Scenario: Client requests streaming completion

- **GIVEN** a client submits a valid chat completions request with streaming enabled
- **WHEN** the system processes the request
- **THEN** the system SHALL return an OpenAI-compatible event stream
- **AND** the stream SHALL represent incremental completion output
- **AND** the request construction and logging SHALL be shared with the non-streaming path

- **WHEN** the `UPSTREAM_TIMEOUT_MS` environment variable is set
- **THEN** the system SHALL use that value as the upstream HTTPS request timeout
- **AND** the default SHALL be 120000 (120 seconds) if not set

### REQ-API-004: Provider account routing

The system SHALL route each OpenAI-compatible request through exactly one bound Huawei Cloud provider account.

**Rationale:** Requests must be routed to a specific provider account to access upstream services.

#### Scenario: API key selects provider account

- **GIVEN** a request is authenticated by an API key bound to a provider account
- **WHEN** the system processes the request
- **THEN** the system SHALL send the upstream request using that provider account only

### Requirement: Non-streaming tool_calls merge

The system SHALL merge tool_calls across multiple SSE events in non-streaming mode, rather than replacing with the last event's tool_calls.

#### Scenario: Multiple tool_call events are merged

- **WHEN** the upstream sends tool_call_1 in one SSE event and tool_call_2 in a subsequent event
- **THEN** the non-streaming response SHALL include both tool_call_1 and tool_call_2 in the `tool_calls` array

### Requirement: Dead code removal in request handlers

The system SHALL NOT use `res.req` (Express internal property) to obtain auth context in request handlers.

#### Scenario: Auth context obtained from middleware

- **WHEN** `handleStreamingRequest` or `handleNonStreamingRequest` needs auth context
- **THEN** the system SHALL obtain it from the function parameters, not from `res.req`

### Requirement: Proactive chain reset on upstream prompt length threshold

The system SHALL track the cumulative `prompt_tokens` per `chat_id` (already maintained via `getLastPromptTokens`). When a new chat completion request arrives on the **normal hot-chain continuation path** (divergence = "normal", has parent_message_id, not tool continuation) and the tracked `prompt_tokens` for that `chat_id` exceeds `UPSTREAM_PROMPT_TOKEN_RESET_THRESHOLD` (default 180000), the system SHALL proactively reset the chain: set `divergence = "middle-damage"`, clear `parent_message_id`, and fold the full conversation history into a single text message (via `foldFullConversation` bounded by `resolveFullContextMaxChars`). This avoids the upstream `ChatAgent.00001216` error by resetting before the limit is hit.

**Rationale:** The upstream CodeArts service has a hard 196608 token limit on cumulative prompt length. On the normal hot-chain path, the proxy only sends increments and the history accumulates server-side; the proxy cannot control the server-side history length. Experiment (`scripts/experiment-prompt-tokens-accumulation.ts`) confirmed that `prompt_tokens` returned by upstream is the cumulative history total. Proactive reset at 180000 (leaving 16K headroom) prevents the error entirely.

#### Scenario: Continuation request under threshold proceeds normally

- **GIVEN** a chat completion request with `parent_message_id`, `divergence = "normal"`, and `getLastPromptTokens(chat_id) = 150000` (below 180000 threshold)
- **WHEN** the system processes the request
- **THEN** the system SHALL NOT proactively reset the chain
- **AND** the request SHALL proceed on the normal hot-chain continuation path (incremental message, parent_message_id preserved)

#### Scenario: Continuation request over threshold triggers proactive reset

- **GIVEN** a chat completion request with `parent_message_id`, `divergence = "normal"`, and `getLastPromptTokens(chat_id) = 185000` (above 180000 threshold)
- **WHEN** the system processes the request
- **THEN** the system SHALL set `divergence = "middle-damage"`
- **AND** the system SHALL clear `parent_message_id` to empty
- **AND** the system SHALL fold the full conversation history via `foldFullConversation` bounded by `resolveFullContextMaxChars(model_id)`
- **AND** the folded content length SHALL NOT exceed `resolveFullContextMaxChars(model_id)` characters
- **AND** the request SHALL be sent upstream with the folded content as a single text message

#### Scenario: Proactive reset does not affect tool continuation

- **GIVEN** a chat completion request with `isToolContinuation = true` and `getLastPromptTokens(chat_id) = 185000`
- **WHEN** the system processes the request
- **THEN** the system SHALL NOT proactively reset (tool continuation sends empty messagesBody and relies on parent; resetting would break the tool flow)

#### Scenario: Proactive reset does not affect cold-start or non-normal divergence

- **GIVEN** a chat completion request without `parent_message_id` (cold-start) OR with `divergence != "normal"` (already middle-damage / tail-divergence / duplicate-stale)
- **WHEN** the system processes the request
- **THEN** the system SHALL NOT apply the proactive reset check (these paths already handle context folding or have no server-side history)

#### Scenario: Proactive reset is signaled in response metadata

- **GIVEN** a chat completion request that triggered proactive reset (over threshold)
- **WHEN** the system returns the response to the client
- **THEN** the system SHALL set `codearts.context_reset = true` in the response metadata (non-streaming: in the `codearts` field of the response body; streaming: in the `codearts` field of the first chunk that carries metadata)
- **AND** the client MAY use this flag to display a notice to the user (e.g. "上下文已压缩")
- **AND** the flag SHALL NOT be set when no proactive reset occurred

#### Scenario: Streaming proactive reset emits notice chunk before upstream call

- **GIVEN** a streaming chat completion request that triggers proactive reset (over threshold)
- **WHEN** the system detects the threshold is exceeded in `buildRequestBody`
- **THEN** the system SHALL emit a notice chunk to the client with content `"\n[上下文已压缩：累积长度超过上游限制，已重置对话链继续。早期细节可能丢失。]\n"` BEFORE sending the request upstream
- **AND** the notice chunk SHALL carry `codearts.context_reset = true` in metadata
- **AND** after the notice chunk, the system SHALL proceed with the forceResync request upstream and stream the response to the client
- **AND** the client SHALL receive a continuous stream: notice chunk + upstream response content

### Requirement: Automatic recovery from upstream prompt length exceeds error

When the upstream returns error code `ChatAgent.00001216` (prompt length exceeds maximum input length), the system SHALL automatically retry the request once with `forceResync: true` (which clears `parent_message_id` and folds the full conversation history), instead of propagating the error to the client. This applies to both non-streaming (`chat.ts`) and streaming (`chat-stream.ts`) paths.

**Rationale:** Experiment (`scripts/experiment-large-fold-reset.ts`) confirmed that after `ChatAgent.00001216`, a `forceResync` retry with 200K chars folded content succeeds (83298 tokens < 196608). The recovery is transparent to the client — the conversation continues with a folded summary of prior history. This is a last-resort fallback; the proactive reset (above) should prevent most cases, but race conditions or threshold misconfiguration could still trigger the error.

#### Scenario: Non-streaming 00001216 error triggers forceResync retry

- **GIVEN** a non-streaming chat completion request that receives upstream error `ChatAgent.00001216`
- **AND** the request has not already been retried with `forceResync`
- **WHEN** the system receives the error
- **THEN** the system SHALL retry the request once with `forceResync: true`
- **AND** the retry SHALL clear `parent_message_id` and fold the full conversation history
- **AND** if the retry succeeds, the system SHALL return the successful response to the client (transparent recovery)
- **AND** if the retry also fails, the system SHALL propagate the error to the client

#### Scenario: Streaming 00001216 error triggers forceResync retry with notice chunk

- **GIVEN** a streaming chat completion request that receives upstream SSE error `ChatAgent.00001216`
- **AND** the request has not already been retried with `forceResync`
- **WHEN** the system receives the error in the SSE stream
- **THEN** the system SHALL emit a notice chunk to the client with content `"\n[上下文已压缩：累积长度超过上游限制，已重置对话链继续。早期细节可能丢失。]\n"` BEFORE starting the retry
- **AND** the system SHALL attempt a `forceResync` retry (build new request body with `forceResync: true`, send upstream, continue streaming the retry response to the client)
- **AND** if the retry succeeds, the client SHALL receive a continuous stream (notice chunk + retry's content)
- **AND** if the retry also fails, the system SHALL emit an error chunk to the client and terminate the stream

#### Scenario: Non-streaming 00001216 error recovery is transparent (no notice)

- **GIVEN** a non-streaming chat completion request that receives upstream error `ChatAgent.00001216`
- **WHEN** the system retries with `forceResync: true` and the retry succeeds
- **THEN** the system SHALL return the successful response to the client WITHOUT injecting any notice text into the response content (non-streaming cannot insert mid-response notices; the recovery is transparent)
- **AND** the system SHALL set `codearts.error_recovery = "ChatAgent.00001216"` in the response metadata to signal that recovery occurred

#### Scenario: 00001216 error after forceResync is not retried again

- **GIVEN** a chat completion request that was already retried with `forceResync: true` and receives `ChatAgent.00001216` again
- **WHEN** the system receives the error
- **THEN** the system SHALL NOT retry again (prevent infinite retry loop)
- **AND** the system SHALL propagate the error to the client (the folded content itself exceeds the upstream limit — operator must reduce `FULL_CONTEXT_MAX_CHARS_BY_MODEL`)

#### Scenario: Other upstream errors are not affected by 00001216 recovery

- **GIVEN** a chat completion request that receives a non-00001216 upstream error (e.g. `ChatAgent.00001007`, rate limit, auth error)
- **WHEN** the system receives the error
- **THEN** the system SHALL NOT trigger the 00001216 forceResync recovery
- **AND** the system SHALL apply existing error handling (tail-divergence repair, rate-limit retry, or propagate)

### Requirement: Visible notice for tail-divergence resync and context folding

When the system performs a tail-divergence resync retry (existing behavior) or a context folding reset (forceResync / middle-damage / duplicate-stale), it SHALL emit a visible notice to the client instead of handling it silently. This unifies all silent recovery paths into a visible pattern.

**Rationale:** Previously these paths were silent — the client (e.g. opencode) had no idea the proxy switched from incremental continuation to full context reset, causing confusion when the model appeared to "forget" context or when token counts didn't match. Making them visible lets the user understand what happened.

#### Scenario: Streaming tail-divergence resync emits notice chunk

- **GIVEN** a streaming chat completion request where `initialDivergence === "tail-divergence"` and the upstream returns an SSE error
- **AND** the request has not already been retried with `resyncRetried`
- **WHEN** the system attempts the resync retry
- **THEN** the system SHALL emit a notice chunk with content `"\n[上下文链分叉：检测到尾部不一致，已切换全量重置继续。]\n"` BEFORE switching to the resync stream
- **AND** the notice chunk SHALL carry `codearts.error_recovery = "tail-divergence-resync"` in metadata

#### Scenario: Non-streaming tail-divergence resync marks response metadata

- **GIVEN** a non-streaming chat completion request where `divergence === "tail-divergence"` and the upstream returns an error
- **WHEN** the system retries with `forceResync: true` and succeeds
- **THEN** the system SHALL set `codearts.error_recovery = "tail-divergence-resync"` in the response metadata

#### Scenario: Streaming context folding reset emits notice chunk

- **GIVEN** a streaming chat completion request where `buildRequestBody` returns `divergence === "middle-damage"` or `"duplicate/stale"` (context folding triggered)
- **WHEN** the system sends the folded request upstream
- **THEN** the system SHALL emit a notice chunk with content `"\n[上下文已重置：对话链已折叠重建。]\n"` BEFORE streaming the upstream response
- **AND** the notice chunk SHALL carry `codearts.context_reset = true` in metadata

#### Scenario: Non-streaming context folding reset marks response metadata

- **GIVEN** a non-streaming chat completion request where `buildRequestBody` returns `divergence === "middle-damage"` or `"duplicate/stale"`
- **WHEN** the system returns the response
- **THEN** the system SHALL set `codearts.context_reset = true` in the response metadata

#### Scenario: PROTOCOL_ERROR remains silent (not surfaced)

- **GIVEN** an SSE event with `error_code === "PROTOCOL_ERROR"` (malformed SSE line)
- **WHEN** the system encounters the event
- **THEN** the system SHALL skip it silently (continue) WITHOUT emitting a notice chunk or metadata marker
- **AND** this is the only remaining silent path (malformed lines are not actionable for users)

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
