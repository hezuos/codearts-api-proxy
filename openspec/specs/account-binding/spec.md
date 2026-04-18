---
spec: account-binding
status: implemented
priority: high
created: 2026-04-14
updated: 2026-04-17
---

# Account Binding

## Overview

The system SHALL allow each proxy user to bind and manage multiple Huawei Cloud accounts independently.

## Requirements

### REQ-ACCT-001: Multiple Huawei accounts per user

The system SHALL allow each proxy user to bind multiple Huawei Cloud accounts independently.

**Rationale:** Users may need to access different Huawei Cloud accounts for different projects or environments. Supporting multiple accounts per user enables flexible account management.

#### Scenario: User binds more than one account

- **GIVEN** a user has already bound one Huawei Cloud account
- **WHEN** the user completes account binding for a second Huawei Cloud account
- **THEN** the system SHALL store it as a separate provider account
- **AND** the system SHALL NOT overwrite the first account

### REQ-ACCT-002: Account listing and status

The system SHALL expose account metadata and availability status for all Huawei Cloud accounts bound to a user.

**Rationale:** Users need visibility into their bound accounts to manage and select appropriate accounts for requests.

#### Scenario: User lists bound accounts

- **GIVEN** a user has bound one or more Huawei Cloud accounts
- **WHEN** the user requests their bound Huawei Cloud accounts
- **THEN** the system SHALL return each account with identifier, display information, status, and default-selection state

### REQ-ACCT-003: Default account selection

The system SHALL support selecting one bound Huawei Cloud account as the default account for future operations.

**Rationale:** Simplifies client usage by providing a default account when no specific account is specified in requests.

#### Scenario: User changes default account

- **GIVEN** a user has multiple bound Huawei Cloud accounts
- **WHEN** the user marks a different bound Huawei Cloud account as default
- **THEN** the system SHALL update the default designation
- **AND** the system SHALL clear the previous default designation for that user

### REQ-ACCT-004: Account unbinding

The system SHALL allow a user to unbind a Huawei Cloud account they previously bound.

**Rationale:** Users need the ability to remove accounts that are no longer needed or have been compromised.

#### Scenario: User unbinds account

- **GIVEN** a user has a bound Huawei Cloud account
- **WHEN** the user unbinds the provider account
- **THEN** the system SHALL remove or deactivate the account binding
- **AND** the system SHALL prevent future request routing through that account
