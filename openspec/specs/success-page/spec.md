---
spec: success-page
status: proposed
priority: medium
created: 2026-04-19
updated: 2026-04-19
---

# Success Page

## Overview

The success page SHALL confirm a completed OAuth login and expose the account and API key information users need to start using the proxy.

## Requirements

### REQ-SUCCESS-001: Success page displays account information

The system SHALL display Huawei Cloud account information on the success page after OAuth login.

#### Scenario: Display account details

- **WHEN** user accesses `/success` with valid `auth_key` cookie
- **THEN** page SHALL display user name from provider account
- **AND** page SHALL display domain ID from provider account
- **AND** page SHALL display account ID from provider account

### REQ-SUCCESS-002: Success page displays API key

The system SHALL display the user's API key on the success page with masking by default.

#### Scenario: API key masked by default

- **WHEN** success page loads
- **THEN** API key SHALL be displayed as `sk-xxxx...xxxx` (first 6 and last 4 characters visible)

#### Scenario: API key reveal on click

- **WHEN** user clicks "Show" button for API key
- **THEN** full API key SHALL be displayed

#### Scenario: API key copy to clipboard

- **WHEN** user clicks "Copy" button for API key
- **THEN** full API key SHALL be copied to clipboard
- **AND** user SHALL see confirmation message

### REQ-SUCCESS-003: Success page displays usage examples

The system SHALL display usage examples showing how to use the API key with OpenAI SDK.

#### Scenario: Show usage examples

- **WHEN** success page loads
- **THEN** page SHALL display example code for setting `OPENAI_API_KEY` and `OPENAI_BASE_URL`
- **AND** page SHALL display example OpenAI SDK usage

### REQ-SUCCESS-004: Success page navigation

The system SHALL provide navigation links on the success page.

#### Scenario: Navigation options

- **WHEN** success page loads
- **THEN** page SHALL display "View Account Status" link to `/status`
- **AND** page SHALL display "Bind Another Account" link to `/auth/huawei/authorize`
- **AND** page SHALL display "Return Home" link to `/`

### REQ-SUCCESS-005: Success page requires authentication

The system SHALL require valid `auth_key` cookie to access success page.

#### Scenario: Unauthenticated access redirected

- **WHEN** user accesses `/success` without valid `auth_key` cookie
- **THEN** system SHALL redirect to home page `/`
