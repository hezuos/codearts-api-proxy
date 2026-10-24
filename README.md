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

## 使用 Docker 部署

镜像为三阶段构建（builder → prod-deps → runtime，基于 `node:22-alpine`），以编译后的 `dist/` 运行，使用非 root 用户，仅暴露 `1455` 端口，内置基于 `/ready` 的健康检查。

### 构建镜像

```bash
docker build -t codearts-agent-proxy .
```

### 运行容器

```bash
docker run -d --name codearts-proxy \
  -p 1455:1455 \
  -v codearts-proxy-data:/app/data \
  -e ENCRYPTION_KEY='<32字节随机密钥>' \
  -e ADMIN_PASSWORD='<管理后台密码>' \
  codearts-agent-proxy
```

- **端口**：华为云 OAuth 回调固定为 `127.0.0.1:1455`，本地部署保持 `-p 1455:1455` 即可；远程部署需配合上文「远程部署与回调粘贴」。
- **数据卷**：`/app/data` 持久化加密的账号会话、API Key 与运行时数据。删除容器不会丢失登录态，但**更换 `ENCRYPTION_KEY` 会使存量加密数据无法解密**。
- **`ENCRYPTION_KEY` 必填**：生产环境必须注入独立随机密钥，否则回落到内置默认值（不安全）。
- **健康检查**：镜像内置 `HEALTHCHECK`（每 30s 调 `/ready`，同时校验数据卷可写）。

- **日志**：规则输出到 stdout（`docker logs -f codearts-proxy` 查看）；如需落盘可设 `LOG_FILE` 指向挂载卷内路径。

### 环境变量注入

```bash
# 方式一：-e 显式传入
docker run ... -e LOG_LEVEL=debug \
  -e UPSTREAM_MAX_CONCURRENCY=2

# 方式二：以宿主机 .env 作为 env-file（.dockerignore 已排除 .env，不会进入镜像）
docker run ... --env-file .env
```

完整变量见上文「环境变量」表。敏感值（`ENCRYPTION_KEY`、`ADMIN_PASSWORD`）在 Compose/编排平台建议改用 secrets 注入，避免写入明文。

### docker-compose 示例

```yaml
services:
  codearts-agent-proxy:
    image: codearts-agent-proxy
    container_name: codearts-proxy
    restart: unless-stopped
    ports:
      - "1455:1455"
    volumes:
      - codearts-proxy-data:/app/data
    environment:
      NODE_ENV: production
      # 敏感值走宿主机环境变量/编排 secrets，切勿硬编码进文件
      ENCRYPTION_KEY: "${ENCRYPTION_KEY:?必须设置 ENCRYPTION_KEY}"
      ADMIN_PASSWORD: "${ADMIN_PASSWORD:-}"

volumes:
  codearts-proxy-data:
```

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
| `UPSTREAM_MAX_CONCURRENCY` | `3` | 每 ProviderAccount 最大上游并发请求数，超出者 FIFO 排队（0 = 不限） |
| `UPSTREAM_MIN_CONCURRENCY` | `1` | 撞限自适应降级的下限 |
| `UPSTREAM_CONCURRENCY_RECOVER_MS` | `60000` | 连续无撞限多久后逐级恢复有效上限 |
| `REDIRECT_ALLOWED_HOSTS`      | `""`                                                  | 追加到回调 redirect 白名单的主机（逗号分隔，防开放重定向） |
| `RATE_LIMIT_GLOBAL_MAX`       | `300`                                                  | 全局 IP 限流（覆盖无专用限流器的路由） |
| `UPSTREAM_QUEUE_WAIT_TIMEOUT_MS` | `120000` | 排队等待槽位超时（0 = 无限等待） |
| `UPSTREAM_CONCURRENCY_RETRY_MAX` | `2` | 上游返回 TM.00001041 时的重试次数 |
| `UPSTREAM_CONCURRENCY_RETRY_DELAY_MS` | `1500` | 撞限重试基础退避（指数增长） |
| `UPSTREAM_PROMPT_TOKEN_LIMIT` | `196608` | 上游 CodeArts 累积 prompt 长度硬限制（token），超过触发 `ChatAgent.00001216` |
| `ADMIN_PASSWORD`             | 无                                                   | Admin 密码（优先于文件存储的密码）         |
| `LOG_LEVEL`                 | `debug`（开发）/ `info`（生产）                      | 日志级别                                   |

完整变量列表见 `src/config.ts`。

### .env 文件支持

服务启动时会自动读取项目根目录的 `.env` 文件并注入环境变量（若存在）。

- 解析规则：支持 `KEY=VALUE`、`export KEY=VALUE`、单/双引号包裹的值；`#` 开头的行为注释；不覆盖进程内已存在的环境变量。
- 可通过 `ENV_FILE` 环境变量指定 `.env` 的替代路径。
- 示例见 `.env.example`；`.env` 已被 `.gitignore` 排除，避免提交敏感值。

```bash
cp .env.example .env
# 编辑 .env 后直接启动即可生效
pnpm dev
```

### 上下文与并发

- 代理不再改写、压缩或截断客户端历史：请求始终按原顺序、原角色逐字透传。
- 上下文超限（上游 `ChatAgent.00001216` 或 HTTP 413）会返回 `context_length_exceeded`，由客户端自行压缩或摘要。请把客户端声明的模型窗口调到接近上游真实上限（约 18 万 token）。
- 上游单账号并发会话上限为 3，且是**账号级共享**的：官方 IDE、其他客户端会同时占用。代理只能观察到自己的在途数，所以撞限时会把该账号的有效上限自动下调（最低 `UPSTREAM_MIN_CONCURRENCY`），连续 `UPSTREAM_CONCURRENCY_RECOVER_MS` 无撞限后逐级恢复。

```bash
UPSTREAM_MAX_CONCURRENCY=3
```

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
# 在项目根目录 .env 中写入（见上方「.env 文件支持」）
LOG_LEVEL=debug
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

### 真实热链分叉验证

先启动本地代理并完成华为云登录。然后使用代理生成的 API Key 运行：

```bash
set OPENAI_BASE_URL=http://localhost:1455
set OPENAI_API_KEY=替换为本地代理 API Key
set CODEARTS_TEST_MODEL=GLM-5.1
pnpm verify:real
```

PowerShell：

```powershell
$env:OPENAI_BASE_URL = "http://localhost:1455"
$env:OPENAI_API_KEY = "替换为本地代理 API Key"
$env:CODEARTS_TEST_MODEL = "GLM-5.1"
pnpm verify:real
```

脚本通过真实 `/v1/chat/completions` 入口依次验证：

1. 首轮 CodeArts 会话建立
2. 正常增量续传
3. 模拟外部 provider 轮次后切回 CodeArts，验证 `tail-divergence` 和尾部补发
4. 修改中段历史，验证 `middle-damage` 全量重置
5. 重复/陈旧请求被拒绝

默认使用非流式请求；设置 `CODEARTS_TEST_STREAM=true` 可验证流式响应解析。脚本只输出脱敏摘要，不读取 `data/`、不解密 AK/SK，也不会把 API Key 写入文件。运行时请同时查看 proxy 日志中的 `divergence`、`suffixStart` 和 `fullContextInjected` 字段。

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

代理保持**最小有状态设计**：进程内维护 `Map<chat_id, response_message_id>`（含 4 小时 TTL 自动淘汰）、链指纹与 `Map<chat_id, "main"|"sub">`，仅用于续传判定、缓存估算与主/子 Agent 区分，不存储消息历史。v2 请求全量透传客户端 messages，`chat_id` 不会发送给上游。

核心模块：

- `src/upstream/huawei/chat-request.ts` — v2 请求体构造、HTTP/SSE 传输、会话 ID 推导
- `src/upstream/huawei/upstream-gate.ts` — 上游并发槽位排队与 TM.00001041 识别
- `src/upstream/huawei/chat-stream.ts` — 流式 SSE 处理、OpenAI chunk 包装
- `src/upstream/huawei/chat-protocol.ts` — CodeArts SSE 协议解析
- `src/upstream/huawei/chat-translate.ts` — OpenAI ↔ CodeArts 消息/工具调用转换
- `src/upstream/huawei/chat-recovery.ts` — 上游错误恢复（合成 tool_call 继续）
- `src/upstream/huawei/models.ts` — 动态模型列表获取（agent-center API + 文件缓存）
- `src/upstream/huawei/tools.ts` — 工具定义格式转换与子代理工具过滤
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
