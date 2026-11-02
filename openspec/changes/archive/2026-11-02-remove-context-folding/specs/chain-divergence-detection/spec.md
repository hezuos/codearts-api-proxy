# Spec Delta

## REMOVED Requirements

### Requirement: Repair is independent from cold-start injection

**Reason**: 修复动作本身就是"折叠全量历史后重发"，折叠移除后该能力没有实现基础。

**Migration**: 开启修复开关的部署无需操作，开关与其分支一并删除。

### Requirement: Tail repair preserves tool segment semantics without repeating the first user message

**Reason**: 尾部修复属于折叠路径的一部分，已随折叠移除。

**Migration**: 无；分叉不再触发修复请求。

### Requirement: Tail repair failure falls back to full reset

**Reason**: 不存在"全量重置重试"这一动作。

**Migration**: 无；分叉只影响日志与缓存估算，请求按原样转发。

## ADDED Requirements

### Requirement: Divergence classification never rewrites the request

The proxy SHALL use chain divergence classification only for logging and cache-hit estimation. Classification SHALL NOT change the message history, trigger a resend, or alter the request in any other way.

#### Scenario: Tail divergence

- **GIVEN** the tracked chain prefix matches but the tail differs
- **WHEN** the proxy classifies the request
- **THEN** it SHALL forward the client history unchanged
- **AND** it SHALL NOT issue a repair request

#### Scenario: Middle damage

- **GIVEN** the client history diverges in the middle of the tracked chain
- **WHEN** the proxy classifies the request
- **THEN** it SHALL forward the client history unchanged
- **AND** it SHALL record the classification for logging and cache estimation only

#### Scenario: Duplicate or stale request

- **GIVEN** the client history exactly equals the tracked chain
- **WHEN** the proxy classifies the request
- **THEN** it SHALL still forward the request as received
- **AND** it SHALL NOT drop or rewrite messages based on classification
