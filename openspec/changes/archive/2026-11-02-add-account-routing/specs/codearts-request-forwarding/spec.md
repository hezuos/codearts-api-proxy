# Spec Delta

## ADDED Requirements

### Requirement: Requests are served by a selected healthy account

For every chat request the proxy SHALL select exactly one bound account of the presented key, preferring the account already associated with the conversation and, failing that, a healthy account with a free concurrency slot.

#### Scenario: Selection prefers free capacity

- **GIVEN** a key has two healthy accounts, one with no free slot and one with a free slot
- **WHEN** a request arrives for a conversation with no sticky account
- **THEN** the proxy SHALL select the account with a free slot

#### Scenario: Candidates are ordered by free capacity

- **GIVEN** a key has several healthy accounts
- **WHEN** the proxy evaluates the candidates for a request
- **THEN** it SHALL order the candidates so that accounts with a free concurrency slot come first
- **AND** an account known to be saturated SHALL NOT be selected while another candidate has a free slot

#### Scenario: Slot availability is read without consuming a slot

- **WHEN** the proxy evaluates whether an account has a free concurrency slot
- **THEN** it SHALL read the account's current slot usage without acquiring or reserving a slot
- **AND** the evaluation SHALL NOT change the account's slot state

#### Scenario: All accounts saturated

- **GIVEN** every bound account is healthy but has no free slot
- **WHEN** a request arrives
- **THEN** the proxy SHALL wait for a slot within the configured queue timeout
- **AND** it SHALL return HTTP 429 if the timeout is exceeded

#### Scenario: Queue timeout and upstream rejection share one error classification

- **GIVEN** the proxy gives up waiting for a concurrency slot because the wait limit was exceeded
- **WHEN** it reports the failure to the client
- **THEN** the failure SHALL be classified as a concurrency-limit error
- **AND** the response SHALL be HTTP 429 with a Retry-After header
- **AND** an upstream concurrency-limit rejection SHALL use the same error classification

### Requirement: Requests fail over to another bound account

When the selected account reports the upstream concurrency limit, rejects its credentials, or rejects the requested model as unavailable, the proxy SHALL retry the request on the next healthy account of the same key, at most once per account.

#### Scenario: Quota rejection moves to the next account

- **GIVEN** the selected account returns the upstream concurrency-limit error
- **AND** another bound account is healthy and has a free slot
- **WHEN** the proxy retries the request
- **THEN** the retry SHALL use the other account
- **AND** the original account SHALL enter its cooldown window

#### Scenario: Cross-account migration follows same-account retries

- **GIVEN** the upstream layer retries a concurrency-limit rejection against the same account before surfacing the failure
- **WHEN** the proxy performs cross-account migration
- **THEN** the migration SHALL occur only after the same-account retries are exhausted
- **AND** the same-account retry policy SHALL remain unchanged by this capability

#### Scenario: Credential rejection moves to the next account

- **GIVEN** the selected account returns an authentication error that remains after a refresh attempt
- **AND** another bound account is healthy
- **WHEN** the proxy retries the request
- **THEN** the retry SHALL use the other account
- **AND** the original account SHALL enter its cooldown window

#### Scenario: Model unavailable on the selected account

- **GIVEN** the selected account does not expose the requested model
- **AND** another bound account exposes it
- **WHEN** the proxy retries the request
- **THEN** the retry SHALL use the other account

#### Scenario: Exhausted accounts produce a single terminal error

- **GIVEN** every bound account has already been attempted for this request
- **WHEN** the last attempt also fails
- **THEN** the proxy SHALL return one terminal error to the client
- **AND** it SHALL NOT loop across accounts

### Requirement: Sub-agent requests follow the same routing

子代理请求 SHALL 与主代理请求使用相同的账号选择规则，SHALL NOT 绕过分配策略。

#### Scenario: Sub-agent request uses the same account selection

- **GIVEN** a sub-agent request arrives for a conversation already served by an account
- **WHEN** the proxy selects an account
- **THEN** the selection rules SHALL be the same as for main-agent requests

### Requirement: User-scoped keys resolve their account through the allocation policy

用户级 API Key 的请求 SHALL 先按其分配粒度策略确定候选账号顺序，再在该账号不满足健康度或容量条件时改用下一个候选账号。

#### Scenario: Policy determines the candidate order

- **GIVEN** a user-scoped key with conversation granularity and three available accounts
- **WHEN** a new conversation arrives
- **THEN** the proxy SHALL consider the accounts in the policy's round-robin order
- **AND** it SHALL use the first account in that order that is healthy and has a free slot

#### Scenario: Sub-agent requests follow the same allocation

- **GIVEN** a user-scoped key and a sub-agent request for a conversation already assigned to an account
- **WHEN** the proxy selects an account
- **THEN** the selection SHALL follow the key's allocation granularity
- **AND** the sub-agent request SHALL NOT bypass the allocation policy
