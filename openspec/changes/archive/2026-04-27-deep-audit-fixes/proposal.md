## Why

深度代码审计（docs/deep-code-audit.md）发现 4 个 CRITICAL、6 个 HIGH、8 个 MEDIUM 级别问题，涵盖数据一致性 bug、安全漏洞、性能瓶颈和设计缺陷。最紧迫的是：session 刷新原地修改缓存对象导致不一致状态、API Key 明文索引仍在填充、SSE 流错误信息丢失、以及全存储层同步 I/O 阻塞事件循环。这些问题在生产高并发场景下会导致签名失败、内存泄漏、响应截断和延迟尖峰。

## What Changes

- 修复 `refreshStoredSession` 原地修改缓存对象 — 改为先创建副本再原子更新
- 移除 `apiKeysByValue` 明文索引运行时填充 — 仅保留启动迁移回退，运行时只用 hash 索引
- 修复 `httpsPost` 的 `res.on("error")` 丢失错误信息 — 将 error 传播给 SSE 消费者
- 修复 `deleteKey` 中 `apiKeysByValue` 清理失败 — 用正确的键删除
- 修复 `buildRequestBody` 双重序列化 — 返回结构化对象 + JSON 字符串
- 修复 `deriveConversationId` 碰撞风险 — 加入用户标识作为哈希盐
- 修复 Admin 密码 timing attack — 使用 `crypto.timingSafeEqual`
- 修复 `refresh-task.ts` setTimeout 泄漏 — 使用 `clearTimeout` 清理
- 修复 `parseSSE` PROTOCOL_ERROR 导致整个请求失败 — 改为跳过而非 throw
- 修复非流式 `tool_calls` 覆盖 — 改为合并逻辑
- 修复 `logger.ts` 无效 LOG_LEVEL 静默失败 — 启动时验证并 fallback
- 修复 `getAllSessions()` 返回内部引用 — 返回副本
- 修复 `handleStreamingRequest` 死代码 — 移除未使用的 `auth` 变量
- 添加请求取消机制 — 客户端断开时销毁上游连接
- 添加 `UPSTREAM_TIMEOUT_MS` 环境变量 — 替代硬编码 120s 超时
- 添加 `IS_MASTER_NODE` 环境变量 — 替代硬编码 `isMasterNode`
- 添加未认证端点速率限制 — 保护 `/admin/login`、`/admin/setup` 等
- 修复 `index.ts` 缩进不一致

## Capabilities

### New Capabilities

- `request-cancellation`: 客户端断开连接时自动取消上游请求，避免资源浪费
- `unauthed-rate-limiting`: 对未认证端点（admin login/setup 等）添加 IP 粒度速率限制

### Modified Capabilities

- `user-auth`: API Key 明文索引移除（运行时不再填充 `apiKeysByValue`），`deleteKey` 清理修复
- `sse-streaming`: SSE 流错误传播修复（`res.on("error")` 不再吞错误），PROTOCOL_ERROR 改为跳过
- `admin-auth`: Admin 密码比较改用 `timingSafeEqual`，未认证端点增加速率限制
- `hierarchical-store`: `getAllSessions()` 返回副本，`readEncryptedFile` 解密失败容错
- `openai-api`: `buildRequestBody` 返回结构化对象，`deriveConversationId` 加入用户盐，`httpsPost` 超时可配置，`handleStreamingRequest` 移除死代码

## Impact

- **src/auth/huawei/session-store.ts** — `refreshStoredSession` 改为副本模式
- **src/store/hierarchical-store.ts** — `setApiKey` 移除明文索引写入，`deleteKey` 修复清理，`getAllSessions` 返回副本
- **src/upstream/huawei/chat-request.ts** — `httpsPost` 错误传播，`buildRequestBody` 返回类型变更，`deriveConversationId` 加盐，超时可配置
- **src/upstream/huawei/chat-stream.ts** — 适配 `buildRequestBody` 新返回类型，添加请求取消
- **src/upstream/huawei/chat.ts** — 适配 `buildRequestBody`，`tool_calls` 合并逻辑，PROTOCOL_ERROR 跳过
- **src/upstream/huawei/chat-protocol.ts** — PROTOCOL_ERROR 标记为可跳过
- **src/auth/admin.ts** — `timingSafeEqual` 替换 `===`
- **src/auth/huawei/refresh-task.ts** — `clearTimeout` 清理，`IS_MASTER_NODE` 环境变量
- **src/utils/logger.ts** — LOG_LEVEL 验证
- **src/routes/openai.ts** — 移除死代码，添加请求取消
- **src/index.ts** — 未认证端点速率限制，缩进修复
- **src/config.ts** — 新增 `upstreamTimeoutMs`、`isMasterNode` 配置项
