## MODIFIED Requirements

### REQ-ADMIN-AUTH-004: Admin login authentication

The system SHALL authenticate admin login requests using constant-time password comparison to prevent timing side-channel attacks.

**Rationale:** When admin password comes from environment variable, `===` comparison is timing-sensitive. `crypto.timingSafeEqual` eliminates this side channel.

#### Scenario: Successful admin login

- **WHEN** admin submits correct password on `/admin/login`
- **THEN** system SHALL set `admin_session` cookie
- **AND** system SHALL update `last_login` timestamp
- **AND** system SHALL redirect to `/admin`

#### Scenario: Failed admin login

- **WHEN** admin submits incorrect password on `/admin/login`
- **THEN** system SHALL return error message "Invalid password"
- **AND** system SHALL NOT set admin session cookie

#### Scenario: Environment variable password uses timing-safe comparison

- **WHEN** admin password is set via `ADMIN_PASSWORD` environment variable
- **THEN** system SHALL compare submitted password using `crypto.timingSafeEqual`
- **AND** comparison time SHALL NOT correlate with number of matching characters
