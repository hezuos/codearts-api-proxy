---
spec: huawei-auth
status: implemented
priority: high
created: 2026-04-14
updated: 2026-04-17
---

# Huawei Authentication

## Overview

The system SHALL manage Huawei Cloud login flows, session persistence, and automatic credential refresh.

## Requirements

### REQ-HUAWEI-001: Huawei login initiation

The system SHALL initiate Huawei Cloud login by creating a login flow and returning the information needed to complete browser-based authentication.

**Rationale:** Browser-based OAuth flow requires server-side coordination to manage login state and correlate callbacks.

#### Scenario: Start login flow

- **GIVEN** a user requests to bind a Huawei Cloud account
- **WHEN** the system initiates the login process
- **THEN** the system SHALL create a login flow record with correlation data
- **AND** the system SHALL return a login URL or equivalent redirect target

### REQ-HUAWEI-002: Login callback completion

The system SHALL complete Huawei Cloud login by accepting callback data, exchanging it for upstream session credentials, and creating a new API Key with a bound Session (1:1) attached to the initiating user's provider account.

**Rationale:** Each login produces an independent Key+Session pair. Multiple logins to the same account create multiple keys, each with its own session and credential lifecycle.

#### Scenario: Callback completes successfully

- **GIVEN** a pending login flow exists
- **WHEN** the system receives valid callback data for the login flow
- **THEN** the system SHALL exchange the login artifacts for session credentials
- **AND** the system SHALL create or update the bound provider account
- **AND** the system SHALL create a new API Key bound to the account
- **AND** the system SHALL create a Session bound to the new API Key (1:1)

### REQ-HUAWEI-003: Session persistence

The system SHALL persist upstream session material as an independently encrypted file within the owning API Key's directory. Each session SHALL be stored in its own file at `keys/{keyId}/session.json`.

**Rationale:** Per-key session storage enables independent credential lifecycle per client, eliminates shared-session concurrency risks.

#### Scenario: Session is stored after login

- **GIVEN** login exchange succeeds and a new API Key is created
- **WHEN** the system processes the session credentials
- **THEN** the system SHALL store the session as `keys/{keyId}/session.json` with expiration metadata
- **AND** the system SHALL encrypt the session file independently
- **AND** the system SHALL store secret material required for refresh

### REQ-HUAWEI-004: Automatic refresh

The system SHALL automatically refresh upstream Huawei session credentials per-key before expiration when refreshable credentials are available. Refresh SHALL operate on individual key sessions independently.

**Rationale:** Per-key refresh ensures one key's credential update does not affect other keys using the same account. Each key has independent refresh timing and state.

#### Scenario: Refresh executes per-key before expiry

- **GIVEN** a key's session approaches its refresh threshold
- **WHEN** the refresh task runs
- **THEN** the system SHALL refresh that key's session credentials
- **AND** the system SHALL update only that key's `session.json`
- **AND** the system SHALL NOT affect other keys' sessions

#### Scenario: Expired unrefreshable session becomes unusable

- **GIVEN** a key's session is expired
- **AND** refresh fails or is impossible
- **WHEN** the system detects the expired session
- **THEN** the system SHALL mark the session unavailable
- **AND** the system SHALL require re-login before future upstream requests using that key

### HUAWEI-005: New IAM credential format support

The login callback SHALL support detecting and processing both the legacy and `NewIamLogin` credential formats from the upstream API. The `provisionLoginResult` SHALL automatically dispatch to the appropriate handler based on the detected format.

#### Scenario: Callback with new IAM format credentials

- **GIVEN** a pending login flow exists
- **WHEN** the ticket exchange response uses `NewIamLogin` format
- **THEN** the system SHALL detect the format via `payload.credentials.access_key_id`
- **AND** the system SHALL extract credentials using the new field mapping
- **AND** the system SHALL persist `refreshToken` if present
- **AND** the system SHALL record `credentialFormat: "new_iam"` on the session

### HUAWEI-006: IAM user info resolution

The login callback SHALL resolve user identity information via IAM API when processing a `NewIamLogin` response that lacks direct user info fields.

#### Scenario: Resolve user info for new format

- **GIVEN** a login flow using `NewIamLogin` format
- **WHEN** `user_id`/`user_name`/`domain_id` are missing from the response payload
- **THEN** the system SHALL call `resolveUserInfo` with the extracted credentials
- **AND** the system SHALL use the returned identity info for account provisioning

### HUAWEI-007: Dynamic credential refresh scheduling

The automatic refresh task SHALL use dynamic `setTimeout` scheduling based on each session's `expiresAt` field, replacing the fixed-interval `setInterval` approach.

#### Scenario: Schedule based on expiration

- **GIVEN** a key's session has refreshable credentials and a future `expiresAt`
- **WHEN** the refresh scheduler initializes
- **THEN** the system SHALL calculate the refresh delay as `expiresAt - now - 2h - random(0-59s)`
- **AND** the system SHALL schedule a `setTimeout` for the calculated delay
