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

The system SHALL initiate Huawei Cloud login by creating a login flow bound to an explicit user and returning the information needed to complete browser-based authentication. Both the browser authorize entry and the browser start entry SHALL require explicit attribution and SHALL NOT fall back to a default user.

**Rationale:** Browser-based OAuth flow requires server-side coordination to manage login state and correlate callbacks.

#### Scenario: Start login flow

- **GIVEN** a user requests to bind a Huawei Cloud account
- **WHEN** the system initiates the login process
- **THEN** the system SHALL create a login flow record with correlation data
- **AND** the system SHALL record the explicit initiating user id on the flow
- **AND** the system SHALL return a login URL or equivalent redirect target

#### Scenario: Both browser entries require attribution

- **WHEN** an anonymous browser hits either `GET /auth/huawei/authorize` or `POST /auth/huawei/browser/start` without an authenticated user session or a valid binding token
- **THEN** the system SHALL reject with an explicit binding-required error and create no flow

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

### Requirement: Explicit user binding for anonymous login

Anonymous browser login flows SHALL NOT fall back to a default user; they SHALL resolve the user only from an authenticated cookie session or a valid binding token.

#### Scenario: Missing attribution rejected

- **WHEN** anonymous login starts with neither an authenticated user session nor a valid binding token
- **THEN** the system SHALL reject with an explicit binding-required error and create no flow

### Requirement: Authenticated API login keeps its own user

An already authenticated API login SHALL keep its own `auth.userId` as the flow owner and SHALL NOT consume a binding token.

#### Scenario: API login reuses auth user

- **WHEN** a request bearing a valid Bearer API key initiates Huawei login
- **THEN** the system SHALL bind the new flow to `auth.userId` and SHALL NOT require or consume a binding token

### Requirement: OAuth2 callback resolves flow by ticket

The OAuth2 `code + state` callback SHALL resolve the pending login flow by its ticket or state correlation instead of picking the most recently expiring flow, and SHALL provision under that flow's bound user.

#### Scenario: Concurrent logins do not cross-provision

- **WHEN** two browser login flows for different users are pending and a callback arrives for one of them
- **THEN** the system SHALL exchange and provision only under the callback-correlated flow's user
- **AND** the system SHALL NOT attach the callback result to the other user's flow

#### Scenario: Callback without correlatable flow rejected

- **WHEN** an OAuth2 callback arrives with no matching pending flow for its ticket or state
- **THEN** the system SHALL reject with an explicit unknown-or-expired-flow error and provision nothing

### Requirement: Same Huawei account SHALL NOT be stolen across users

A Huawei account id that is already bound to one proxy user SHALL NOT be silently reassigned to another proxy user by a later login; the later binding SHALL be rejected with an explicit conflict error.

#### Scenario: Second user binding same Huawei account rejected

- **WHEN** a login callback resolves to an account id already owned by a different proxy user
- **THEN** the system SHALL reject with an explicit account-conflict error and create no account, key or session under the second user

#### Scenario: Same user re-login still upserts

- **WHEN** a login callback resolves to an account id already owned by the same proxy user
- **THEN** the system SHALL upsert the account and provision a new Key plus Session as before

### HUAWEI-007: Dynamic credential refresh scheduling

The automatic refresh task SHALL use dynamic `setTimeout` scheduling based on each session's `expiresAt` field, replacing the fixed-interval `setInterval` approach.

#### Scenario: Schedule based on expiration

- **GIVEN** a key's session has refreshable credentials and a future `expiresAt`
- **WHEN** the refresh scheduler initializes
- **THEN** the system SHALL calculate the refresh delay as `expiresAt - now - 2h - random(0-59s)`
- **AND** the system SHALL schedule a `setTimeout` for the calculated delay
