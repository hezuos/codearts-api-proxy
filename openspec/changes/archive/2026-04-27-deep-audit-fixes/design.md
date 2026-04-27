## Context

深度代码审计（docs/deep-code-audit.md）在已完成第一轮精简优化（codebase-simplification-and-hardening，55/55 tasks）的代码库上发现了 32 个问题。当前代码库已具备结构化日志、错误分类体系、SHA-256 hash 索引、速率限制等基础设施，但存在以下系统性缺陷：

1. **数据一致性**: `refreshStoredSession` 原地修改 Map 引用对象，刷新失败导致 AK/SK 不匹配
2. **安全残留**: `apiKeysByValue` 明文索引仍在运行时填充，Admin 密码 `===` 比较
3. **错误传播断裂**: `httpsPost` 的 `res.on("error")` 吞掉错误，SSE 流截断无感知
4. **性能瓶颈**: `buildRequestBody` 双重序列化，全存储层同步 I/O
5. **设计缺陷**: 无请求取消、chat_id 碰撞、PROTOCOL_ERROR 致命化、tool_calls 覆盖

## Goals / Non-Goals

**Goals:**
- 修复 4 个 CRITICAL bug（数据一致性、安全残留、错误传播、流式重试风险）
- 修复 6 个 HIGH 级别问题（性能、碰撞、timing attack、timer 泄漏）
- 修复 8 个 MEDIUM 级别问题（引用泄漏、配置、噪声容忍等）
- 添加请求取消机制（客户端断开 → 销毁上游连接）
- 添加未认证端点速率限制（防暴力破解）
- 新增 `UPSTREAM_TIMEOUT_MS`、`IS_MASTER_NODE` 环境变量

**Non-Goals:**
- 不将存储层全面改为异步 I/O（仅标注为后续优化方向，本次不改）
- 不引入 Prometheus metrics 端点
- 不增加 `lastResponseMessageId` LRU 淘汰（TTL 机制已足够）
- 不扩充测试覆盖（本次聚焦 bug 修复，测试扩充为独立 change）
- 不改变外部 API 契约

## Decisions

### D1: refreshStoredSession 修复 — 浅拷贝 + 原子更新

**选择**: 先 `{ ...stored }` 浅拷贝，修改副本，成功后 `setSession(keyId, updated)` 原子更新。

**替代方案**: 深拷贝（`structuredClone`）— 过重，session 对象只有一层字段。

**理由**: 浅拷贝足够（所有字段都是原始值或可选字符串），且保持与现有 `setSession` 签名兼容。如果 `encryptString` 抛异常，副本被丢弃，原缓存对象不受影响。

### D2: apiKeysByValue 移极移除 — 运行时停止填充

**选择**: `setApiKey` 中移除 `apiKeysByValue.set(rawKeyValue, apiKey)`，`findApiKeyByValue` 移除明文回退路径。`loadAllEntities` 迁移逻辑保留（启动时仍需处理旧数据），迁移完成后清空 `apiKeysByValue`。

**替代方案**: 保留双索引但标记 deprecated — 延迟问题，内存中仍有明文。

**理由**: 迁移已在上一轮 change 中实现，新部署的数据全部使用 hash 索引。运行时不再填充明文索引是安全最小化原则。`deleteKey` 修复：遍历 `apiKeysByValue` 找到值匹配的条目删除（仅在启动迁移回退期间需要）。

### D3: httpsPost 错误传播 — iterator 中增加 error 通道

**选择**: 在 AsyncIterator 实现中增加 `streamError` 变量，`res.on("error")` 时设置 error 并 `done=true; flush()`。iterator 的 `next()` 在 `done && streamError` 时 throw error 而非返回 `{ done: true }`。

**替代方案**: 将 error 作为特殊行 push 到 `lines` 数组 — 污染数据流。

**理由**: throw 是 AsyncIterator 的标准错误传播方式，`for await...of` 的 catch 块会捕获。`parseSSE` 和 `chat-stream.ts` 已有 try/catch，无需额外修改。

### D4: buildRequestBody 返回类型变更 — 结构化对象 + JSON

**选择**: `buildRequestBody` 返回 `{ body: Record<string, unknown>, json: string }`，调用方用 `body` 提取日志字段，用 `json` 发送请求。

**替代方案**: 只返回对象，调用方自行 `JSON.stringify` — 签名需要 JSON 字符串，两次 stringify 更浪费。

**理由**: 避免先 stringify 再 parse 的双重序列化开销。`buildChatHeaders` 签名需要 JSON 字符串，所以必须保留 `json` 字段。

### D5: deriveConversationId 加盐 — 加入 providerAccountId

**选择**: `createHash("sha256").update(session.providerAccountId + ":" + content).digest("hex").slice(0, 32)`

**替代方案**: 加入 randomUUID — 每次请求产生不同 chat_id，无法利用 lastResponseMessageId 延续对话。

**理由**: 加入用户标识使相同消息在不同账户间产生不同 chat_id，同时保持同一用户的对话延续性。冒号分隔符防止 `accountId + content` 的拼接歧义。

### D6: PROTOCOL_ERROR 可跳过 — chat.ts/chat-stream.ts 特殊处理

**选择**: `chat.ts` 和 `chat-stream.ts` 遇到 `error_code === "PROTOCOL_ERROR"` 时 continue 而非 throw/break。`parseSSE` 保留 warn 日志以维持可观测性。

**替代方案**: 在 `parseSSE` yield 的事件上增加 `skip: true` 标记，消费方检查该标记 — 增加间接层但无额外行为差异。或在 `parseSSE` 内部直接跳过不 yield — 丢失可观测性。

**理由**: 直接检查 `error_code` 更简单，无需修改 SSE 事件类型定义。保留 warn 日志（可观测性），但不让单个格式错误的 SSE 行终止整个请求。网络噪声（代理 heartbeat、CDN 注入）不应导致请求失败。

### D7: 请求取消 — AbortController + res.on("close")

**选择**: 在 `handleStreamingRequest` 和 `handleNonStreamingRequest` 中创建 `AbortController`，`res.on("close", () => ac.abort())`。将 `ac.signal` 传入 `httpsPost`，在 `req.on("close")` 时检查 signal 并 destroy 请求。

**替代方案**: 不传 signal，只在 res close 时 destroy — 需要暴露 req 引用，耦合更重。

**理由**: `AbortController` 是 Node.js 标准 API，与 `https.request` 的 `signal` 选项原生集成（Node.js 16+），无需手动管理 req 引用。

### D8: 未认证端点速率限制 — express-rate-limit IP 粒度

**选择**: 对 `/admin/login`、`/admin/setup` 添加 IP 粒度速率限制（10 次/分钟），使用 `express-rate-limit` 默认的 `req.ip` keyGenerator。

**替代方案**: 自建限流中间件 — 重复造轮子。

**理由**: `express-rate-limit` 已是项目依赖，IP 粒度限流是防暴力破解的标准做法。Admin 端点低频使用，10 次/分钟足够宽松。

## Risks / Trade-offs

- **[apiKeysByValue 移除]** 旧部署未迁移的明文 key 在运行时无法通过 `findApiKeyByValue` 找到 → 启动迁移逻辑仍保留，迁移完成后清空明文索引。已迁移的部署无影响。
- **[buildRequestBody 签名变更]** 所有调用方需适配新返回类型 → 仅 2 处调用（chat-stream.ts, chat.ts），改动小。
- **[PROTOCOL_ERROR 跳过]** 真正的上游错误可能被静默跳过 → 保留 warn 日志，且 PROTOCOL_ERROR 仅在 JSON.parse 失败时触发，真正的业务错误（error_code !== "0"）仍会 throw。
- **[deriveConversationId 加盐]** 已有对话的 chat_id 会变化 → `lastResponseMessageId` 中的旧 chat_id 自然过期（TTL 4h），新请求产生新 chat_id，无数据不一致。
- **[AbortController 请求取消]** 客户端短暂断开后重连无法恢复 SSE 流 → 这是 SSE 协议的固有限制，客户端应重新发起请求。
- **[IP 速率限制]** 反向代理后 `req.ip` 可能是代理 IP → 需配置 `app.set("trust proxy", 1)`，本次暂不添加（单实例部署通常无反向代理）。
