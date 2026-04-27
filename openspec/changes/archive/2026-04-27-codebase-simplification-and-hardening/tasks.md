## 1. 安全加固（最高优先级）

- [x] 1.1 Admin session token 改为 `crypto.randomBytes(32)` 启动时生成，替换 `authenticate-admin.ts` 中硬编码的 `"admin-authenticated"`
- [x] 1.2 API Key 存储改为 SHA-256 哈希：在 `hierarchical-store.ts` 中添加 `apiKeysByHash` Map，修改 `setApiKey` 和 `findApiKeyByValue` 使用哈希索引
- [x] 1.3 API Key 迁移逻辑：启动时检测 `keyHash` 字段是否为明文（长度≠64或不含hex字符），自动迁移为 SHA-256 哈希，双索引过渡期保持 `apiKeysByValue` 兼容
- [x] 1.4 加密密钥生产环境强制：修改 `config.ts` 中 `encryptionKey` 逻辑，`NODE_ENV=production` 时无 fallback，缺失则抛错退出
- [x] 1.5 Cookie `auth_key_id` 改为 `httpOnly: true`，在 `huawei-auth.ts` 的 `setAuthKeyIdCookie` 中修改
- [x] 1.6 统一 `isProduction` 到 `config.ts`：添加 `isProduction` 导出，替换所有 6 处 `process.env.NODE_ENV === "production"` 重复计算

## 2. 代码精简 — 删除死代码

- [x] 2.1 从 `package.json` 移除 9 个未使用依赖：uuid, ws, dotenv, better-sqlite3, openai, sql.js, jest, ts-jest, @types/uuid, @types/ws
- [x] 2.2 删除 `types/openai.ts` 中未使用的类型定义（OpenAIResponse, OpenAIModelPermission, OpenAIFunctionCall, OpenAIFunctionDefinition, OpenAILogProbs, OpenAILogProbsContent, OpenAITopLogProb, OpenAIEmbeddingRequest, OpenAIEmbedding, OpenAIEmbeddingsResponse, ModelMapping, ProxyConfig, AuthConfig, OpenAIToCodeArtsConverter, CodeArtsToOpenAIConverter, CodeArtsChatRequest, CodeArtsChatResponse, EventType, StreamEvent, StreamCallback）
- [x] 2.3 删除 `translation/openai-mock.ts` 中未使用的 `buildCompletionResponse`、`buildStreamingChunks`、`getPromptText` 函数
- [x] 2.4 删除 `session-store.ts` 中空操作 `deleteSession` 函数
- [x] 2.5 删除 `refresh-task.ts` 中未使用的 `setMasterNode` 导出
- [x] 2.6 删除 `admin.ts` 中未使用的 `getAdminSource` 导出
- [x] 2.7 删除 `auth/store.ts` 中未使用的 `_removeApiKeyFromValueIndex` 导入和 `hierarchical-store.ts` 中的 `removeApiKeyFromValueIndex` 函数

## 3. 代码精简 — 消除重复

- [x] 3.1 提取 `getCredentials()` 到 `src/auth/huawei/credentials.ts`，从 `chat.ts` 和 `models.ts` 中删除重复实现
- [x] 3.2 提取 `maskValue()` 到 `src/utils/mask.ts`，从 `huawei-auth.ts` 和 `ticket.ts` 中删除重复实现
- [x] 3.3 消除 `tools.ts` 中 SUB_AGENT_TOOLS/SUB_AGENT_TOOL_NAMES 冗余：`SUB_AGENT_TOOLS` 从 `SUB_AGENT_TOOL_NAMES` 派生，删除重复的工具名列表
- [x] 3.4 提取 `admin.ts` 中重复的账户查找逻辑为 `findAccountOwner(accountId)` 辅助函数
- [x] 3.5 提取 `admin.ts` 中重复的 API Key 详情映射为 `mapApiKeyDetails(apiKey, session)` 辅助函数

## 4. 结构化日志

- [x] 4.1 创建 `src/utils/logger.ts`：实现 Logger 类，支持 debug/info/warn/error 级别，development 模式可读输出，production 模式 JSON 输出
- [x] 4.2 Logger 自动携带 traceId：提供 `logger.withTrace(traceId)` 方法返回子 logger
- [x] 4.3 替换 `chat.ts` 中所有 console 调用为 logger（约 40 处）
- [x] 4.4 替换 `openai.ts` 中所有 console 调用为 logger（约 15 处）
- [x] 4.5 替换其余模块中关键 console 调用为 logger（session-store, refresh-task, huawei-auth, ticket, admin, models）
- [x] 4.6 请求体全文仅在 debug 级别输出，info 级别仅输出摘要字段

## 5. 错误分类体系

- [x] 5.1 创建 `src/utils/errors.ts`：定义 AppError 基类（携带 traceId）和 UpstreamAuthError, UpstreamServerError, UpstreamTimeoutError, ProtocolError 子类
- [x] 5.2 将 `chat.ts` 中现有的 `UpstreamAuthError` 迁移到 `errors.ts`
- [x] 5.3 在 `chat.ts` HTTP 错误处理中使用 UpstreamServerError 和 UpstreamTimeoutError
- [x] 5.4 在 SSE 解析错误中使用 ProtocolError

## 6. chat.ts 拆分与去重

- [x] 6.1 创建 `src/upstream/huawei/chat-protocol.ts`：提取 CodeArts 类型定义和 `parseSSE`
- [x] 6.2 创建 `src/upstream/huawei/chat-request.ts`：提取 `buildRequestBody`、`resolveModelId`、`deriveConversationId`、`extractUserMessage`、`extractToolResults`、`buildTaskParameters`、MODEL_MAP、lastResponseMessageId/chatIdRole 状态管理
- [x] 6.3 创建 `src/upstream/huawei/chat-stream.ts`：提取 `streamHuaweiChatToResponse`，使用 transport 和 request 模块的共享逻辑
- [x] 6.4 创建 `src/upstream/huawei/chat.ts`：提取 `sendHuaweiChatRequest`，使用 transport 和 request 模块的共享逻辑，消除与流式函数的重复
- [x] 6.5 重构 `chat.ts` 为 re-export 入口：导出 streamHuaweiChatToResponse、sendHuaweiChatRequest、DEFAULT_MODEL_ID、MODEL_MAP
- [x] 6.6 为 `lastResponseMessageId` Map 添加 TTL 过期：每 10 分钟清理超过 4 小时未更新的条目

## 7. HTTP 客户端统一

- [x] 7.1 在 `ticket.ts` 中用原生 https 替换 axios，添加 `httpsPostJson` helper
- [x] 7.2 将 `ticket.ts` 从 axios 迁移到原生 https + helper，保留重试逻辑和错误检测
- [x] 7.3 将 `refresh.ts` 从 axios 迁移到原生 https + helper
- [x] 7.4 从 `package.json` 移除 axios 依赖

## 8. auth/store 拆分

- [x] 8.1 创建 `src/store/user-store.ts`：从 `auth/store.ts` 提取 User CRUD（createUser, getUser, getDefaultUser, listAllUsers）
- [x] 8.2 创建 `src/store/account-store.ts`：从 `auth/store.ts` 提取 ProviderAccount CRUD（upsertProviderAccount, listProviderAccounts, getProviderAccount, setDefaultProviderAccount, deleteProviderAccount）
- [x] 8.3 创建 `src/store/api-key-store.ts`：从 `auth/store.ts` 提取 ApiKey CRUD + 验证（issueApiKey, validateApiKey, revokeApiKey, getUserApiKey, listApiKeysByUser, findApiKeyByValue）
- [x] 8.4 创建 `src/store/session-store.ts`：从 `auth/huawei/session-store.ts` 积入到 `src/store/` 层，消除动态 import
- [x] 8.5 更新所有导入路径：routes、middleware、index.ts 中 `from "../auth/store"` 改为具体 store 模块
- [x] 8.6 删除或精简 `auth/store.ts`：仅保留 `bootstrapDefaultAuth` 和 `loadPersistedAuthStore`

## 9. 速率限制与健康检查

- [x] 9.1 安装 `express-rate-limit` 依赖，添加 `@types/express-rate-limit` devDependency
- [x] 9.2 在 `index.ts` 中为 `/v1/chat/completions` 添加按 API Key 粒度的速率限制（默认 60次/分钟）
- [x] 9.3 在 `index.ts` 中为 `/v1/models` 添加更宽松的速率限制（默认 120次/分钟）
- [x] 9.4 速率限制参数可通过 `RATE_LIMIT_CHAT_MAX`、`RATE_LIMIT_MODELS_MAX` 环境变量配置
- [x] 9.5 添加 `GET /ready` 端点：检查 data 目录可读写，返回 200 或 503

## 10. Express Request 类型扩展

- [x] 10.1 用 `declare global` 扩展 Express Request 类型添加 `auth` 和 `traceId` 属性，替换 `Reflect.set/get`
- [x] 10.2 更新 `authenticate-api-key.ts` 和 `request-context.ts` 使用类型安全的属性赋值

## 11. 验证与清理

- [x] 11.1 运行 `pnpm build` 确保编译通过
- [x] 11.2 运行现有测试确保通过
- [x] 11.3 运行 ESLint 确保无新警告
- [x] 11.4 验证所有导入路径正确，无循环依赖
