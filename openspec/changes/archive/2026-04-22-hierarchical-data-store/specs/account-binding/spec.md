## MODIFIED Requirements

### REQ-ACCT-004: Account unbinding

The system SHALL allow a user to unbind a Huawei Cloud account they previously bound. Unbinding an account SHALL cascade-delete all API keys and sessions under that account.

**Rationale:** Cascade deletion ensures no orphaned keys or sessions remain after account removal. With Key↔Session 1:1, each key directory contains its session, so deleting the key directory removes both.

#### Scenario: User unbinds account

- **GIVEN** a user has a bound Huawei Cloud account with N keys
- **WHEN** the user unbinds the provider account
- **THEN** the system SHALL delete the account directory and all its contents
- **AND** the system SHALL delete N key directories (each containing key.json and session.json)
- **AND** the system SHALL prevent future request routing through that account

## ADDED Requirements

### Requirement: Session belongs to key not account

Sessions SHALL be stored as children of API Keys (`keys/{keyId}/session.json`), not as standalone entities keyed by `providerAccountId`. The session's lifecycle SHALL be tied to its owning key.

#### Scenario: Session path reflects key ownership

- **WHEN** the system stores a session for a key
- **THEN** the session file path SHALL be `data/users/{userId}/accounts/{accountId}/keys/{keyId}/session.json`

#### Scenario: Deleting a key deletes its session

- **WHEN** an API key is deleted or revoked
- **THEN** the system SHALL delete the key's `session.json`
- **AND** the session credentials SHALL no longer be available for upstream requests
