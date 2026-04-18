---
spec: user-auth
status: implemented
priority: high
created: 2026-04-14
updated: 2026-04-17
---

# User Authentication

## Overview

The system SHALL support proxy-local users as the primary tenant boundary for authentication, data ownership, and request isolation.

## Requirements

### REQ-USER-001: Proxy user identity

The system SHALL support proxy-local users as the primary tenant boundary for authentication, data ownership, and request isolation.

**Rationale:** Multi-tenant isolation requires a clear user boundary that separates all resources, credentials, and sessions.

#### Scenario: User owns isolated resources

- **GIVEN** a proxy user authenticates successfully
- **WHEN** the system processes the authentication
- **THEN** the system SHALL associate all API keys, Huawei account bindings, and sessions with that user only
- **AND** the system SHALL prevent cross-user access to resources

### REQ-USER-002: API key authentication

The system SHALL issue and validate API keys for proxy users to authorize OpenAI-compatible API requests.

**Rationale:** OpenAI-compatible clients expect Bearer token authentication. API keys provide a standard mechanism for client authentication.

#### Scenario: Valid API key authorizes request

- **GIVEN** a client has a valid API key
- **WHEN** the client sends a request with Bearer API key to a protected proxy endpoint
- **THEN** the system SHALL authenticate the owning user
- **AND** the system SHALL continue request processing

#### Scenario: Invalid API key is rejected

- **GIVEN** a client has an invalid API key (missing, revoked, or unknown)
- **WHEN** the client sends a request to a protected proxy endpoint
- **THEN** the system SHALL reject the request
- **AND** the system SHALL return an authentication error response
