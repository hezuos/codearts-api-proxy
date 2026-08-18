## Context

本项目当前华为云认证的凭证提取逻辑（`src/upstream/huawei/ticket.ts` 中的 `extractCredentials`）仅支持旧版 IAM 响应格式（`credential.access` / `secret` / `securitytoken` / `expires_at`）。上游 `huaweicloud.authentication` v5.0.2 默认启用了新版 IAM 登录流程（`LoginWay.NewIamLogin`），其响应格式与旧版不同：

- 凭证字段路径变化：`credential.*` → `credentials.*`
- 字段名变化：`access` → `access_key_id`，`secret` → `secret_access_key`，`securitytoken` → `security_token`，`expires_at` → `expiration`
- 新增 `refresh_token` 字段
- 用户信息需通过 IAM API（`resolveUserInfo`）单独获取，而非直接从登录响应中提取

此外，上游的 Token 刷新调度使用动态 `setTimeout`（基于 `expires_at - now - 2h - random`），本项目当前使用固定 10 分钟 `setInterval`。

完整设计细节参见 `docs/upstream-v5.0.2-migration-design.md`。

## Goals / Non-Goals

**Goals:**
- 新增对新版 IAM 登录响应格式（NewIamLogin）的自动检测和解析
- 从新格式响应中提取并持久化 `refresh_token`
- 支持通过 IAM API（`resolveUserInfo`）获取用户信息
- 新增 `IAMRequestErrorType` 结构化错误分类，覆盖登录和刷新环节
- 将刷新调度从固定 `setInterval` 改造为基于 `expires_at` 的动态 `setTimeout`
- 在 `StoredHuaweiSession` 中新增 `refreshToken`、`loginContext`、`credentialFormat` 可选字段

**Non-Goals:**
- 不下线旧版凭证格式的支持（新旧格式在运行时共存）
- 不改动现有的 AK/SK 签名算法（`sign.ts`）
- 不改动分层存储架构（`hierarchical-store.ts`）
- 不改动 API Key 签发/验证逻辑

## Decisions

### D1: 格式检测策略 — payload 特征检测而非版本协商

- **选择**：通过检测 `payload.credentials.access_key_id` 是否存在来判断新/旧格式
- **理由**：上游 API 不提供显式的版本标识，特征检测是最可靠的方式。新旧格式的字段路径完全不同，不存在歧义。
- **备选方案**：在登录请求中加入 `api_version` 参数 — 但上游 API 不支持，舍弃。

### D2: 凭证解析独立模块

- **选择**：将凭证格式检测和解析抽离为独立模块 `extract-credentials.ts`
- **理由**：`ticket.ts` 当前耦合了 HTTP 传输和响应解析。将格式逻辑独立后，`ticket.ts` 只需调用统一接口，新增格式不影响传输层。
- **备选方案**：直接在 `ticket.ts` 中添加 if/else — 但会导致模块职责混杂，后续新增格式时修改范围更大。

### D3: 刷新调度改造 — `RefreshScheduler` 类封装

- **选择**：新增 `RefreshScheduler` 类，封装动态 `setTimeout` 调度逻辑
- **理由**：对标上游 `getFirstRefreshTime` 算法。`setInterval` 无法感知 `expires_at` 变化，每次刷新后需重新计算下次时间。`setTimeout` 天然支持此模式。
- **重要**：进程重启后依赖 `refresh-task.ts` 的 `startHuaweiRefreshTask` 恢复调度（读取 session 中的 `expiresAt` 重新计算）。

### D4: refresh_token 作为降级刷新路径

- **选择**：优先使用 AK/SK 签名刷新（`/v2/login/refresh`），仅在签名刷新失败时尝试 `refresh_token` 路径
- **理由**：AK/SK 签名刷新已在本项目中验证通过并稳定运行。`refresh_token` 作为新增字段，其有效期和行为尚未在生产环境中验证。降级策略可确保不破坏现有刷新机制。
- **备选方案**：优先使用 `refresh_token` — 但 `refresh_token` 可能比 AK/SK 更早过期，反而降低刷新成功率。

### D5: 新格式的 user_id 获取

- **选择**：新格式中 user_id/user_name/domain_id 可能包含在响应顶层，也可能需要通过 IAM API 查询。设计为：优先从响应中提取，缺失时调用 `resolveUserInfo`。
- **理由**：上游 `doCreateHuaweiLoginAuthentication` 无条件调用 `resolveUserInfo`，但不同 IAM 环境下响应字段可能不同。自适应策略减少 API 调用延迟。
- **风险**：`resolveUserInfo` 的确切 IAM 端点需在部署环境中确认（当前参考上游 `/v3/user/info` 或 `/v3/projects`）。

## Risks / Trade-offs

| 风险 | 影响 | 缓解 |
|------|------|------|
| IAM 用户信息 API 端点不确定 | `resolveUserInfo` 可能失败 | Phase 3 先做技术验证；优先从响应中提取，缺失才调用 IAM |
| `refresh_token` 有效期短于 AK/SK | 降级路径可能失效 | refresh_token 仅做降级使用，不依赖其作为主刷新手段 |
| 新旧 session 读取兼容 | `StoredHuaweiSession` 旧文件缺少新字段 | 所有新增字段均为 `optional?`，读取代码加可选链 |
| `setTimeout` 在进程重启后丢失 | 刷新任务需等待下次完整重启 | `startHuaweiRefreshTask` 中遍历所有 session 重新计算调度 |
