## Why

上游 `huaweicloud.authentication` 扩展 v5.0.2 引入了新版 IAM 登录流程（`LoginWay.NewIamLogin`），API 响应中凭证字段名、刷新令牌机制均发生变化。本项目当前的华为云认证实现基于旧版 API 响应格式，需要与新版本对齐以避免上游 API 变更导致的认证中断，同时获取 `refresh_token` 带来的更可靠的刷新能力。

## What Changes

- **新增 `iam-auth-upgrade` 能力**：支持新版 IAM 登录流程的凭证格式（`credentials.access_key_id` / `secret_access_key` / `security_token` / `expiration`）
- **新增 `refresh_token` 支持**：从新格式登录响应中提取并持久化 `refresh_token`，用于 AK/SK 签名刷新失败时的降级路径
- **新增 IAM 用户信息查询**：新流程中通过 IAM API（`resolveUserInfo`）获取用户信息，替代直接从 ticket 响应中提取
- **新增 `IAMRequestErrorType` 错误分类**：对标上游的结构化认证错误枚举，覆盖登录和刷新环节
- **改造刷新调度机制**：将固定间隔 `setInterval` 替换为基于 `expires_at` 的动态 `setTimeout` 调度，对标上游 `getFirstRefreshTime` 算法
- **新增 `loginContext` 字段**：在 session 中记录 IAM 登录上下文
- **新增 IAM STS 备用刷新路径**（可选）：通过 `X-Auth-Token` 调用 `/v3.0/OS-CREDENTIAL/securitytokens` 获取临时凭证

## Capabilities

### New Capabilities
- `iam-auth-upgrade`: 上游 v5.0.2 新版 IAM 登录凭证格式（`credentials.access_key_id` / `secret_access_key` / `security_token` / `expiration`）、`refresh_token` 持久化与刷新、IAM 用户信息查询、结构化认证错误分类

### Modified Capabilities
- `huawei-auth`: 登录流程扩展 — 在保持旧格式兼容的前提下，新增对新格式凭证（NewIamLogin）的自动检测和处理能力。`provisionLoginResult` 需要根据响应格式分派到不同的处理路径

## Impact

- **新增文件**（6 个）：`extract-credentials.ts`, `user-info.ts`, `iam-sts.ts`, `auth-errors.ts`, `refresh-scheduler.ts`, `user-info.types.ts`
- **修改文件**（5 个）：`session-store.ts`（接口扩展）, `huawei-auth.ts`（登录流程新增分支）, `ticket.ts`（集成凭证检测）, `refresh.ts`（新增 refresh_token 路径）, `refresh-task.ts`（使用动态调度）
- **数据格式**：`StoredHuaweiSession` 新增 `refreshToken`, `loginContext`, `credentialFormat` 可选字段
- **外部依赖**：无新增
