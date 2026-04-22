## ADDED Requirements

### Requirement: List all entities

The CLI SHALL provide a `list` command that enumerates all users, accounts, and keys in the data directory.

#### Scenario: List command output

- **WHEN** `data-manager.mjs list` is executed
- **THEN** the CLI SHALL scan `data/users/` and output each user ID with their account count and key count

### Requirement: Show entity with masked sensitive fields

The CLI SHALL provide a `show` command that decrypts and displays an entity's data with sensitive fields masked.

#### Scenario: Show user profile

- **WHEN** `data-manager.mjs show user <userId>` is executed
- **THEN** the CLI SHALL decrypt and display the user's `profile.json` with sensitive fields masked

#### Scenario: Show session with masked credentials

- **WHEN** `data-manager.mjs show session <keyId>` is executed
- **THEN** the CLI SHALL decrypt and display the session data with AK, SK, and securityToken masked

### Requirement: Reveal entity with full sensitive data

The CLI SHALL provide a `reveal` command that displays complete entity data without masking.

#### Scenario: Reveal session credentials

- **WHEN** `data-manager.mjs reveal session <keyId>` is executed
- **THEN** the CLI SHALL decrypt and display the session data with all fields in full

### Requirement: Tree view of data directory

The CLI SHALL provide a `tree` command that displays the hierarchical directory structure as an ASCII tree.

#### Scenario: Tree command output

- **WHEN** `data-manager.mjs tree` is executed
- **THEN** the CLI SHALL output an ASCII tree showing the `data/` directory structure with entity IDs and file status (encrypted/plaintext)

### Requirement: Export entity as plaintext JSON

The CLI SHALL provide an `export` command that decrypts and writes an entity's data to a plaintext JSON file.

#### Scenario: Export session to file

- **WHEN** `data-manager.mjs export session <keyId> <output-path>` is executed
- **THEN** the CLI SHALL decrypt the session and write it as formatted JSON to the specified output path

### Requirement: Data consistency check

The CLI SHALL provide a `check` command that verifies data integrity across the hierarchical store.

#### Scenario: Check detects orphaned accounts

- **WHEN** an account directory exists but has no key directories
- **THEN** `data-manager.mjs check` SHALL report the orphaned account

#### Scenario: Check detects missing sessions

- **WHEN** a key directory exists but has no `session.json`
- **THEN** `data-manager.mjs check` SHALL report the key with missing session

#### Scenario: Check detects expired sessions

- **WHEN** a session's `expiresAt` is in the past
- **THEN** `data-manager.mjs check` SHALL report the expired session

#### Scenario: Check detects revoked keys

- **WHEN** a key has a `revokedAt` timestamp
- **THEN** `data-manager.mjs check` SHALL report the revoked key

### Requirement: Re-encrypt all files with new key

The CLI SHALL provide a `rekey` command that re-encrypts all data files with a new encryption key.

#### Scenario: Rekey with new encryption key

- **WHEN** `data-manager.mjs rekey --old <old-key> --new <new-key>` is executed
- **THEN** the CLI SHALL decrypt all files with the old key
- **AND** the CLI SHALL re-encrypt all files with the new key
- **AND** the CLI SHALL verify each file can be decrypted with the new key
