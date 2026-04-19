---
spec: request-translation
status: implemented
priority: high
created: 2026-04-14
updated: 2026-04-19
---

# Request and Response Translation

## Overview

The system SHALL translate between OpenAI-compatible request/response formats and CodeArts upstream formats.

## Requirements

### REQ-TRANS-001: Request message translation

The system SHALL translate OpenAI chat request messages into the upstream CodeArts-compatible request format. When the caller provides `tools` in the request, the system SHALL use those tool definitions (converted to CodeArts format) for `task_parameters.tools` instead of hardcoded definitions. When the caller does not provide `tools`, the system SHALL fall back to hardcoded tool definitions.

**Rationale:** OpenCode sends its own tool definitions that match its validation rules. Using caller-provided tools eliminates the mismatch between what the LLM sees and what the client validates.

#### Scenario: Roles and content are translated

- **GIVEN** a client submits OpenAI-format messages
- **WHEN** the system processes the request
- **THEN** the system SHALL map supported roles and content into an upstream request body
- **AND** the upstream request SHALL be accepted by CodeArts services

#### Scenario: Caller tools are forwarded to CodeArts

- **GIVEN** a client submits a request with a non-empty `tools` array
- **WHEN** the system builds the CodeArts request body
- **THEN** the system SHALL convert the caller's tools to CodeArts format and use them as `task_parameters.tools`

#### Scenario: Fallback to hardcoded tools when caller omits them

- **GIVEN** a client submits a request without `tools` or with an empty `tools` array
- **WHEN** the system builds the CodeArts request body
- **THEN** the system SHALL use the hardcoded `DEFAULT_TOOLS` as `task_parameters.tools`

### REQ-TRANS-002: Response translation

The system SHALL translate upstream non-streaming responses into OpenAI-compatible response objects.

**Rationale:** Clients expect OpenAI-format responses, but CodeArts returns responses in a different format.

#### Scenario: Upstream completion becomes OpenAI response

- **GIVEN** the upstream service returns a successful non-streaming completion
- **WHEN** the system processes the response
- **THEN** the system SHALL return an OpenAI-compatible completion payload with translated fields

### REQ-TRANS-003: Error translation

The system SHALL convert upstream errors into OpenAI-compatible HTTP and JSON error responses.

**Rationale:** Clients expect OpenAI-style error responses for proper error handling.

#### Scenario: Upstream authentication failure is surfaced

- **GIVEN** the upstream service rejects a request due to invalid or expired provider credentials
- **WHEN** the system receives the error
- **THEN** the system SHALL return a proxy error response
- **AND** the error response SHALL be consistent with OpenAI-style client expectations
