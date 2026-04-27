---
spec: openai-api
status: implemented
priority: high
created: 2026-04-14
updated: 2026-04-17
---

# OpenAI-Compatible API

## Overview

The system SHALL provide OpenAI-compatible endpoints for model listing and chat completions, including streaming responses.

## Requirements

### REQ-API-001: Models endpoint

The system SHALL provide an OpenAI-compatible models endpoint for clients integrating through the proxy.

**Rationale:** OpenAI SDKs and clients expect a `/v1/models` endpoint to discover available models.

#### Scenario: Client requests models

- **GIVEN** a client has valid authentication
- **WHEN** the client calls the models endpoint
- **THEN** the system SHALL return an OpenAI-compatible models response

### REQ-API-002: Chat completions endpoint

The system SHALL provide an OpenAI-compatible chat completions endpoint for non-streaming requests. The request body construction SHALL return a structured object to avoid double serialization. The conversation ID derivation SHALL include user identity to prevent cross-account collision.

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

The system SHALL provide an OpenAI-compatible chat completions streaming mode. The upstream request timeout SHALL be configurable via environment variable.

**Rationale:** Streaming responses enable real-time output for interactive applications. Hardcoded 120s timeout may be insufficient for long-running agent conversations.

#### Scenario: Client requests streaming completion

- **GIVEN** a client submits a valid chat completions request with streaming enabled
- **WHEN** the system processes the request
- **THEN** the system SHALL return an OpenAI-compatible event stream
- **AND** the stream SHALL represent incremental completion output

#### Scenario: Upstream timeout is configurable

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
