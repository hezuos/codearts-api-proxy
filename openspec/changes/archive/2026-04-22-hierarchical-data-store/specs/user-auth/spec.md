## MODIFIED Requirements

### REQ-USER-002: API key authentication

The system SHALL issue and validate API keys for proxy users to authorize OpenAI-compatible API requests. Each API key SHALL have a strictly bound session (1:1). The system SHALL NOT issue API keys without an associated session.

**Rationale:** Key↔Session 1:1 binding ensures each client has independent credential lifecycle. Eliminates shared-session concurrency risks and fallback complexity.

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

## REMOVED Requirements

### Requirement: Bootstrap default API key

**Reason**: Key↔Session 1:1 binding makes keyless bootstrap invalid. A key without a session has no upstream credentials and cannot serve requests. OAuth login is the sole entry point for creating usable keys.

**Migration**: Existing bootstrap default keys will be migrated as regular keys during data migration. If the migrated key has no matching session, it will be skipped (not migrated).
