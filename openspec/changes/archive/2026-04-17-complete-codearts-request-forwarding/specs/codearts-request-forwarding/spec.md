---
spec: codearts-request-forwarding
status: implemented
priority: high
created: 2026-04-16
updated: 2026-04-17
---

# CodeArts Request Forwarding

## Overview

The proxy SHALL forward requests to CodeArts while preserving conversation continuity, handling different request variants, and managing tool catalogs appropriately.

## Requirements

### REQ-FWD-001: Preserve upstream conversation continuity

The proxy SHALL preserve CodeArts conversation continuity across turns by reusing the correct upstream conversation identifiers.

**Rationale:** Creating a new upstream conversation for every request would lose context and break multi-turn interactions.

#### Scenario: Continue an existing upstream thread

- **GIVEN** a client sends a follow-up request for a previously established proxy conversation
- **WHEN** the proxy processes the request
- **THEN** the proxy SHALL reuse the stored upstream `chat_id`
- **AND** the proxy SHALL forward the latest stored upstream parent linkage identifier required by CodeArts

#### Scenario: Start a new upstream thread

- **GIVEN** a client sends a request with no existing proxy conversation state
- **WHEN** the proxy processes the request
- **THEN** the proxy SHALL create a new upstream conversation state entry
- **AND** the proxy SHALL persist the upstream conversation identifiers returned by CodeArts for future turns

### REQ-FWD-002: Forward request variants without flattening semantics

The proxy SHALL build upstream request bodies that preserve the semantic request mode.

**Rationale:** Different request types (standard, tool continuation, sub-agent) require different upstream request structures.

#### Scenario: Standard user turn

- **GIVEN** a client sends a normal chat turn
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL send an upstream request with a `messages` payload representing the current user turn
- **AND** the proxy SHALL include the task parameters required for a standard CodeArts turn

#### Scenario: Tool continuation turn

- **GIVEN** a client sends tool execution results for a prior upstream tool call
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

- **GIVEN** the proxy restarts after previously handling a conversation with stored upstream linkage metadata
- **WHEN** the proxy initializes
- **THEN** the proxy SHALL reload the persisted conversation state
- **AND** the proxy SHALL be able to continue the upstream thread without requiring the user to restart the conversation manually
