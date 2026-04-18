---
spec: proxy-context-passthrough
status: implemented
priority: high
created: 2026-04-16
updated: 2026-04-17
---

# Proxy Context Passthrough

## Overview

The proxy SHALL construct upstream requests using field source classification to ensure minimal intervention and proper context passthrough from callers.

## Requirements

### REQ-CTX-001: Field source classification for task_parameters

The proxy SHALL classify and populate upstream `task_parameters` fields according to three categories: PASSTHROUGH, PROTOCOL, and CALLER_OR_DEFAULT.

**Rationale:** Clear field classification ensures predictable behavior and prevents unintended data leakage from the proxy runtime environment.

#### Field Categories

- **PASSTHROUGH**: Field value comes from caller when provided, otherwise uses empty value (`""`, `[]`, `false`). Never inferred from proxy runtime environment.
- **PROTOCOL**: Field value is a fixed protocol value confirmed by packet capture. Not controlled by caller.
- **CALLER_OR_DEFAULT**: Field value comes from caller when provided, otherwise uses fixed default value confirmed by packet capture.

### REQ-CTX-002: currentWorkingDirectory handling

The proxy SHALL handle `environmentDetails.currentWorkingDirectory` as a PASSTHROUGH field.

#### Scenario: currentWorkingDirectory from caller

- **GIVEN** the caller provides `codearts.current_working_directory` or `codearts.workspace_root`
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL use the caller-provided value as `environmentDetails.currentWorkingDirectory`

#### Scenario: currentWorkingDirectory missing

- **GIVEN** the caller does not provide working directory fields
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL set `environmentDetails.currentWorkingDirectory` to empty string `""`
- **AND** the proxy SHALL NOT use `process.cwd()` or any proxy runtime path

### REQ-CTX-003: osVersion handling

The proxy SHALL handle `environmentDetails.osVersion` as a CALLER_OR_DEFAULT field.

#### Scenario: osVersion from caller

- **GIVEN** the caller provides `codearts.os_version`
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL use the caller-provided value as `environmentDetails.osVersion`

#### Scenario: osVersion missing

- **GIVEN** the caller does not provide `codearts.os_version`
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL set `environmentDetails.osVersion` to `"win32"`
- **AND** the proxy SHALL NOT use `process.platform`

### REQ-CTX-004: Protocol fixed fields

The proxy SHALL use fixed values for PROTOCOL fields as confirmed by packet capture.

**Rationale:** Protocol fields are determined by the upstream API contract and must not vary based on caller input.

#### Scenario: Protocol fields are fixed

- **GIVEN** the proxy constructs any upstream request
- **WHEN** the request is sent
- **THEN** `routerVersion` SHALL be `"v2"`
- **AND** `isNewClient` SHALL be `true`
- **AND** `features.support_end_tag` SHALL be `true`
- **AND** `client` SHALL be `"IDE"`
- **AND** `task` SHALL be `"plan-execute"`
- **AND** `agent_id` SHALL be `"CodeAgent"`
- **AND** `ide` SHALL be `"CodeArts Agent"`

### REQ-CTX-005: Caller-or-default fields

The proxy SHALL use caller values or captured defaults for CALLER_OR_DEFAULT fields.

#### Scenario: preferred_language caller override

- **GIVEN** the caller provides `codearts.preferred_language`
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL use the caller-provided value

#### Scenario: preferred_language default

- **GIVEN** the caller does not provide `codearts.preferred_language`
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL use `"zh-cn"`

#### Scenario: codebase_search default

- **GIVEN** the caller does not provide `codearts.codebase_search`
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL use `false`

#### Scenario: enable_code_interpreter default

- **GIVEN** the caller does not provide `codearts.enable_code_interpreter`
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL use `false`

#### Scenario: projectLevelPrompt default

- **GIVEN** the caller does not provide `codearts.project_level_prompt`
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL use `""`

### REQ-CTX-006: Proxy runtime environment isolation

The proxy SHALL NOT leak its runtime environment information into upstream requests.

**Rationale:** Leaking proxy runtime information could cause unexpected behavior and security concerns.

#### Scenario: No process.cwd() in upstream request

- **GIVEN** the caller does not provide working directory
- **WHEN** any upstream request is constructed
- **THEN** `environmentDetails.currentWorkingDirectory` SHALL NOT contain the proxy process's `process.cwd()` value

#### Scenario: No process.platform in upstream request

- **GIVEN** the caller does not provide OS version
- **WHEN** any upstream request is constructed
- **THEN** `environmentDetails.osVersion` SHALL NOT contain the proxy process's `process.platform` value
