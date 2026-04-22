## MODIFIED Requirements

### REQ-ADMIN-PANEL-002: Admin panel displays all users

The system SHALL display list of all users with their associated accounts and API keys. Each key display SHALL include session status (active, expiring, expired, missing).

#### Scenario: List all users

- **WHEN** admin panel loads
- **THEN** page SHALL display all users from the hierarchical store
- **AND** each user SHALL show email, display name, and creation date

#### Scenario: Show user accounts

- **WHEN** admin panel displays a user
- **THEN** page SHALL show number of bound accounts for that user
- **AND** page SHALL list each account with status (valid, expiring, expired)

#### Scenario: Show user API keys with session status

- **WHEN** admin panel displays a user
- **THEN** page SHALL show all API keys for that user (masked)
- **AND** page SHALL indicate which key is active vs revoked
- **AND** page SHALL show each key's session status (active, expiring, expired, missing)

### REQ-ADMIN-PANEL-004: Admin can force token refresh

The system SHALL allow admin to force token refresh for any key's session. Refresh SHALL operate on the specific key's session, not at the account level.

#### Scenario: Force refresh key session

- **WHEN** admin clicks "Force Refresh" for a key
- **THEN** system SHALL call refresh endpoint for that key's session
- **AND** page SHALL update with new expiration time for that key
- **AND** admin SHALL see success or error message
