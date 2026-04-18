## ADDED Requirements

### Requirement: Admin password from environment variable

The system SHALL accept admin password from `ADMIN_PASSWORD` environment variable with highest priority.

#### Scenario: Environment variable takes precedence

- **WHEN** `ADMIN_PASSWORD` environment variable is set
- **THEN** system SHALL use it as admin password
- **AND** system SHALL NOT require setup page
- **AND** system SHALL mark admin as configured

### Requirement: Admin password from setup page

The system SHALL allow admin password configuration via setup page when environment variable is not set.

#### Scenario: Redirect to setup when not configured

- **WHEN** user accesses `/admin` and admin password is not configured
- **THEN** system SHALL redirect to `/admin/setup`

#### Scenario: Setup page saves password

- **WHEN** user submits password on `/admin/setup` page
- **THEN** system SHALL hash password with bcrypt (cost factor 12)
- **AND** system SHALL save hash to `data/admin-config.json`
- **AND** system SHALL set admin session cookie
- **AND** system SHALL redirect to `/admin`

### Requirement: Admin password persistence

The system SHALL persist admin password hash in `data/admin-config.json` file.

#### Scenario: Password file structure

- **WHEN** admin password is saved
- **THEN** file SHALL contain `password_hash` (bcrypt hash), `created_at`, `last_login`, and `source` fields

#### Scenario: Load existing password on startup

- **WHEN** system starts and `data/admin-config.json` exists
- **THEN** system SHALL load admin password hash from file
- **AND** system SHALL mark admin as configured

### Requirement: Admin login authentication

The system SHALL authenticate admin login requests using bcrypt password comparison.

#### Scenario: Successful admin login

- **WHEN** admin submits correct password on `/admin/login`
- **THEN** system SHALL set `admin_session` cookie
- **AND** system SHALL update `last_login` timestamp
- **AND** system SHALL redirect to `/admin`

#### Scenario: Failed admin login

- **WHEN** admin submits incorrect password on `/admin/login`
- **THEN** system SHALL return error message "Invalid password"
- **AND** system SHALL NOT set admin session cookie

### Requirement: Admin session cookie

The system SHALL use a separate cookie `admin_session` for admin authentication, distinct from user `auth_key` cookie.

#### Scenario: Admin cookie security

- **WHEN** system sets `admin_session` cookie
- **THEN** cookie SHALL have `httpOnly=true`, `secure=true` (production), and `sameSite=strict`

#### Scenario: Admin cookie validation

- **WHEN** admin accesses `/admin` or `/admin/api/*` endpoints
- **THEN** system SHALL validate `admin_session` cookie
- **AND** system SHALL redirect to `/admin/login` if cookie is missing or invalid

### Requirement: Admin logout

The system SHALL allow admin to logout and clear session cookie.

#### Scenario: Admin logout clears cookie

- **WHEN** admin posts to `/admin/logout`
- **THEN** system SHALL clear `admin_session` cookie
- **AND** system SHALL redirect to home page `/`
