---
spec: api-rate-limiting
status: implemented
priority: medium
created: 2026-04-27
updated: 2026-04-27
---

# API Rate Limiting

## Overview

The system SHALL apply per-API-key rate limiting to protected endpoints to prevent upstream quota exhaustion.

## Requirements

### Requirement: Per-key rate limiting on chat completions

The system SHALL limit the rate of chat completion requests per API key to prevent upstream quota exhaustion.

#### Scenario: Rate limit enforced

- **WHEN** an API key exceeds the configured request rate limit
- **THEN** the system SHALL return HTTP 429 with OpenAI-compatible error format
- **AND** the response SHALL include `Retry-After` header

#### Scenario: Rate limit configurable

- **WHEN** the `RATE_LIMIT_MAX` environment variable is set
- **THEN** the system SHALL use that value as the maximum requests per window
- **AND** the default SHALL be 60 requests per 60-second window

### Requirement: Rate limit on model list endpoint

The system SHALL apply a separate, more permissive rate limit on the `/v1/models` endpoint.

#### Scenario: Model list rate limit

- **WHEN** an API key exceeds the model list rate limit
- **THEN** the system SHALL return HTTP 429
- **AND** the default SHALL be 120 requests per 60-second window
