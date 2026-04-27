## ADDED Requirements

### Requirement: Structured log output
The system SHALL provide a logger that outputs structured log entries with level, timestamp, traceId, and message fields.

#### Scenario: Log entry structure
- **WHEN** the logger emits a log entry
- **THEN** the entry SHALL contain `level`, `timestamp`, `traceId` (if available), and `message` fields
- **AND** in production mode the output SHALL be JSON
- **AND** in development mode the output SHALL be human-readable

### Requirement: Log level control
The system SHALL support configurable log levels (debug, info, warn, error) and suppress entries below the configured level.

#### Scenario: Production level filtering
- **WHEN** `NODE_ENV=production`
- **THEN** the logger SHALL default to `info` level
- **AND** debug-level entries SHALL NOT be emitted

#### Scenario: Development level filtering
- **WHEN** `NODE_ENV=development`
- **THEN** the logger SHALL default to `debug` level
- **AND** all entries SHALL be emitted

### Requirement: Sensitive data redaction
The system SHALL NOT log full request bodies at info level. Full bodies SHALL only appear at debug level, truncated to 2000 characters.

#### Scenario: Request body logging at info level
- **WHEN** a chat completion request is logged at info level
- **THEN** the log SHALL include model, chatId, message count, and stream flag
- **AND** the log SHALL NOT include the full request body

#### Scenario: Request body logging at debug level
- **WHEN** a chat completion request is logged at debug level
- **THEN** the log MAY include the full request body, truncated to 2000 characters
