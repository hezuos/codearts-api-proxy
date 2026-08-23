## ADDED Requirements

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
