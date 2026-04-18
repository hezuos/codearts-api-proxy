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

The system SHALL provide an OpenAI-compatible chat completions endpoint for non-streaming requests.

**Rationale:** Non-streaming chat completions are the primary interface for LLM interactions.

#### Scenario: Client requests non-streaming completion

- **GIVEN** a client submits a valid chat completions request without streaming
- **WHEN** the system processes the request
- **THEN** the system SHALL translate the request upstream
- **AND** the system SHALL return an OpenAI-compatible chat completion response

### REQ-API-003: Streaming chat completions endpoint

The system SHALL provide an OpenAI-compatible chat completions streaming mode.

**Rationale:** Streaming responses enable real-time output for interactive applications.

#### Scenario: Client requests streaming completion

- **GIVEN** a client submits a valid chat completions request with streaming enabled
- **WHEN** the system processes the request
- **THEN** the system SHALL return an OpenAI-compatible event stream
- **AND** the stream SHALL represent incremental completion output

### REQ-API-004: Provider account routing

The system SHALL route each OpenAI-compatible request through exactly one bound Huawei Cloud provider account.

**Rationale:** Requests must be routed to a specific provider account to access upstream services.

#### Scenario: API key selects provider account

- **GIVEN** a request is authenticated by an API key bound to a provider account
- **WHEN** the system processes the request
- **THEN** the system SHALL send the upstream request using that provider account only
