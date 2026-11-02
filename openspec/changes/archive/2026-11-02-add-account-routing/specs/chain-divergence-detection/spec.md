# Spec Delta

## ADDED Requirements

### Requirement: Conversation identity is stable and account-independent

对话标识 SHALL 由客户端提供的稳定对话键派生，且 SHALL NOT 包含 ProviderAccount 或系统提示词内容。客户端未提供稳定对话键时，代理 SHALL 回退到不含系统提示词的指纹。来源优先级 SHALL 为：请求体 `codearts.chat_id` → `X-Conversation-Id` 请求头 → 首条用户消息内容指纹。三个来源均不可得时，代理 SHALL NOT 绑定对话标识。

#### Scenario: System prompt drift

- **GIVEN** 同一对话的后续请求系统提示词内容发生变化
- **WHEN** 代理解析对话标识
- **THEN** 解析结果 SHALL 与上一轮相同

#### Scenario: Account switch keeps identity

- **GIVEN** 同一对话的请求被切换到另一个账号
- **WHEN** 代理解析对话标识
- **THEN** 解析结果 SHALL 保持不变

#### Scenario: Caller override wins

- **GIVEN** 客户端显式提供对话标识
- **WHEN** 代理解析对话标识
- **THEN** 代理 SHALL 使用客户端提供的值

#### Scenario: No stable key available

- **GIVEN** 客户端未提供稳定对话键
- **WHEN** 代理解析对话标识
- **THEN** 代理 SHALL 使用首条用户消息内容的指纹
- **AND** 该指纹 SHALL NOT 包含系统提示词或账号

#### Scenario: Conversation id header is used when the body field is absent

- **GIVEN** 客户端未提供 `codearts.chat_id`，但提供了 `X-Conversation-Id` 请求头
- **WHEN** 代理解析对话标识
- **THEN** 解析结果 SHALL 派生自该请求头的值

#### Scenario: No conversation signal at all

- **GIVEN** 请求既无 `codearts.chat_id`，也无 `X-Conversation-Id` 请求头，且消息中没有任何 user 角色
- **WHEN** 代理解析对话标识
- **THEN** 代理 SHALL NOT 绑定任何对话标识
- **AND** 该请求 SHALL NOT 与任何先前轮次关联

### Requirement: Chain state is tracked per conversation and account

链状态 SHALL 按 (对话标识, ProviderAccount) 组合跟踪，使同一对话在不同账号上的上游消息标识互不污染。

#### Scenario: Same conversation on two accounts

- **GIVEN** a conversation has been served by account A and is then served by account B
- **WHEN** the proxy records the new upstream reply identifiers
- **THEN** the identifiers for account B SHALL be stored separately from account A's
- **AND** cache estimation SHALL use the values belonging to the serving account

### Requirement: Fingerprint fallback relies on full history resend

以首条用户消息内容作为兜底指纹的前提是客户端每轮回传完整消息历史。代理 SHALL NOT 在指纹不可得时以随机值冒充稳定标识。

#### Scenario: No user message means no fingerprint

- **GIVEN** 请求中没有任何 user 角色消息
- **WHEN** 代理需要解析对话标识
- **THEN** 代理 SHALL 报告没有可用的稳定标识
- **AND** 代理 SHALL NOT 派生随机标识来伪装成稳定值
