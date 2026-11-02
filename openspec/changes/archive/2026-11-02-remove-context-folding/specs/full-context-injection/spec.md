# Spec Delta

## REMOVED Requirements

### Requirement: Full-context injection on cache miss

**Reason**: v2 通道无服务端会话状态，代理对每个请求都转发完整历史，不再存在"缓存未命中才注入"的分支。

**Migration**: 无需迁移，历史默认全量转发。

### Requirement: Folded history format

**Reason**: 折叠机制整体移除，代理不再把历史序列化为带角色标记的单段文本。

**Migration**: 不再产生折叠文本；客户端消息以原生结构透传。

### Requirement: Missing-segment append format

**Reason**: 该补发逻辑已在 v2 迁移中删除，且其实现依赖折叠文本格式。

**Migration**: 无需迁移。

### Requirement: Truncation guard

**Reason**: 代理不再对历史做任何截断；静默丢历史会破坏工具调用链并使模型重复劳动。

**Migration**: 上下文压缩交由客户端承担；真正超出上游硬限时返回上下文超限错误。

## ADDED Requirements

### Requirement: Verbatim history forwarding

The proxy SHALL forward the client `messages` array to the upstream request in original order, with original roles and content, without merging, rewriting, compressing, or dropping any message.

#### Scenario: Multi-turn history with tool calls

- **GIVEN** a client sends a history containing system, user, assistant tool calls, and tool results
- **WHEN** the proxy builds the upstream request
- **THEN** every message SHALL appear in the upstream request in the same order and with the same role and content

#### Scenario: Large system prompt

- **GIVEN** a client sends a system message that alone exceeds any previously configured character budget
- **WHEN** the proxy builds the upstream request
- **THEN** the system message SHALL be forwarded unchanged

#### Scenario: No synthetic content is injected

- **GIVEN** any client request
- **WHEN** the proxy builds the upstream request
- **THEN** the proxy SHALL NOT append role markers, continuation directives, truncation markers, or compression notices to the message content

### Requirement: History is never silently rewritten on size pressure

The proxy SHALL NOT delete, compress, or fold history in order to satisfy an upstream length limit. When the upstream rejects a request for length, the proxy SHALL surface that rejection instead of retrying with rewritten history.

#### Scenario: Upstream length rejection

- **GIVEN** a request whose history exceeds the upstream prompt limit
- **WHEN** the upstream rejects it for length
- **THEN** the proxy SHALL return the mapped context-length error to the client
- **AND** the proxy SHALL NOT resend the request with truncated or folded history
