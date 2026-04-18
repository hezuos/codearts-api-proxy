---
spec: status-page
status: proposed
priority: medium
created: 2026-04-19
updated: 2026-04-19
---

# Status Page

## Overview

The status page SHALL let authenticated users inspect and manage their bound Huawei accounts, token state, and active API key.

## Requirements

### REQ-STATUS-001: Status page displays all bound accounts

The system SHALL display all Huawei Cloud accounts bound to the current user on the status page.

#### Scenario: List all user accounts

- **WHEN** user accesses `/status` with valid `auth_key` cookie
- **THEN** page SHALL display all provider accounts for the user
- **AND** each account SHALL show user name, domain ID, and display name

### REQ-STATUS-002: Status page displays account token status

The system SHALL display token expiration status for each bound account.

#### Scenario: Show token expiration time

- **WHEN** status page displays an account
- **THEN** page SHALL show token expiration time from session store

#### Scenario: Calculate account status

- **WHEN** status page displays an account
- **THEN** system SHALL calculate status as:
  - "Valid" if expires_at > now + 2 hours
  - "Expiring Soon" if now < expires_at <= now + 2 hours
  - "Expired" if expires_at <= now

#### Scenario: Show last refresh time

- **WHEN** status page displays an account
- **THEN** page SHALL show last refresh timestamp from session store

### REQ-STATUS-003: Status page provides refresh operation

The system SHALL allow users to manually refresh token for each account.

#### Scenario: Manual token refresh

- **WHEN** user clicks "Refresh" button for an account
- **THEN** system SHALL call refresh endpoint for that provider account
- **AND** page SHALL update with new expiration time
- **AND** user SHALL see success message

### REQ-STATUS-004: Status page provides unbind operation

The system SHALL allow users to unbind (delete) a Huawei Cloud account.

#### Scenario: Unbind account with confirmation

- **WHEN** user clicks "Unbind" button for an account
- **THEN** system SHALL show confirmation dialog
- **AND** if confirmed, system SHALL delete provider account and associated session
- **AND** page SHALL remove account from list
- **AND** user SHALL see success message

#### Scenario: Cannot unbind last account

- **WHEN** user has only one bound account
- **THEN** "Unbind" button SHALL be disabled or hidden
- **OR** system SHALL show warning that at least one account must remain

### REQ-STATUS-005: Status page provides set default operation

The system SHALL allow users to set an account as the default for API requests.

#### Scenario: Set default account

- **WHEN** user clicks "Set as Default" button for a non-default account
- **THEN** system SHALL update that account's `isDefault` flag to true
- **AND** system SHALL set all other accounts' `isDefault` to false
- **AND** page SHALL update to show new default indicator

#### Scenario: Default account indicator

- **WHEN** status page displays the default account
- **THEN** account SHALL show "(Default)" label
- **AND** "Set as Default" button SHALL be disabled or hidden

### REQ-STATUS-006: Status page displays user API key

The system SHALL display the user's API key on the status page with masking and management options.

#### Scenario: Show masked API key

- **WHEN** status page loads
- **THEN** page SHALL display API key as `sk-xxxx...xxxx`

#### Scenario: Regenerate API key

- **WHEN** user clicks "Regenerate" button for API key
- **THEN** system SHALL generate new API key
- **AND** system SHALL revoke old API key
- **AND** system SHALL update `auth_key` cookie with new key
- **AND** page SHALL display new API key
- **AND** user SHALL see warning that old key is now invalid

### REQ-STATUS-007: Status page requires authentication

The system SHALL require valid `auth_key` cookie to access status page.

#### Scenario: Unauthenticated access redirected

- **WHEN** user accesses `/status` without valid `auth_key` cookie
- **THEN** system SHALL redirect to home page `/`
