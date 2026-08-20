---
spec: env-loading
status: implemented
priority: high
created: 2026-08-20
updated: 2026-08-20
---

# Environment Loading

## Purpose

Provides a single, deterministic environment variable loading entry point that injects `.env` before any module reads process-level configuration.

## Requirements

### Requirement: Unified environment loading

The system SHALL load environment variables from the project root `.env` file through a single dedicated module, and SHALL do so before any other module reads environment variables at module load time.

#### Scenario: .env injected before module-level reads

- **WHEN** the application starts
- **THEN** the unified environment module SHALL be loaded first
- **AND** all modules that read environment variables at module load time SHALL observe values from `.env`

### Requirement: ENV_FILE path override

The system SHALL support overriding the `.env` file location through the `ENV_FILE` environment variable.

#### Scenario: Custom env file location

- **WHEN** `ENV_FILE` is set to a custom path
- **THEN** environment variables SHALL be loaded from that path instead of the default project root `.env`

### Requirement: Existing environment variables take precedence

The system SHALL NOT overwrite environment variables that are already set in the process environment.

#### Scenario: System environment variable wins over .env

- **WHEN** `LOG_FILE` is already set in the process environment
- **AND** the `.env` file also defines `LOG_FILE`
- **THEN** the already-set process environment value SHALL be used
