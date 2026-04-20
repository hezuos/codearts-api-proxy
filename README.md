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

| 变量                    | 默认值                                               | 说明                             |
| ----------------------- | ---------------------------------------------------- | -------------------------------- |
| `PORT`                  | `1455`                                               | 监听端口                         |
| `CALLBACK_PORT`         | 同 `PORT`                                            | 传给华为登录 URL 的回调端口      |
| `DEFAULT_API_KEY`       | `dev-openai-compatible-key`                          | 客户端 Bearer Token              |
| `ENCRYPTION_KEY`        | `dev-only-32-byte-encryption-key!`                   | AK/SK 加密密钥，生产环境必须修改 |
| `IDE_VERSION`           | `26.3.11`                                            | 需与 CodeArts 服务端匹配         |
| `PLUGIN_VERSION`        | `26.3.5`                                             | 需与 CodeArts 服务端匹配         |
| `HUAWEI_REDIRECT_HOST`  | `https://devcloud.cn-north-4.huaweicloud.com/codeartside` | 华为云登录入口域名         |
| `ENABLE_REFRESH_TASK`   | `true`                                               | 是否自动刷新 Token               |
| `REQUEST_BODY_LIMIT`    | `10mb`                                               | 请求体大小限制                   |

完整变量列表见 `src/config.ts`。

## 开发命令

```bash
pnpm build   # 编译 TypeScript → dist/
pnpm dev     # ts-node 直接运行（开发用）
pnpm test    # 运行单元测试
pnpm lint    # ESLint 检查
```

修改代码后务必执行 `pnpm build` 确认零 TypeScript 错误。

## 数据文件

运行时数据存放在 `data/`（已加入 `.gitignore`，不提交）：

- `auth-store.json` — API Key 存储
- `huawei-sessions.json` — AK/SK 及会话 Token（敏感）

## 架构说明

代理保持**最小有状态设计**：进程内仅维护一个 `Map<chat_id, response_message_id>`，用于自动填充 `parent_message_id`，不存储消息历史。

- `src/upstream/huawei/chat.ts` — 核心逻辑：请求构造、签名、SSE 透传、tool 结果转发、sub-agent 处理
- `src/auth/huawei/sign.ts` — AK/SK HMAC-SHA256 签名（勿修改）
- `src/routes/huawei-auth.ts` — 华为云 OAuth 认证流程（浏览器登录、回调处理）
- `src/types/openai.ts` — 类型定义，含 `codearts` 扩展字段
- `docs/codearts-api-spec.md` — CodeArts API 字段规范
