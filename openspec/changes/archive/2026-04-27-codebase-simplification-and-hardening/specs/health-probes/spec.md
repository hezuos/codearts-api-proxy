## ADDED Requirements

### Requirement: Liveness probe
The system SHALL provide a `/health` endpoint that returns 200 when the process is alive.

#### Scenario: Liveness check
- **WHEN** a client calls `GET /health`
- **THEN** the system SHALL return HTTP 200 with `{ status: "ok" }`

### Requirement: Readiness probe
The system SHALL provide a `/ready` endpoint that checks whether the system can process requests.

#### Scenario: All checks pass
- **WHEN** the data directory is accessible and writable
- **THEN** the system SHALL return HTTP 200 with `{ status: "ok", checks: { store: true } }`

#### Scenario: Data directory inaccessible
- **WHEN** the data directory is not accessible or not writable
- **THEN** the system SHALL return HTTP 503 with `{ status: "degraded", checks: { store: false } }`
