## MODIFIED Requirements

### Requirement: In-memory read cache with file-level persistence
The system SHALL load all entity files into memory Maps at startup for low-latency reads, and persist only the changed entity file on each write. Runtime read/write operations on the hot path SHALL use asynchronous I/O to avoid blocking the event loop.

#### Scenario: Startup loads all entities
- **WHEN** the system starts
- **THEN** the system SHALL scan the `data/users/` directory tree
- **AND** the system SHALL decrypt and load all entity files into in-memory Maps
- **AND** startup loading MAY use synchronous I/O (one-time operation)

#### Scenario: Write updates both cache and file asynchronously
- **WHEN** the system writes an entity during request processing
- **THEN** the system SHALL update the in-memory Map entry synchronously
- **AND** the system SHALL write the encrypted file to disk asynchronously
- **AND** the system SHALL NOT block the event loop on disk I/O

## ADDED Requirements

### Requirement: Encryption key mandatory in production
The system SHALL require the `ENCRYPTION_KEY` environment variable in production mode and SHALL NOT fall back to a hardcoded default.

#### Scenario: Production without ENCRYPTION_KEY
- **WHEN** `NODE_ENV=production` and `ENCRYPTION_KEY` is not set
- **THEN** the system SHALL fail to start with a clear error message

#### Scenario: Development without ENCRYPTION_KEY
- **WHEN** `NODE_ENV=development` and `ENCRYPTION_KEY` is not set
- **THEN** the system SHALL use a development-only default key with a startup warning
