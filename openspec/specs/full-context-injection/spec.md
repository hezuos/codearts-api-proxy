---
spec: full-context-injection
status: implemented
priority: high
created: 2026-08-18
updated: 2026-08-18
---

# Full-Context Injection

## Purpose

Provides the capability to transplant a full conversation history into a CodeArts request when upstream continuity state (chat_id/parent linkage) is missing, so switching providers or model resets does not lose context.

## Requirements

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
