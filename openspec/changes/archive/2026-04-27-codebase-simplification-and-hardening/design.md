## Context

CodeArts Agent Proxy 是一个 Express.js 代理服务，将华为云 CodeArts LLM API 封装为 OpenAI 兼容接口。当前代码库 35 个 TypeScript 文件、约 5,300 行，存在三类系统性问题：

1. **安全漏洞**：Admin session token 硬编码、API Key 明文存储、加密密钥不安全回退
2. **代码腐化**：590 行死代码/重复代码、1070 行超大文件、8 处重复函数
3. **架构缺陷**：无结构化日志、HTTP 客户端混用（axios + 原生 https）、全局可变状态散布、同步 I/O、无速率限制

当前模块依赖链：`routes → auth/store → hierarchical-store → file-store → encryption`，`auth/store` 作为上帝模块承担了过多职责。

## Goals / Non-Goals

**Goals:**
- 修复 3 个严重安全漏洞（Admin token、API Key 明文、加密密钥回退）
- 精简约 590 行代码，消除重复逻辑
- 拆分超大文件（chat.ts 1070 行 → 5 个模块）
- 引入结构化日志，统一 HTTP 客户端
- 按领域拆分 auth/store 上帝模块
- 添加速率限制和深度健康检查
- 建立错误分类体系

**Non-Goals:**
- 不重写核心协议转换逻辑（OpenAI ↔ CodeArts）
- 不更换存储引擎（仍用 JSON 文件，不引入数据库）
- 不改变外部 API 契约（OpenAI 兼容接口不变）
- 不引入 Redis 或其他外部状态存储（短期内存方案足够）
- 不重构登录流程状态管理为持久化（保留内存存储 + 过期清理）
- 不迁移测试框架（保留 ts-node + assert 模式，仅清理 __testHooks）

## Decisions

### D1: 结构化日志 — 自建轻量 wrapper（不引入 pino）

**选择**: 自建 `src/utils/logger.ts` wrapper，基于 console 但添加级别控制和结构化输出。

**替代方案**: 引入 pino（性能最优但增加依赖）、winston（功能全但过重）。

**理由**: 项目当前无任何日志框架，引入 pino 需要改所有 118 处调用点且改变输出格式。自建 wrapper 可以渐进迁移：先替换 console 为 logger，后续可切换底层实现。保持零新依赖。

### D2: API Key 哈希迁移 — 双索引过渡期

**选择**: 在 `hierarchical-store` 中同时维护 `apiKeysByValue`（明文，向后兼容）和 `apiKeysByHash`（SHA-256，新路径）。验证时优先查哈希索引，回退查明文索引。启动时自动迁移现有明文 keyHash 为哈希值。

**替代方案**: 一次性迁移（需停服）、Bcrypt 哈希（过慢，API Key 验证需 <1ms）。

**理由**: SHA-256 对 API Key 验证场景足够安全（非密码，无彩虹表风险），且验证速度极快。双索引过渡确保零停机。

### D3: HTTP 客户端统一 — 保留原生 https，移除 axios

**选择**: 统一使用原生 `https` 模块 + 共享 `src/upstream/huawei/http.ts` helper。SSE 流式场景已用原生 https，非流式场景（refresh、ticket）从 axios 迁移。

**替代方案**: 全部用 axios（不支持原生 SSE）、用 node-fetch（额外依赖）。

**理由**: 消除 axios 依赖减少 bundle 大小；原生 https 对 SSE 支持更好；共享 helper 统一超时/错误处理。

### D4: chat.ts 拆分策略 — 按职责边界拆分

**选择**:
```
chat.ts (1070行) →
  chat-request.ts   — 请求体构造 + 模型映射 + 会话ID推导 (~265行)
  chat-stream.ts    — 流式响应主函数 (~280行)
  chat-non-stream.ts — 非流式响应主函数 (~175行)
  chat-transport.ts — HTTP/SSE 传输层 + 共享日志 (~145行)
  chat.ts           — 公共 API + re-export + tool 转换 (~95行)
```

**替代方案**: 仅提取传输层（最小拆分）、按流式/非流式二分。

**理由**: 按职责拆分使每个文件可独立理解。共享逻辑（日志、错误处理、lastResponseMessageId 更新）放入 transport.ts，消除流式/非流式 200 行重复。

### D5: auth/store 拆分 — 按领域边界

**选择**:
```
auth/store.ts (231行) →
  store/user-store.ts     — User CRUD
  store/account-store.ts  — ProviderAccount CRUD
  store/api-key-store.ts  — ApiKey CRUD + 验证 + 哈希
  store/session-store.ts  — Session 读写（从 auth/huawei/ 移出）
```

**替代方案**: 保留 auth/store 作为 facade、仅拆分验证逻辑。

**理由**: 按领域拆分后路由直接导入需要的 store，消除 22 个导入/11 个 re-export 的传递依赖链。

### D6: 速率限制 — express-rate-limit

**选择**: 引入 `express-rate-limit`（轻量、无外部存储依赖），按 API Key 粒度限流。

**替代方案**: 自建限流中间件、用 Redis 支持分布式限流。

**理由**: 单实例部署场景下内存限流足够。express-rate-limit 是 Express 生态标准选择，零配置即可用。

### D7: 错误分类 — 继承体系

**选择**:
```
AppError (base, 带 traceId + 结构化上下文)
  ├── UpstreamAuthError     (401/403)
  ├── UpstreamServerError   (5xx)
  ├── UpstreamTimeoutError  (网络超时)
  └── ProtocolError        (SSE 格式错误、JSON 解析失败)
```

**替代方案**: 用错误码枚举 + plain object、用第三方错误库。

**理由**: 继承体系与 TypeScript 类型守卫天然配合（`instanceof`），且每个错误类可携带不同上下文字段。

## Risks / Trade-offs

- **[API Key 迁移兼容性]** 现有部署的 keyHash 字段存的是明文，迁移后旧值无法直接用于哈希查找 → 双索引过渡期 + 启动时自动迁移
- **[chat.ts 拆分导入变更]** 所有导入 chat.ts 的文件需更新路径 → chat.ts 保留为 re-export 入口，外部导入不变
- **[移除 axios]** refresh.ts 和 ticket.ts 需重写 HTTP 调用 → 共享 http.ts helper 简化迁移，功能等价
- **[结构化日志格式变更]** 运维可能依赖当前 console 输出格式 → logger 在 development 模式下保持可读格式，production 模式输出 JSON
- **[速率限制误杀]** 过低的限制可能影响正常使用 → 初始限制宽松（60 次/分钟），可通过环境变量调整
- **[auth/store 拆分导入变更]** 22 个导入路径需更新 → 逐文件迁移，编译器捕获所有遗漏
