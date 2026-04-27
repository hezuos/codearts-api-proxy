## MODIFIED Requirements

### Requirement: Liveness probe

The system SHALL provide a `/health` endpoint that returns 200 when the process is alive, including the application version, git commit hash, and build time from `src/version.ts`.

#### Scenario: Liveness check

- **WHEN** a client calls `GET /health`
- **THEN** the system SHALL return HTTP 200 with `{ status: "ok", version: "<APP_VERSION>", gitCommit: "<GIT_COMMIT>", buildTime: "<BUILD_TIME>" }`

### Requirement: Readiness probe

The system SHALL provide a `/ready` endpoint that checks whether the system can process requests, including the application version, git commit hash, and build time.

#### Scenario: All checks pass

- **WHEN** the data directory is accessible and writable
- **THEN** the system SHALL return HTTP 200 with `{ status: "ok", version: "<APP_VERSION>", gitCommit: "<GIT_COMMIT>", buildTime: "<BUILD_TIME>", checks: { store: true } }`

#### Scenario: Data directory inaccessible

- **WHEN** the data directory is not accessible or not writable
- **THEN** the system SHALL return HTTP 503 with `{ status: "degraded", version: "<APP_VERSION>", gitCommit: "<GIT_COMMIT>", buildTime: "<BUILD_TIME>", checks: { store: false } }`
