# Spec Delta

## ADDED Requirements

### Requirement: Admin creates users explicitly

The admin panel SHALL allow an authenticated admin to create users explicitly, including the first user during setup; the system SHALL NOT create users implicitly at startup. Creating a user SHALL require a non-empty display name, SHALL accept an optional email, and SHALL enforce email uniqueness only for non-empty emails compared case-insensitively after trimming.

#### Scenario: Create first user during setup

- **WHEN** admin completes initial setup with user details
- **THEN** the system creates the first user and shows it in the user list

#### Scenario: Setup validates user input

- **WHEN** admin submits setup with a missing display name or a malformed email
- **THEN** the system rejects with an explicit validation error and creates nothing

#### Scenario: Create additional user from panel

- **WHEN** an authenticated admin creates another user
- **THEN** the system creates the user and shows it in the user list

#### Scenario: Duplicate email rejected from panel

- **WHEN** admin creates a user with an already used email
- **THEN** the system rejects the request with an explicit duplicate error

### Requirement: Admin issues binding tokens

The admin panel SHALL allow an authenticated admin to issue a single-use binding token for a selected user. The plaintext token SHALL be displayed exactly once at issuance and SHALL NOT be retrievable afterwards; the panel SHALL show only expiry and consumed state for existing tokens.

#### Scenario: Issue token from admin panel

- **WHEN** admin requests a binding token for a listed user
- **THEN** the system returns a one-time token string with its expiry
