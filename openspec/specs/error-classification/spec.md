---
spec: error-classification
status: implemented
priority: high
created: 2026-04-27
updated: 2026-04-27
---

# Error Classification

## Overview

The system SHALL provide a structured error class hierarchy for distinguishing error types throughout the request lifecycle.

## Requirements

### Requirement: Error class hierarchy

The system SHALL provide a structured error class hierarchy for distinguishing error types throughout the request lifecycle.

#### Scenario: Upstream authentication error

- **WHEN** the upstream returns HTTP 401 or 403
- **THEN** the system SHALL throw `UpstreamAuthError` with `httpStatus` and `responseBody` fields

#### Scenario: Upstream server error

- **WHEN** the upstream returns HTTP 5xx
- **THEN** the system SHALL throw `UpstreamServerError` with `httpStatus` and `responseBody` fields

#### Scenario: Upstream timeout

- **WHEN** an upstream request exceeds the configured timeout
- **THEN** the system SHALL throw `UpstreamTimeoutError` with `url` and `timeoutMs` fields

#### Scenario: Protocol error

- **WHEN** the upstream returns malformed SSE data or unparseable JSON
- **THEN** the system SHALL throw `ProtocolError` with `rawData` field

### Requirement: Error context propagation

All custom error classes SHALL carry a `traceId` field for log correlation.

#### Scenario: Error includes trace context

- **WHEN** any custom error is thrown during request processing
- **THEN** the error SHALL have a `traceId` field matching the current request's trace ID
