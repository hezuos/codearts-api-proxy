## ADDED Requirements

### Requirement: IP-based rate limiting on unauthenticated endpoints

The system SHALL apply IP-granularity rate limiting to unauthenticated admin endpoints to prevent brute-force attacks.

#### Scenario: Admin login rate limiting

- **WHEN** a client submits POST `/admin/login` requests
- **THEN** the system SHALL allow at most 10 requests per minute per source IP
- **AND** the system SHALL return HTTP 429 with `Retry-After` header when limit is exceeded

#### Scenario: Admin setup rate limiting

- **WHEN** a client submits POST `/admin/setup` requests
- **THEN** the system SHALL allow at most 10 requests per minute per source IP
- **AND** the system SHALL return HTTP 429 when limit is exceeded

#### Scenario: Authenticated endpoints unaffected

- **WHEN** a client accesses authenticated endpoints (`/admin/api/*`)
- **THEN** the system SHALL NOT apply IP-based rate limiting (API key rate limiting applies instead)
