## MODIFIED Requirements

### REQ-USER-002: API key authentication
The system SHALL issue and validate API keys for proxy users to authorize OpenAI-compatible API requests. Each API key SHALL have a strictly bound session (1:1). The system SHALL NOT issue API keys without an associated session. API keys SHALL be stored and looked up using SHA-256 hash, NOT plaintext values.

#### Scenario: Valid API key authorizes request with direct session access
- **GIVEN** a client has a valid API key with a bound session
- **WHEN** the client sends a request with Bearer API key to a protected proxy endpoint
- **THEN** the system SHALL hash the provided key with SHA-256
- **AND** the system SHALL look up the key by hash in the index
- **AND** the system SHALL authenticate the owning user
- **AND** the system SHALL directly retrieve the session bound to the key
- **AND** the system SHALL continue request processing using that session's credentials

#### Scenario: Invalid API key is rejected
- **GIVEN** a client has an invalid API key (missing, revoked, or unknown)
- **WHEN** the client sends a request to a protected proxy endpoint
- **THEN** the system SHALL reject the request
- **AND** the system SHALL return an authentication error response

#### Scenario: Backward compatibility with plaintext keyHash
- **GIVEN** an existing deployment where `keyHash` field contains the plaintext API key
- **WHEN** the system starts and loads existing keys
- **THEN** the system SHALL detect plaintext keyHash values (not matching SHA-256 format)
- **AND** the system SHALL migrate them to SHA-256 hash during startup
- **AND** the system SHALL maintain both plaintext and hash indexes during transition
