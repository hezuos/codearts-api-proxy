# AGENTS.md

## 语言约定

- 文档、注释、LLM 输出均使用中文

## 项目概述

OpenAI 兼容代理，封装华为云 CodeArts Agent LLM API。客户端（如 OpenCode）使用标准 OpenAI `/v1/chat/completions` 协议，代理负责 AK/SK 签名并转换为 CodeArts SSE 协议转发上游。

## 包管理器

**使用 `pnpm`**（非 npm）：

```bash
pnpm install        # 安装依赖
pnpm run build      # 编译 TypeScript
pnpm run dev        # 开发模式（ts-node）
pnpm start          # 运行编译后代码
pnpm test           # 运行测试
pnpm run lint       # ESLint 检查
```

修改代码后务必执行 `pnpm run build` 确认零 TypeScript 错误。

## 核心架构

```
src/
  index.ts                        # Express 应用入口
  config.ts                       # 环境变量配置（含默认值）
  auth/
    store.ts                      # 认证存储门面（重导出各 store 模块）
    admin.ts                      # Admin 密码管理（bcrypt）
    huawei/
      sign.ts                     # AK/SK HMAC-SHA256 签名（勿修改）
      session-store.ts            # 华为会话持久化
      refresh-task.ts             # 后台 Token 刷新任务
  middleware/
    authenticate-api-key.ts       # API 路由 Bearer Token 认证
    authenticate-ui.ts            # UI 页面 Cookie 认证
    authenticate-admin.ts         # Admin 会话认证
  routes/
    openai.ts                     # POST /v1/chat/completions, GET /v1/models
    huawei-auth.ts                # OAuth 登录流程
    provider-accounts.ts          # Provider 账号管理 API
    web-ui.ts                     # Web UI API
    admin.ts                      # Admin API
  upstream/huawei/
    chat-request.ts               # 请求体构建 + HTTP 传输
    chat-stream.ts                # SSE 流式响应处理
    chat-protocol.ts              # CodeArts SSE 协议解析
    chat-translate.ts             # OpenAI ↔ CodeArts 消息转换
    tools.ts                      # 工具定义（DEFAULT_TOOLS / SUB_AGENT_TOOLS）
    models.ts                     # 模型列表获取（带缓存）
  store/
    hierarchical-store.ts         # 分层存储（User → Account → ApiKey → Session）
    file-store.ts                 # 加密文件读写
    paths.ts                      # 数据文件路径计算
  types/openai.ts                 # OpenAI 类型定义 + codearts 扩展字段
public/                           # Web UI 静态文件
```

## 关键设计规则（勿违反）

- **最小有状态**：进程内仅维护 `Map<chat_id, response_message_id>`（`chat-request.ts`），用于自动填充 `parent_message_id`。不存储消息历史。
- **`chat_id` 派生**：SHA-256 哈希（providerAccountId + 首条 user/system 消息内容）前 32 字符。勿用 `randomUUID()`。
- **`parent_message_id` 更新**：仅在 SSE 成功响应（无 `error_code`）时更新 Map。错误时保留旧值以支持重试。
- **`extractToolResults`**：仅当 `messages[last].role === "tool"` 时提取工具结果。若最后一条是 `user`，返回 `[]`（新对话轮次）。
- **`currentWorkingDirectory`**：必须来自 `request.codearts.current_working_directory`，勿用 `process.cwd()`。
- **`osVersion`**：默认 `"win32"`，勿用 `process.platform`。
- **`Task.subagent_type`**：通过 `normalizeToolCallArguments` 归一化为小写（CodeArts LLM 输出混合大小写，OpenCode 仅接受小写）。

## 环境变量

完整列表见 `src/config.ts`。关键变量：

| 变量                | 默认值                            | 说明                     |
| ------------------- | --------------------------------- | ------------------------ |
| `PORT`              | `1455`                            | 监听端口                 |
| `ENCRYPTION_KEY`    | `dev-only-32-byte-encryption-key!`| 生产环境必须修改         |
| `DEFAULT_API_KEY`   | `dev-openai-compatible-key`       | 客户端 Bearer Token      |
| `IDE_VERSION`       | `26.3.11`                         | 需匹配 CodeArts 服务端   |
| `PLUGIN_VERSION`    | `26.3.5`                          | 需匹配 CodeArts 服务端   |
| `HUAWEI_IS_INNER_VERSION` | `false`                    | 是否为内部版本（影响 URL 路径） |
| `ENABLE_REFRESH_TASK` | `true`                        | 是否自动刷新 Token       |

## 数据文件（不在 git 中）

`data/` 目录（gitignored）按分层结构存储：

- `users/{userId}/profile.json` — 用户配置
- `users/{userId}/accounts/{accountId}/account.json` — Provider 账号
- `users/{userId}/accounts/{accountId}/keys/{keyId}/key.json` — API Key
- `users/{userId}/accounts/{accountId}/keys/{keyId}/session.json` — 华为会话（含 AK/SK，敏感）

所有文件使用 AES-256-GCM 加密（密钥来自 `ENCRYPTION_KEY`）。

## 单用户模式

当前为单用户模式：整个代理实例服务于一个用户。`bootstrapDefaultAuth()` 确保唯一用户存在。数据模型保留多用户结构，为后续扩展预留。

## Web UI

静态页面（`public/`）：

- `/` — 首页（登录入口）
- `/success` — 登录成功页（显示 API Key）
- `/status` — 账号状态仪表盘
- `/admin` — Admin 控制面板
- `/admin/login` — Admin 登录
- `/admin/setup` — Admin 密码设置

认证方式：
- 用户页面：`auth_key` Cookie（值同 API Key）
- Admin 页面：`admin_session` Cookie

## 参考文档

- `docs/codearts-api-spec.md` — CodeArts API 字段规范
- `docs/request-and-api.md` — 字段来源规则
- `scripts/captured-requests/` — IDE 请求捕获（ground truth）
