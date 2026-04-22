## MODIFIED Requirements

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
