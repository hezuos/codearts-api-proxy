## ADDED Requirements

### Requirement: Log file configuration

The system SHALL support writing log entries to a file when `LOG_FILE` is configured, and SHALL read this configuration from either the `.env` file or the process environment.

#### Scenario: LOG_FILE configured in .env

- **WHEN** `LOG_FILE` is set in the project `.env` file
- **THEN** the logger SHALL write all emitted log entries to the configured file path in append mode

#### Scenario: LOG_FILE configured in process environment

- **WHEN** `LOG_FILE` is set as a process environment variable
- **THEN** the logger SHALL write all emitted log entries to the configured file path in append mode

#### Scenario: No LOG_FILE configured

- **WHEN** neither the `.env` file nor the process environment defines `LOG_FILE`
- **THEN** the logger SHALL output entries to the console only

#### Scenario: Invalid LOG_FILE path

- **WHEN** `LOG_FILE` points to an unwritable path
- **THEN** the logger SHALL continue console output
- **AND** the logger SHALL emit a warning indicating file output failed to initialize
