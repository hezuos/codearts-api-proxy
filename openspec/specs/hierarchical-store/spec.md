---
spec: hierarchical-store
status: implemented
priority: high
created: 2026-04-22
updated: 2026-04-22
---

# Hierarchical Data Store

## Overview

The system SHALL store all persistent data in a hierarchical directory structure with per-file independent encryption, in-memory read cache, and Key↔Session 1:1 binding.

## Requirements

### Requirement: Hierarchical directory layout

The system SHALL store all persistent data in a hierarchical directory structure under `data/`, organized as `users/{userId}/accounts/{accountId}/keys/{keyId}/`, where each level corresponds to an entity (User, ProviderAccount, ApiKey).

#### Scenario: Directory structure reflects entity relationships

- **WHEN** the system stores data for a user with accounts and keys
- **THEN** the directory layout SHALL be `data/users/{userId}/profile.json` for user data
- **AND** `data/users/{userId}/accounts/{accountId}/account.json` for account data
- **AND** `data/users/{userId}/accounts/{accountId}/keys/{keyId}/key.json` for key data
- **AND** `data/users/{userId}/accounts/{accountId}/keys/{keyId}/session.json` for session data
- **AND** `data/admin.json` for admin configuration

### Requirement: Per-file independent encryption

The system SHALL encrypt each data file independently using AES-256-GCM with a fresh random IV (12 bytes) per write. File content SHALL be stored as `base64(iv + authTag + ciphertext)`.

#### Scenario: Single file write on entity change

- **WHEN** an entity (user, account, key, or session) is created or updated
- **THEN** the system SHALL serialize and encrypt only that entity's file
- **AND** the system SHALL NOT rewrite any other entity's file

#### Scenario: Fresh IV on every write

- **WHEN** the system writes an encrypted file
- **THEN** the system SHALL generate a new random 12-byte IV
- **AND** the system SHALL NOT reuse IVs across writes

### Requirement: Key-Session strict 1:1 binding

Each API Key directory SHALL contain exactly one `session.json`. A Key SHALL NOT exist without a Session, and a Session SHALL NOT exist without a Key.

#### Scenario: Key creation requires session

- **WHEN** the system creates a new API Key
- **THEN** the system SHALL also create a `session.json` in the same key directory
- **AND** the session SHALL contain valid credential data

#### Scenario: Key deletion cascades to session

- **WHEN** the system deletes an API Key
- **THEN** the system SHALL also delete the associated `session.json`
- **AND** the system SHALL remove the key directory

### Requirement: Entity-level read/write API

The system SHALL provide functions to read and write individual entity files by path, without requiring full data set serialization.

#### Scenario: Read single entity

- **WHEN** the system reads a user, account, key, or session
- **THEN** the system SHALL decrypt and parse only that entity's file
- **AND** the system SHALL NOT load or decrypt other entity files

#### Scenario: Write single entity

- **WHEN** the system writes a user, account, key, or session
- **THEN** the system SHALL serialize and encrypt only that entity's file
- **AND** the system SHALL NOT modify other entity files

### Requirement: Directory-based entity listing

The system SHALL enumerate entities by scanning their parent directory using filesystem directory listing.

#### Scenario: List users

- **WHEN** the system needs to enumerate all users
- **THEN** the system SHALL list subdirectories of `data/users/`

#### Scenario: List accounts for a user

- **WHEN** the system needs to enumerate accounts for a user
- **THEN** the system SHALL list subdirectories of `data/users/{userId}/accounts/`

#### Scenario: List keys for an account

- **WHEN** the system needs to enumerate keys for an account
- **THEN** the system SHALL list subdirectories of `data/users/{userId}/accounts/{accountId}/keys/`

### Requirement: Cascade deletion

The system SHALL cascade deletions to child entities when a parent entity is removed.

#### Scenario: Delete account cascades to keys and sessions

- **WHEN** the system deletes a provider account
- **THEN** the system SHALL delete all key directories under that account
- **AND** each key directory deletion SHALL remove both `key.json` and `session.json`

#### Scenario: Delete user cascades to accounts, keys, and sessions

- **WHEN** the system deletes a user
- **THEN** the system SHALL delete the entire user directory tree
- **AND** all accounts, keys, and sessions under that user SHALL be removed

### Requirement: In-memory read cache with file-level persistence

The system SHALL load all entity files into memory Maps at startup for low-latency reads, and persist only the changed entity file on each write.

#### Scenario: Startup loads all entities

- **WHEN** the system starts
- **THEN** the system SHALL scan the `data/users/` directory tree
- **AND** the system SHALL decrypt and load all entity files into in-memory Maps

#### Scenario: Write updates both cache and file

- **WHEN** the system writes an entity
- **THEN** the system SHALL update the in-memory Map entry
- **AND** the system SHALL write the encrypted file to disk

### Requirement: No bootstrap default key

The system SHALL NOT create a default API Key at startup. API Keys SHALL only be created through the OAuth login flow.

#### Scenario: Startup without existing data

- **WHEN** the system starts with no existing user data
- **THEN** the system SHALL create a default user with no keys
- **AND** the system SHALL NOT create any API Key or Session

#### Scenario: API request without any key returns 401

- **WHEN** a client sends a request with no valid API key
- **THEN** the system SHALL return 401 Unauthorized
