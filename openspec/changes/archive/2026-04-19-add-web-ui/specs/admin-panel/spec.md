## ADDED Requirements

### Requirement: Admin panel displays system status

The system SHALL display system-wide statistics on the admin panel.

#### Scenario: Show system statistics

- **WHEN** admin accesses `/admin` with valid `admin_session` cookie
- **THEN** page SHALL display total number of users
- **AND** page SHALL display total number of bound accounts
- **AND** page SHALL display total number of active API keys

### Requirement: Admin panel displays all users

The system SHALL display list of all users with their associated accounts and API keys.

#### Scenario: List all users

- **WHEN** admin panel loads
- **THEN** page SHALL display all users from auth store
- **AND** each user SHALL show email, display name, and creation date

#### Scenario: Show user accounts

- **WHEN** admin panel displays a user
- **THEN** page SHALL show number of bound accounts for that user
- **AND** page SHALL list each account with status (valid, expiring, expired)

#### Scenario: Show user API keys

- **WHEN** admin panel displays a user
- **THEN** page SHALL show all API keys for that user (masked)
- **AND** page SHALL indicate which key is active vs revoked

### Requirement: Admin can revoke API keys

The system SHALL allow admin to revoke any user's API key.

#### Scenario: Revoke API key

- **WHEN** admin clicks "Revoke" button for an API key
- **THEN** system SHALL set `revokedAt` timestamp on the API key
- **AND** page SHALL update to show key as revoked
- **AND** user SHALL see success message

#### Scenario: Cannot revoke already revoked key

- **WHEN** admin views a revoked API key
- **THEN** "Revoke" button SHALL be disabled or hidden

### Requirement: Admin can force token refresh

The system SHALL allow admin to force token refresh for any account.

#### Scenario: Force refresh account token

- **WHEN** admin clicks "Force Refresh" button for an account
- **THEN** system SHALL call refresh endpoint for that provider account
- **AND** page SHALL update with new expiration time
- **AND** admin SHALL see success or error message

### Requirement: Admin can view account details

The system SHALL allow admin to view detailed information for any account.

#### Scenario: View account details

- **WHEN** admin clicks "View" or account name
- **THEN** page SHALL show account details including:
  - Provider user ID and name
  - Domain ID
  - Token expiration time
  - Last refresh time
  - Account status

### Requirement: Admin panel requires admin authentication

The system SHALL require valid `admin_session` cookie to access admin panel.

#### Scenario: Unauthenticated access redirected

- **WHEN** user accesses `/admin` without valid `admin_session` cookie
- **THEN** system SHALL redirect to `/admin/login` or `/admin/setup`

### Requirement: Admin API endpoints require authentication

The system SHALL require admin authentication for all `/admin/api/*` endpoints.

#### Scenario: API authentication required

- **WHEN** request is made to `/admin/api/*` without valid `admin_session` cookie
- **THEN** system SHALL return 401 Unauthorized

### Requirement: Admin panel provides logout

The system SHALL allow admin to logout from the panel.

#### Scenario: Admin logout

- **WHEN** admin clicks "Logout" button
- **THEN** system SHALL clear `admin_session` cookie
- **AND** system SHALL redirect to home page `/`
