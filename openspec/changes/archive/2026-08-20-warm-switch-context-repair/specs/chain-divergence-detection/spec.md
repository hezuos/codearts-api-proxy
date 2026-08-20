## Purpose

Detects when a conversation that the proxy previously served through CodeArts has diverged from the client's current message history, and repairs the upstream request accordingly — appending only the missing tail when the old chain is intact, or rebuilding from scratch when it is not.

## ADDED Requirements

### Requirement: Chain state is tracked per conversation

The proxy SHALL maintain, in memory for each resolved `chat_id`, chain state that records what the proxy last confirmed the CodeArts thread knows: a prefix hash chain of the client message history it last forwarded, the length of that chain, and a hash of the assistant reply the proxy last returned to the client.

**Rationale:** The CodeArts server history cannot be read back by the proxy, so the only trustworthy signal for "what the server has seen" is the proxy's own last confirmed turn.

#### Scenario: Chain state recorded on successful turn

- **GIVEN** the proxy successfully completes a CodeArts turn for a `chat_id`
- **WHEN** the next request for the same `chat_id` arrives
- **THEN** the proxy SHALL still have access to the chain state recorded from the successful turn (prefix hash, chain length, last reply hash)
- **AND** the chain state SHALL be cleared when the same TTL eviction that removes `lastResponseMessageId` fires

#### Scenario: Chain state absent after restart

- **GIVEN** the proxy restarts after previously serving a conversation
- **WHEN** a request arrives for that conversation's `chat_id`
- **THEN** the proxy SHALL treat the chain state as absent (in-memory state is lost on restart)
- **AND** the proxy SHALL fall back to the cold-start injection behavior of the `full-context-injection` capability

#### Scenario: Chain state always records client message history, not folded text

- **GIVEN** the proxy completes a turn that was forwarded as a folded text (tail-divergence repair, full-reset rebuild, or cold-start injection)
- **WHEN** the proxy updates the chain state for that `chat_id`
- **THEN** the proxy SHALL compute `prefixChain` and `prefixLen` from the client's original `request.messages` (not from the folded text that was actually sent upstream)
- **AND** the proxy SHALL compute `lastReplyHash` from the assistant message the proxy returned to the client
- **Rationale:** The next round's divergence detection compares against the client's history, not the proxy's folded text; recording the folded text would cause every subsequent turn to be misclassified as diverged.

#### Scenario: Tool continuation updates chain state after success

- **GIVEN** a tool continuation request is excluded from divergence detection
- **AND** the request contains the client's complete `messages` history including the latest tool messages
- **WHEN** CodeArts successfully returns the next assistant response and the proxy updates chain state
- **THEN** the proxy SHALL compute `prefixChain` and `prefixLen` from the complete original `request.messages`
- **AND** the proxy SHALL set `lastReplyHash` to the newly returned assistant response, not the preceding assistant tool-call message
- **AND** the next normal user request SHALL use this updated state for suffix validation

### Requirement: Divergence repair independence from cold-start injection flag

The proxy SHALL ensure that the `CHAIN_DIVERGENCE_REPAIR_ENABLED` feature flag controls the divergence detection and repair path independently of `FULL_CONTEXT_INJECTION_ENABLED`. The middle-damage full-history fold and the tail-divergence repair failure fallback (full reset) SHALL NOT be gated by `FULL_CONTEXT_INJECTION_ENABLED`.

**Rationale:** Both flags default to `false`. If a user enables only `CHAIN_DIVERGENCE_REPAIR_ENABLED`, the middle-damage and fallback branches must still fold the full history; otherwise the proxy would silently degrade to forwarding only the last user message (losing history). `FULL_CONTEXT_INJECTION_ENABLED` governs only the cold-start (cache miss) injection path.

#### Scenario: Middle damage folds full history with only repair flag enabled

- **GIVEN** `CHAIN_DIVERGENCE_REPAIR_ENABLED` is `true`
- **AND** `FULL_CONTEXT_INJECTION_ENABLED` is `false`
- **AND** divergence detection classifies a request as middle damage
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL inject the folded full client history (reset upstream continuity, empty `parent_message_id`)
- **AND** the proxy SHALL NOT silently forward only the last user message

### Requirement: Message continuity hashes are canonical

The proxy SHALL normalize all message fields that affect continuity when computing chain and reply hashes, including `role`, normalized `content`, `name`, `refusal`, `reasoning_content`, `tool_call_id`, and each tool call's `id`, `type`, function name, and arguments. Tool calls SHALL be canonically sorted by `id` before hashing so array-order-only changes do not create false divergence.

#### Scenario: Message metadata changes are detected

- **GIVEN** two messages have the same visible content but differ in role, tool-call id, tool-call type, tool name, arguments, reasoning content, refusal, or tool message linkage
- **WHEN** the proxy computes their continuity hashes
- **THEN** the hashes SHALL differ

#### Scenario: Tool-call array order does not cause false divergence

- **GIVEN** two messages contain the same tool calls in different array orders
- **WHEN** the proxy computes their continuity hashes
- **THEN** the hashes SHALL be equal after canonical sorting by tool-call id

### Requirement: Divergence detection distinguishes tail divergence, normal continuation, and middle damage

When a client sends a request without a caller-provided `parent_message_id`, and the proxy has chain state for the resolved `chat_id`, the proxy SHALL compare the client's current message history against the tracked chain and classify it into one of three kinds: normal continuation (prefix chain matches and the entire suffix after the tracked chain length is one valid continuation turn), tail divergence (prefix chain matches but the suffix is not a valid single continuation turn), or middle damage (the prefix chain itself fails to match, or the suffix cannot be confidently validated).

**Rationale:** Checking only the first message after the tracked boundary is insufficient: after a provider switch and switch-back, the client history is `[oldPrefix, lastReply, externalUser, externalAssistant, currentUser]`, where the message at the chain boundary matches the last reply yet further turns from the external provider still lie beyond it. Validating the whole suffix structure is required to catch this. A tail divergence means the CodeArts thread still contains all previously forwarded context, so the missing suffix can be appended without rebuilding; middle damage means the server's stored chain no longer matches the client's history (edit / regeneration / compaction / unverifiable suffix), so the damaged portion cannot be patched and a reset is required. The proxy cannot distinguish "mid-history insertion" (an external provider turn inserted in the middle) from "mid-history edit" (an existing turn rewritten) — both produce the same prefix-chain mismatch, and an unverifiable suffix likewise cannot be safely patched. Because CodeArts supports appending new messages but not editing stored history, attempting a partial repair on middle damage would leave the original and edited versions of the same turn coexisting (contradictory context), and relocating inserted content would break temporal/causal ordering. A full reset is therefore the only safe repair for middle damage.

#### Scenario: Prefix chain matches and suffix is one valid continuation turn

- **GIVEN** a client sends a new request for a `chat_id` with tracked chain state
- **AND** the client message history's first `chainLength` messages match the tracked prefix chain
- **AND** the suffix after `chainLength` consists of: the tracked last reply hash as its first message, optionally followed by zero or more `tool` messages whose `tool_call_id` values trace back to that assistant's tool_calls, and ending with exactly one `user` message
- **AND** no other `assistant` or `user` messages appear in the suffix
- **WHEN** the proxy classifies the divergence
- **THEN** the proxy SHALL treat the request as a normal continuation
- **AND** the proxy SHALL forward it incrementally (reuse tracked `parent_message_id`, forward only the latest user turn) with no context repair

#### Scenario: Prefix chain matches but suffix contains external turns

- **GIVEN** a client sends a request whose first `chainLength` messages match the tracked prefix chain
- **AND** the suffix after `chainLength` contains a complete external provider turn (e.g. `[lastReply, externalUser, externalAssistant, currentUser]`)
- **OR** the suffix contains multiple consecutive `user` turns or an extra `assistant` message
- **WHEN** the proxy classifies the divergence
- **THEN** the proxy SHALL classify it as a tail divergence
- **AND** the proxy SHALL repair the request by appending a folded version of the diverged suffix (see the `full-context-injection` capability) while reusing the tracked upstream continuity identifiers

#### Scenario: Prefix chain matches but suffix cannot be validated

- **GIVEN** a client sends a request whose first `chainLength` messages match the tracked prefix chain
- **AND** the suffix structure is ambiguous — e.g. a `tool` message whose `tool_call_id` cannot be traced to the first assistant's tool_calls, or a role sequence matching no expected shape (client compressed or merged messages)
- **WHEN** the proxy classifies the divergence
- **THEN** the proxy SHALL NOT attempt a partial repair (painting an unverifiable suffix onto the old chain risks contradictory content)
- **AND** the proxy SHALL classify it as middle damage and rebuild from the full client history (reset upstream continuity and inject the folded full history)

#### Scenario: Prefix chain fails to match

- **GIVEN** a client sends a request whose first messages do not match the tracked prefix chain (a turn was edited, regenerated, or the middle of the history was compacted)
- **WHEN** the proxy classifies the divergence
- **THEN** the proxy SHALL classify it as middle damage
- **AND** the proxy SHALL NOT attempt partial repair
- **AND** the proxy SHALL rebuild the request from the full client history (reset upstream continuity and inject the folded full history)

#### Scenario: Client history shorter than tracked chain

- **GIVEN** a client sends a request whose message history length is less than the tracked `chainLength` (the client compacted or trimmed history below the tracked boundary)
- **WHEN** the proxy classifies the divergence
- **THEN** the proxy SHALL classify it as middle damage (the prefix cannot even reach the tracked length)
- **AND** the proxy SHALL rebuild the request from the full client history (reset upstream continuity and inject the folded full history)

#### Scenario: Client history exactly equals tracked chain length

- **GIVEN** a client sends a request whose message history length exactly equals the tracked `chainLength`
- **AND** the first `chainLength` messages match the tracked prefix chain
- **WHEN** the proxy classifies the request
- **THEN** the proxy SHALL classify it as a duplicate or stale request
- **AND** the proxy SHALL NOT call `extractUserMessage` or send the last user message to CodeArts again
- **AND** the proxy SHALL reuse an available cached response or return an explicit retryable error if no cached response is available

### Requirement: Requests excluded from divergence detection

The proxy SHALL exclude certain request classes from divergence detection, keeping their existing behavior unchanged.

**Rationale:** Tool continuations carry `messages=[]` plus `task_parameters.tool_result` and are governed by their own `tool_call_id` matching rules; sub-agent requests carry their own context via `subAgent_prompt`; caller-provided parents mean the caller manages continuity itself.

#### Scenario: Tool continuation bypasses detection

- **GIVEN** a request classified as a tool continuation (client-supplied `tool_results` or a trailing `tool` message with verifiable upstream call)
- **WHEN** the proxy processes the request
- **THEN** the proxy SHALL NOT run divergence detection
- **AND** the proxy SHALL keep the existing tool continuation behavior (empty `messages` + `task_parameters.tool_result`)

#### Scenario: Sub-agent request bypasses detection

- **GIVEN** a request that targets a sub-agent workflow (`codearts.sub_agent` present)
- **WHEN** the proxy processes the request
- **THEN** the proxy SHALL NOT run divergence detection
- **AND** the proxy SHALL keep the existing sub-agent behavior

#### Scenario: Caller-provided parent bypasses detection

- **GIVEN** a client sends a request with a non-empty `codearts.parent_message_id`
- **WHEN** the proxy processes the request
- **THEN** the proxy SHALL NOT run divergence detection
- **AND** the proxy SHALL trust the caller-provided linkage and resume incrementally

### Requirement: Repair failure falls back to full reset

If a tail-divergence repair request fails (the upstream rejects it or returns an error), the proxy SHALL retry the turn as a full-reset rebuild (reset upstream continuity and inject the folded full history).

**Rationale:** Tail-divergence repair relies on the untestable assumption that the pre-break CodeArts chain is still valid upstream. If that assumption fails, the only recovery is to rebuild from the client's full history.

#### Scenario: Tail-divergence repair fails upstream

- **GIVEN** a tail-divergence repair request is sent upstream and fails with an upstream error
- **WHEN** the proxy handles the failure
- **THEN** the proxy SHALL retry the same request with a full-reset rebuild (folded full history, empty `parent_message_id`)
- **AND** the proxy SHALL log that the tail-divergence repair fell back to full reset
- **AND** the proxy SHALL retry at most once (no infinite retry loop)

#### Scenario: Tail-divergence repair failure fallback is a dedicated branch, not rate-limit retry

- **GIVEN** a tail-divergence repair request fails with a non-rate-limit error (e.g. HTTP 500, `ChatAgent.00009999`)
- **WHEN** the proxy handles the failure
- **THEN** the proxy SHALL trigger the tail-divergence fallback branch (not the existing `isRetryableSSEError` rate-limit retry path)
- **AND** the rate-limit retry path SHALL remain unchanged for rate-limit errors

#### Scenario: Non-streaming tail-divergence repair failure fallback

- **GIVEN** a non-streaming tail-divergence repair request (`stream: false`) fails with an upstream error
- **WHEN** the proxy handles the failure in the non-streaming handler
- **THEN** the proxy SHALL retry once with a full-reset rebuild before returning
- **AND** if the retry also fails, the proxy SHALL throw the error to the caller (consistent with existing non-streaming error semantics)