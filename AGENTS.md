## 语言约定

- 文档、注释、LLM 输出均使用中文

# PROJECT KNOWLEDGE BASE

**Generated:** 2026-06-19
**Version:** 1.8.0

## OVERVIEW

OpenAI 兼容代理，封装华为云 CodeArts Agent LLM API。Express + TypeScript (CommonJS)，Node>=20，无 ORM，自研分层文件存储。

## STRUCTURE

```
src/
├── index.ts                    # Express 入口，29 路由注册，优雅关闭
├── config.ts                   # 30+ 环境变量（华为云端点、版本号、限流参数）
├── auth/
│   ├── huawei/                 # OAuth2+PKCE+DPoP 登录，AK/SK 签名，Token 刷新
│   ├── crypto/                 # AES-256-GCM 加解密
│   ├── admin.ts                # Admin 会话管理
│   └── store.ts                # [废弃] re-export facade → 用 src/store/
├── middleware/                  # 三级认证：API Key / UI Cookie / Admin Session
├── routes/                     # 29 端点（OpenAI API + OAuth + Admin + Web UI）
├── upstream/huawei/            # 核心代理：协议转换、SSE 流、工具定义
├── store/                      # 自研分层文件存储（内存缓存 + AES-256-GCM 加密持久化）
├── db/models/                  # 纯类型定义（User/ProviderAccount/ApiKey）— 无数据库
├── types/                      # OpenAI 兼容类型 + CodeArts 专有类型
├── translation/                # OpenAI 响应格式构建器（openai-mock.ts 名不副实）
└── utils/                      # 日志器、错误体系、脱敏工具
```

## WHERE TO LOOK

| 任务 | 位置 | 备注 |
|------|------|------|
| 添加新 API 端点 | `src/routes/` | 参考现有路由的认证中间件选择 |
| 修改聊天协议转换 | `src/upstream/huawei/` | 见子目录 AGENTS.md |
| 修改认证流程 | `src/auth/huawei/` | 见子目录 AGENTS.md |
| 修改数据存储 | `src/store/` | 见子目录 AGENTS.md |
| 添加新环境变量 | `src/config.ts` | 添加字段 + 默认值 |
| 修改前端页面 | `public/` | 纯 HTML/JS/CSS，无框架 |
| 调试请求签名 | `src/auth/huawei/sign.ts` | **勿修改** |
| 理解 CodeArts 协议 | `docs/codearts-api-spec.md` | 字段规范 |
| 查看真实请求样本 | `scripts/captured-requests/` | IDE 请求捕获 |

## CONVENTIONS

- **语言**: 文档、注释、LLM 输出均使用中文
- **包管理器**: 强制 `pnpm`（非 npm/yarn）— 注意 package.json scripts 内部仍用 `npm run`，需统一
- **`any` 类型**: ESLint error 级别禁止
- **函数式架构**: 无类/装饰器/依赖注入，路由为独立 `export async function`
- **测试**: 无框架，`assert` + `ts-node` 手动串联运行，co-location 模式（`.test.ts` 与源码同目录）
- **`__testHooks`**: 生产代码导出测试钩子对象，避免修改内部可见性
- **import 风格**: 全部使用相对路径（tsconfig 路径别名已定义但未使用，属死配置）
- **日志**: 自研结构化日志器（`src/utils/logger.ts`），生产 JSON / 开发人类可读
- **ESLint**: 旧格式 `.eslintrc.cjs`，env 含 `jest: true` 但项目无 jest

## ANTI-PATTERNS (THIS PROJECT)

- **勿修改 `sign.ts`** — AK/SK HMAC-SHA256 签名算法，与华为云 API 严格绑定
- **勿用 `randomUUID()` 生成 chat_id** — 必须用 SHA-256 哈希派生（providerAccountId + 首条消息内容）前32字符
- **勿用 `process.platform`** — `osVersion` 固定 `"win32"`
- **勿用 `process.cwd()`** — `currentWorkingDirectory` 必须来自 `request.codearts.current_working_directory`
- **勿创建第二个用户** — 单用户模式，`createUser()` 有硬守卫
- **勿解绑最后一个 ProviderAccount** — 至少保留一个账号
- **有 tool_calls 时 finish_reason 必须为 `"tool_calls"`** — 非 `"stop"`，否则客户端不执行工具
- **生产环境必须设置 `ENCRYPTION_KEY`** — 无安全回退
- **`IDE_VERSION`/`PLUGIN_VERSION` 必须匹配服务端** — 随意修改将导致请求被拒
- **子代理工具列表不得包含 Edit/Write/Task** — 仅 Bash/Glob/Grep/Read/openBrowserInIDE

## UNIQUE STYLES

- **三路径 Token 刷新降级链**: OAuth2 refresh → AK/SK 签名 → legacy refresh_token
- **per-session 刷新调度**: 每个 session 独立调度，基于 expiresAt 精准计算（过期前 2h + 随机抖动）
- **错误恢复**: 上游错误时合成 tool_call 继续对话（`chat-recovery.ts`）
- **模型缓存三级降级**: agent-center API → 文件缓存(1h TTL) → 静态列表
- **SSE 畸形行容错**: 跳过而非断开整个流
- **Admin 会话令牌每次重启随机生成**: 防止 cookie 伪造
- **全量上下文折叠注入（缓存未命中）**: 当无 `parent_message_id` 且内存 Map 未命中时，将完整对话历史折叠为带 role 标记的单条 text 注入上游（`foldFullConversation`），由 `FULL_CONTEXT_INJECTION_ENABLED` 控制（默认 false）。子代理永不注入；工具续传路径不受影响。
- **热链分叉修复**: `CHAIN_DIVERGENCE_REPAIR_ENABLED` 开启后，校验客户端消息前缀与完整尾部结构；正常尾部增量续传，尾部链分叉只补发缺失尾部，中段损伤或无法确认时全量重置。`MISSING_CONTEXT_HINT` 控制补发提示词，`FULL_CONTEXT_MAX_CHARS`/`FULL_CONTEXT_MAX_CHARS_BY_MODEL` 控制折叠长度。详见 `docs/spike-full-context-injection.md` 与 `openspec/changes/warm-switch-context-repair/`。

## COMMANDS

```bash
pnpm install          # 安装依赖
pnpm run build        # 生成 version.ts + tsc 编译
pnpm run dev          # ts-node 直接运行（开发用）
pnpm start            # 运行编译后代码
pnpm test             # 运行 4 个测试文件（手动串联）
pnpm run lint         # ESLint 检查
pnpm run format       # Prettier 格式化
```

## NOTES

- `src/version.ts` 是构建时自动生成的，已 gitignore
- `data/` 目录存储运行时数据（已 gitignore），分层结构：`users/{userId}/accounts/{accountId}/keys/{keyId}/`
- `src/auth/store.ts` 是已废弃的 re-export facade，新代码应直接导入 `src/store/` 模块（但 index.ts 仍从它导入）
- `src/translation/openai-mock.ts` 名为 "mock" 实为 OpenAI 响应格式构建器
- `docs/adapters/` 下的 `.ts` 文件是参考代码，不参与编译
- `src/db/models/` 仅含纯类型定义，无数据库操作
- Docker 三阶段构建：builder → prod-deps → runtime（node:22-alpine）
- CI 仅有 release workflow（`v*` tag 触发），无 PR 级别 CI
- tsconfig 中 `experimentalDecorators`/`emitDecoratorMetadata` 已启用但项目无类/装饰器
- `scripts/` 含敏感调试产物（密钥二进制、解密脚本），部分 gitignore
