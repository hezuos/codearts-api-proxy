---
spec: admin-panel
status: proposed
priority: medium
created: 2026-04-19
updated: 2026-04-19
---

# Admin Panel

## Purpose

Provide authenticated administrators with visibility and control over users, accounts, and API keys.
## Requirements

### REQ-ADMIN-PANEL-001: Admin panel displays system status

The system SHALL display system-wide statistics on the admin panel.

#### Scenario: Show system statistics

- **WHEN** admin accesses `/admin` with valid `admin_session` cookie
- **THEN** page SHALL display total number of users
- **AND** page SHALL display total number of bound accounts
- **AND** page SHALL display total number of active API keys

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

### REQ-ADMIN-PANEL-003: Admin can revoke API keys

The system SHALL allow admin to revoke any user's API key.

#### Scenario: Revoke API key

- **WHEN** admin clicks "Revoke" button for an API key
- **THEN** system SHALL set `revokedAt` timestamp on the API key
- **AND** page SHALL update to show key as revoked
- **AND** user SHALL see success message

#### Scenario: Cannot revoke already revoked key

- **WHEN** admin views a revoked API key
- **THEN** "Revoke" button SHALL be disabled or hidden

### REQ-ADMIN-PANEL-004: Admin can force token refresh

The system SHALL allow admin to force token refresh for any key's session. Refresh SHALL operate on the specific key's session, not at the account level.

#### Scenario: Force refresh key session

- **WHEN** admin clicks "Force Refresh" for a key
- **THEN** system SHALL call refresh endpoint for that key's session
- **AND** page SHALL update with new expiration time for that key
- **AND** admin SHALL see success or error message

### REQ-ADMIN-PANEL-005: Admin can view account details

The system SHALL allow admin to view detailed information for any account.

#### Scenario: View account details

- **WHEN** admin clicks "View" or account name
- **THEN** page SHALL show account details including:
  - Provider user ID and name
  - Domain ID
  - Token expiration time
  - Last refresh time
  - Account status

### REQ-ADMIN-PANEL-006: Admin panel requires admin authentication

The system SHALL require valid `admin_session` cookie to access admin panel.

#### Scenario: Unauthenticated access redirected

- **WHEN** user accesses `/admin` without valid `admin_session` cookie
- **THEN** system SHALL redirect to `/admin/login` or `/admin/setup`

### REQ-ADMIN-PANEL-007: Admin API endpoints require authentication

The system SHALL require admin authentication for all `/admin/api/*` endpoints.

#### Scenario: API authentication required

- **WHEN** request is made to `/admin/api/*` without valid `admin_session` cookie
- **THEN** system SHALL return 401 Unauthorized

### REQ-ADMIN-PANEL-008: Admin panel provides logout

The system SHALL allow admin to logout from the panel.

#### Scenario: Admin logout

- **WHEN** admin clicks "Logout" button
- **THEN** system SHALL clear `admin_session` cookie
- **AND** system SHALL redirect to home page `/`

### Requirement: Admin panel styling

The admin panel SHALL use shared CSS from style.css only. All component styles (modal, key-row, menu-wrap, action-popover, dropdown, session-badge, button variants) SHALL be defined in style.css using CSS variable design tokens. No inline `<style>` block SHALL exist in admin.html.

#### Scenario: Admin uses design tokens

- **WHEN** the admin page is rendered
- **THEN** all visual properties SHALL reference CSS variables from the design system, enabling dark mode and consistent theming

### Requirement: Admin panel mobile layout

The admin panel SHALL provide a card-based layout for data tables on viewports below 768px, and allow key rows to wrap.

#### Scenario: Accounts table becomes cards on mobile

- **WHEN** viewport width is below 768px on the admin page
- **THEN** the accounts table SHALL be hidden and a card list SHALL be shown, with each account rendered as a card containing all fields (username, domain, provider, status, keys, actions)

#### Scenario: Users table becomes cards on mobile

- **WHEN** viewport width is below 768px on the admin page
- **THEN** the users table SHALL be hidden and a card list SHALL be shown

#### Scenario: Desktop tables unchanged

- **WHEN** viewport width is 768px or above
- **THEN** admin tables SHALL render as normal tables and card lists SHALL be hidden

#### Scenario: Key rows wrap on mobile

- **WHEN** viewport width is below 768px
- **THEN** `.key-row` SHALL allow `flex-wrap: wrap` so elements flow to the next line instead of overflowing

