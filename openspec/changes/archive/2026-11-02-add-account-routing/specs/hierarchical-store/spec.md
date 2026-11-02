# Spec Delta

## MODIFIED Requirements

### Requirement: Key-Session strict 1:1 binding

每个 (API Key, ProviderAccount) 组合的目录 SHALL 恰好包含一个 `session.json`。Key 与其绑定的每个账号各持有一条会话；在未绑定的账号目录下 SHALL NOT 存在该 Key 的会话。该约束 SHALL 只适用于账号级 Key；用户级 Key 不存在 (Key, ProviderAccount) 组合，SHALL NOT 持有会话。

#### Scenario: Key creation requires session

- **WHEN** the system creates a new API Key bound to N accounts
- **THEN** the system SHALL create one `session.json` in each bound account's key directory
- **AND** each session SHALL contain valid credential data for its account

#### Scenario: Key deletion cascades to session

- **WHEN** the system deletes an API Key
- **THEN** the system SHALL delete the key's `session.json` under every bound account
- **AND** the system SHALL remove those key directories

#### Scenario: User-scoped key is exempt

- **WHEN** the system creates a user-scoped API Key
- **THEN** no `session.json` SHALL be created for that key
- **AND** the key SHALL remain usable for authentication

## ADDED Requirements

### Requirement: Sessions are addressable by key and account

In-memory session lookup SHALL accept a (Key, Account) pair so that one key can resolve different credentials per account without ambiguity.

#### Scenario: Two sessions for one key

- **GIVEN** one key has sessions for accounts A and B
- **WHEN** the proxy resolves the session for that key under account B
- **THEN** it SHALL return B's session
- **AND** resolving for account A SHALL still return A's session

#### Scenario: Startup loads every key-account session

- **GIVEN** the data directory contains keys bound to multiple accounts
- **WHEN** the store loads entities at startup
- **THEN** every (key, account) session SHALL be loaded
- **AND** one undecryptable session SHALL NOT prevent other sessions from loading

### Requirement: User-scoped keys are stored under the user

用户级 API Key SHALL 存储在 `data/users/{userId}/keys/{keyId}/key.json`，与账号级 Key 的 `data/users/{userId}/accounts/{accountId}/keys/{keyId}/key.json` 并列。启动加载 SHALL 扫描并加载用户级 Key 目录。解绑账号 SHALL NOT 删除用户级 Key；删除用户 SHALL 级联删除。

#### Scenario: User-scoped key path

- **WHEN** the system stores a user-scoped API key
- **THEN** the key file path SHALL be `data/users/{userId}/keys/{keyId}/key.json`
- **AND** the key directory SHALL NOT contain a session file

#### Scenario: Startup loads user-scoped keys

- **GIVEN** the data directory contains a user-scoped key
- **WHEN** the store loads entities at startup
- **THEN** the user-scoped key SHALL be loaded and be usable for authentication

#### Scenario: Unbinding an account keeps the user-scoped key

- **GIVEN** a user-scoped key exists at `data/users/{userId}/keys/{keyId}/`
- **WHEN** one of the user's provider accounts is unbound
- **THEN** the user-scoped key directory SHALL remain on disk
- **AND** the user-scoped key SHALL remain loadable

#### Scenario: Deleting a user cascades to user-scoped keys

- **WHEN** the system deletes a user
- **THEN** it SHALL delete the user's `keys/` directory and every user-scoped key in it

#### Scenario: Deleted user's key no longer authenticates

- **GIVEN** a user-scoped key was loaded into the in-memory key index
- **WHEN** the system deletes that user
- **THEN** the user-scoped key SHALL be removed from the in-memory key index
- **AND** the key SHALL no longer authenticate a request
- **AND** removing the user's directory alone SHALL NOT be sufficient to achieve this
