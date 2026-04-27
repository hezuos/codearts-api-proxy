## MODIFIED Requirements

### Requirement: In-memory read cache with file-level persistence

The system SHALL load all entity files into memory Maps at startup for low-latency reads, and persist only the changed entity file on each write. The `getAllSessions()` function SHALL return a copy of the sessions Map, not a direct reference, to prevent uncontrolled mutations that bypass persistence.

#### Scenario: Startup loads all entities

- **WHEN** the system starts
- **THEN** the system SHALL scan the `data/users/` directory tree
- **AND** the system SHALL decrypt and load all entity files into in-memory Maps

#### Scenario: Write updates both cache and file

- **WHEN** the system writes an entity
- **THEN** the system SHALL update the in-memory Map entry
- **AND** the system SHALL write the encrypted file to disk

#### Scenario: getAllSessions returns independent copy

- **WHEN** a caller obtains the result of `getAllSessions()`
- **THEN** modifications to the returned Map SHALL NOT affect the internal sessions cache
- **AND** callers SHALL NOT mutate entries in the returned Map (entries are shared references for performance)

## ADDED Requirements

### Requirement: Decryption failure tolerance on startup

The system SHALL tolerate individual entity file decryption or parsing failures during startup, logging a warning and skipping the corrupted file rather than crashing.

#### Scenario: Corrupted entity file is skipped

- **WHEN** the system encounters a file that fails decryption or JSON parsing during `loadAllEntities`
- **THEN** the system SHALL log a warning with the file path and error message
- **AND** the system SHALL skip that entity and continue loading others
- **AND** the system SHALL start successfully

### Requirement: API key deletion cleans all indexes

The system SHALL remove API key entries from all in-memory indexes (including legacy plaintext index) when a key is deleted.

#### Scenario: Delete key removes from both indexes

- **WHEN** the system deletes an API key
- **THEN** the system SHALL remove the key from `apiKeys` Map
- **AND** the system SHALL remove the key from `apiKeysByHash` Map
- **AND** the system SHALL remove the key from `apiKeysByValue` Map (if present)
- **AND** the system SHALL remove the key from `keyLocation` Map
- **AND** the system SHALL remove the associated session from `sessions` Map
