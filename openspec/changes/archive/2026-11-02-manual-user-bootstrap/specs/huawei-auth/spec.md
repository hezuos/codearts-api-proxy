# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
