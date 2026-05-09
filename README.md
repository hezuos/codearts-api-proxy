# CodeArts Agent Proxy

将华为云 CodeArts Agent LLM API 封装为标准 OpenAI 兼容接口的代理服务。

客户端（如 OpenCode）使用标准 OpenAI 协议与代理通信，代理负责 AK/SK 签名并将请求转换为 CodeArts SSE 协议转发到上游。

## 快速开始

```bash
# 安装依赖
pnpm install

# 开发模式（无需编译）
pnpm dev

# 编译后运行
pnpm build && pnpm start
```

服务默认监听 `http://localhost:1455`，启动后访问首页可进行华为云账号授权登录。

## 主要接口

### LLM API

| 接口                         | 说明                   |
| ---------------------------- | ---------------------- |
| `POST /v1/chat/completions`  | OpenAI 兼容对话接口    |
| `GET /v1/models`             | 模型列表               |

### 认证与账号

| 接口                                      | 说明                         |
| ----------------------------------------- | ---------------------------- |
| `GET /`                                   | 首页，含授权入口链接         |
| `GET /auth/huawei/authorize`              | 华为云 OAuth 授权登录        |
| `POST /auth/huawei/browser/start`         | 启动浏览器登录流程           |
| `GET /auth/huawei/browser/status/:id`     | 查询浏览器登录状态           |
| `POST /auth/huawei/browser/finalize/:id`  | 完成浏览器登录               |
| `GET /callback`                           | 华为云 OAuth 回调            |
| `GET /success`                            | 账号仪表盘（API Key、多账号管理、使用示例） |

### 账号管理（Web UI API）

| 接口                                      | 说明                         |
| ----------------------------------------- | ---------------------------- |
| `GET /api/ui/account`                     | 当前账号信息                 |
| `GET /api/ui/status`                      | 多账号状态                   |
| `POST /api/ui/regenerate-key`             | 重新生成 API Key             |
| `POST /api/ui/accounts/:id/refresh`       | 刷新账号 Token               |
| `DELETE /api/ui/accounts/:id`             | 解绑账号                     |
| `POST /api/ui/accounts/:id/default`       | 设为默认账号                 |

### Provider 账号（API Key 认证）

| 接口                                      | 说明                         |
| ----------------------------------------- | ---------------------------- |
| `GET /provider-accounts`                  | 已绑定的华为云账号列表       |
| `POST /provider-accounts/:id/default`     | 设为默认 Provider 账号       |
| `DELETE /provider-accounts/:id`           | 解绑 Provider 账号           |
| `POST /provider-accounts/:id/refresh`     | 刷新 Provider 账号 Token     |

所有 `/v1/*` 和 `/provider-accounts` 接口均需 Bearer Token 认证（默认 key：`dev-openai-compatible-key`）。

## 远程部署与回调粘贴

华为云 OAuth 回调地址固定为 `127.0.0.1`，当代理运行在远程机器时，自动回调无法到达代理。此时：

1. 在首页点击登录，浏览器弹出华为云登录页面
2. 完成登录后，浏览器会跳转到 `http://127.0.0.1:1455/callback?identifier=...`（页面会显示连接失败）
3. 从浏览器地址栏复制完整的回调 URL
4. 粘贴到首页的 "Paste Callback URL" 输入框并提交

> 此功能仅在代理通过非 localhost 地址访问时显示。

## 环境变量

| 变量                        | 默认值                                               | 说明                                       |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| `PORT`                      | `1455`                                               | 监听端口                                   |
| `CALLBACK_PORT`             | 同 `PORT`                                            | 传给华为登录 URL 的回调端口                |
| `DEFAULT_API_KEY`           | `dev-openai-compatible-key`                          | 客户端 Bearer Token                        |
| `ENCRYPTION_KEY`            | `dev-only-32-byte-encryption-key!`                   | AK/SK 加密密钥，生产环境必须设置           |
| `IDE_VERSION`               | `26.3.11`                                            | 需与 CodeArts 服务端匹配                   |
| `PLUGIN_VERSION`            | `26.3.5`                                             | 需与 CodeArts 服务端匹配                   |
| `HUAWEI_REDIRECT_HOST`      | `https://devcloud.cn-north-4.huaweicloud.com/codeartside` | 华为云登录入口域名                   |
| `HUAWEI_API_HOST`           | `https://ide.cn-north-4.myhuaweicloud.com`           | 华为云 API 主机（ticket/refresh）          |
| `HUAWEI_CHAT_HOST`          | `https://snap-access.cn-north-4.myhuaweicloud.com`   | 华为云 Chat 主机（SSE 聊天/模型列表）      |
| `HUAWEI_IAM_HOST`           | `https://iam.cn-north-4.myhuaweicloud.com`           | 华为云 IAM 主机                            |
| `HUAWEI_GPTS_URL`           | `""`（自动派生）                                     | Agent Center URL，空则从 CHAT_HOST 推导    |
| `HUAWEI_AGENT_ID`           | `""`（自动派生）                                     | Agent ID，空则根据版本推导                 |
| `HUAWEI_IS_INNER_VERSION`   | `false`                                              | 是否为内部版本（影响 URL 路径和响应解析）  |
| `ENABLE_REFRESH_TASK`       | `true`                                               | 是否自动刷新 Token                         |
| `REQUEST_BODY_LIMIT`        | `10mb`                                               | 请求体大小限制                             |
| `DATA_DIR`                  | `data`                                               | 运行时数据目录                             |
| `MODEL_CACHE_TTL`           | `300`                                                | 模型列表缓存 TTL（秒）                     |
| `RATE_LIMIT_CHAT_MAX`       | `60`                                                 | 每窗口每 Key 最大 chat 请求数              |
| `RATE_LIMIT_MODELS_MAX`     | `120`                                                | 每窗口每 Key 最大 models 请求数            |
| `UPSTREAM_TIMEOUT_MS`       | `120000`                                             | 上游 HTTPS 请求超时（毫秒）                |
| `IS_MASTER_NODE`            | `true`                                               | 是否为刷新任务主节点（多实例部署时使用）    |
| `ADMIN_PASSWORD`            | 无                                                   | Admin 密码（优先于文件存储的密码）         |
| `LOG_LEVEL`                 | `debug`（开发）/ `info`（生产）                      | 日志级别                                   |

完整变量列表见 `src/config.ts`。

## 日志配置

项目使用自研的轻量级结构化日志器（`src/utils/logger.ts`）。

### 日志级别控制

| 环境变量      | 说明                                           | 有效值                           |
| ------------- | ---------------------------------------------- | -------------------------------- |
| `LOG_LEVEL`   | 直接控制日志级别（优先级最高）                 | `debug`, `info`, `warn`, `error` |
| `NODE_ENV`    | 间接控制（影响默认级别和输出格式）             | `production`, `development` 等   |

**优先级**：`LOG_LEVEL` 环境变量 > `NODE_ENV` 默认值

### 环境差异

| 环境          | 默认日志级别 | 输出格式                       |
| ------------- | ------------ | ------------------------------ |
| `production`  | `info`       | JSON 格式（便于日志聚合）       |
| `development` | `debug`      | 人类可读格式（带颜色）          |

### 生产环境开启 Debug 日志

```bash
# 方法一：设置 LOG_LEVEL（推荐）
LOG_LEVEL=debug pnpm start

# 方法二：Docker 部署
docker run -e LOG_LEVEL=debug ...

# 方法三：.env 文件
echo "LOG_LEVEL=debug" >> .env
```

> **注意**：即使设置 `LOG_LEVEL=debug`，在 production 环境下日志仍会输出为 JSON 格式。如需人类可读格式，需同时设置 `NODE_ENV=development`（但这会影响其他行为，不推荐）。

## 开发命令

```bash
pnpm build   # 编译 TypeScript → dist/
pnpm dev     # ts-node 直接运行（开发用）
pnpm test    # 运行单元测试
pnpm lint    # ESLint 检查
```

修改代码后务必执行 `pnpm build` 确认零 TypeScript 错误。

## 数据文件

运行时数据存放在 `data/`（已加入 `.gitignore`，不提交），采用分层目录结构：

```
data/
└── users/{userId}/
    ├── profile.json              — 用户信息
    └── accounts/{accountId}/
        ├── account.json          — ProviderAccount 信息
        └── keys/{keyId}/
            ├── key.json          — API Key 元数据
            └── session.json      — AK/SK 及会话 Token（敏感，加密存储）
```

另有 `data/model-cache.json` 为动态模型列表缓存文件。

## 架构说明

### 单用户模式

当前系统运行在**单用户模式**：整个代理实例只服务于一个用户，所有 ProviderAccount、ApiKey、Session 都归属于该用户。

- 启动时 `bootstrapDefaultAuth()` 确保唯一用户存在（无用户则自动创建，已有则跳过）
- `createUser()` 内置守卫：如果用户已存在，调用将抛错，防止创建第二个用户
- 数据模型保留了多用户结构（`User → ProviderAccount → ApiKey → Session`），Admin API 也保留了用户列表端点，为后续多用户扩展预留能力
- 扩展为多用户时，需移除 `createUser()` 中的单用户守卫，并新增用户注册/创建入口

### 最小有状态设计

代理保持**最小有状态设计**：进程内维护 `Map<chat_id, response_message_id>`（含 4 小时 TTL 自动淘汰）和 `Map<chat_id, "main"|"sub">`，用于自动填充 `parent_message_id` 和区分主/子 Agent，不存储消息历史。

核心模块：

- `src/upstream/huawei/chat-request.ts` — 请求体构造、HTTP 传输、会话 ID 推导、parent_message_id 追踪
- `src/upstream/huawei/chat-stream.ts` — 流式 SSE 处理、OpenAI chunk 包装
- `src/upstream/huawei/chat-protocol.ts` — CodeArts SSE 协议解析
- `src/upstream/huawei/chat-translate.ts` — OpenAI ↔ CodeArts 消息/工具调用转换
- `src/upstream/huawei/chat-recovery.ts` — 上游错误恢复（合成 tool_call 继续）
- `src/upstream/huawei/models.ts` — 动态模型列表获取（agent-center API + 文件缓存）
- `src/upstream/huawei/tools.ts` — 工具定义（DEFAULT_TOOLS 11 个 + SUB_AGENT_TOOLS 5 个）
- `src/auth/huawei/sign.ts` — AK/SK HMAC-SHA256 签名（勿修改）
- `src/auth/huawei/credentials.ts` — 凭证提取 + 签名请求封装
- `src/auth/huawei/session-store.ts` — 华为会话存储 + 刷新逻辑
- `src/auth/huawei/refresh-task.ts` — 后台定时刷新任务（10 分钟间隔，2 小时阈值）
- `src/routes/huawei-auth.ts` — 华为云 OAuth 认证流程（浏览器登录、回调处理）
- `src/types/openai.ts` — OpenAI 类型定义，含 `codearts` 扩展字段
- `src/types/openai-codearts.ts` — CodeArts 专有类型
- `src/utils/logger.ts` — 自研结构化日志器
- `src/utils/errors.ts` — 结构化错误分类（AppError / UpstreamAuthError / UpstreamTimeoutError / ProtocolError）
- `docs/codearts-api-spec.md` — CodeArts API 字段规范
