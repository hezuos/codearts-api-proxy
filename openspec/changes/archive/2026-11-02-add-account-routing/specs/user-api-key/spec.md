# Spec Delta

## Purpose

用户级 API Key 让一个用户把自己的多个华为云账号当作一个容量池使用：代理在该用户所属账号之间自动分配请求，分配粒度由用户在创建时显式选择。

## ADDED Requirements

### Requirement: User-scoped API key

系统 SHALL 支持创建不绑定单一账号的用户级 API Key。其候选账号集合 SHALL 为该用户全部处于可用状态的账号，并在每次请求时重新求值。

#### Scenario: Creating a user-scoped key

- **GIVEN** a user has bound three active Huawei Cloud accounts
- **WHEN** the user creates a user-scoped API key
- **THEN** the key SHALL NOT reference a single account
- **AND** the key SHALL be usable with any of the three accounts

#### Scenario: Account removed from the pool

- **GIVEN** a user-scoped key was serving requests with account A
- **WHEN** account A is unbound
- **THEN** the key SHALL remain valid
- **AND** subsequent requests SHALL NOT be routed to account A

#### Scenario: No account left in the pool

- **GIVEN** a user-scoped key exists and the user has no active account
- **WHEN** a request arrives with that key
- **THEN** the proxy SHALL return an authentication error explaining that no account is available
- **AND** it SHALL NOT serve the request through an arbitrary account

### Requirement: Candidate accounts are those that are actually usable

候选账号 SHALL 同时满足以下全部条件方可进入用户级 Key 的候选集：账号状态为可用；存在未吊销的账号级 Key；该账号级 Key 持有可用的会话凭证。任一条件不满足的账号 SHALL 退出候选集，但其账号与凭证数据 SHALL 保留，以便在条件恢复后重新进入候选集。候选集 SHALL 在每次请求时重新求值。

#### Scenario: Account without an active key leaves the pool

- **GIVEN** a user-scoped key and an account whose only API key was revoked
- **WHEN** a request arrives
- **THEN** the proxy SHALL NOT select that account
- **AND** the account's remaining data SHALL be preserved

#### Scenario: Account with a missing session leaves the pool

- **GIVEN** a user-scoped key and an account whose key has no stored session
- **WHEN** a request arrives
- **THEN** the proxy SHALL NOT select that account

#### Scenario: Account recovers and re-enters the pool

- **GIVEN** an account had left the candidate pool because its session was missing
- **WHEN** that account's session is restored
- **THEN** subsequent requests SHALL be able to select that account again

### Requirement: Allocation granularity is chosen at creation

创建用户级 API Key 时 SHALL 必须显式选择分配粒度：`conversation`（对话连续）或 `request`（按请求轮询）。管理界面 SHALL 预选 `conversation`，并 SHALL 允许用户改选 `request`。界面 SHALL 在用户选择 `request` 时说明其会牺牲上游缓存局部性。

#### Scenario: Default selection is conversation granularity

- **WHEN** the user opens the creation form for a user-scoped key
- **THEN** the conversation-granularity option SHALL be preselected

#### Scenario: User switches to request granularity

- **GIVEN** the user opens the creation form for a user-scoped key
- **WHEN** the user selects the request-granularity option and creates the key
- **THEN** the created key SHALL carry the request-granularity policy

#### Scenario: Request granularity discloses its trade-off

- **WHEN** the user selects the request-granularity option
- **THEN** the interface SHALL state that this granularity gives up upstream cache locality

#### Scenario: Policy is changeable after creation

- **WHEN** the user changes the allocation granularity of an existing user-scoped key
- **THEN** subsequent requests SHALL use the new granularity

### Requirement: Conversation granularity assigns a conversation to one account

按 `conversation` 粒度时，系统 SHALL 为每个对话标识分配一个账号，并在该对话后续轮次中持续使用该账号，直到该账号不可用。该粘性保证 SHALL 以单个代理实例为边界。

#### Scenario: New conversations are distributed round-robin

- **GIVEN** a user-scoped key with conversation granularity and three available accounts
- **WHEN** three distinct conversations arrive for the first time
- **THEN** the three conversations SHALL be assigned to three distinct accounts

#### Scenario: Later turns keep the assigned account

- **GIVEN** a conversation was assigned to account B
- **WHEN** the next turn of that conversation arrives and account B is healthy
- **THEN** the proxy SHALL route it to account B

#### Scenario: Assigned account becomes unusable

- **GIVEN** a conversation was assigned to account B
- **AND** account B is cooling down or has no free slot
- **WHEN** the next turn of that conversation arrives
- **THEN** the proxy SHALL route it to another available account
- **AND** it SHALL rebind the conversation to that account

#### Scenario: Requests handled by different proxy instances are not bound together

- **GIVEN** two proxy instances each hold their own allocation state
- **WHEN** two turns of the same conversation are handled by different instances
- **THEN** the proxy SHALL NOT guarantee that both turns are served by the same account
- **AND** the conversation content SHALL still reach the upstream intact

### Requirement: Request granularity reallocates every request

按 `request` 粒度时，系统 SHALL 为每个请求重新选择账号，按轮询顺序推进，不保持对话与账号的绑定。

#### Scenario: Consecutive requests use different accounts

- **GIVEN** a user-scoped key with request granularity and three available accounts
- **WHEN** three requests arrive
- **THEN** the three requests SHALL be served by three distinct accounts

#### Scenario: Conversations are not pinned

- **GIVEN** a user-scoped key with request granularity
- **WHEN** two turns of the same conversation arrive
- **THEN** the proxy SHALL NOT guarantee they are served by the same account
- **AND** the conversation content SHALL still reach the upstream intact

### Requirement: Allocation is resilient to account failures

用户级 Key 选中的账号若因并发上限、凭证失效或模型不可用而失败，系统 SHALL 释放该账号的并发槽位并改用下一个可用候选账号，每个账号在一次请求内至多尝试一次。

#### Scenario: Concurrency limit moves to the next account

- **GIVEN** a request was routed to account A and rejected with the upstream concurrency-limit error
- **WHEN** another candidate account is available
- **THEN** the proxy SHALL retry the request on that account
- **AND** account A SHALL enter its cooldown window

#### Scenario: All candidates fail

- **GIVEN** every candidate account has been attempted for a request
- **WHEN** the last attempt also fails
- **THEN** the proxy SHALL return a single terminal error to the client
- **AND** it SHALL NOT loop across accounts

### Requirement: User-scoped key has no credentials of its own

用户级 API Key SHALL NOT 持有独立会话；其每次请求的凭据 SHALL 取自被选中账号下可用 Key 的会话。

#### Scenario: Credentials come from the selected account

- **GIVEN** a request is routed to account B
- **WHEN** the proxy builds the upstream request
- **THEN** it SHALL use account B's session credentials
- **AND** it SHALL NOT use credentials from any other account

#### Scenario: Revoking the underlying account key

- **GIVEN** a user-scoped key selects account B, whose account-level key was revoked
- **WHEN** a request arrives
- **THEN** the proxy SHALL NOT select account B
- **AND** it SHALL select another available account

#### Scenario: Refreshing a user-scoped key reports that it has no session

- **GIVEN** an administrator requests a credential refresh for a user-scoped key
- **WHEN** the proxy handles the request
- **THEN** it SHALL report that the key holds no credentials of its own
- **AND** it SHALL NOT fail with an internal server error

### Requirement: Regenerating an account key preserves user-scoped keys

"重新生成账号密钥"操作 SHALL 只作用于账号级 API Key，SHALL NOT 吊销或删除该用户的用户级 API Key。

#### Scenario: Regeneration keeps the user-scoped key

- **GIVEN** a user has one account-scoped key and one user-scoped key
- **WHEN** the user regenerates their account-scoped key
- **THEN** the account-scoped key SHALL be revoked and replaced
- **AND** the user-scoped key SHALL remain active and usable

#### Scenario: Regeneration does not affect the aggregate policy

- **GIVEN** a user-scoped key carries the request-granularity policy
- **WHEN** the user regenerates their account-scoped key
- **THEN** the user-scoped key SHALL retain its allocation granularity

### Requirement: User-scoped keys are rejected by the web interface cookie authentication

Web UI 的 Cookie 认证 SHALL 只接受账号级 API Key。用户级 Key SHALL NOT 能作为 Web UI 的登录凭据。

#### Scenario: User-scoped key cannot authenticate the web interface

- **GIVEN** a user-scoped key exists
- **WHEN** it is presented as the web interface cookie credential
- **THEN** the request SHALL be redirected to the sign-in page
- **AND** the key SHALL NOT be accepted as an authenticated web session

#### Scenario: Regenerating a key never produces a sessionless key

- **WHEN** the web interface regenerates a key
- **THEN** the newly issued key SHALL carry a usable session
- **AND** it SHALL be usable for API requests immediately after issuance

### Requirement: Allocation state is bounded and observable

轮询游标与对话绑定表 SHALL 为进程内状态，SHALL 带有空闲超时与容量上限，进程重启后清空。系统 SHALL 记录每次账号选择的依据（绑定命中、轮询分配、容量优先或迁移），以便把重启后的重新分配与策略异常区分开。

#### Scenario: Idle bindings are evicted

- **GIVEN** a conversation binding has been idle beyond its timeout
- **WHEN** the same conversation identifier arrives again
- **THEN** the proxy SHALL treat it as a new conversation and assign an account by the active policy

#### Scenario: Binding table does not grow without bound

- **GIVEN** more distinct conversations than the binding table's capacity arrive
- **WHEN** the table is full
- **THEN** the proxy SHALL evict entries so that the table stays within its capacity

#### Scenario: Selection reason is logged

- **WHEN** the proxy selects an account for a request
- **THEN** it SHALL log the conversation identifier, the selected account, the allocation granularity, and the reason for the selection

#### Scenario: Restart is distinguishable from a policy fault

- **GIVEN** the proxy restarted and lost its binding table
- **WHEN** the next request for a previously bound conversation is served
- **THEN** the logged selection reason SHALL indicate that no binding was found
- **AND** it SHALL NOT indicate a binding hit

### Requirement: User-scoped keys are created and managed through the administration interface

用户级 API Key SHALL 只能通过管理界面创建与管理，华为账号登录流程 SHALL NOT 签发用户级 Key。管理界面 SHALL 以独立于账号密钥列表的分区呈现用户级 Key，并显式标注其作用域与分配粒度。

#### Scenario: Signing in does not produce a user-scoped key

- **WHEN** a user completes a Huawei Cloud account sign-in
- **THEN** the issued key SHALL be bound to that account
- **AND** it SHALL NOT be a user-scoped key

#### Scenario: User-scoped keys are listed separately

- **GIVEN** a user has both account-scoped and user-scoped keys
- **WHEN** the administrator views that user's keys
- **THEN** the user-scoped keys SHALL appear in their own partition
- **AND** each SHALL display its scope and allocation granularity

#### Scenario: Raw key is returned once at creation

- **WHEN** a user-scoped key is created
- **THEN** the creation response SHALL carry the raw key
- **AND** subsequent listing endpoints SHALL expose only its hash
