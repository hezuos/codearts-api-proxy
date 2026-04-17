# CodeArts Agent Proxy

将华为云 CodeArts Agent LLM API 封装为标准 OpenAI 兼容接口的代理服务。

客户端（如 OpenCode）使用标准 OpenAI 协议与代理通信，代理负责 AK/SK 签名并将请求转换为 CodeArts SSE 协议转发到上游。

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（无需编译）
npm run dev

# 编译后运行
npm run build && npm start
```

服务默认监听 `http://localhost:1455`，启动后访问首页可进行华为云账号授权登录。

## 主要接口

| 接口                         | 说明                   |
| ---------------------------- | ---------------------- |
| `GET /`                      | 首页，含授权入口链接   |
| `GET /auth/huawei/authorize` | 华为云 OAuth 授权登录  |
| `GET /health`                | 健康检查               |
| `POST /v1/chat/completions`  | OpenAI 兼容对话接口    |
| `GET /v1/models`             | 模型列表               |
| `GET /provider-accounts`     | 已绑定的华为云账号列表 |

所有 `/v1/*` 和账号管理接口均需 Bearer Token 认证（默认 key：`dev-openai-compatible-key`）。

## 环境变量

| 变量              | 默认值                             | 说明                             |
| ----------------- | ---------------------------------- | -------------------------------- |
| `PORT`            | `1455`                             | 监听端口                         |
| `DEFAULT_API_KEY` | `dev-openai-compatible-key`        | 客户端 Bearer Token              |
| `ENCRYPTION_KEY`  | `dev-only-32-byte-encryption-key!` | AK/SK 加密密钥，生产环境必须修改 |
| `IDE_VERSION`     | `26.3.11`                          | 需与 CodeArts 服务端匹配         |
| `PLUGIN_VERSION`  | `26.3.5`                           | 需与 CodeArts 服务端匹配         |

完整变量列表见 `src/config.ts`。

## 开发命令

```bash
npm run build   # 编译 TypeScript → dist/
npm run dev     # ts-node 直接运行（开发用）
npm test        # 运行单元测试
npm run lint    # ESLint 检查
```

修改代码后务必执行 `npm run build` 确认零 TypeScript 错误。

## 数据文件

运行时数据存放在 `data/`（已加入 `.gitignore`，不提交）：

- `auth-store.json` — API Key 存储
- `huawei-sessions.json` — AK/SK 及会话 Token（敏感）

## 架构说明

代理保持**最小有状态设计**：进程内仅维护一个 `Map<chat_id, response_message_id>`，用于自动填充 `parent_message_id`，不存储消息历史。

- `src/upstream/huawei/chat.ts` — 核心逻辑：请求构造、签名、SSE 透传
- `src/auth/huawei/sign.ts` — AK/SK HMAC-SHA256 签名（勿修改）
- `src/types/openai.ts` — 类型定义，含 `codearts` 扩展字段
- `docs/codearts-api-spec.md` — CodeArts API 字段规范
