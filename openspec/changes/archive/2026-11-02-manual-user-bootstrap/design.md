# Design

## Context

当前启动链路是 `loadPersistedAuthStore()` 扫 `data/users/` 解密加载，`bootstrapDefaultAuth()` 在内存无用户时建 `dev@codearts-agent-proxy.local`。解密失败跳过只打 warn，导致换 `ENCRYPTION_KEY` / `DATA_DIR` 后静默建出第二个同名用户。`LoginFlowRecord` 已有 `userId` 字段，`resolveBrowserLoginUserId` 兜底读 cookie 或 `getDefaultUser()`。`accountId = huawei-${domainId}` 全局唯一，`providerAccounts` 是全局 Map。详见 proposal 动机。

## Goals / Non-Goals

**Goals：**

- 启动零自动创建，多用户显式归属，一次性口令只做归属不做身份。
- 新旧 OAuth2 回调统一按票据归属，消除串户。
- 同一华为账号跨用户抢绑变显式冲突。

**Non-Goals：**

- 不做用户登录密码体系、不做用户级权限隔离（仍共用 admin 会话）。
- 口令不做持久化、不做可配置 TTL。
- 不自动合并存量重复用户之外的其他脏数据。

## Decisions

### 1. 口令存内存 Map，不落盘

口令为 `sk-invite-` + 随机串，内存 Map 存 `tokenHash -> { userId, expiresAt, consumed }`，key 只存 SHA-256。重启失效可接受（绑定是低频运维动作），且避免加密文件里再留一份可复制的秘密。消费时先判存在、未消费、未过期、用户仍存在，四项全过才标记 consumed 并继续，原子靠 Node 单线程内同步段保证。

备选落盘被否：重启保持有效反而扩大窗口，且清理逻辑更复杂。

### 2. 口令走 `invite_token` 字段，两个浏览器入口同校验

`GET /auth/huawei/authorize` 与 `POST /auth/huawei/browser/start` 共用 `resolveInviteUserId(req)`：先看 `auth_key` cookie 解出的已鉴权用户，有则直接用；无则取 `query.invite_token ?? body.invite_token` 消费口令。失败统一 400 + 明确错误码（`binding_required` / `token_invalid` / `token_expired`）。`GET` 带 query 方便首页链接，`POST` 带 body 方便 fetch。

### 3. 新旧回调统一按票据归属

- 旧 `identifier` 回调：已有 `preferredTicketId`（query 或 cookie）精确定位，保持。
- 新 OAuth2 `code + state` 回调：`state` 即建 flow 时的 `LoginFlowRecord.state`，按 `state` 精确匹配 pending flow；无 `state` 或匹配不上则明确 400，不再回退 `getAnyPendingLoginFlow()`。`getAnyPendingLoginFlow` 保留仅供测试或删掉，不再用于生产回调。
- 回调完成沿用 `flow.userId` provision，不变。

### 4. 跨用户抢账号直接拒绝

`provisionLoginResult` 在 `upsertProviderAccount` 前加归属检查：目标 `accountId` 已存在且 `account.userId !== flow.userId` 时，整单拒绝并报错 `account_conflict`，不建 Key/Session。同用户重登仍走原 upsert。

### 5. 用户创建与 email 规则

`createUser` 删单用户守卫；`email` 可空，仅非空时按 trim + 小写去重；`displayName` 必填非空。setup 页表单新增 `displayName` + 可选 `email`；panel 新增建用户小表单。Admin API：`POST /admin/api/users { displayName, email? }`、`POST /admin/api/users/:id/invite` 返回 `{ token, expiresAt }`。

### 6. 启动与零用户行为

`index.ts` 删 `bootstrapDefaultAuth()` 调用；`user-store.ts` 删该函数（`createUser` 保留给 admin 调）。零用户时 `/v1/*` 自然 401（无 Key 可校验）；首页登录无口令点按钮直接 400 `binding_required`，前端展示引导去找 admin 要口令。`huawei-auth.test.ts` 里调 `bootstrapDefaultAuth` 的改用 `setUser` 直建。

## Risks / Trade-offs

- [重启口令失效] 运维正在发口令时重启需重发 → 口令签发是秒级操作，可接受。
- [OAuth2 state 匹配不上] 上游若不原样回传 state 则新回调全失败 → 上线前用真实回调验证一次；失败时日志打 `state` 前缀便于排查。
- [存量抢绑变拒绝] 若已有两用户同绑一账号（当前代码允许），升级后后绑者登录被拒 → 迁移步骤先做重复清理，见下。
- [setup 表单加字段] 老用户已设过 admin 密码不会重走 setup，首用户需在 panel 补建 → tasks 含 panel 建用户，覆盖该路径。

## Migration Plan

1. 备份 `data/`。
2. 停服，查 `data/users/*/profile.json` 解密，明确认出重复 `dev` 用户：保留有账号/有 Key 者，删 0 账号孤儿目录。
3. 升级启动，确认 Admin 用户列表只剩预期用户。
4. 用真实华为账号走一次持口令登录（含 OAuth2 code+state 路径），确认归属正确。

回滚：恢复 `data/` 备份并回退版本；新签发的口令在内存，重启即废，无残留。
