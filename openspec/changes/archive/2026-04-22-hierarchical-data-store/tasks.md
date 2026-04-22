## 1. 存储引擎核心

- [x] 1.1 创建 `src/store/file-store.ts`：实现 per-file 加密读写函数 `readEncryptedFile(path)` / `writeEncryptedFile(path, data)`，每次写入生成新 IV
- [x] 1.2 创建 `src/store/paths.ts`：实现实体路径解析函数 `userDir(userId)` / `profilePath(userId)` / `accountDir(userId, accountId)` / `accountPath(userId, accountId)` / `keyDir(userId, accountId, keyId)` / `keyPath(userId, accountId, keyId)` / `sessionPath(userId, accountId, keyId)` / `adminPath()`
- [x] 1.3 创建 `src/store/hierarchical-store.ts`：实现实体级读写 API（`readUserProfile` / `writeUserProfile` / `readAccount` / `writeAccount` / `readKey` / `writeKey` / `readSession` / `writeSession`）
- [x] 1.4 实现实体列举函数：`listUsers()` / `listAccounts(userId)` / `listKeys(userId, accountId)`，基于 `fs.readdirSync` 扫描目录
- [x] 1.5 实现级联删除：`deleteKey(userId, accountId, keyId)` 级联删除 session.json；`deleteAccount(userId, accountId)` 级联删除 keys/ 目录；`deleteUser(userId)` 级联删除整个用户目录
- [x] 1.6 实现启动加载：`loadAllEntities()` 扫描 data/users/ 目录树，解密所有文件，加载到内存 Map（users, accounts, keys, sessions）
- [x] 1.7 更新 `src/config.ts`：调整 dataDir 配置，移除旧的 `authStoreFile` / `sessionStoreFile` / `conversationStoreFile` 路径

## 2. 模型层更新

- [x] 2.1 更新 `src/db/models/api-key.ts`：ApiKey 接口保持 `providerAccountId` 字段（key 仍属于 account），确认字段语义
- [x] 2.2 更新 `src/db/models/provider-account.ts`：确认 ProviderAccount 接口不变
- [x] 2.3 更新 `StoredHuaweiSession` 接口（`src/auth/huawei/session-store.ts`）：新增 `keyId` 字段，移除 `providerAccountId` 作为主键的语义（session 通过路径归属 key，不再需要 providerAccountId 字段做关联）
- [x] 2.4 删除未使用的模型文件：`src/db/models/session.ts`、`src/db/models/login-flow.ts`

## 3. 认证存储层重写

- [x] 3.1 重写 `src/auth/store.ts`：用 hierarchical-store API 替代旧的内存 Map + 全量持久化模式；`validateApiKey()` 返回的 `AuthContext` 直接携带 session 凭证
- [x] 3.2 重写 `src/auth/huawei/session-store.ts`：session 读写改为 `readSession()` / `writeSession()` 路径级操作；移除 `sessionCache` Map（session 数据通过 key 的内存缓存访问）
- [x] 3.3 重写 `src/auth/admin.ts`：admin 配置读写改为 `adminPath()` 路径；移除硬编码路径
- [x] 3.4 移除 `bootstrapDefaultAuth()` 中的默认 Key 创建逻辑：只创建 User，不创建 Key

## 4. 请求链路简化

- [x] 4.1 更新 `src/middleware/authenticate-api-key.ts`：`validateApiKey()` 返回的 `AuthContext` 直接包含 session 凭证，中间件将完整凭证挂载到 `req.auth`
- [x] 4.2 更新 `src/routes/openai.ts`：移除 account→session 间接查找逻辑，直接从 `req.auth` 获取 session 凭证用于请求签名
- [x] 4.3 更新 `AuthContext` 接口：新增 `session` 字段（包含 AK/SK/securityToken/businessToken），移除 `providerAccountId` 的 fallback 语义

## 5. 登录流程适配

- [x] 5.1 更新 `src/routes/huawei-auth.ts`：OAuth 登录完成后创建 Key+Session 对（1:1），session 写入 `keys/{keyId}/session.json`
- [x] 5.2 更新 `src/routes/web-ui.ts`：regenerate key 时同时创建新 session（需要重新登录获取凭证，或复制当前 session）

## 6. Session 刷新适配

- [x] 6.1 重写 `src/auth/huawei/refresh-task.ts`：遍历所有 key 目录，对每个 key 的 session 独立检查过期和刷新
- [x] 6.2 更新 `src/auth/huawei/refresh.ts`：刷新结果写入对应 key 的 `session.json`
- [x] 6.3 移除 `refreshLocks` Map（每个文件独立写入，无并发风险）

## 7. Admin 面板适配

- [x] 7.1 更新 `src/routes/admin.ts`：API 端点使用 hierarchical-store API 读取数据；account 详情内嵌 key 列表及每个 key 的 session 状态
- [x] 7.2 更新 `src/routes/provider-accounts.ts`：适配新数据结构
- [x] 7.3 更新 `public/admin.html`：key 展示增加 session 状态列（active/expiring/expired/missing）；force refresh 改为按 key 粒度

## 8. 数据迁移工具

- [x] 8.1 创建 `scripts/data-migrate.mjs`：实现旧→新格式迁移（解密旧文件 → 创建目录结构 → 写加密文件 → 验证）
- [x] 8.2 实现 `--dry-run` 选项：预览迁移计划，不写文件
- [x] 8.3 实现 `--rollback` 选项：从 `data/.backup/` 恢复旧文件
- [x] 8.4 实现迁移前备份：将旧文件复制到 `data/.backup/`
- [x] 8.5 实现迁移后验证：比对实体数量和引用完整性

## 9. 数据管理 CLI

- [x] 9.1 创建 `scripts/data-manager.mjs`：实现 `list` 命令（遍历 data/users/ 列出用户/账户/key）
- [x] 9.2 实现 `show` 命令：解密+掩码显示指定实体
- [x] 9.3 实现 `reveal` 命令：解密+完整显示（含敏感凭证）
- [x] 9.4 实现 `tree` 命令：ASCII 树形展示 data/ 目录结构
- [x] 9.5 实现 `export` 命令：解密导出为明文 JSON
- [x] 9.6 实现 `check` 命令：一致性检查（孤立 account、缺失 session、过期 session、已撤销 key）
- [x] 9.7 实现 `migrate` 命令：调用 data-migrate 逻辑
- [x] 9.8 实现 `rekey` 命令：用新加密密钥重加密所有文件

## 10. 清理与验证

- [x] 10.1 删除 `data/conversation-store.json`（未使用）
- [x] 10.2 废弃 `scripts/debug-decrypt.mjs` 和 `scripts/check-data-consistency.mjs`（被 data-manager.mjs 替代）
- [x] 10.3 更新 `src/index.ts`：启动流程使用新的 `loadAllEntities()`，移除旧的 `loadPersistedAuthStore()` / `loadPersistedSessions()`
- [x] 10.4 端到端测试：启动服务 → OAuth 登录 → API 请求 → 刷新 → 删除 key → 删除 account，验证全流程
