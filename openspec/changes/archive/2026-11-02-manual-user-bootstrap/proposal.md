# Proposal

## Why

启动时 `bootstrapDefaultAuth` 在内存无用户时自动创建 `dev@codearts-agent-proxy.local`，一旦某次启动未能加载磁盘用户（换 `ENCRYPTION_KEY`、`DATA_DIR` 变更、解密失败跳过），就会静默再建一个同名不同 `id` 的用户，形成无法区分的重复数据。同时 `createUser` 内置单用户守卫阻止多用户，而浏览器登录靠 `getDefaultUser()` 猜归属，多用户下无法确定请求归属。

## What Changes

- **BREAKING**：启动不再自动创建任何用户；零用户时服务空跑，各入口明确报错，不再静默建用户。
- 移除 `bootstrapDefaultAuth` 调用与自动建用户逻辑；`createUser` 取消单用户守卫，改为 `email` 去重，允许多用户。
- `admin/setup` 流程在设置密码后顺手创建首个用户；`admin` 面板新增用户创建入口（A+B）。
- 新增一次性绑定口令：由 admin 为指定用户签发，只能使用一次、有过期时间；首页匿名华为登录必须携带有效口令，登录 flow 全程携带显式 `userId`，不再回退到默认用户（方案 a）。
- 零用户 / 无口令 / 口令无效时，浏览器登录与 API 登录返回明确错误；存量重复 `dev` 用户通过一次性合并清理收敛。
- 存量测试中依赖 `bootstrapDefaultAuth` 与单用户假设的用例随之更新。

## Capabilities

### New Capabilities

- `user-invite-binding`：一次性绑定口令的签发、校验、一次性消费与过期行为，以及匿名登录必须持口令归属到显式用户的约束。

### Modified Capabilities

- `hierarchical-store`：启动不再创建默认用户；允许多用户并按 `email` 去重；目录扫描与加载行为不变。
- `huawei-auth`：登录 flow 必须携带显式 `userId`，移除 `getDefaultUser` 兜底；无归属时明确报错。
- `ticketed-web-login`：浏览器登录票据绑定显式用户与一次性口令，回调按票据归属完成。
- `admin-panel`：新增用户创建与绑定口令签发能力；用户列表展示多用户。

## Impact

- 代码：`src/store/user-store.ts`（删 bootstrap、放开守卫）、`src/index.ts`（删启动调用）、`src/routes/huawei-auth.ts`（显式 `userId`、口令校验）、`src/routes/admin.ts`（建用户、签发口令接口）、`public/admin-setup.html`、`public/admin.html`、`public/index.html`（登录入口携带口令）。
- 数据：`data/users/` 存量重复 `dev` 用户需合并清理（保留有账号者，删除 0 账号孤儿，操作前备份）。
- 兼容：全新安装首个用户需经 setup 创建；存量单用户实例升级后不受影响（用户已存在，仅停用自动创建）。
