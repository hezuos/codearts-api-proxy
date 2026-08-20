## MODIFIED Requirements

### Requirement: Full-context injection on cache miss

When the proxy has no upstream continuity state for a request — neither a caller-provided `parent_message_id` nor a tracked `lastResponseMessageId` for the resolved `chat_id` — and the client supplies a message history containing more than the current turn, the proxy SHALL inject the complete history into the upstream request instead of forwarding only the last user message.

**Rationale:** A cache miss means the proxy cannot resume an existing CodeArts thread via `parent_message_id`; forwarding only the last message would leave the upstream model without conversation context (e.g. after switching from another provider). The "more than the current turn" guard avoids triggering injection on a genuine first-turn cold start, where the single message is already the complete context.

#### Scenario: Cache miss with multi-turn history

- **GIVEN** a client sends a request with multiple turn history and no `codearts.parent_message_id`
- **AND** the proxy has no tracked `lastResponseMessageId` for the resolved `chat_id`
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL build a single `text` message whose content contains the folded history from all client messages
- **AND** the proxy SHALL NOT forward only the last user message

#### Scenario: Cache miss with single message history

- **GIVEN** a cache-miss request whose client message history contains only the current user turn
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL NOT enter the injection branch (guarded by the `messages.length > 1` condition from the injection trigger definition)
- **AND** the proxy SHALL forward the current user turn as a normal single `text` message (identical to today's behavior)

**Note:** The "fold-then-fallback" path (design D3 boundary 4) is a separate concern for malformed multi-turn inputs that fold to an empty string; single-turn history never reaches the fold function because the D1 guard short-circuits before it.

#### Scenario: Cache hit keeps incremental forwarding

- **GIVEN** a client provides `codearts.parent_message_id` or the proxy has a tracked `lastResponseMessageId`
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL forward only the latest user message and reuse the continuity identifiers
- **AND** the proxy SHALL NOT inject the folded full history

### Requirement: Folded history format

The proxy SHALL serialize the client message history into a deterministic plain-text format that preserves sender roles and tool-call context, using role markers and separator conventions that survive upstream text handling.

**Rationale:** CodeArts `messages` elements carry no role field, so roles must be embedded in the folded text for the upstream model to interpret them.

#### Scenario: Roles are preserved

- **GIVEN** a history containing `system`, `user`, and `assistant` messages
- **WHEN** the proxy folds the history
- **THEN** the folded text SHALL mark each segment with its sender role
- **AND** the folded text SHALL order segments chronologically

#### Scenario: Developer and unknown roles are rendered

- **GIVEN** a history containing a `developer` message or a message with an unknown role
- **WHEN** the proxy folds the history
- **THEN** a `developer` message SHALL be rendered as a `[system]` segment
- **AND** a message with an unknown role SHALL be rendered as a `[unknown: <role>]` text marker
- **AND** no segment SHALL be rendered as bare text without a role marker

#### Scenario: Folded text ends with continuation directive

- **GIVEN** the proxy folds any multi-turn history
- **WHEN** the folded text is produced
- **THEN** the folded text SHALL end with a continuation directive instructing the model to continue based on the history and respond to the latest user request

#### Scenario: Tool rounds are textualized

- **GIVEN** a history containing assistant `tool_calls` and `tool` result messages
- **WHEN** the proxy folds the history
- **THEN** the proxy SHALL render each tool call and its result as text markers under their assistant/user segments
- **AND** the proxy SHALL NOT translate them into upstream `task_parameters.tool_result`

### Requirement: Truncation guard

The proxy SHALL cap the folded history so an injected message never exceeds a configured size threshold, keeping the newest turns and foundational context (system prompt, first user turn) while dropping the middle.

**Rationale:** Long cross-provider histories can exceed upstream text limits; unbounded injection risks upstream rejection.

#### Scenario: History within threshold

- **GIVEN** a folded history whose size is at or below the configured threshold
- **WHEN** the proxy injects it
- **THEN** the proxy SHALL include the complete folded history unchanged

#### Scenario: History exceeds threshold

- **GIVEN** a folded history whose size exceeds the configured threshold
- **WHEN** the proxy injects it
- **THEN** the proxy SHALL trim middle turns before folding
- **AND** the proxy SHALL retain the system prompt and the most recent turns

#### Scenario: Sub-agent request never injects

- **GIVEN** a client sends a sub-agent request (`codearts.sub_agent` present) with no upstream continuity state
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL NOT inject the folded full history
- **AND** the proxy SHALL keep the existing incremental behavior for sub-agent turns (build messages from the current user turn and rely on `subAgent_prompt` for sub-agent context)

#### Scenario: Tool continuation after cache miss

- **GIVEN** a cache-miss request whose last client message is a `tool` result
- **AND** the proxy cannot confirm that the `tool_call_id` was issued by a known CodeArts turn (cache miss means the linkage map was lost)
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL NOT route the request as a tool continuation
- **AND** the proxy SHALL fold the tool result into the injected history text (never `task_parameters.tool_result`)
- **AND** the proxy SHALL log a warning that upstream continuity is unavailable for this continuation

#### Scenario: Tool continuation with verifiable upstream call

- **GIVEN** a request whose last client message is a `tool` result
- **AND** the proxy can confirm the `tool_call_id` matches a known CodeArts-issued call (caller-provided linkage or tracked `lastResponseMessageId` present)
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL route the request as a tool continuation (empty `messages` + `task_parameters.tool_result`)
- **AND** the proxy SHALL NOT inject the folded full history

## ADDED Requirements

### Requirement: Missing-segment append format

For a tail-divergence (as classified by the `chain-divergence-detection` capability), the proxy SHALL serialize only the missing tail into a single `text` message. If the first suffix message equals the tracked last reply, that reply is already represented by `parent_message_id` and SHALL be excluded; otherwise the suffix begins at the tracked boundary. The appended content SHALL mark the missing history as reference context distinct from the current user request, reusing the existing role-marker and tool-textualization conventions.

**Rationale:** Appending only the missing tail (instead of re-folding the whole history) minimizes token cost and preserves the intact upstream chain via the tracked `parent_message_id`. Semantic drift from presenting a textified tail is mitigated by an explicit header hint and a `[当前用户请求]` marker separating the current turn from the reference context.

#### Scenario: Tail append includes header hint and request marker

- **GIVEN** a tail-divergence repair request for a `chat_id` with intact tracked chain
- **AND** the missing tail consists of several turns including a final user turn
- **WHEN** the proxy builds the missing-segment text
- **THEN** the text SHALL begin with a header hint marking the content as reference context ("仅作参考，非用户新请求")
- **AND** when the first suffix message equals the tracked last reply, the proxy SHALL exclude that reply from the folded missing segment because it is already represented by `parent_message_id`
- **AND** the proxy SHALL render the missing turns (excluding the final user turn) using the role-marker and tool-textualization conventions
- **AND** the text SHALL end with a `[当前用户请求]` marker followed by the current user turn text

#### Scenario: Missing-segment text fits no truncation

- **GIVEN** a missing-segment text whose size is at or below the configured threshold
- **WHEN** the proxy builds the message
- **THEN** the proxy SHALL include the complete missing-segment text unchanged

#### Scenario: Missing-segment text exceeds threshold

- **GIVEN** a missing-segment text whose size exceeds the configured threshold
- **WHEN** the proxy builds the message
- **THEN** the proxy SHALL trim the middle of the missing tail while retaining the header hint, the newest turns, and the final current-user request marker
- **AND** the proxy SHALL NOT use the full-history truncation strategy (which anchors on `[system]` / `[user #1]`); the missing-segment truncation anchors on the header hint and the `[当前用户请求]` marker instead

#### Scenario: Missing-segment directly fixes the turn

- **GIVEN** a tail-divergence repair request is forwarded upstream
- **WHEN** the upstream request is constructed
- **THEN** the proxy SHALL reuse the tracked upstream `chat_id` and `parent_message_id`
- **AND** the proxy SHALL set `messages` to a single `text` message containing the missing-segment text
- **AND** the proxy SHALL NOT apply the full-history fold
- **AND** when the first suffix message equals the tracked last reply, the missing-segment text SHALL begin after that reply (the `L + 1` position); otherwise it SHALL begin at the tracked boundary `L`

#### Scenario: Missing-segment repair failure falls back to full reset

- **GIVEN** a tail-divergence repair request fails with an upstream error
- **WHEN** the proxy handles the failure
- **THEN** the proxy SHALL retry the turn as a full-reset rebuild (folded full history, empty `parent_message_id`) per the `chain-divergence-detection` capability
- **AND** the proxy SHALL log that the tail-divergence append fell back to full reset