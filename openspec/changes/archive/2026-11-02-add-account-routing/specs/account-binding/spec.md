# Spec Delta

## MODIFIED Requirements

### Requirement: Session belongs to key not account

会话 SHALL 存储为 API Key 的子项（`keys/{keyId}/session.json`），而不是以 `providerAccountId` 为键的独立实体。一个绑定多个账号的 Key SHALL 在各自账号目录下持有独立会话，其生命周期与所属 (Key, Account) 组合绑定。用户级 Key 不绑定任何账号，SHALL NOT 持有自有会话。

#### Scenario: Session path reflects key ownership

- **WHEN** the system stores a session for a key
- **THEN** the session file path SHALL be `data/users/{userId}/accounts/{accountId}/keys/{keyId}/session.json`

#### Scenario: Sessions of multiple bound accounts are independent

- **GIVEN** a key is bound to two accounts
- **WHEN** the credentials of one account are refreshed
- **THEN** the other account's session SHALL remain unchanged

#### Scenario: Deleting a key deletes its session

- **WHEN** an API key is deleted or revoked
- **THEN** the system SHALL delete the key's `session.json` under every bound account
- **AND** the session credentials SHALL no longer be available for upstream requests

#### Scenario: User-scoped key holds no session

- **WHEN** the system creates a user-scoped API key
- **THEN** the key SHALL NOT have a session file of its own
- **AND** the credentials used for its requests SHALL come from the account selected for each request

## ADDED Requirements

### Requirement: One key can bind multiple accounts

An API Key SHALL be able to reference more than one bound ProviderAccount. The first entry SHALL be treated as the preferred account for backward compatibility with single-account keys.

#### Scenario: Key bound to several accounts

- **GIVEN** a user has bound three Huawei Cloud accounts
- **WHEN** the user creates an API key selecting all three
- **THEN** the key SHALL reference all three accounts
- **AND** each referenced account SHALL have its own session under that key

#### Scenario: Legacy single-account key

- **GIVEN** an existing key that references exactly one account
- **WHEN** the key is used without any configuration change
- **THEN** requests SHALL continue to be served by that account

#### Scenario: Explicitly bound list differs from the user-level pool

- **GIVEN** a user has three bound accounts
- **WHEN** the user creates an account-scoped key bound to two of them
- **THEN** the key SHALL reference exactly those two accounts
- **AND** it SHALL NOT expand to include the third account
- **AND** its candidate set SHALL NOT be recomputed as the user's full account set

### Requirement: Conversation is routed stickily to one account

For a given conversation identity the proxy SHALL prefer the account it previously used for that conversation, and SHALL keep using it as long as it is healthy and has a free concurrency slot.

#### Scenario: Second turn reuses the same account

- **GIVEN** a conversation was served by account A and A is healthy
- **WHEN** the next turn of the same conversation arrives
- **THEN** the proxy SHALL route it to account A

#### Scenario: Sticky account is saturated

- **GIVEN** account A is healthy but has no free concurrency slot
- **WHEN** the next turn of the conversation arrives
- **THEN** the proxy SHALL route it to another healthy account with a free slot
- **AND** it SHALL NOT fail the request while another account can serve it

### Requirement: Failing accounts cool down and fail over

When an account reports the upstream concurrency limit or rejects its credentials, the proxy SHALL mark that account unavailable for a cooldown window and serve the request from the next healthy account.

#### Scenario: Concurrency limit triggers failover

- **GIVEN** a request routed to account A is rejected with the upstream concurrency-limit error
- **WHEN** another bound account is healthy
- **THEN** the proxy SHALL retry the request once on that account
- **AND** account A SHALL be skipped for subsequent requests during its cooldown

#### Scenario: Credential failure triggers failover

- **GIVEN** a request routed to account A is rejected with an authentication error that remains after a refresh attempt
- **WHEN** another bound account is healthy
- **THEN** the proxy SHALL retry the request once on that account
- **AND** account A SHALL be skipped during its cooldown

#### Scenario: All accounts unavailable

- **GIVEN** every bound account of the key is cooling down or saturated
- **WHEN** a request arrives
- **THEN** the proxy SHALL queue the request within the configured wait limit
- **AND** it SHALL return HTTP 429 with a retry hint if the wait limit is exceeded

### Requirement: Unbinding an account preserves user-scoped keys

解绑账号 SHALL 只删除该账号目录下的 Key 与会话，SHALL NOT 删除用户级 API Key。用户级 Key 的候选集合 SHALL 相应缩小。

#### Scenario: Unbinding removes only account-scoped artifacts

- **GIVEN** a user has an account-scoped key and a user-scoped key
- **WHEN** the user unbinds the account owning the account-scoped key
- **THEN** the account-scoped key SHALL be deleted
- **AND** the user-scoped key SHALL remain valid

#### Scenario: User-scoped key pool shrinks

- **GIVEN** a user-scoped key serves requests across three accounts
- **WHEN** one of those accounts is unbound
- **THEN** subsequent requests SHALL be served by the remaining two accounts
