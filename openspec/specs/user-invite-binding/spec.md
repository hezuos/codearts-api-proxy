# user-invite-binding Specification

## Purpose

Lets administrators onboard users explicitly with single-use binding tokens instead of auto-created default users.

## Requirements

### Requirement: Binding token issuance

The system SHALL let an authenticated admin issue a single-use binding token for an explicit user. Tokens SHALL be cryptographically random, SHALL expire after 15 minutes, SHALL be stored in memory only, and SHALL be shown to the admin exactly once at issuance.

#### Scenario: Issue token for explicit user

- **WHEN** admin requests a binding token for an existing user id
- **THEN** the system returns a one-time token bound to that user with an expiry timestamp, and the plaintext token is never retrievable again

#### Scenario: Issue token for unknown user fails

- **WHEN** admin requests a binding token for a nonexistent user id
- **THEN** the system returns 404 and issues no token

### Requirement: Single-use token consumption

A binding token SHALL be usable at most once and SHALL expire after its TTL. Consumption SHALL be atomic so concurrent logins with the same token allow at most one success. Reuse or expiry SHALL be rejected with an explicit error, and deleting the bound user SHALL immediately invalidate its outstanding tokens.

#### Scenario: Token consumed once

- **WHEN** an anonymous browser login presents a valid unused unexpired token in the `invite_token` field
- **THEN** the system consumes the token and binds the login flow to the token user

#### Scenario: Token reuse rejected

- **WHEN** a login presents an already consumed token
- **THEN** the system rejects the request with an explicit token-invalid error

#### Scenario: Expired token rejected

- **WHEN** a login presents an expired token
- **THEN** the system rejects the request with an explicit token-expired error and the token is purged

#### Scenario: Concurrent use allows at most one success

- **WHEN** two logins present the same unused token concurrently
- **THEN** exactly one SHALL succeed and the other SHALL be rejected as token-invalid

#### Scenario: Deleted user invalidates tokens

- **WHEN** the bound user is deleted before the token is used
- **THEN** the token SHALL be invalidated and any later use SHALL be rejected as token-invalid

### Requirement: Anonymous login requires binding token

Anonymous browser login SHALL NOT guess a user; it SHALL require a valid binding token in the `invite_token` field and carry the explicit user through the whole flow. Missing, reused, or expired tokens SHALL map to explicit 400 errors, and a process restart SHALL invalidate all outstanding tokens.

#### Scenario: Login without token rejected

- **WHEN** an anonymous browser starts Huawei login without a token
- **THEN** the system rejects with an explicit binding-required error

#### Scenario: Login with token carries explicit user

- **WHEN** an anonymous browser starts login with a valid token
- **THEN** the flow record stores the token user id and the callback provisions under that user
