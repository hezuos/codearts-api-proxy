---
spec: iam-auth-upgrade
status: draft
priority: high
created: 2026-06-17
updated: 2026-06-17
---

# IAM Auth Upgrade

## Overview

The system SHALL support the new IAM login credential format (`NewIamLogin`) from upstream `huaweicloud.authentication` v5.0.2, including automatic format detection, `refresh_token` persistence and usage, IAM user info resolution, and structured error classification.

## ADDED Requirements

### Requirement: IAM-NEW-001: New credential format detection

The system SHALL automatically detect whether a ticket exchange response uses the new IAM credential format (`NewIamLogin`) or the legacy format.

**Rationale:** The upstream API does not provide a version indicator. The detection MUST rely on response payload structure.

#### Scenario: Detect new format via credentials.access_key_id
- **WHEN** the ticket exchange response contains `payload.credentials.access_key_id`
- **THEN** the system SHALL classify the response as `NewIamLogin` format

#### Scenario: Fallback to legacy format
- **WHEN** the ticket exchange response does NOT contain `payload.credentials.access_key_id`
- **THEN** the system SHALL classify the response as legacy format

### Requirement: IAM-NEW-002: New credential extraction

The system SHALL extract credentials from the new IAM format, mapping upstream response fields to the internal credential model.

**Field mapping:**

| Upstream Field | Internal Field |
|----------------|----------------|
| `credentials.access_key_id` | `accessKey` |
| `credentials.secret_access_key` | `secretKey` |
| `credentials.security_token` | `securityToken` |
| `credentials.expiration` | `expiresAt` |

#### Scenario: Extract new format credentials
- **WHEN** a ticket exchange response in `NewIamLogin` format is received
- **THEN** the system SHALL extract `accessKey` from `credentials.access_key_id`
- **AND** the system SHALL extract `secretKey` from `credentials.secret_access_key`
- **AND** the system SHALL extract `securityToken` from `credentials.security_token`
- **AND** the system SHALL extract `expiresAt` from `credentials.expiration`

### Requirement: IAM-NEW-003: refresh_token persistence

The system SHALL extract and persist the `refresh_token` field from new IAM login responses.

**Rationale:** `refresh_token` provides an alternative credential refresh path when AK/SK signature-based refresh fails.

#### Scenario: Extract refresh_token from new format
- **WHEN** a ticket exchange response in `NewIamLogin` format contains `payload.refresh_token`
- **THEN** the system SHALL extract and store `refreshToken` in the session record

#### Scenario: refresh_token absent
- **WHEN** a ticket exchange response in `NewIamLogin` format does NOT contain `refresh_token`
- **THEN** the system SHALL proceed without `refreshToken` (field remains undefined)

### Requirement: IAM-NEW-004: IAM user info resolution

The system SHALL resolve user identity information (user_id, user_name, domain_id) when using the new IAM login flow.

**Rationale:** The new IAM flow may not include user identity fields in the ticket exchange response. The system MUST query IAM to obtain these.

#### Scenario: Resolve user info via IAM API
- **WHEN** login uses `NewIamLogin` format
- **AND** user_id/user_name/domain_id are not directly available from the response
- **THEN** the system SHALL call the IAM user info API to resolve them

#### Scenario: User info present in response
- **WHEN** login uses `NewIamLogin` format
- **AND** user_id/user_name/domain_id ARE present in the response payload
- **THEN** the system SHALL use them directly without an additional IAM API call

### Requirement: IAM-NEW-005: Credential refresh scheduling

The system SHALL schedule credential refresh using dynamic timeout calculation based on credential expiration.

**Algorithm (matching upstream `getFirstRefreshTime`):**
1. If `expiresAt` is not set → refresh immediately
2. Calculate `now + 2 hours` as the safe refresh point
3. If safe point ≥ expiration time → refresh immediately
4. Add a random jitter (0-59 seconds) to the safe point to scatter refresh requests across sessions

#### Scenario: Dynamic refresh scheduling
- **WHEN** a session has `expiresAt` set to a future time
- **THEN** the system SHALL schedule the next refresh at `expiresAt - 2h - random(0-59s)`
- **AND** the scheduler SHALL use `setTimeout` (not `setInterval`)

#### Scenario: Re-schedule after successful refresh
- **WHEN** a refresh completes successfully
- **AND** the response contains a new `expiresAt`
- **THEN** the system SHALL cancel the existing timer
- **AND** the system SHALL schedule the next refresh based on the new `expiresAt`

### Requirement: IAM-NEW-006: Structured error classification

The system SHALL classify IAM request errors using a structured enumeration matching upstream `IAMRequestErrorType`.

**Error types:**

| Enum Value | Error String |
|------------|-------------|
| `UNAUTHORIZED` | "Authentication Error" |
| `PROXY` | "Proxy Authentication Error" |
| `FORBIDDEN_TOKEN` | "IAM.1201" |
| `FORBIDDEN_API_ACCESS` | "not programmatic access" |
| `TIMEOUT` | "Login Timeout" |
| `FAILED` | "Login Failed" |
| `USER_OR_PWD` | "Invalid user name or password" |
| `ACCOUNT_LOCKED` | "The account is locked." |
| `ACCOUNT_DISABLED` | "The account is disabled." |
| `EXPIRED_REFRESH_TOKEN` | "Expired refresh token" |

#### Scenario: Classify refresh error by response body
- **WHEN** the refresh endpoint returns an error with code matching `IAM.1201`
- **THEN** the system SHALL classify it as `FORBIDDEN_TOKEN`

#### Scenario: Classify login error by response code
- **WHEN** the ticket exchange returns HTTP 401
- **THEN** the system SHALL classify it as `UNAUTHORIZED`
