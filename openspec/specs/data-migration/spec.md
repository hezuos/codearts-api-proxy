---
spec: data-migration
status: implemented
priority: high
created: 2026-04-22
updated: 2026-04-22
---

# Data Migration

## Overview

The system SHALL provide a migration tool to convert from flat-file storage to the hierarchical directory structure, with dry-run, backup, rollback, and verification support.

## Requirements

### Requirement: Migrate from flat files to hierarchical directory structure

The system SHALL provide a migration script that converts the old flat-file format (`auth-store.json` + `huawei-sessions.json`) to the new hierarchical directory structure.

#### Scenario: Successful migration

- **WHEN** the migration script is executed with existing flat-file data
- **THEN** the script SHALL decrypt `auth-store.json` and `huawei-sessions.json`
- **AND** the script SHALL create the hierarchical directory structure under `data/users/`
- **AND** each user SHALL have a `profile.json`
- **AND** each account SHALL have an `account.json`
- **AND** each key SHALL have a `key.json` and `session.json` (session data sourced from the matching `providerAccountId` in `huawei-sessions.json`)
- **AND** the script SHALL copy `admin-config.json` to `admin.json`

#### Scenario: Key-to-session mapping during migration

- **WHEN** multiple keys share the same `providerAccountId` in the old format
- **THEN** each key SHALL receive its own `session.json` containing a copy of the shared session data
- **AND** each session SHALL be independently encrypted

### Requirement: Migration dry-run

The migration script SHALL support a `--dry-run` option that previews the migration without writing files.

#### Scenario: Dry-run preview

- **WHEN** the migration script is executed with `--dry-run`
- **THEN** the script SHALL output the planned directory structure and file count
- **AND** the script SHALL NOT create any files or directories

### Requirement: Migration backup

The migration script SHALL back up existing flat files before migration.

#### Scenario: Backup before migration

- **WHEN** the migration script is executed
- **THEN** the script SHALL copy existing `auth-store.json`, `huawei-sessions.json`, and `admin-config.json` to `data/.backup/` before writing new files

### Requirement: Migration rollback

The migration script SHALL support a `--rollback` option that restores the old flat-file format from backup.

#### Scenario: Rollback restores old format

- **WHEN** the migration script is executed with `--rollback`
- **THEN** the script SHALL restore files from `data/.backup/` to `data/`
- **AND** the script SHALL remove the hierarchical directory structure

### Requirement: Migration verification

The migration script SHALL verify data integrity after migration by comparing entity counts and key references.

#### Scenario: Post-migration verification

- **WHEN** migration completes
- **THEN** the script SHALL re-read all new files and verify:
  - User count matches old `users[]` length
  - Account count matches old `providerAccounts[]` length
  - Key count matches old `apiKeys[]` length
  - Every key has a corresponding session file
- **AND** the script SHALL report any discrepancies as errors
