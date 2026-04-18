---
spec: user-auth-ui
status: proposed
priority: medium
created: 2026-04-19
updated: 2026-04-19
---

# User Auth UI

## Overview

The web UI SHALL use a cookie-backed authentication flow so authenticated users can access protected pages after Huawei OAuth login.

## Requirements

### REQ-UI-AUTH-001: Cookie-based UI authentication

The system SHALL authenticate UI page access using an HTTP cookie named `auth_key` containing the user's API key value.

#### Scenario: Valid cookie allows UI access

- **WHEN** user accesses a protected UI page with valid `auth_key` cookie
- **THEN** system SHALL allow access and attach user context to request

#### Scenario: Missing cookie redirects to home

- **WHEN** user accesses a protected UI page without `auth_key` cookie
- **THEN** system SHALL redirect to home page `/`

#### Scenario: Invalid cookie redirects to home

- **WHEN** user accesses a protected UI page with invalid or revoked API key in cookie
- **THEN** system SHALL redirect to home page `/`

### REQ-UI-AUTH-002: Cookie security attributes

The system SHALL set the `auth_key` cookie with security attributes to prevent common attacks.

#### Scenario: Cookie security in production

- **WHEN** system sets `auth_key` cookie in production (HTTPS)
- **THEN** cookie SHALL have `httpOnly=true`, `secure=true`, and `sameSite=lax`

#### Scenario: Cookie security in development

- **WHEN** system sets `auth_key` cookie in development (HTTP)
- **THEN** cookie SHALL have `httpOnly=true`, `secure=false`, and `sameSite=lax`

### REQ-UI-AUTH-003: Cookie set after OAuth login

The system SHALL set the `auth_key` cookie after successful Huawei Cloud OAuth login completion.

#### Scenario: Cookie set on login completion

- **WHEN** OAuth callback completes successfully and API key is generated or retrieved
- **THEN** system SHALL set `auth_key` cookie with the API key value
- **AND** system SHALL redirect to `/success` page

### REQ-UI-AUTH-004: Cookie expiration

The system SHALL set cookie expiration to 30 days by default.

#### Scenario: Cookie max age

- **WHEN** system sets `auth_key` cookie
- **THEN** cookie `maxAge` SHALL be 2592000000 milliseconds (30 days)
