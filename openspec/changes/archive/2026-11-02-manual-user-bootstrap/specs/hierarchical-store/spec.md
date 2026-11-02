# Spec Delta

## MODIFIED Requirements

### Requirement: No bootstrap default key

The system SHALL NOT create a default API Key at startup. API Keys SHALL only be created through the OAuth login flow.

#### Scenario: Startup without existing data

- **WHEN** the system starts with no existing user data
- **THEN** the system SHALL start with zero users and create nothing
- **AND** the system SHALL NOT create any user, API Key or Session implicitly

#### Scenario: API request without any key returns 401

- **WHEN** a client sends a request with no valid API key
- **THEN** the system SHALL return 401 Unauthorized

## ADDED Requirements

### Requirement: Explicit multi-user creation

The system SHALL allow creating multiple users through explicit admin operations. Email uniqueness SHALL be enforced only when a non-empty email is provided, compared case-insensitively after trimming. Users without email SHALL be allowed and SHALL NOT conflict with each other.

#### Scenario: Create first user via setup

- **WHEN** admin completes initial setup with user details
- **THEN** the system creates the first user explicitly and creates nothing implicitly

#### Scenario: Create additional user via admin

- **WHEN** an authenticated admin creates another user with a new email
- **THEN** the system creates the user with a fresh id

#### Scenario: Duplicate email rejected

- **WHEN** admin creates a user with an already used email, compared case-insensitively after trimming
- **THEN** the system rejects the request with an explicit duplicate error

#### Scenario: Users without email do not conflict

- **WHEN** admin creates users without providing an email
- **THEN** the system SHALL allow multiple such users and SHALL NOT treat missing emails as duplicates
