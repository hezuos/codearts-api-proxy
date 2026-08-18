---
spec: huawei-auth
status: delta
priority: high
created: 2026-06-17
updated: 2026-06-17
---

# Huawei Authentication — Delta

Delta spec for `huawei-auth` capability. Existing requirements remain unchanged. The following extensions are added.

## ADDED Requirements

### Requirement: HUAWEI-005: New IAM credential format support

The login callback SHALL support detecting and processing both the legacy and `NewIamLogin` credential formats from the upstream API. The `provisionLoginResult` SHALL automatically dispatch to the appropriate handler based on the detected format.

#### Scenario: Callback with new IAM format credentials
- **GIVEN** a pending login flow exists
- **WHEN** the ticket exchange response uses `NewIamLogin` format
- **THEN** the system SHALL detect the format via `payload.credentials.access_key_id`
- **AND** the system SHALL extract credentials using the new field mapping
- **AND** the system SHALL persist `refreshToken` if present
- **AND** the system SHALL record `credentialFormat: "new_iam"` on the session

### Requirement: HUAWEI-006: IAM user info resolution

The login callback SHALL resolve user identity information via IAM API when processing a `NewIamLogin` response that lacks direct user info fields.

#### Scenario: Resolve user info for new format
- **GIVEN** a login flow using `NewIamLogin` format
- **WHEN** `user_id`/`user_name`/`domain_id` are missing from the response payload
- **THEN** the system SHALL call `resolveUserInfo` with the extracted credentials
- **AND** the system SHALL use the returned identity info for account provisioning

### Requirement: HUAWEI-007: Dynamic credential refresh scheduling

The automatic refresh task SHALL use dynamic `setTimeout` scheduling based on each session's `expiresAt` field, replacing the fixed-interval `setInterval` approach.

#### Scenario: Schedule based on expiration
- **GIVEN** a key's session has refreshable credentials and a future `expiresAt`
- **WHEN** the refresh scheduler initializes
- **THEN** the system SHALL calculate the refresh delay as `expiresAt - now - 2h - random(0-59s)`
- **AND** the system SHALL schedule a `setTimeout` for the calculated delay
