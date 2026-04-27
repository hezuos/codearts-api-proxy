# 项目设计问题分析与改进方案

> 分析日期: 2026-04-24
> 范围: 架构设计、安全性、可维护性、可测试性、运行时可靠性

---

## D1. 无结构化日志系统 — 全部使用 console 直接输出

### 问题

全项目 118 处 `console.log/warn/error` 调用，无结构化日志框架。存在以下问题：

1. **无法控制日志级别** — 生产环境无法关闭 debug 级别日志，大量请求/响应体全文输出（如 `chat.ts:643` 输出完整 JSON body）
2. **无结构化输出** — 全部是模板字符串拼接，无法被日志收集系统（ELK、Loki）解析
3. **敏感信息泄露风险** — 完整请求体日志可能包含用户代码、密钥等敏感内容
4. **无请求关联** — traceId 靠手动拼接 `[${traceId}]` 前缀，容易遗漏

### 改进方案

引入轻量结构化日志（如 `pino`，或自建 wrapper）：

```
┌─────────────────────────────────────────────────────┐
│  当前: console.log(`[${traceId}] model: ${model}`)  │
│                                                     │
│  改进: logger.info("request", {                     │
│    traceId, model, chatId,                          │
│    // body 仅在 debug 级别输出                       │
│  })                                                 │
└─────────────────────────────────────────────────────┘
```

- 按 `config.nodeEnv` 控制级别：production=info, development=debug
- 请求体全文仅在 debug 级别输出，且截断超长内容
- 所有日志自动携带 traceId

---

## D2. Admin 认证使用硬编码 Session Token — 严重安全隐患

### 问题

`authenticate-admin.ts:6`:

```typescript
const ADMIN_SESSION_TOKEN = "admin-authenticated";
```

Admin 会话认证使用**硬编码的固定字符串**作为 cookie 值。这意味着：

1. 任何知道这个值的人都可以伪造 admin cookie
2. 值在源码中明文，无法轮换
3. 无过期机制（cookie maxAge=24h，但 token 值永不过期）
4. 多实例部署时所有实例共享同一 token，无法按实例隔离

### 改进方案

```typescript
// 启动时生成随机 session token
const adminSessionToken = randomBytes(32).toString("hex");

// 或使用签名 JWT
import jwt from "jsonwebtoken";
const token = jwt.sign({ role: "admin" }, secret, { expiresIn: "24h" });
```

---

## D3. API Key 存储使用明文值作为索引 — 安全隐患

### 问题

`auth/store.ts:143`:

```typescript
keyHash: input.rawKey,  // 字段名是 keyHash，但存的是明文 rawKey
```

`hierarchical-store.ts:32`:

```typescript
const apiKeysByValue = new Map<string, ApiKey>();  // 明文 API Key → ApiKey 映射
```

字段名为 `keyHash` 但实际存储的是**明文 API Key 值**。这导致：

1. 内存中持有所有用户的明文 API Key
2. 磁盘上加密存储的 JSON 中也包含明文 key（虽然整体文件加密，但语义上 keyHash 应该是 hash）
3. 验证时直接明文比较，无时序安全比较（timing attack 理论上可行）

### 改进方案

```typescript
// 生成时
const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

// 验证时
const lookupHash = crypto.createHash("sha256").update(rawKey).digest("hex");
const apiKey = apiKeysByHash.get(lookupHash);
```

---

## D4. HTTP 客户端不统一 — axios 与原生 https 混用

### 问题

| 模块 | HTTP 客户端 | 用途 |
|------|------------|------|
| `refresh.ts` | axios | Token 刷新 |
| `ticket.ts` | axios | Ticket 交换 |
| `chat.ts` | 原生 `https.request` | SSE 流式聊天 |
| `models.ts` | 原生 `https.get` | 模型列表获取 |

两种 HTTP 客户端混用导致：

1. 错误处理方式不一致（axios 用 `isAxiosError`，原生用 status code 判断）
2. 超时配置方式不一致（axios 用 `timeout` 选项，原生用 `req.setTimeout`）
3. 签名逻辑需要在两种客户端中分别适配
4. 增加维护成本和理解难度

### 改进方案

统一为一种方案。推荐保留原生 `https` 用于 SSE 流式场景（axios 不原生支持 SSE），其余场景也用原生 `https` + 共享的 `httpHelper` 模块：

```
┌──────────────────────────────────────────────┐
│  src/upstream/huawei/http.ts                 │
│  ├── httpsPost(url, headers, body) → stream  │
│  ├── httpsGet(url, headers) → { status, body}│
│  └── httpsPostJSON(url, headers, body) → {}  │
└──────────────────────────────────────────────┘
```

移除 `axios` 依赖，减少 bundle 大小。

---

## D5. 全局可变状态散布各模块 — 无集中管理

### 问题

项目中至少有 **8 个模块级全局可变 Map/Set**：

| 模块 | 变量 | 用途 |
|------|------|------|
| `chat.ts` | `lastResponseMessageId` | chat_id → response_message_id |
| `chat.ts` | `chatIdRole` | chat_id → "main"/"sub" |
| `hierarchical-store.ts` | `users`, `apiKeys`, `apiKeysByValue`, `providerAccounts`, `sessions`, `keyLocation` | 内存数据缓存 |
| `models.ts` | `modelCache` | 模型列表缓存 |
| `huawei-auth.ts` | `loginFlows`, `browserExchangeTasks` | 登录流程状态 |
| `admin.ts` | `adminConfig`, `adminPasswordFromEnv` | Admin 配置 |
| `refresh-task.ts` | `started`, `running`, `timer`, `enableRefreshTask`, `isMasterNode` | 刷新任务状态 |

问题：

1. **无法重置** — 测试间无法隔离状态（`huawei-auth.ts` 不得不暴露 `__testHooks` 来手动清理）
2. **无法多实例** — 多进程部署时各实例状态独立，`lastResponseMessageId` 会不一致
3. **启动顺序依赖** — `loadPersistedAuthStore()` 必须在请求前调用，但无编译期保障

### 改进方案

短期：将全局状态集中到显式的 "state store" 对象中，通过依赖注入传递：

```typescript
// 替代散布的全局 Map
interface AppState {
  lastResponseMessageId: Map<string, string>;
  chatIdRole: Map<string, "main" | "sub">;
  loginFlows: Map<string, LoginFlowRecord>;
  // ...
}
```

长期：将 `lastResponseMessageId` 和 `chatIdRole` 持久化到 Redis/文件，支持多实例。

---

## D6. 加密密钥管理 — 开发环境硬编码回退

### 问题

`config.ts:44-47`:

```typescript
encryptionKey: requireEnv(
  "ENCRYPTION_KEY",
  "dev-only-32-byte-encryption-key!",  // 硬编码回退
),
```

`requireEnv` 函数在有 fallback 时永远不会抛错。这意味着：

1. 如果忘记设置 `ENCRYPTION_KEY`，生产环境会静默使用硬编码密钥
2. 所有用此密钥加密的数据（AK/SK、session）都可被任何持有源码的人解密
3. `requireEnv` 的名字暗示"必需"，但 fallback 使其变成"可选"

### 改进方案

```typescript
encryptionKey: process.env.NODE_ENV === "production"
  ? requireEnv("ENCRYPTION_KEY")  // 生产环境必须设置，无 fallback
  : (process.env.ENCRYPTION_KEY ?? "dev-only-32-byte-encryption-key!"),
```

---

## D7. 文件存储全部使用同步 I/O — 阻塞事件循环

### 问题

`file-store.ts` 和 `hierarchical-store.ts` 中全部使用同步文件操作：

- `fs.existsSync`, `fs.readFileSync`, `fs.writeFileSync`
- `fs.readdirSync`, `fs.statSync`, `fs.mkdirSync`
- `fs.unlinkSync`, `fs.rmSync`, `fs.rmdirSync`

在 Node.js 单线程模型中，同步 I/O 会阻塞事件循环。当数据文件较大或磁盘 I/O 慢时，所有并发请求都会被阻塞。

### 改进方案

将热路径（请求处理中的读写）改为异步：

```typescript
// 当前
export function readEncryptedFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  // ...
}

// 改进
export async function readEncryptedFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    // ...
  } catch (e) {
    if ((e as any).code === "ENOENT") return null;
    throw e;
  }
}
```

启动时的 `loadAllEntities()` 可保留同步（只执行一次），但运行时的读写应异步。

---

## D8. 无请求限流/速率限制

### 问题

项目无任何速率限制机制。虽然 `types/openai.ts` 中定义了 `ProxyConfig.rateLimit` 类型，但从未被使用。

任何持有有效 API Key 的客户端可以：
1. 无限频率调用 `/v1/chat/completions`，耗尽上游 CodeArts 配额
2. 无限频率调用登录/刷新接口
3. 暴力枚举 API Key（虽然 Bearer token 有一定长度，但无限尝试仍是风险）

### 改进方案

使用 `express-rate-limit` 或类似中间件：

```typescript
import rateLimit from "express-rate-limit";

const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,  // 每分钟 20 次
  keyGenerator: (req) => getRequestAuth(req).apiKeyId,
});

app.post("/v1/chat/completions", authenticateApiKey, chatLimiter, createChatCompletion);
```

---

## D9. 无优雅的错误分类和错误码体系

### 问题

项目中的错误处理是 ad-hoc 的：

1. `UpstreamAuthError` — 唯一的自定义错误类，仅用于 401/403
2. 其他所有错误都是 `new Error(message)` — 无法区分网络超时、上游 5xx、协议错误等
3. `openai-error.ts` 的 `createOpenAIError` 只在 HTTP 响应中使用，内部错误无结构化
4. SSE 流中的错误靠 `break` + 内联 chunk 发送，无统一处理

### 改进方案

建立错误分类体系：

```
┌──────────────────────────────────────────────────────┐
│  AppError (base)                                     │
│  ├── UpstreamAuthError    (401/403 from CodeArts)    │
│  ├── UpstreamServerError  (5xx from CodeArts)        │
│  ├── UpstreamTimeoutError (network timeout)          │
│  ├── ProtocolError        (malformed SSE, bad JSON)  │
│  └── ConfigError          (missing config, bad env)  │
└──────────────────────────────────────────────────────┘
```

每个错误类携带结构化上下文（httpStatus, traceId, upstreamBody 等），便于日志和客户端响应。

---

## D10. `auth/store.ts` 是"上帝模块" — 职责过重

### 问题

`auth/store.ts` 同时承担了：
1. User CRUD
2. ProviderAccount CRUD
3. ApiKey CRUD + 验证
4. Session 代理访问
5. 启动引导（bootstrap）
6. 从 `hierarchical-store` 的大量 re-export（22 个导入，11 个 re-export）

它实际上是 `hierarchical-store` 的外观层（facade），但混入了业务逻辑（validateApiKey、revokeApiKey 等），导致：

1. 任何需要存储访问的模块都导入 `auth/store`，即使只需要 `getProviderAccount`
2. 循环依赖风险 — `chat.ts` 导入 `auth/store` 获取 `getProviderAccount`，但 `auth/store` 又间接依赖加密模块
3. re-export 链过长：`routes → auth/store → hierarchical-store → file-store → encryption`

### 改进方案

按领域拆分：

```
src/store/
  ├── user-store.ts      — User CRUD
  ├── account-store.ts   — ProviderAccount CRUD
  ├── api-key-store.ts   — ApiKey CRUD + 验证
  ├── session-store.ts   — Session 读写（从 auth/huawei 移出）
  └── hierarchical-store.ts — 底层文件 I/O（内部实现）
```

路由直接导入需要的 store，不再通过 `auth/store` 中转。

---

## D11. SSE 传输层手写 AsyncIterator — 可用 ReadableStream 替代

### 问题

`chat.ts:441-498` 手写了一个完整的 AsyncIterator 协议实现来将 Node.js `IncomingMessage` 转为逐行异步迭代器。这段代码约 60 行，处理了 pending resolve 队列、backpressure 等。

Node.js 从 v16 起原生支持 `Readable.from()` 和 web `ReadableStream`，可以大幅简化。

### 改进方案

```typescript
import { Readable } from "stream";

async function* lines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  let buf = "";
  for await (const chunk of stream as AsyncIterable<string>) {
    buf += chunk;
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    yield* parts;
  }
  if (buf) yield buf;
}
```

从 ~60 行降至 ~8 行，功能等价。

---

## D12. 登录流程状态全内存 — 重启丢失

### 问题

`huawei-auth.ts` 的 `loginFlows` Map 完全在内存中，进程重启后所有进行中的登录流程丢失。用户在浏览器中完成华为云 OAuth 后回调到代理，但代理已不记得对应的 flow，导致登录失败。

虽然 flow 有 5 分钟过期时间，但重启窗口期内的用户会看到 "Unknown or expired login flow" 错误。

### 改进方案

短期：将 loginFlows 持久化到临时文件（类似 session 存储）。

长期：使用 Redis 或数据库存储，支持多实例和重启恢复。

---

## D13. `lastResponseMessageId` 无过期/淘汰机制

### 问题

`chat.ts:120`:

```typescript
const lastResponseMessageId = new Map<string, string>();
```

这个 Map 永远只增不删。长期运行的服务器中：

1. 每个唯一的 chat_id 都会永久占用一条记录
2. 无 LRU 淘汰、无 TTL 过期、无大小上限
3. 理论上可导致内存缓慢增长（虽然单条记录很小）

### 改进方案

添加 TTL 过期：

```typescript
// 简单方案：定期清理超过 N 小时未更新的条目
setInterval(() => {
  // 清理逻辑
}, 60_000);

// 或使用 LRU Map（如 lru-cache npm 包）
```

---

## D14. 测试基础设施薄弱

### 问题

1. **无测试框架** — 测试用 `ts-node` 直接执行 `.test.ts`，用 `assert` 手写，无 describe/it 结构
2. **无 mock 框架** — `huawei-auth.ts` 不得不暴露 `__testHooks` 来注入测试替身，污染生产代码
3. **覆盖率极低** — 仅 3 个测试文件，覆盖 chat stateless、tools、huawei-auth 三个模块
4. **无集成测试** — 无对完整请求链路（Express → auth → upstream → response）的端到端测试
5. **package.json 中 jest/ts-jest 已声明但未使用** — 配置不一致

### 改进方案

1. 采用 `vitest`（与 ESM/TypeScript 兼容性好）或 `jest` + `ts-jest`
2. 使用依赖注入替代 `__testHooks` — 将 `exchangeHuaweiTicket` 作为参数传入而非模块级变量
3. 添加集成测试：用 `supertest` 对 Express app 发请求
4. 移除未使用的 jest 依赖或正式配置使用

---

## D15. Cookie 安全配置不一致

### 问题

| Cookie | httpOnly | secure | sameSite | maxAge |
|--------|----------|--------|----------|--------|
| `auth_key` | true | dynamic | lax | 30d |
| `auth_key_id` | **false** | dynamic | lax | 30d |
| `admin_session` | true | dynamic | **strict** | 24h |
| `huawei_login_ticket` | true | dynamic | lax | 5m |

问题：
1. `auth_key_id` 设置了 `httpOnly: false` — JavaScript 可读取，可能被 XSS 窃取
2. `secure` 全部依赖 `process.env.NODE_ENV`，但多处重复计算而非从 config 读取
3. `sameSite` 不一致 — admin 用 strict，其他用 lax，无明确设计理由

### 改进方案

1. `auth_key_id` 改为 `httpOnly: true`（除非前端 JS 确实需要读取它，但应通过 API 获取而非 cookie）
2. 在 `config.ts` 中统一 `isProduction` 和 `cookieSecure` 配置
3. 统一 `sameSite` 策略，或文档化不同选择的理由

---

## D16. 动态 import 用于避免循环依赖 — 设计异味

### 问题

`session-store.ts:60,96`:

```typescript
const { decryptString } = await import("../crypto/encryption");
const { encryptString } = await import("../crypto/encryption");
```

使用动态 `await import()` 来延迟加载加密模块。注释无说明原因，但通常是为了避免循环依赖。

这导致：
1. 函数从同步变为异步（`refreshStoredSession` 必须是 async）
2. 模块依赖关系不透明 — 静态分析工具无法检测到这个依赖
3. 每次调用都有动态 import 的开销（虽然 V8 会缓存，但语义上不清晰）

### 改进方案

重构模块依赖关系，消除循环依赖，改为静态 import。如果确实存在循环，说明模块边界需要重新划分。

---

## D17. 无健康检查深度探测

### 问题

`index.ts:70`:

```typescript
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});
```

健康检查端点只返回固定值，不检查：
1. 上游 CodeArts 是否可达
2. 加密模块是否正常
3. 数据目录是否可读写
4. Session 是否即将过期

在容器编排（K8s）中，这种浅健康检查无法发现"进程活着但服务不可用"的情况。

### 改进方案

区分 liveness 和 readiness：

```typescript
// liveness: 进程是否活着
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// readiness: 是否能处理请求
app.get("/ready", async (_req, res) => {
  const checks = {
    store: checkStoreAccessible(),
    upstream: checkUpstreamReachable(),  // 可选，带超时
  };
  const allOk = Object.values(checks).every(Boolean);
  res.status(allOk ? 200 : 503).json({ status: allOk ? "ok" : "degraded", checks });
});
```

---

## 设计问题优先级矩阵

| # | 问题 | 严重度 | 改进难度 | 影响范围 |
|---|------|--------|---------|---------|
| D2 | Admin 硬编码 Session Token | **严重** | 低 | 安全 |
| D3 | API Key 明文存储 | **严重** | 中 | 安全 |
| D6 | 加密密钥硬编码回退 | **严重** | 低 | 安全 |
| D1 | 无结构化日志 | 高 | 中 | 运维/安全 |
| D4 | HTTP 客户端不统一 | 高 | 中 | 可维护性 |
| D5 | 全局可变状态散布 | 高 | 高 | 可测试性/可扩展性 |
| D7 | 同步文件 I/O | 高 | 中 | 性能 |
| D8 | 无速率限制 | 高 | 低 | 安全/可靠性 |
| D10 | auth/store 上帝模块 | 中 | 中 | 可维护性 |
| D11 | 手写 AsyncIterator | 中 | 低 | 可维护性 |
| D13 | Map 无过期机制 | 中 | 低 | 可靠性 |
| D14 | 测试基础设施薄弱 | 中 | 高 | 质量 |
| D9 | 无错误分类体系 | 中 | 中 | 可维护性 |
| D15 | Cookie 安全不一致 | 中 | 低 | 安全 |
| D12 | 登录状态全内存 | 中 | 中 | 可靠性 |
| D16 | 动态 import 避循环依赖 | 低 | 低 | 可维护性 |
| D17 | 无深度健康检查 | 低 | 低 | 运维 |

---

## 架构改进总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        当前架构                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Routes ──→ auth/store (上帝模块) ──→ hierarchical-store           │
│     │              │                       │                        │
│     │              ├── User CRUD           ├── 6 个全局 Map         │
│     │              ├── Account CRUD        ├── 同步 fs I/O          │
│     │              ├── ApiKey CRUD         └── 加密文件读写         │
│     │              ├── Session 代理                                   │
│     │              ├── 11 个 re-export                                  │
│     │              └── Bootstrap                                       │
│     │                                                                │
│     ├──→ upstream/huawei/chat.ts (1070行)                            │
│     │        ├── 全局 Map (lastResponseMessageId, chatIdRole)        │
│     │        ├── 手写 AsyncIterator                                  │
│     │        ├── 118 处 console.log                                  │
│     │        └── 流式/非流式 200行重复                                │
│     │                                                                │
│     └──→ middleware/                                                 │
│              ├── Reflect.set/get (非标准)                             │
│              └── 硬编码 Admin Token                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        改进架构                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Routes ──→ store/ (按领域拆分)                                     │
│     │        ├── user-store.ts                                      │
│     │        ├── account-store.ts                                   │
│     │        ├── api-key-store.ts  (SHA-256 hash)                   │
│     │        └── session-store.ts                                   │
│     │                                                                │
│     ├──→ upstream/huawei/                                           │
│     │        ├── chat-request.ts   (请求构造)                       │
│     │        ├── chat-stream.ts    (流式响应)                       │
│     │        ├── chat-response.ts  (非流式响应)                     │
│     │        ├── http.ts           (统一 HTTP 客户端)               │
│     │        └── credentials.ts    (共享凭证提取)                   │
│     │                                                                │
│     ├──→ middleware/                                                │
│     │        ├── Express Request 类型扩展                            │
│     │        └── 随机 Admin Session Token                           │
│     │                                                                │
│     ├──→ logger.ts  (结构化日志, pino 或自建)                       │
│     ├──→ errors.ts  (错误分类体系)                                  │
│     └──→ config.ts  (isProduction, cookieSecure 统一)               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```
