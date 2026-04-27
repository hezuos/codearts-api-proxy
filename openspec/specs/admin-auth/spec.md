---
spec: admin-auth
status: proposed
priority: medium
created: 2026-04-19
updated: 2026-04-19
---

# Admin Auth

## Overview

The system SHALL provide a separate admin authentication flow based on a configured password and a dedicated admin session cookie.

## Requirements

### REQ-ADMIN-AUTH-001: Admin password from environment variable

The system SHALL accept admin password from `ADMIN_PASSWORD` environment variable with highest priority.

#### Scenario: Environment variable takes precedence

- **WHEN** `ADMIN_PASSWORD` environment variable is set
- **THEN** system SHALL use it as admin password
- **AND** system SHALL NOT require setup page
- **AND** system SHALL mark admin as configured

### REQ-ADMIN-AUTH-002: Admin password from setup page

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

### REQ-ADMIN-AUTH-003: Admin password persistence

The system SHALL persist admin password hash in `data/admin-config.json` file.

#### Scenario: Password file structure

- **WHEN** admin password is saved
- **THEN** file SHALL contain `password_hash` (bcrypt hash), `created_at`, `last_login`, and `source` fields

#### Scenario: Load existing password on startup

- **WHEN** system starts and `data/admin-config.json` exists
- **THEN** system SHALL load admin password hash from file
- **AND** system SHALL mark admin as configured

### REQ-ADMIN-AUTH-004: Admin login authentication

The system SHALL authenticate admin login requests using constant-time password comparison to prevent timing side-channel attacks.

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

### REQ-ADMIN-AUTH-006: Admin logout

The system SHALL allow admin to logout and clear session cookie.

#### Scenario: Admin logout clears cookie

- **WHEN** admin posts to `/admin/logout`
- **THEN** system SHALL clear `admin_session` cookie
- **AND** system SHALL redirect to home page `/`
