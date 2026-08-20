---
spec: structured-logging
status: implemented
priority: high
created: 2026-04-27
updated: 2026-04-27
---

# Structured Logging

## Overview

The system SHALL provide a structured logger with level control, trace context, and sensitive data redaction.

## Requirements

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
