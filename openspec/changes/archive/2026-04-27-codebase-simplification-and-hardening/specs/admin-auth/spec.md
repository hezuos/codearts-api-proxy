## MODIFIED Requirements

### REQ-ADMIN-AUTH-005: Admin session cookie
The system SHALL use a separate cookie `admin_session` for admin authentication, distinct from user `auth_key` cookie. The session token SHALL be a cryptographically random value generated at process startup, NOT a hardcoded string.

#### Scenario: Admin cookie security
- **WHEN** system sets `admin_session` cookie
- **THEN** cookie SHALL have `httpOnly=true`, `secure=true` (production), and `sameSite=strict`

#### Scenario: Admin cookie validation
- **WHEN** admin accesses `/admin` or `/admin/api/*` endpoints
- **THEN** system SHALL validate `admin_session` cookie against the startup-generated random token
- **AND** system SHALL redirect to `/admin/login` if cookie is missing or invalid

#### Scenario: Session token is random
- **WHEN** the process starts
- **THEN** the admin session token SHALL be generated using `crypto.randomBytes(32)`
- **AND** the token SHALL be different across process restarts
