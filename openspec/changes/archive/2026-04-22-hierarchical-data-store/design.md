## Context

当前 CodeArts Agent Proxy 的数据存储采用两个加密扁平 JSON 文件（`auth-store.json` 含 users/apiKeys/providerAccounts，`huawei-sessions.json` 含 sessions），运行时加载到内存 Map 中，每次变更全量序列化→加密→写盘。

关键现状：
- 所有用户数据混在两个大文件中，变更触发全量重写
- Key→Account 是 N:1，Session→Account 是 1:1，Key 通过 Account 间接访问 Session
- 同一 Account 下多个 Key 共享一个 Session，凭证刷新影响所有 Key 使用者
- Session 刷新就地修改对象字段，JavaScript 引用语义下进行中的请求可能看到不一致状态
- Bootstrap 创建无 Session 的默认 Key，请求时 fallback 到 default Account
- `conversation-store.json` 完全未使用，`session.ts`/`login-flow.ts` 模型未使用
- 加密粒度为整个文件，IV/nonce 随每次写入重新生成

## Goals / Non-Goals

**Goals:**
- 按用户/账户/密钥分层目录组织数据，目录结构即关系结构
- Key 与 Session 严格 1:1，每个 Key 拥有独立凭证生命周期
- 每个数据文件独立加密，变更只重写受影响文件
- 请求链路简化：Key 验证后直接获取 Session，无需 Account→Session 间接查找
- 提供数据迁移工具（旧→新）和管理 CLI
- 移除 bootstrap 默认 Key，OAuth 登录是获得可用 Key 的唯一途径

**Non-Goals:**
- 不引入数据库（SQLite/PostgreSQL）——文件系统存储对当前规模足够
- 不改变加密算法（仍用 AES-256-GCM）
- 不改变华为云 OAuth 协议或上游 API 调用方式
- 不实现多区域/多端点支持（endpoint 仍硬编码 cn-north-4）
- 不实现 Admin UI 的 Key 创建/重绑定功能（仍通过 OAuth 登录创建）
- 不实现 Session 的并发安全写时复制（CoW）——Node.js 单线程下风险可接受

## Decisions

### D1: 目录结构设计

```
data/
├── admin.json
└── users/
    └── {userId}/
        ├── profile.json
        └── accounts/
            └── {accountId}/
                ├── account.json
                └── keys/
                    └── {keyId}/
                        ├── key.json
                        └── session.json
```

**选择理由**: 目录层级直接映射实体关系（User→Account→Key→Session），无需额外索引即可通过路径定位任何实体。Key 下挂 Session 体现 1:1 关系。

**替代方案**:
- 扁平文件 + 索引文件：失去直观性，需要维护索引一致性
- 按实体类型分目录（users/、accounts/、keys/）：跨目录引用需要 ID 查找，不如嵌套直观

### D2: Key↔Session 1:1 绑定

每个 Key 目录下恰好有一个 `session.json`。Key 创建时必须同时创建 Session（OAuth 登录流程天然满足）。不存在无 Session 的 Key。

**选择理由**: 消除共享 Session 的并发风险；每个客户端（Key 使用者）有独立凭证，刷新互不影响；数据模型更简单——删除 Key 级联删除 Session，无需跨实体引用解析。

**替代方案**:
- 保持 N:1 共享 + 写时复制：复杂度高，需要版本化 Session 引用
- Session 独立于 Key 但 1:1 映射：多一层间接引用，无额外收益

### D3: 每文件独立加密

每个 `.json` 文件独立用 AES-256-GCM 加密，每次写入生成新的随机 IV（12 bytes）和 authTag。文件内容格式：`base64(iv + authTag + ciphertext)`。

**选择理由**: 变更只重写单个文件，减少 I/O 和崩溃时数据丢失风险；文件粒度与实体粒度一致。

**权衡**: 目录名和文件名是明文，暴露 userId/accountId/keyId 的存在。这是可接受的——这些 ID 本身不是秘密，敏感数据（AK/SK/token）在文件内容中加密。

**替代方案**:
- 目录级加密（整个用户目录打包为一个加密文件）：又回到全量重写问题
- 明文 + OS 权限控制：安全性不足，凭证明文存储

### D4: 运行时存储层 API

新的存储层提供实体级读写函数，替代当前的内存 Map + 全量持久化模式：

```typescript
// 读取：解密 + 解析单个文件
readUserProfile(userId): User
readAccount(userId, accountId): ProviderAccount
readKey(userId, accountId, keyId): ApiKey
readSession(userId, accountId, keyId): StoredHuaweiSession

// 写入：序列化 + 加密 + 写单个文件
writeUserProfile(userId, data): void
writeAccount(userId, accountId, data): void
writeKey(userId, accountId, keyId, data): void
writeSession(userId, accountId, keyId, data): void

// 列举：扫描目录
listUsers(): string[]
listAccounts(userId): string[]
listKeys(userId, accountId): string[]

// 删除：删除文件 + 级联
deleteKey(userId, accountId, keyId): void   // 级联删除 session.json
deleteAccount(userId, accountId): void       // 级联删除 keys/ 目录
deleteUser(userId): void                     // 级联删除 accounts/ 目录
```

**选择理由**: 每次读写只涉及单个文件，无需全量序列化。列举操作通过 `fs.readdirSync` 扫描目录，无需维护内存索引。

**替代方案**:
- 保持内存 Map + 按实体持久化：需要维护 Map 与文件的一致性，启动时仍需全量加载
- 懒加载 + LRU 缓存：当前数据量小，全量加载更简单可靠

**决策**: 启动时全量加载到内存 Map（保持当前模式的低延迟优势），但持久化时只写变更的单个文件。内存 Map 作为读缓存，写操作同时更新 Map 和文件。

### D5: 请求链路简化

当前: `Request → validateApiKey(key) → resolveAccount(accountId) → getSession(accountId) → 签名请求`

新: `Request → validateApiKey(key) → getSession(keyId) → 签名请求`

Key 验证后直接获取关联 Session，Account 信息仅在 Admin UI 和登录流程中使用。`AuthContext` 接口改为直接携带 session 凭证而非仅 `providerAccountId`。

**选择理由**: 减少一次间接查找；消除"Key 无绑定→fallback 到 default Account"的复杂逻辑；请求处理不再需要 Account 解析步骤。

### D6: Bootstrap 变更

移除 `bootstrapDefaultAuth()` 中的默认 Key 创建逻辑。启动时：
1. 确保 data/ 目录结构存在
2. 如果没有 User，创建默认 User
3. 不创建 Key——用户必须通过 OAuth 登录获得 Key+Session

**选择理由**: Key↔Session 严格 1:1 下，无 Session 的 Key 没有意义。OAuth 登录是创建 Key+Session 的唯一入口，语义更清晰。

**影响**: 首次部署时，启动后代理服务可响应但所有 API 请求返回 401，直到管理员完成 OAuth 登录。这是可接受的——当前也需要登录才能获得凭证。

### D7: Session 刷新按 Key 粒度

刷新任务遍历所有 Key 目录，对每个 `session.json` 独立检查过期和刷新。刷新时：
1. 读取 `session.json`，解密
2. 检查 `expiresAt`，若剩余 < 2h 则刷新
3. 调用华为 refresh API 获取新凭证
4. 写入新的 `session.json`（加密）

**选择理由**: 每个 Key 的 Session 独立刷新，互不影响。不再需要 `refreshLocks` Map（每个文件独立写入，无并发风险）。

### D8: 迁移策略

提供 `data-migrate.mjs` 脚本，执行一次性迁移：

1. 读取旧 `auth-store.json`（解密）→ 得到 users[], apiKeys[], providerAccounts[]
2. 读取旧 `huawei-sessions.json`（解密）→ 得到 sessions[]
3. 按 userId 分组，创建目录结构
4. 对每个 User → 写 `profile.json`
5. 对每个 Account → 写 `account.json`
6. 对每个 Key → 写 `key.json`
7. 对每个 Key，找到其 Account 对应的 Session → 写 `session.json`（Key↔Session 1:1 下，同一 Account 的多个 Key 共享同一 Session 副本）
8. 复制 `admin-config.json` → `admin.json`
9. 验证：重新读取所有新文件，与旧数据比对
10. 备份旧文件到 `data/.backup/`

**回滚**: 从 `data/.backup/` 恢复旧文件，删除新目录结构。

## Risks / Trade-offs

- **[目录名暴露元数据]** → 可接受。userId/accountId/keyId 是 UUID，本身不含敏感信息。真正的秘密（AK/SK/token）在加密文件内容中。
- **[文件数膨胀]** → 当前规模下（单用户、少量账户和 Key）不是问题。如果未来用户量增长到数千，可考虑引入 SQLite。
- **[迁移失败导致数据丢失]** → 迁移脚本先备份旧文件，支持 dry-run 预览，验证步骤确认数据完整后才提交。
- **[启动时全量加载性能]** → 每个文件独立解密，文件数增多时启动略慢。当前规模下可忽略。若未来成为瓶颈，可改为懒加载。
- **[Key↔Session 1:1 导致同一 Account 多次登录产生重复 Session]** → 这是正确行为。每次登录产生独立 Key+Session，凭证独立管理。旧 Session 自然过期后可清理。
- **[移除默认 Key 导致首次部署体验变化]** → 文档说明：部署后需先完成 OAuth 登录。Admin 面板仍可访问（用 admin 密码）。

## Migration Plan

1. **发布前**: 运行 `data-migrate.mjs --dry-run` 确认迁移预览正确
2. **停机**: 停止代理服务
3. **迁移**: 运行 `data-migrate.mjs`，旧文件备份到 `data/.backup/`
4. **验证**: 运行 `data-manager.mjs check` 确认数据一致性
5. **启动**: 启动新版本代理服务，验证 API 请求正常
6. **回滚（如需）**: 停止服务，从 `data/.backup/` 恢复旧文件，启动旧版本

## Open Questions

- 是否需要在 `profile.json` 中保留 `email` 和 `displayName` 字段？当前代码中这些字段可选且未实际使用。
- Admin 面板是否需要增加"清理过期 Session"功能？当前过期 Session 只是留在磁盘上不参与刷新。
