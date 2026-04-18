---
spec: huawei-auth
status: implemented
priority: high
created: 2026-04-14
updated: 2026-04-17
---

# Huawei Authentication

## Overview

The system SHALL manage Huawei Cloud login flows, session persistence, and automatic credential refresh.

## Requirements

### REQ-HUAWEI-001: Huawei login initiation

The system SHALL initiate Huawei Cloud login by creating a login flow and returning the information needed to complete browser-based authentication.

**Rationale:** Browser-based OAuth flow requires server-side coordination to manage login state and correlate callbacks.

#### Scenario: Start login flow

- **GIVEN** a user requests to bind a Huawei Cloud account
- **WHEN** the system initiates the login process
- **THEN** the system SHALL create a login flow record with correlation data
- **AND** the system SHALL return a login URL or equivalent redirect target

### REQ-HUAWEI-002: Login callback completion

The system SHALL complete Huawei Cloud login by accepting callback data, exchanging it for upstream session credentials, and attaching the resulting account to the initiating user.

**Rationale:** The OAuth callback must be processed to obtain session credentials and complete account binding.

#### Scenario: Callback completes successfully

- **GIVEN** a pending login flow exists
- **WHEN** the system receives valid callback data for the login flow
- **THEN** the system SHALL exchange the login artifacts for session credentials
- **AND** the system SHALL create or update the bound provider account

### REQ-HUAWEI-003: Session persistence

The system SHALL persist upstream session material needed for future requests and refresh operations.

**Rationale:** Session credentials must be stored securely to enable subsequent requests without requiring re-authentication.

#### Scenario: Session is stored after login

- **GIVEN** login exchange succeeds
- **WHEN** the system processes the session credentials
- **THEN** the system SHALL store the provider account session with expiration metadata
- **AND** the system SHALL store secret material required for refresh

### REQ-HUAWEI-004: Automatic refresh

The system SHALL automatically refresh upstream Huawei session credentials before expiration when refreshable credentials are available.

**Rationale:** Sessions expire and must be refreshed to maintain continuous access without user intervention.

#### Scenario: Refresh executes before expiry

- **GIVEN** a stored provider account session approaches its refresh threshold
- **WHEN** the refresh task runs
- **THEN** the system SHALL refresh the upstream credentials
- **AND** the system SHALL update the stored session state

#### Scenario: Expired unrefreshable session becomes unusable

- **GIVEN** a provider account session is expired
- **AND** refresh fails or is impossible
- **WHEN** the system detects the expired session
- **THEN** the system SHALL mark the session unavailable
- **AND** the system SHALL require re-login before future upstream requests
