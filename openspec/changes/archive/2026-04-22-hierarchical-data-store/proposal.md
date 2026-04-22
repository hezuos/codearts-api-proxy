## Why

当前所有用户数据（users、apiKeys、providerAccounts、sessions）存储在两个加密的扁平 JSON 文件中（`auth-store.json`、`huawei-sessions.json`），每次任何数据变更都全量序列化→加密→写盘。这导致：(1) 变更影响范围大，单条数据修改触发整个数据集重写；(2) 数据关系不直观，key→account→session 的归属关系被埋在运行时 Map 查找中；(3) 并发安全风险，就地修改 session 字段可能影响进行中的请求；(4) key 与 session 的 N:1 共享模型不合理，同一 account 下多个 key 共享一个 session，凭证刷新影响所有 key 使用者。

## What Changes

- **BREAKING**: 将扁平文件存储重构为按用户/账户/密钥分层目录结构
- **BREAKING**: 将 Key→Session 关系从 N:1（多 key 共享一 session）改为 1:1（每个 key 拥有独立 session）
- **BREAKING**: 移除 bootstrap 默认 key 逻辑——不再自动创建无 session 的 key，必须通过 OAuth 登录才能获得可用 key
- 每个数据文件独立加密（AES-256-GCM），变更只重写受影响的单个文件
- 新增数据迁移脚本（旧扁平格式 → 新目录格式）
- 新增数据管理 CLI 工具（`data-manager.mjs`），支持 list/show/reveal/tree/export/check/migrate/rekey
- 删除未使用的 `conversation-store.json`
- 删除未使用的模型文件 `src/db/models/session.ts`、`src/db/models/login-flow.ts`

## Capabilities

### New Capabilities
- `hierarchical-store`: 分层目录存储引擎——按 user/account/key 层级组织数据文件，每个文件独立加密/解密，提供实体级读写 API
- `data-migration`: 数据迁移工具——从旧扁平格式迁移到新目录格式，支持 dry-run、回滚、验证
- `data-cli`: 数据管理 CLI——`data-manager.mjs` 提供 list/show/reveal/tree/export/check/migrate/rekey 命令

### Modified Capabilities
- `user-auth`: API Key 不再可选绑定 account，key 创建必须伴随 session（严格 1:1）；移除 bootstrap 默认 key
- `account-binding`: session 归属于 key 而非 account，请求链路从 key→account→session 简化为 key→session 直接查找
- `huawei-auth`: OAuth 登录流程创建 key+session 对（1:1），同一 account 多次登录产生多个独立 key+session
- `admin-panel`: 适配新数据结构，key 展示需内嵌 session 状态

## Impact

- **存储层**: `src/auth/store.ts`、`src/auth/huawei/session-store.ts`、`src/auth/admin.ts` 全面重写
- **模型层**: `ApiKey` 新增 `session` 内嵌或关联；`StoredHuaweiSession` 新增 `keyId` 字段
- **请求链路**: `src/middleware/authenticate-api-key.ts`、`src/routes/openai.ts` 简化——key 验证后直接获取 session，无需 account→session 间接查找
- **登录流程**: `src/routes/huawei-auth.ts` 调整为创建 key+session 对
- **Bootstrap**: `src/auth/store.ts` 中 `bootstrapDefaultAuth()` 移除默认 key 创建
- **Admin UI**: `src/routes/admin.ts`、`public/admin.html` 适配新结构
- **刷新逻辑**: `src/auth/huawei/refresh-task.ts`、`src/auth/huawei/refresh.ts` 按 key 粒度刷新 session
- **加密**: `src/auth/crypto/encryption.ts` 可能需要调整以支持单文件加密（独立 IV/nonce 管理）
- **配置**: `src/config.ts` 调整文件路径配置
- **Scripts**: 新增 `scripts/data-manager.mjs`、`scripts/data-migrate.mjs`；`debug-decrypt.mjs`、`check-data-consistency.mjs` 废弃
- **数据兼容**: 需要一次性迁移脚本将现有数据转换为新格式
