## 1. 数据结构与错误类型

- [x] 1.1 扩展 `StoredHuaweiSession` 接口：新增 `refreshToken`, `loginContext`, `credentialFormat` 可选字段
      - 文件: `src/auth/huawei/session-store.ts`
      - 验证: `pnpm build` 编译通过

- [x] 1.2 创建 `IAMRequestErrorType` 枚举文件和 `IAMHttpErrorCode` 枚举
      - 新文件: `src/utils/auth-errors.ts`
      - 内容: 对标上游 EXCEPTIONS 和 EXCEPTIONS_CODE，覆盖 12 种错误类型 + 7 种 HTTP 状态码
      - 验证: 枚举值完整且可被 import

## 2. 凭证格式解析

- [x] 2.1 实现 `isNewIamLoginPayload` 函数：检测响应是否为 NewIamLogin 格式
      - 新文件: `src/upstream/huawei/extract-credentials.ts`
      - 验证: 传入含 `credentials.access_key_id` 的 payload 返回 true，否则返回 false

- [x] 2.2 实现 `extractNewIamCredentials` 函数：从新格式提取凭证
      - 映射: `access_key_id→accessKey`, `secret_access_key→secretKey`, `security_token→securityToken`, `expiration→expiresAt`
      - 返回: `HuaweiTicketExchangeResponse` 兼容对象
      - 验证: 单元测试覆盖字段映射正确性

- [x] 2.3 实现 `extractRefreshToken` 函数：从新格式 payload 提取 refresh_token
      - 验证: refresh_token 存在时返回其值，不存在时返回 undefined

- [x] 2.4 在 `ticket.ts` 中集成格式检测
      - `exchangeHuaweiTicket` 返回后，使用 `isNewIamLoginPayload` 检测格式
      - 新格式走 `extractNewIamCredentials` + `extractRefreshToken`
      - 验证: 新旧格式的 ticket 响应均能正确解析

## 3. IAM 用户信息查询

- [x] 3.1 实现 `resolveUserInfo` 函数：通过 IAM API 获取用户信息
      - 新文件: `src/upstream/huawei/user-info.ts`
      - 使用 AK/SK 签名调用 IAM 用户信息端点
      - 返回: `{ userId, userName, domainId }`
      - 验证: 需要先确认正确的 IAM API 端点（通过实际环境测试）

- [x] 3.2 在 `huawei-auth.ts` 的登录完成流程中集成 `resolveUserInfo`
      - 定位: `provisionLoginResult` 函数
      - 当 `credentialFormat === 'new_iam'` 且 user_id 缺失时调用
      - 验证: 登录完成后 session 中的 account 包含正确的用户信息

## 4. 登录流程集成

- [x] 4.1 在 `huawei-auth.ts` 中实现 `provisionNewIamLoginResult` 函数
      - 调用 `extractNewIamCredentials` 获取凭证
      - 调用 `resolveUserInfo`（必要时）获取用户信息
      - 提取 `refreshToken`
      - 存储 session 时写入 `refreshToken`、`credentialFormat`、`loginContext`
      - 验证: 完整新格式登录 E2E 流程成功

- [x] 4.2 重构 `provisionLoginResult`：根据格式分派到不同处理函数
      - 检测 `result.raw` → `isNewIamLoginPayload` → `provisionNewIamLoginResult`
      - 否则走现有的 `provisionLegacyLoginResult` 逻辑
      - 验证: 新旧格式的登录流程都能正确完成

## 5. 刷新调度升级

- [x] 5.1 实现 `RefreshScheduler` 类
      - 新文件: `src/auth/huawei/refresh-scheduler.ts`
      - 方法: `calculateNextDelay(expiresAt)`, `schedule(expiresAt, refreshFn)`, `cancel()`
      - 算法: 过期前 2h + 随机 0-59s 的 setTimeout
      - 验证: 单元测试覆盖边界条件（无 expiresAt、已过期、即将过期）

- [x] 5.2 改造 `refresh-task.ts` 使用动态调度
      - 为每个 session 维护独立的 `RefreshScheduler` 实例
      - 取消原有的 `setInterval` 固定间隔
      - 每次刷新成功后重新计算下次刷新时间
      - 进程重启时通过 `startHuaweiRefreshTask` 遍历 session 恢复调度
      - 验证: 刷新任务在正确的时间点火，日志可观测

- [x] 5.3 在 `refresh.ts` 中新增 `refresh_token` 刷新路径（降级）
      - 当 AK/SK 签名刷新返回 `ExpiredRefreshToken` 错误时降级
      - 使用 `refresh_token` 调用 `/v2/login/refresh` 或 IAM STS 端点
      - 验证: 模拟签名失败 → 降级到 refresh_token → 凭证刷新成功

## 6. IAM STS 备用路径（可选）

- [ ] 6.1 实现 `getCredentialsByToken` 函数
      - 新文件: `src/upstream/huawei/iam-sts.ts`
      - 使用 `X-Auth-Token` 调用 `/v3.0/OS-CREDENTIAL/securitytokens`
      - 验证: 能通过 businessToken 获取临时凭证

- [ ] 6.2 将 IAM STS 路径集成到刷新降级策略
      - 当 AK/SK 刷新和 refresh_token 均失败时最后尝试
      - 验证: 端到端降级路径可用
