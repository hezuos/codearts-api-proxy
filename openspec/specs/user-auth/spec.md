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

The system SHALL issue and validate API keys for proxy users to authorize OpenAI-compatible API requests. Each API key SHALL have a strictly bound session (1:1). The system SHALL NOT issue API keys without an associated session. The system SHALL NOT store API key plaintext values in runtime memory indexes — only SHA-256 hash indexes SHALL be used for lookup at runtime.

**Rationale:** Key↔Session 1:1 binding ensures each client has independent credential lifecycle. Eliminates shared-session concurrency risks and fallback complexity. Removing plaintext runtime index minimizes credential exposure in memory dumps.

#### Scenario: Valid API key authorizes request with direct session access

- **GIVEN** a client has a valid API key with a bound session
- **WHEN** the client sends a request with Bearer API key to a protected proxy endpoint
- **THEN** the system SHALL authenticate the owning user
- **AND** the system SHALL directly retrieve the session bound to the key
- **AND** the system SHALL continue request processing using that session's credentials

#### Scenario: Invalid API key is rejected

- **GIVEN** a client has an invalid API key (missing, revoked, or unknown)
- **WHEN** the client sends a request to a protected proxy endpoint
- **THEN** the system SHALL reject the request
- **AND** the system SHALL return an authentication error response

#### Scenario: API key lookup uses hash index only

- **WHEN** the system validates an API key by its raw value
- **THEN** the system SHALL hash the raw value with SHA-256
- **AND** the system SHALL look up the key in the hash index
- **AND** the system SHALL NOT access any plaintext value index at runtime

#### Scenario: Backward compatibility with plaintext keyHash

- **GIVEN** an existing deployment where `keyHash` field contains the plaintext API key
- **WHEN** the system starts and loads existing keys
- **THEN** the system SHALL detect plaintext keyHash values (not matching SHA-256 format)
- **AND** the system SHALL migrate them to SHA-256 hash during startup
- **AND** the system SHALL maintain both plaintext and hash indexes during transition

### Requirement: Session refresh atomicity

The system SHALL update session credentials atomically — if refresh fails partway, the cached session SHALL remain in its pre-refresh state.

#### Scenario: Refresh encrypt failure preserves original session

- **WHEN** `refreshStoredSession` fails during `encryptString` of the new secret key
- **THEN** the in-memory session SHALL retain its original `accessKey`, `secretKeyCiphertext`, and `securityToken`
- **AND** the session SHALL remain usable for subsequent requests

#### Scenario: Refresh success updates atomically

- **WHEN** `refreshStoredSession` completes successfully
- **THEN** the in-memory session SHALL be updated with all new credential fields simultaneously
- **AND** the updated session SHALL be persisted to disk
