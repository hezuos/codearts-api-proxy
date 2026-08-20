---
spec: codearts-request-forwarding
status: implemented
priority: high
created: 2026-04-16
updated: 2026-08-18
---

# CodeArts Request Forwarding

## Purpose

Defines how the proxy forwards CodeArts requests while preserving conversation continuity, handling request variants, and managing tool catalogs.

## Overview

The proxy SHALL forward requests to CodeArts while preserving conversation continuity, handling different request variants, and managing tool catalogs appropriately.

## Requirements

### REQ-FWD-001: Preserve upstream conversation continuity

The proxy SHALL preserve CodeArts conversation continuity across turns by reusing the correct upstream conversation identifiers and validating the client history when warm-chain repair is enabled.

**Rationale:** Creating a new upstream conversation for every request would lose context and break multi-turn interactions. A tracked parent alone is insufficient after the client switches providers; the proxy must distinguish a valid single-turn continuation from a divergent suffix.

#### Scenario: Continue an existing upstream thread

- **GIVEN** a client sends a follow-up request for a previously established proxy conversation
- **WHEN** the proxy processes the request
- **THEN** the proxy SHALL reuse the stored upstream `chat_id`
- **AND** the proxy SHALL forward the latest stored upstream parent linkage identifier required by CodeArts

#### Scenario: Continue a thread after verifying the chain is intact

- **GIVEN** the client does not provide `codearts.parent_message_id`
- **AND** the proxy has chain state for the resolved `chat_id`
- **AND** the tracked prefix matches and the complete suffix is one valid continuation (`lastReply + traceable tool results + one current user`)
- **WHEN** the proxy processes the request
- **THEN** the proxy SHALL reuse the stored parent linkage
- **AND** the proxy SHALL forward only the latest user turn

#### Scenario: Continue a thread after a tail divergence

- **GIVEN** the client does not provide `codearts.parent_message_id`
- **AND** the tracked prefix matches but the suffix contains explicit external provider turns or extra user/assistant messages
- **WHEN** the proxy processes the request
- **THEN** the proxy SHALL reuse the stored `chat_id` and parent linkage
- **AND** the proxy SHALL append only the folded missing suffix
- **AND** if the boundary message is the tracked last reply, the appended suffix SHALL start after that reply

#### Scenario: Continue a thread after middle damage

- **GIVEN** the client does not provide `codearts.parent_message_id`
- **AND** the tracked prefix fails or the suffix cannot be safely validated
- **WHEN** the proxy processes the request
- **THEN** the proxy SHALL reset upstream continuity with an empty `parent_message_id`
- **AND** the proxy SHALL forward the folded full client history

#### Scenario: Reject duplicate or stale request

- **GIVEN** the client history exactly matches the tracked chain length and prefix
- **WHEN** the proxy processes the request
- **THEN** the proxy SHALL NOT forward the last user message again
- **AND** it SHALL reuse a cached response or return a retryable error

#### Scenario: Start a new upstream thread

- **GIVEN** a client sends a request with no existing proxy conversation state
- **WHEN** the proxy processes the request
- **THEN** the proxy SHALL create a new upstream conversation state entry
- **AND** the proxy SHALL persist the upstream conversation identifiers returned by CodeArts for future turns

#### Scenario: Start a new upstream thread with full history

- **GIVEN** a client sends a request with no existing proxy conversation state (no caller-provided `parent_message_id` and no tracked `lastResponseMessageId` for the resolved `chat_id`)
- **AND** the client message history contains more than the current turn
- **WHEN** the proxy processes the request
- **THEN** the proxy SHALL create a new upstream conversation state entry
- **AND** the proxy SHALL inject the folded full message history into the upstream `messages` payload instead of forwarding only the latest user message
- **AND** the proxy SHALL persist the upstream conversation identifiers returned by CodeArts for future turns

### REQ-FWD-002: Forward request variants without flattening semantics

The proxy SHALL build upstream request bodies that preserve the semantic request mode.

**Rationale:** Different request types (standard, tool continuation, sub-agent) require different upstream request structures.

#### Scenario: Standard user turn with continuity

- **GIVEN** a client sends a normal chat turn with upstream continuity available (caller-provided `parent_message_id` or tracked `lastResponseMessageId` for the resolved `chat_id`)
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL send an upstream request with a `messages` payload representing the current user turn
- **AND** the proxy SHALL include the task parameters required for a standard CodeArts turn

#### Scenario: Standard user turn without continuity

- **GIVEN** a client sends a normal chat turn with no upstream continuity available
- **AND** the client message history contains more than the current turn
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL send an upstream request whose `messages` payload is a single folded `text` message containing the full history
- **AND** the proxy SHALL include the task parameters required for a standard CodeArts turn

#### Scenario: Tool continuation turn

- **GIVEN** a client sends tool execution results for a prior upstream tool call
- **AND** the proxy can confirm the `tool_call_id` matches a known CodeArts-issued call (caller-provided linkage or tracked `lastResponseMessageId` present)
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL send an upstream request with empty `messages`
- **AND** the proxy SHALL place the structured tool execution results under upstream-compatible `task_parameters.tool_result`

#### Scenario: Sub-agent turn

- **GIVEN** a client sends a request that targets a sub-agent workflow
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL send an upstream request with `isSubAgent` enabled
- **AND** the proxy SHALL include the sub-agent type and any required sub-agent prompt metadata

### REQ-FWD-003: Use context-appropriate tool catalogs and model routing

The proxy SHALL forward upstream tool definitions and model identifiers that match the selected request mode.

**Rationale:** Different request modes require different tool catalogs and model configurations.

#### Scenario: Standard request tool catalog

- **GIVEN** the proxy forwards a standard CodeArts request
- **WHEN** the request is constructed
- **THEN** the proxy SHALL use the validated default CodeArts tool catalog for standard turns

#### Scenario: Sub-agent tool catalog

- **GIVEN** the proxy forwards a sub-agent request
- **WHEN** the request is constructed
- **THEN** the proxy SHALL use the validated reduced tool catalog for that sub-agent mode

#### Scenario: Known model routing

- **GIVEN** a client requests a model name that has a validated CodeArts model mapping
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL forward the corresponding validated upstream `model_id`

### REQ-FWD-004: Surface tool calls and maintain continuation metadata

The proxy SHALL translate upstream tool-call responses into OpenAI-compatible response fields and retain the metadata needed for continuation.

**Rationale:** Tool calls must be properly translated and continuation metadata preserved for subsequent requests.

#### Scenario: Upstream returns tool calls

- **GIVEN** CodeArts returns one or more tool calls in a response
- **WHEN** the proxy processes the response
- **THEN** the proxy SHALL expose them in the OpenAI-compatible response as tool calls
- **AND** the proxy SHALL retain any upstream linkage metadata required for the next continuation turn

#### Scenario: Process restart after a prior turn

- **GIVEN** the proxy restarts after previously handling a conversation with in-memory upstream linkage metadata
- **WHEN** the proxy processes the next request for that conversation
- **THEN** the proxy SHALL NOT assume the upstream thread can be resumed (in-memory linkage is lost on restart; there is no persisted conversation state for chat linkage)
- **AND** the proxy SHALL treat the request per the full-context injection rules of the `full-context-injection` capability (inject folded history when the restart lost all linkage and the client history contains more than the current turn)
- **AND** when the client provides `codearts.parent_message_id`, the proxy SHALL trust the caller-provided linkage and resume incrementally
