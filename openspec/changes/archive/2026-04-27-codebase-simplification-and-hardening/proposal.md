## Why

项目存在三类系统性问题：(1) **安全漏洞** — Admin 硬编码 session token、API Key 明文存储、加密密钥硬编码回退；(2) **代码腐化** — 590 行未使用代码/类型/依赖、200 行流式/非流式重复逻辑、1070 行超大文件、8 处重复函数；(3) **架构缺陷** — 无结构化日志、HTTP 客户端混用、全局可变状态散布、同步文件 I/O 阻塞事件循环、无速率限制。这些问题累积影响安全性、可维护性和运行时可靠性，需要系统性治理。

## What Changes

### 安全加固
- Admin session token 改为启动时随机生成，消除硬编码伪造风险
- API Key 存储改为 SHA-256 哈希索引，内存不再持有明文 key
- 加密密钥在生产环境强制要求设置，移除不安全的硬编码回退
- Cookie `auth_key_id` 改为 httpOnly，统一 sameSite 策略

### 代码精简
- 删除 9 个未使用的 npm 依赖（uuid, ws, dotenv, better-sqlite3, openai, sql.js, jest, @types/uuid, @types/ws）
- 删除 `types/openai.ts` 中 ~240 行未使用的类型定义
- 删除 6 个未使用的导出函数（buildCompletionResponse, buildStreamingChunks, deleteSession, setMasterNode, getAdminSource, removeApiKeyFromValueIndex）
- 提取重复的 `getCredentials()`、`maskValue()`、`isProduction` 到共享模块
- 消除 `chat.ts` 流式/非流式函数 ~200 行重复逻辑
- 消除 `tools.ts` 中 SUB_AGENT_TOOLS/SUB_AGENT_TOOL_NAMES 冗余定义
- 提取 `admin.ts` 中重复的账户查找和 key 详情映射逻辑

### 架构改进
- 拆分 `chat.ts`（1070 行）为 5 个职责单一的模块
- 引入结构化日志层（pino 或轻量 wrapper），替换 118 处 console 直接调用
- 统一 HTTP 客户端为原生 https + 共享 helper，移除 axios 依赖
- 将 `auth/store.ts` 上帝模块按领域拆分为 user-store、account-store、api-key-store、session-store
- 用 Node.js Readable 替换手写 AsyncIterator（~60 行 → ~8 行）
- 为 `lastResponseMessageId` Map 添加 TTL 过期机制
- 替换 `Reflect.set/get` 为 Express Request 类型扩展
- 添加 `/ready` 深度健康检查端点
- 添加请求速率限制中间件

## Capabilities

### New Capabilities
- `structured-logging`: 结构化日志系统，替代 console 直接调用，支持级别控制和 traceId 自动注入
- `api-rate-limiting`: 请求速率限制，防止上游配额耗尽和暴力攻击
- `error-classification`: 错误分类体系，区分上游认证错误/服务端错误/超时/协议错误
- `health-probes`: liveness + readiness 健康检查，支持容器编排深度探测

### Modified Capabilities
- `admin-auth`: Admin session token 从硬编码改为随机生成，消除伪造风险
- `user-auth`: API Key 存储从明文改为 SHA-256 哈希索引
- `hierarchical-store`: 同步 I/O 热路径改为异步，避免阻塞事件循环
- `openai-api`: 统一 HTTP 客户端、拆分 chat.ts、消除重复逻辑
- `sse-streaming`: 用 Readable 替换手写 AsyncIterator

## Impact

- **安全**: 修复 3 个严重漏洞，影响 admin 认证、API Key 存储、加密密钥管理
- **代码量**: 净减少约 590 行（11%），chat.ts 从 1070 行拆分为 5 个模块
- **依赖**: 移除 axios、uuid、ws、dotenv 等 9 个未使用依赖；可能新增 pino
- **API**: 新增 `/ready` 端点；`/v1/chat/completions` 和 `/v1/models` 添加速率限制
- **Breaking**: API Key 验证逻辑变更（明文→哈希），现有部署需迁移 keyHash 字段
- **文件重组**: `auth/store.ts` 拆分为 4 个模块；`upstream/huawei/chat.ts` 拆分为 5 个模块
